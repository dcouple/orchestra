import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConsoleConfig, type Config, type ConsoleConfig } from "../src/config.js";
import { ConsoleServer, probeDaemon } from "../src/console-server.js";
import { EventLog } from "../src/eventlog.js";
import { WebhookServer } from "../src/server.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(probe: () => Promise<boolean> = async () => true,
  beforeAssetOpen?: (canonicalPath: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "console-server-")); dirs.push(dir);
  const assets = join(dir, "assets"); mkdirSync(join(assets, "assets"), { recursive: true });
  writeFileSync(join(assets, "index.html"), "<!doctype html><title>Orchestra Console</title><div id=root></div>");
  writeFileSync(join(assets, "assets", "app.js"), "console.log('local')");
  const skillInventoryPath = join(dir, "console-inventory.json");
  writeFileSync(skillInventoryPath, JSON.stringify({ schemaVersion: 1, sourceRevision: "a".repeat(40),
    sources: [{ id: "claude", label: "Claude Code", available: true, skillCount: 1 },
      { id: "codex", label: "Codex", available: true, skillCount: 1 }],
    skills: [{ name: "implementer", description: "Implements a bounded plan.", version: null, availability: "available",
      provenance: ["Claude Code", "Codex"], compatibility: ["claude", "codex"] }] }));
  const config: ConsoleConfig = { port: 0, bindAddr: "127.0.0.1", dbPath: join(dir, "events.db"), assetsDir: assets,
    daemonHealthUrl: "http://127.0.0.1:8787/healthz", skillInventoryPath };
  const log = new EventLog(config.dbPath);
  const logger = { log: vi.fn(), error: vi.fn() };
  const server = new ConsoleServer({ config, log, probe, now: () => 2_000, logger, beforeAssetOpen });
  return { server, log, config, dir, logger };
}

function requestWithHost(port: number, host: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolveResponse, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/api/overview", headers: { Host: host } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolveResponse({ status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }));
    });
    req.on("error", reject); req.end();
  });
}

async function expectJsonError(response: Response, status: number, body: unknown): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual(body);
}

function populate(log: EventLog): void {
  log.append({ deliveryId: "secret-delivery-1", app: "planner", action: "created", agentSessionId: "session-1",
    issueId: "issue-id-1", issueIdentifier: "ENG-42", receivedAt: 1_000,
    rawBody: Buffer.from('{"token":"RAW_WEBHOOK_SECRET"}') });
  const turn = log.claimNextTurn(1_100)!;
  log.ingestCodexInvocation({ linearSessionId: "session-1", turnId: turn.id, sourceKey: "invocation-parent",
    role: "code-researcher", prompt: "PROMPT_SECRET", report: "REPORT_SECRET", startedAt: 1_200, endedAt: 1_700,
    outcome: "done", model: "gpt-test", traceId: "TRACE_SECRET", providerConversationId: "PROVIDER_SECRET",
    providerTurnId: "PROVIDER_TURN_SECRET", mode: "fresh", cumulativeTotalTokens: 15, inputTokens: 10, outputTokens: 5 });
  log.ingestCodexInvocation({ linearSessionId: "session-1", turnId: turn.id, sourceKey: "invocation-child",
    role: "implementer", prompt: "CHILD_PROMPT_SECRET", startedAt: 1_400,
    model: "gpt-test", traceId: "CHILD_TRACE_SECRET", inputTokens: 7, cacheReadTokens: 3 });
  log.stageExternalUrl("session-1", "planner", "Linear issue", "https://linear.example/acme/issue/ENG-42/exact-title", 1_800);
  log.stageExternalUrl("session-1", "planner", "Artifact bundle", "https://artifacts.example/bundle/exact-one", 1_810);
  log.append({ deliveryId: "secret-delivery-2", app: "implementer", action: "created", agentSessionId: "session-2",
    issueId: "issue-id-2", issueIdentifier: "ENG-99", receivedAt: 1_820,
    rawBody: Buffer.from('{"authorization":"SECOND_RAW_SECRET"}') });
  log.setProviderState("claude", "ready", null, 1_900);
  log.scheduleOperation({ id: "operation-1", requestDigest: "a".repeat(64), type: "restart", reason: "routine", requestedAt: 1_950 });
  log.upsertDependencyObservation({ kind: "mcp", name: "linear", configured: true, status: "healthy", reasonCode: null,
    capabilities: { toolCount: 17, truncated: false }, observedAt: 1_900, staleAfterMs: 1_000 });
  for (const [kind, name] of [["mcp", "playwright"], ["mcp", "xcodebuildmcp"], ["harness", "claudex"]] as const)
    log.upsertDependencyObservation({ kind, name, configured: false, status: "disabled", reasonCode: "disabled", observedAt: 1_900, staleAfterMs: 1_000 });
  log.upsertDependencyObservation({ kind: "harness", name: "claude", configured: true, status: "healthy", reasonCode: null,
    observedAt: 1_900, staleAfterMs: 1_000 });
}

describe("console HTTP server", () => {
  it("cancels every streamed response body after observing repeated daemon health statuses", async () => {
    const bodyClosed: Array<Promise<void>> = [];
    let requestCount = 0;
    const healthServer = createServer((_request, response) => {
      bodyClosed.push(new Promise(resolveClose => response.once("close", resolveClose)));
      const status = requestCount++ === 1 ? 503 : 200;
      response.writeHead(status, { "Content-Type": "application/octet-stream" });
      response.write("health-status-observed-but-body-remains-open");
    });
    await new Promise<void>((resolveListen, reject) => {
      healthServer.once("error", reject);
      healthServer.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const port = (healthServer.address() as AddressInfo).port;
      const results: boolean[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1)
        results.push(await probeDaemon(`http://127.0.0.1:${port}/healthz`, 1_000));
      expect(results).toEqual([true, false, true]);
      expect(bodyClosed).toHaveLength(3);
      await Promise.all(bodyClosed);
    } finally {
      healthServer.closeAllConnections();
      await new Promise<void>(resolveClose => healthServer.close(() => resolveClose()));
    }
  });

  it("loads console-only defaults without daemon credentials and rejects unsafe listener settings", () => {
    expect(loadConsoleConfig({ DB_PATH: "/tmp/console.db" })).toMatchObject({ port: 8790, bindAddr: "127.0.0.1",
      dbPath: "/tmp/console.db", daemonHealthUrl: "http://127.0.0.1:8787/healthz" });
    expect(() => loadConsoleConfig({ CONSOLE_BIND_ADDR: "0.0.0.0" })).toThrow("must be 127.0.0.1");
    expect(() => loadConsoleConfig({ CONSOLE_DAEMON_HEALTH_URL: "http://localhost:8787/healthz" })).toThrow("http://127.0.0.1");
  });
  it("binds only IPv4 loopback and serves read APIs plus local compiled assets", async () => {
    const { server, log } = setup(); const address = await server.listen();
    expect(address.address).toBe("127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true, observedAt: 2000 });
    expect(await (await fetch(`${base}/api/overview`)).json()).toMatchObject({ daemon: { status: "online", observedAt: 2000 }, recentRuns: [] });
    expect(await (await fetch(`${base}/assets/app.js`)).text()).toContain("local");
    expect(await (await fetch(`${base}/runs/one`)).text()).toContain("Orchestra Console");
    await expectJsonError(await fetch(`${base}/assets/missing.js`), 404,
      { error: { code: "not_found", message: "asset not found" } });
    await expectJsonError(await fetch(`${base}/%2e%2e%2fsecret.txt`), 404,
      { error: { code: "not_found", message: "asset not found" } });
    await server.close(); log.close();
  });

  it("returns a bounded unavailable skills DTO when the installed manifest is missing", async () => {
    const { server, log, config } = setup(); rmSync(config.skillInventoryPath);
    const address = await server.listen();
    expect(await (await fetch(`http://127.0.0.1:${address.port}/api/skills`)).json()).toEqual({
      availability: "unavailable", reasonCode: "missing", sourceRevision: null, sources: [], skills: [],
    });
    await server.close(); log.close();
  });

  it("logs bounded request context for successful Phase 2 reads without query, header, or raw caller details", async () => {
    const { server, log, logger } = setup(); const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/dependencies?query=QUERY_SECRET`, {
      headers: { "X-Request-Secret": "HEADER_SECRET" },
    })).status).toBe(200);
    expect((await fetch(`${base}/api/skills?token=TOKEN_SECRET`, {
      headers: { Authorization: "Bearer AUTH_SECRET" },
    })).status).toBe(200);
    const records = logger.log.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records).toEqual([
      { event: "console_api_request", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), caller: "loopback",
        method: "GET", path: "/api/dependencies", status: 200 },
      { event: "console_api_request", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), caller: "loopback",
        method: "GET", path: "/api/skills", status: 200 },
    ]);
    expect(records[0]!.requestId).not.toBe(records[1]!.requestId);
    const serialized = JSON.stringify(records);
    for (const sentinel of ["QUERY_SECRET", "HEADER_SECRET", "TOKEN_SECRET", "AUTH_SECRET", "Bearer",
      "Authorization", "query", "headers", "host", "origin", "127.0.0.1", "/Users/"])
      expect(serialized).not.toContain(sentinel);
    await server.close(); log.close();
  });

  it("rejects an in-root static symlink whose real target escapes the assets root", async () => {
    const { server, log, config, dir } = setup();
    const secret = join(dir, "outside-secret.txt"); writeFileSync(secret, "OUTSIDE_ASSET_SECRET");
    symlinkSync(secret, join(config.assetsDir, "leak.txt"));
    const address = await server.listen();
    const response = await fetch(`http://127.0.0.1:${address.port}/leak.txt`);
    const body = await response.text();
    expect(response.status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: { code: "not_found", message: "asset not found" } });
    expect(body).not.toContain("OUTSIDE_ASSET_SECRET");
    await server.close(); log.close();
  });

  it("survives an external-symlink replacement at the validated pre-open asset seam", async () => {
    let outsideSecret = ""; let replaced = false;
    const { server, log, dir } = setup(async () => true, canonicalPath => {
      if (replaced || !canonicalPath.endsWith("/assets/app.js")) return;
      replaced = true; writeFileSync(outsideSecret, "PRE_OPEN_OUTSIDE_SECRET");
      rmSync(canonicalPath); symlinkSync(outsideSecret, canonicalPath);
    });
    outsideSecret = join(dir, "outside-pre-open-secret.txt");
    const address = await server.listen(); const base = `http://127.0.0.1:${address.port}`;
    const assetResponse = await fetch(`${base}/assets/app.js`); const body = await assetResponse.text();
    expect(assetResponse.status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: { code: "not_found", message: "asset not found" } });
    expect(body).not.toContain("PRE_OPEN_OUTSIDE_SECRET");
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true, observedAt: 2_000 });
    await server.close(); log.close();
  });

  it("projects populated SQLite overview, runs, detail, links, and invocation timelines through real HTTP", async () => {
    const { server, log } = setup(); populate(log); const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const overviewResponse = await fetch(`${base}/api/overview`);
    const runsResponse = await fetch(`${base}/api/runs`);
    const detailResponse = await fetch(`${base}/api/runs/session-1`);
    const unlinkedResponse = await fetch(`${base}/api/runs/session-2`);
    const dependenciesResponse = await fetch(`${base}/api/dependencies`); const skillsResponse = await fetch(`${base}/api/skills`);
    expect([overviewResponse.status, runsResponse.status, detailResponse.status, unlinkedResponse.status,
      dependenciesResponse.status, skillsResponse.status]).toEqual([200, 200, 200, 200, 200, 200]);
    const overviewText = await overviewResponse.text(); const overview = JSON.parse(overviewText) as any;
    const runsText = await runsResponse.text(); const runs = JSON.parse(runsText) as any;
    const detailText = await detailResponse.text(); const detail = JSON.parse(detailText) as any;
    const unlinkedText = await unlinkedResponse.text(); const unlinked = JSON.parse(unlinkedText) as any;
    const dependenciesText = await dependenciesResponse.text(); const dependencies = JSON.parse(dependenciesText) as any;
    const skillsText = await skillsResponse.text(); const skills = JSON.parse(skillsText) as any;
    expect(overview).toMatchObject({ observedAt: 2_000, daemon: { status: "online", observedAt: 2_000 }, activeRuns: 2,
      providers: [{ provider: "claude", status: "ready", reason: null, cooldownUntil: null, updatedAt: 1_900 }],
      operations: { pending: { id: "operation-1", type: "restart", state: "pending" } },
      dependencies: { status: "healthy", configured: 2, total: 5 } });
    expect(overview.recentRuns).toHaveLength(2);
    expect(runs.runs).toHaveLength(2);
    expect(runs.runs.find((run: any) => run.id === "session-1")).toMatchObject({ issueIdentifier: "ENG-42",
      invocationCount: 2, totalTokens: 15, resources: [
        { label: "Linear issue", url: "https://linear.example/acme/issue/ENG-42/exact-title" },
        { label: "Artifact bundle", url: "https://artifacts.example/bundle/exact-one" },
      ] });
    expect(detail).toMatchObject({ id: "session-1", invocationCount: 2, totalTokens: 15,
      resources: [
        { label: "Linear issue", url: "https://linear.example/acme/issue/ENG-42/exact-title" },
        { label: "Artifact bundle", url: "https://artifacts.example/bundle/exact-one" },
      ],
      invocations: [
        { id: expect.any(Number), role: "code-researcher", runtime: "codex", model: "gpt-test",
          startedAt: 1_200, endedAt: 1_700, durationMs: 500, state: "terminal", outcome: "done",
          usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: null, cacheReadTokens: null, totalTokens: 15 } },
        { id: expect.any(Number), role: "implementer", runtime: "codex", model: "gpt-test",
          startedAt: 1_400, endedAt: null, durationMs: 600, state: "active", outcome: null,
          usage: { inputTokens: 7, outputTokens: null, cacheCreationTokens: null, cacheReadTokens: 3, totalTokens: 10 } },
      ] });
    expect(unlinked).toMatchObject({ id: "session-2", issueIdentifier: "ENG-99", resources: [] });
    expect(dependencies).toMatchObject({ status: "healthy", daemon: { status: "online" }, dependencies: [
      { kind: "mcp", name: "linear", configured: true, status: "healthy", capabilities: { toolCount: 17, truncated: false } },
      { kind: "mcp", name: "playwright", configured: false, status: "disabled" },
      { kind: "mcp", name: "xcodebuildmcp", configured: false, status: "disabled" },
      { kind: "harness", name: "claude", configured: true, status: "healthy" },
      { kind: "harness", name: "claudex", configured: false, status: "disabled" },
    ] });
    expect(skills).toMatchObject({ availability: "available", sourceRevision: "a".repeat(40), skills: [
      { name: "implementer", description: "Implements a bounded plan.", version: null,
        provenance: ["Claude Code", "Codex"], compatibility: ["claude", "codex"] },
    ] });
    const serialized = [overviewText, runsText, detailText, unlinkedText, dependenciesText, skillsText].join("\n");
    for (const secret of ["RAW_WEBHOOK_SECRET", "SECOND_RAW_SECRET", "PROMPT_SECRET", "REPORT_SECRET", "TRACE_SECRET",
      "PROVIDER_SECRET", "PROVIDER_TURN_SECRET", "CHILD_PROMPT_SECRET", "CHILD_TRACE_SECRET", "secret-delivery"])
      expect(serialized).not.toContain(secret);
    for (const forbidden of ["prompt", "report", "rawBody", "worktreePath", "claudeSessionId", "traceId",
      "providerConversationId", "providerTurnId", "webhookSecret", "staticToken", "linearApiKey"])
      expect(serialized).not.toContain(`\"${forbidden}\"`);
    for (const forbidden of ["Authorization", "Bearer", "inputSchema", "environment", "absolutePath", "/Users/"])
      expect(serialized).not.toContain(forbidden);
    await server.close(); log.close();
  });

  it("rejects invalid Host, hostile Origin, unsupported methods, and mutation routes", async () => {
    const { server, log, config } = setup(); const address = await server.listen(); const base = `http://127.0.0.1:${address.port}`;
    const dbBefore = readFileSync(config.dbPath); const skillsBefore = readFileSync(config.skillInventoryPath);
    expect(await requestWithHost(address.port, "evil.example")).toEqual({ status: 403,
      body: { error: { code: "forbidden", message: "untrusted host or origin" } } });
    await expectJsonError(await fetch(`${base}/api/overview`, { headers: { Origin: "https://evil.example" } }), 403,
      { error: { code: "forbidden", message: "untrusted host or origin" } });
    await expectJsonError(await fetch(`${base}/api/overview`, { headers: { Origin: `http://localhost:${address.port}` } }), 403,
      { error: { code: "forbidden", message: "untrusted host or origin" } });
    await expectJsonError(await fetch(`${base}/api/overview`, { method: "POST" }), 405,
      { error: { code: "method_not_allowed", message: "read-only endpoint" } });
    await expectJsonError(await fetch(`${base}/api/operations`, { method: "POST" }), 405,
      { error: { code: "method_not_allowed", message: "read-only endpoint" } });
    await expectJsonError(await fetch(`${base}/api/mutate`), 404,
      { error: { code: "not_found", message: "endpoint not found" } });
    await expectJsonError(await fetch(`${base}/api/runs/missing`), 404,
      { error: { code: "not_found", message: "run not found" } });
    await expectJsonError(await fetch(`${base}/api/runs/%`), 400,
      { error: { code: "bad_request", message: "invalid run id" } });
    const mutationGuesses = [
      ["configuration", "/api/config"],
      ["credentials", "/api/credentials"],
      ["enablement", "/api/dependencies/enable"],
      ["disablement", "/api/dependencies/disable"],
      ["refresh", "/api/dependencies/refresh"],
      ["execution", "/api/dependencies/execute"],
      ["skill editing", "/api/skills/implementer/edit"],
    ] as const;
    for (const [family, path] of mutationGuesses) {
      await expectJsonError(await fetch(`${base}${path}`), 404,
        { error: { code: "not_found", message: "endpoint not found" } });
      await expectJsonError(await fetch(`${base}${path}`, { method: "POST", body: family }), 405,
        { error: { code: "method_not_allowed", message: "read-only endpoint" } });
    }
    for (const path of ["/api/dependencies", "/api/skills"])
      await expectJsonError(await fetch(`${base}${path}`, { method: "POST" }), 405,
        { error: { code: "method_not_allowed", message: "read-only endpoint" } });
    expect(readFileSync(config.dbPath)).toEqual(dbBefore);
    expect(readFileSync(config.skillInventoryPath)).toEqual(skillsBefore);
    await server.close(); log.close();
  });

  it("keeps signed webhook ingress and daemon health available while a degraded console is stopped independently", async () => {
    const { server: consoleServer, log, dir } = setup(async () => false);
    const cliproxyEnvFile = join(dir, "cliproxy.env"); writeFileSync(cliproxyEnvFile, "CLIPROXY_MANAGEMENT_KEY=management-secret\n");
    const webhookConfig = { port: 0, bindAddr: "127.0.0.1", dbPath: join(dir, "events.db"), replayWindowMs: 60_000,
      dispatchQuarantineDir: join(dir, "quarantine"), dispatchQuarantineAgeMs: 86_400_000,
      linearGraphqlUrl: "http://unused", linearTokenUrl: "http://unused", cliproxyEnvFile,
      apps: { planner: { name: "planner", webhookSecret: "planner-secret", staticToken: "p" },
        implementer: { name: "implementer", webhookSecret: "implementer-secret", staticToken: "i" } } } as Config;
    const webhookServer = new WebhookServer({ config: webhookConfig, log, logger: { log: vi.fn(), error: vi.fn() } });
    const webhookAddress = await webhookServer.listen(); const consoleAddress = await consoleServer.listen();
    const webhookBase = `http://127.0.0.1:${webhookAddress.port}`;
    const consoleBase = `http://127.0.0.1:${consoleAddress.port}`;
    expect(await (await fetch(`${consoleBase}/api/overview`)).json()).toMatchObject({ daemon: { status: "offline" } });
    expect(await (await fetch(`${webhookBase}/healthz`)).json()).toMatchObject({ ok: true });
    await expectJsonError(await fetch(`${webhookBase}/api/overview`), 404, { error: "not_found" });
    await expectJsonError(await fetch(`${webhookBase}/api/runs`), 404, { error: "not_found" });
    const sendSigned = async (delivery: string) => {
      const body = JSON.stringify({ webhookTimestamp: Date.now(), action: "created", agentSession: { id: delivery } });
      const signature = createHmac("sha256", "planner-secret").update(body).digest("hex");
      const response = await fetch(`${webhookBase}/webhook/planner`, { method: "POST",
        headers: { "Linear-Signature": signature, "Linear-Delivery": delivery }, body });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    };
    await sendSigned("before-console-stop");
    await consoleServer.close();
    expect(await (await fetch(`${webhookBase}/healthz`)).json()).toMatchObject({ ok: true });
    await sendSigned("after-console-stop");
    expect(log.count()).toBe(2);
    await webhookServer.close(); log.close();
  });

  it.each([
    ["refused", async () => false],
    ["rejected", async () => { throw new Error("refused"); }],
  ])("keeps the console available when the daemon probe is %s", async (_name, probe) => {
    const { server, log } = setup(probe); const address = await server.listen();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/overview`);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ daemon: { status: "offline", observedAt: 2000 } });
    await server.close(); log.close();
  });

  it("bounds a stalled daemon probe and returns a degraded snapshot", async () => {
    const { server, log } = setup(() => new Promise<boolean>(() => {})); const address = await server.listen();
    const started = Date.now(); const response = await fetch(`http://127.0.0.1:${address.port}/api/overview`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(await response.json()).toMatchObject({ daemon: { status: "offline", observedAt: 2000 } });
    await server.close(); log.close();
  });
});
