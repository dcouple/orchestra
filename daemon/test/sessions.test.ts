import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import type {
  LinearGateway,
  PostResult,
  ProgressContent,
  TerminalContent,
} from "../src/linear.js";
import { WebhookServer } from "../src/server.js";
import {
  ProviderReadinessPoller,
  SessionWorker,
  classifyProviderFailure,
  selectSessionProfile,
} from "../src/sessions.js";
import { OtlpRelay } from "../src/otel-relay.js";
import { resolveOtlpTraces } from "../src/otel.js";
import {
  readCliproxyApiKey,
  readCliproxyManagementKey,
} from "../src/proxy-env.js";
const dirs: string[] = [];
const oldMode = process.env.CLAUDE_FAKE_MODE;
const oldArgs = process.env.CLAUDE_FAKE_ARGS_FILE;
const oldEnv = process.env.CLAUDE_FAKE_ENV_FILE;
const oldDelay = process.env.CLAUDE_FAKE_DELAY_MS;
const oldDispatchOwner = process.env.ORCHESTRA_DISPATCH_OWNER;
const ownerOne = "a0000000-0000-0000-0000-000000000001";
const ownerTwo = "a0000000-0000-0000-0000-000000000002";
const otelTestKeys = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SERVICE_NAME",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_X",
] as const;
const oldOtelEnv = Object.fromEntries(
  otelTestKeys.map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  if (oldMode === undefined) delete process.env.CLAUDE_FAKE_MODE;
  else process.env.CLAUDE_FAKE_MODE = oldMode;
  if (oldArgs === undefined) delete process.env.CLAUDE_FAKE_ARGS_FILE;
  else process.env.CLAUDE_FAKE_ARGS_FILE = oldArgs;
  if (oldEnv === undefined) delete process.env.CLAUDE_FAKE_ENV_FILE;
  else process.env.CLAUDE_FAKE_ENV_FILE = oldEnv;
  if (oldDelay === undefined) delete process.env.CLAUDE_FAKE_DELAY_MS;
  else process.env.CLAUDE_FAKE_DELAY_MS = oldDelay;
  if (oldDispatchOwner === undefined)
    delete process.env.ORCHESTRA_DISPATCH_OWNER;
  else process.env.ORCHESTRA_DISPATCH_OWNER = oldDispatchOwner;
  for (const key of otelTestKeys) {
    if (oldOtelEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldOtelEnv[key];
  }
});
function git(args: string[], cwd?: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  dirs.push(dir);
  const seed = join(dir, "seed"),
    origin = join(dir, "origin.git"),
    repo = join(dir, "repo");
  mkdirSync(seed);
  git(["init", "-b", "main"], seed);
  git(["config", "user.email", "test@example.com"], seed);
  git(["config", "user.name", "Test"], seed);
  git(["commit", "--allow-empty", "-m", "initial"], seed);
  git(["clone", "--bare", seed, origin]);
  git(["clone", origin, repo]);
  const log = new EventLog(join(dir, "events.db"));
  const config: Config = {
    port: 0,
    bindAddr: "127.0.0.1",
    dbPath: join(dir, "events.db"),
    dispatchQuarantineDir: join(dir, "dispatch-quarantine"),
    dispatchQuarantineAgeMs: 86_400_000,
    replayWindowMs: 60_000,
    linearGraphqlUrl: "http://unused",
    linearTokenUrl: "http://unused",
    linearMcpUrl: "https://mcp.linear.app/mcp",
    linearMcpMonitorIntervalMs: 60_000,
    linearMcpMonitorTimeoutMs: 10_000,
    apps: {
      planner: {
        name: "planner",
        harness: "claude",
        webhookSecret: "p",
        staticToken: "p",
      },
      implementer: {
        name: "implementer",
        harness: "claude",
        webhookSecret: "i",
        staticToken: "i",
      },
    },
    sessionsEnabled: true,
    worktreesRoot: join(dir, "trees"),
    targetRepoPath: repo,
    claudeArgv: [process.execPath, resolve("test/fixtures/fake-claude.mjs")],
    fableArgv: [process.execPath, resolve("test/fixtures/fake-claude.mjs")],
    claudePermissionMode: "plan",
    claudeMaxTurns: 5,
    bashDefaultTimeoutMs: 900_000,
    bashMaxTimeoutMs: 900_000,
    cliproxyEnvFile: join(dir, "proxy.env"),
    cliproxyUrl: "http://127.0.0.1:1",
    providerProbeIntervalMs: 60_000,
    providerStateStaleMs: 300_000,
    providerInitialProbeTimeoutMs: 5000,
    doPermissionMode: "plan",
    doMaxTurns: 50,
    doMaxBudgetUsd: 10,
    sessionConcurrency: 2,
    keepaliveMs: 30,
    linearApiKey: "linear-key",
    attachmentsEnabled: false,
    attachmentHosts: ["uploads.linear.app"],
  };
  writeFileSync(
    config.cliproxyEnvFile,
    "CLIPROXY_API_KEY=api-key-one\nCLIPROXY_MANAGEMENT_KEY=management-key\n",
  );
  return { dir, log, config };
}
class Poster {
  posts: Array<{
    app: string;
    session: string;
    content: ProgressContent | TerminalContent;
    ephemeral: boolean;
    at: number;
  }> = [];
  urls: Array<{ app: string; session: string; label: string; url: string }> =
    [];
  failures = 0;
  urlFailures = 0;
  async postActivity(
    _app: string,
    session: string,
    _id: string,
    content: ProgressContent | TerminalContent,
    ephemeral: boolean,
  ): Promise<PostResult> {
    this.posts.push({ app: _app, session, content, ephemeral, at: Date.now() });
    if (!ephemeral && this.failures-- > 0)
      return { ok: false, retriable: true, error: "temporary" };
    return { ok: true };
  }
  async setSessionExternalUrl(
    app: string,
    session: string,
    label: string,
    url: string,
  ): Promise<PostResult> {
    if (this.urlFailures-- > 0)
      return { ok: false, retriable: true, error: "temporary url failure" };
    this.urls.push({ app, session, label, url });
    return { ok: true };
  }
}
class CapturingLogger {
  lines: string[] = [];
  log(...args: unknown[]): void {
    this.lines.push(String(args[0]));
  }
  error(...args: unknown[]): void {
    this.lines.push(String(args[0]));
  }
  entries(): Array<Record<string, unknown>> {
    return this.lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
  }
}
function activityBody(
  content: ProgressContent | TerminalContent | undefined,
): string | undefined {
  return content && "body" in content ? content.body : undefined;
}
function append(
  log: EventLog,
  delivery: string,
  session: string,
  action: "created" | "prompted",
  issue = "issue-uuid",
  identifier = "ENG-42",
) {
  const raw =
    action === "created"
      ? {
          action,
          promptContext: "Help plan this",
          agentSession: { id: session, issue: { id: issue, identifier } },
        }
      : {
          action,
          agentActivity: { body: "follow up" },
          agentSession: { id: session },
        };
  log.append({
    deliveryId: delivery,
    app: "planner",
    action,
    agentSessionId: session,
    ...(action === "created"
      ? { issueId: issue, issueIdentifier: identifier }
      : {}),
    receivedAt: Date.now(),
    rawBody: Buffer.from(JSON.stringify(raw)),
  });
}
function appendImplementer(
  log: EventLog,
  delivery: string,
  session: string,
  issue = "issue-uuid",
  identifier = "ENG-42",
) {
  log.append({
    deliveryId: delivery,
    app: "implementer",
    action: "created",
    agentSessionId: session,
    issueId: issue,
    issueIdentifier: identifier,
    receivedAt: Date.now(),
    rawBody: Buffer.from(
      JSON.stringify({
        action: "created",
        agentSession: { id: session, issue: { id: issue, identifier } },
      }),
    ),
  });
}
function setTurnsStatus(
  dbPath: string,
  status: "done" | "deleted",
): void {
  const db = new Database(dbPath);
  try {
    if (status === "done")
      db.prepare(
        "UPDATE turns SET status='done' WHERE status IN ('pending','running','awaiting_activity')",
      ).run();
    else db.prepare("DELETE FROM turns").run();
  } finally {
    db.close();
  }
}
function dispatchFixture(
  worktree: string,
  owner: string,
  basename: string,
): { directory: string; files: string[] } {
  const directory = join(worktree, ".codex-dispatches", owner);
  const files = [
    `${basename}.done`,
    `${basename}.prompt`,
    `${basename}.md`,
    `${basename}.log`,
    `${basename}.sh`,
  ];
  mkdirSync(directory, { recursive: true });
  for (const file of files)
    writeFileSync(
      join(directory, file),
      file.endsWith(".done") ? "0\n" : `${file}\n`,
    );
  return { directory, files };
}
function turnUsage(dbPath: string, id = 1): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT status, usage_input_tokens inputTokens, usage_output_tokens outputTokens,
      usage_cache_creation_tokens cacheCreationTokens, usage_cache_read_tokens cacheReadTokens,
      cost_usd costUsd, model FROM turns WHERE id=?`,
      )
      .get(id) as Record<string, unknown>;
  } finally {
    db.close();
  }
}
async function waitFor(
  predicate: () => boolean,
  timeout = 4000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function capturedTurnEnv(
  endpoint: "base" | "traces" | "none",
  baseAttributes?: string,
  session = "linear-session",
): Promise<Record<string, string>> {
  const { dir, log, config } = setup();
  const poster = new Poster();
  process.env.CLAUDE_FAKE_ENV_FILE = join(dir, "env.jsonl");
  for (const key of otelTestKeys) delete process.env[key];
  if (endpoint === "base")
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1/otel";
  if (endpoint === "traces")
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "http://127.0.0.1:1/otel/v1/traces";
  if (baseAttributes !== undefined)
    process.env.OTEL_RESOURCE_ATTRIBUTES = baseAttributes;
  const upstream = resolveOtlpTraces(process.env);
  const relay = upstream
    ? new OtlpRelay({
        endpoint: upstream.endpoint,
        headers: upstream.headers,
        quietMs: 5,
      })
    : undefined;
  await relay?.start();
  append(log, `otel-${endpoint}`, session, "created");
  const worker = new SessionWorker(
    log,
    poster as unknown as LinearGateway,
    config,
    { pollMs: 10, reconcileMs: 20, ...(relay ? { relay } : {}) },
  );
  worker.start();
  await waitFor(() => log.turnStates()[0]?.status === "done");
  await worker.stop();
  await relay?.close();
  log.close();
  const row = JSON.parse(
    readFileSync(process.env.CLAUDE_FAKE_ENV_FILE, "utf8").trim(),
  ) as { env: Record<string, string> };
  return row.env;
}
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function healthy(port: number, child: ChildProcess): Promise<void> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (child.exitCode !== null)
      throw new Error(`child exited ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("child health timed out");
}

describe("SessionWorker", () => {
  it("reads only exact proxy credential assignments with redacted failures", async () => {
    const { dir } = setup();
    const path = join(dir, "exact-proxy.env");
    writeFileSync(
      path,
      "NOT_CLIPROXY_API_KEY=wrong\nexport CLIPROXY_API_KEY='api-key'\nCLIPROXY_MANAGEMENT_KEY=\"management-key\" # current\n",
    );
    await expect(readCliproxyApiKey(path)).resolves.toBe("api-key");
    await expect(readCliproxyManagementKey(path)).resolves.toBe(
      "management-key",
    );
    writeFileSync(path, "CLIPROXY_MANAGEMENT_KEY=management-key\n");
    await expect(readCliproxyApiKey(path)).rejects.toThrow(
      "proxy_api_key_missing",
    );
    await expect(readCliproxyApiKey(join(dir, "missing.env"))).rejects.toThrow(
      "proxy_env_unreadable",
    );
  });
  it("relaunches a browser-required /do once and keeps non-browser turns Linear-only", async () => {
    const { log, config, dir } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_MODE = "browser-relaunch";
    process.env.CLAUDE_FAKE_ENV_FILE = join(dir, "browser-env.jsonl");
    Object.assign(config, { browserEnabled: true, playwrightMcpBin: process.execPath, playwrightChromeBin: process.execPath,
      browserAttemptTimeoutMs: 5000, artifactsDir: join(dir, "artifacts") });
    appendImplementer(log, "browser", "browser-session");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => ["done", "failed"].includes(log.turnStates()[0]?.status ?? ""));
    expect(log.turnStates()[0]?.status, JSON.stringify(logger.entries())).toBe("done");
    expect(log.getSession("browser-session")).toMatchObject({ browserRequired: 1, browserRunId: expect.any(String) });
    const rows = readFileSync(process.env.CLAUDE_FAKE_ENV_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line).env);
    expect(rows).toHaveLength(2);
    expect(rows[0].ORCHESTRA_BROWSER_REQUEST_FILE).toBeTruthy();
    expect(rows[0].ORCHESTRA_BROWSER_EVIDENCE_DIR).toBeUndefined();
    expect(rows[1]).toMatchObject({ ORCHESTRA_BROWSER_RUN_ID: expect.any(String), ORCHESTRA_BROWSER_ATTEMPT_ID: expect.stringMatching(/^attempt-/) });
    expect(rows[1].ORCHESTRA_BROWSER_REQUEST_FILE).toBeUndefined();
    expect(existsSync(rows[1].ORCHESTRA_BROWSER_STATE_DIR)).toBe(false);
    expect(existsSync(rows[1].ORCHESTRA_BROWSER_EVIDENCE_DIR)).toBe(true);
    expect(logger.entries().filter(entry => entry.event === "browser_relaunch_required")).toHaveLength(1);
    await worker.stop(); log.close();
  });
  it.each([["crash", 5000], ["hang", 40]])("removes browser state but retains evidence after %s", async (mode, timeout) => {
    const { log, config, dir } = setup(); const poster = new Poster();
    process.env.CLAUDE_FAKE_MODE = mode; process.env.CLAUDE_FAKE_ENV_FILE = join(dir, `${mode}-env.jsonl`);
    Object.assign(config, { browserEnabled: true, playwrightMcpBin: process.execPath, playwrightChromeBin: process.execPath,
      browserAttemptTimeoutMs: timeout, artifactsDir: join(dir, "artifacts") });
    appendImplementer(log, mode, `${mode}-session`); log.requireBrowser(`${mode}-session`, `${mode}-run`);
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    const row = JSON.parse(readFileSync(process.env.CLAUDE_FAKE_ENV_FILE, "utf8").trim()).env;
    expect(existsSync(row.ORCHESTRA_BROWSER_STATE_DIR)).toBe(false);
    expect(existsSync(row.ORCHESTRA_BROWSER_EVIDENCE_DIR)).toBe(true);
    if (mode === "hang") expect(activityBody(poster.posts.find(post => !post.ephemeral)?.content)).toContain("timed out");
    await worker.stop(); log.close();
  });
  it("removes browser state after an explicit worker abort", async () => {
    const { log, config, dir } = setup(); const poster = new Poster();
    process.env.CLAUDE_FAKE_MODE = "hang"; process.env.CLAUDE_FAKE_ENV_FILE = join(dir, "abort-env.jsonl");
    Object.assign(config, { browserEnabled: true, playwrightMcpBin: process.execPath, playwrightChromeBin: process.execPath,
      browserAttemptTimeoutMs: 5000, artifactsDir: join(dir, "artifacts") });
    appendImplementer(log, "abort", "abort-session"); log.requireBrowser("abort-session", "abort-run");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    await waitFor(() => existsSync(process.env.CLAUDE_FAKE_ENV_FILE!));
    const row = JSON.parse(readFileSync(process.env.CLAUDE_FAKE_ENV_FILE, "utf8").trim()).env;
    await worker.stop();
    expect(existsSync(row.ORCHESTRA_BROWSER_STATE_DIR)).toBe(false);
    expect(existsSync(row.ORCHESTRA_BROWSER_EVIDENCE_DIR)).toBe(true);
    log.close();
  });
  it("continues durable ingestion while an operation drain blocks every new claim", async () => {
    const { dir, log, config } = setup(); const poster = new Poster();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "drain-args.jsonl"); process.env.CLAUDE_FAKE_MODE = "hang";
    append(log, "running", "session-running", "created", "issue-running", "OPS-1");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10 }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "running");
    log.scheduleOperation({ id: "operation", requestDigest: "a".repeat(64), type: "restart", reason: "test drain" });
    append(log, "queued", "session-queued", "created", "issue-queued", "OPS-2"); worker.trigger();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(log.turnStates().find(turn => turn.issueId === "issue-queued")?.status).toBe("pending");
    await worker.stop();
    log.cancelOperation("operation");
    process.env.CLAUDE_FAKE_MODE = "happy";
    const resumed = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10 }); resumed.start();
    await waitFor(() => log.turnStates().find(turn => turn.issueId === "issue-queued")?.status === "done");
    await resumed.stop(); log.close();
  });
  it("classifies only conservative provider failures", () => {
    const base = {
      ok: false,
      isError: true,
      exitCode: 1,
      signal: null,
      permissionDenials: [],
      sawResult: false,
    } as const;
    expect(
      classifyProviderFailure({ ...base, spawnError: "spawn ECONNREFUSED" }),
    ).toMatchObject({ reason: "spawn_econnrefused" });
    expect(
      classifyProviderFailure({
        ...base,
        stderrTail: "HTTP 403 from base URL",
      }),
    ).toMatchObject({ state: "auth_failure", reason: "http_403" });
    expect(
      classifyProviderFailure({ ...base, stderrTail: "ordinary model error" }),
    ).toBeUndefined();
  });
  it("probes readiness and selects Fable only for fresh ready state without cooldown", async () => {
    const { log, config } = setup();
    config.fableArgv = ["fable"];
    const logger = new CapturingLogger();
    await new ProviderReadinessPoller(log, config, logger, async () => ({
      files: [
        {
          provider: "claude",
          disabled: false,
          failed: false,
          email: "secret@example.com",
        },
      ],
    })).probe(1000);
    expect(selectSessionProfile(log, config, "planner", 1001)).toEqual({
      profile: "fable",
      runtime: "claude",
      reason: "claude_ready",
    });
    expect(logger.entries()[0]).toEqual({
      event: "provider_state_changed",
      provider: "claude",
      status: "ready",
      reason: "eligible_1_failed_0",
      cooldownUntil: null,
    });
    expect(logger.lines.join("\n")).not.toContain("secret@example.com");
    log.setProviderCooldown("claude", 5000, "http_503", 1100);
    expect(selectSessionProfile(log, config, "planner", 1200)).toEqual({
      profile: "sol",
      runtime: "claudex",
      reason: "claude_cooldown",
    });
    log.close();
  });
  it("probes the management auth-files endpoint with the key read from disk", async () => {
    const { log, config } = setup();
    writeFileSync(
      config.cliproxyEnvFile,
      "CLIPROXY_MANAGEMENT_KEY=management-secret\n",
    );
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          files: [{ provider: "claude", disabled: false, failed: true }],
        }),
      );
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    config.cliproxyUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const logger = new CapturingLogger();
    await new ProviderReadinessPoller(log, config, logger).probe(1000);
    expect(authorization).toBe("Bearer management-secret");
    expect(log.getProviderState("claude")).toMatchObject({
      status: "ready",
      reason: "eligible_1_failed_1",
    });
    expect(logger.lines.join("\n")).not.toContain("management-secret");
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    log.close();
  });
  it("times out a stalled readiness fetch and never overlaps interval probes", async () => {
    const { log, config } = setup();
    writeFileSync(
      config.cliproxyEnvFile,
      "CLIPROXY_MANAGEMENT_KEY=management-secret\n",
    );
    config.providerInitialProbeTimeoutMs = 50;
    config.providerProbeIntervalMs = 10;
    let requests = 0;
    let active = 0;
    let maxActive = 0;
    const server = createServer((request) => {
      requests++;
      active++;
      maxActive = Math.max(maxActive, active);
      request.on("close", () => {
        active--;
      });
      // Intentionally never respond: AbortSignal.timeout must release the single-flight probe.
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    config.cliproxyUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const poller = new ProviderReadinessPoller(
      log,
      config,
      new CapturingLogger(),
    );
    const startedAt = Date.now();
    poller.start();
    const inFlight = poller.probe();
    expect(poller.probe()).toBe(inFlight);
    await inFlight;
    poller.stop();
    expect(log.getProviderState("claude")).toMatchObject({
      status: "not_ready",
      reason: "probe_timeout",
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(requests).toBe(1);
    expect(maxActive).toBe(1);
    server.closeAllConnections();
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    log.close();
  });
  it("keeps Fable sticky before and after provider-session establishment", async () => {
    // AC5's pre/post-establishment states cannot both be reached from one webhook payload, so seed them directly.
    const seeded = setup();
    seeded.log.close();
    const log = new EventLog(seeded.config.dbPath, () => ({
      profile: "fable",
      runtime: "claude",
      reason: "claude_ready",
    }));
    const fixtureEmail = "secret@example.com";
    const fixtureKey = "management-secret";
    seeded.config.linearApiKey = fixtureKey;
    writeFileSync(
      seeded.config.cliproxyEnvFile,
      `CLIPROXY_API_KEY=sticky-api-key\nCLIPROXY_MANAGEMENT_KEY=${fixtureKey}\n`,
    );
    const logger = new CapturingLogger();
    await new ProviderReadinessPoller(log, seeded.config, logger, async () => ({
      files: [
        {
          provider: "claude",
          disabled: false,
          failed: false,
          email: fixtureEmail,
        },
      ],
    })).probe();
    seeded.config.fableArgv = [
      process.execPath,
      resolve("test/fixtures/fake-claude.mjs"),
      "--fable-launcher",
    ];
    seeded.config.claudexArgv = [
      ...seeded.config.claudeArgv,
      "--claudex-runtime",
    ];
    process.env.CLAUDE_FAKE_ARGS_FILE = join(seeded.dir, "routing.jsonl");
    process.env.CLAUDE_FAKE_MODE = "provider-fail-pre-id";
    append(log, "fable-created", "fable-session", "created");
    let worker = new SessionWorker(
      log,
      new Poster() as unknown as LinearGateway,
      seeded.config,
      { pollMs: 10, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    await worker.stop();
    expect(log.getSession("fable-session")).toMatchObject({
      profile: "fable",
      runtime: "claude",
      profileFallback: null,
    });
    let starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0].args).toContain("--fable-launcher");
    const firstFailureEntries = logger.entries();
    const classified = firstFailureEntries.find(
      (entry) => entry.event === "provider_failure_classified",
    );
    expect(classified).toEqual({
      event: "provider_failure_classified",
      linearSessionId: "fable-session",
      profile: "fable",
      provider: "claude",
      classifiedState: "transport_failure",
      reason: "connection_refused",
      cooldownUntil: expect.any(Number),
    });
    expect(
      firstFailureEntries.find((entry) => entry.event === "profile_fallback"),
    ).toBeUndefined();

    process.env.CLAUDE_FAKE_MODE = "happy";
    append(
      log,
      "established-created",
      "established-fable",
      "created",
      "issue-2",
      "ENG-43",
    );
    worker = new SessionWorker(
      log,
      new Poster() as unknown as LinearGateway,
      seeded.config,
      { pollMs: 10, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[1]?.status === "done");
    await worker.stop();
    expect(log.getSession("established-fable")).toMatchObject({
      profile: "fable",
      claudeSessionId: "claude-session-1",
    });
    process.env.CLAUDE_FAKE_MODE = "provider-fail-post-id";
    append(
      log,
      "established-prompt",
      "established-fable",
      "prompted",
      "issue-2",
      "ENG-43",
    );
    worker = new SessionWorker(
      log,
      new Poster() as unknown as LinearGateway,
      seeded.config,
      { pollMs: 10, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[2]?.status === "failed");
    await worker.stop();
    expect(log.getSession("established-fable")?.profile).toBe("fable");
    starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts).toHaveLength(3);
    const healthServer = new WebhookServer({
      config: seeded.config,
      log,
      logger,
    });
    const healthAddress = await healthServer.listen();
    const healthBody = await (
      await fetch(`http://127.0.0.1:${healthAddress.port}/healthz`, {
        headers: { Authorization: `Bearer ${fixtureKey}` },
      })
    ).json();
    const routingNames = new Set([
      "session_profile_assigned",
      "provider_state_changed",
      "provider_failure_classified",
      "profile_fallback",
      "profile_launcher_unconfigured",
      "legacy_session_profile_defaulted",
    ]);
    const capturedRoutingEvents = logger
      .entries()
      .filter((entry) => routingNames.has(String(entry.event)));
    expect(
      [...capturedRoutingEvents, healthBody].every((payload) => {
        const serialized = JSON.stringify(payload);
        return (
          !serialized.includes(fixtureEmail) && !serialized.includes(fixtureKey)
        );
      }),
    ).toBe(true);
    await healthServer.close();
    log.close();
  });
  it("classifies only the selected pool when Fable fails before establishment", async () => {
    const seeded = setup();
    seeded.log.close();
    const poster = new Poster();
    const logger = new CapturingLogger();
    const log = new EventLog(seeded.config.dbPath, () => ({
      profile: "fable",
      runtime: "claude",
      reason: "claude_ready",
    }));
    seeded.config.fableArgv = [
      process.execPath,
      resolve("test/fixtures/fake-claude.mjs"),
      "--fable-launcher",
    ];
    seeded.config.claudexArgv = [
      ...seeded.config.claudeArgv,
      "--claudex-runtime",
    ];
    process.env.CLAUDE_FAKE_ARGS_FILE = join(
      seeded.dir,
      "two-provider-failures.jsonl",
    );
    process.env.CLAUDE_FAKE_MODE = "provider-fail-pre-id";
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      seeded.config,
      { pollMs: 10, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    await worker.stop();
    expect(log.getSession("session")).toMatchObject({
      profile: "fable",
      runtime: "claude",
      profileFallback: null,
      claudeSessionId: null,
    });
    expect(log.getProviderState("claude")).toMatchObject({
      status: "cooldown",
      reason: "connection_refused",
    });
    expect(log.getProviderState("codex")).toBeUndefined();
    expect(
      logger
        .entries()
        .filter((entry) => entry.event === "provider_failure_classified"),
    ).toEqual([
      expect.objectContaining({
        linearSessionId: "session",
        profile: "fable",
        provider: "claude",
      }),
    ]);
    expect(
      logger.entries().filter((entry) => entry.event === "profile_fallback"),
    ).toHaveLength(0);
    expect(poster.posts.filter((post) => !post.ephemeral)).toHaveLength(1);
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0].args).toContain("--fable-launcher");
    log.close();
  });
  it("persists Fable for planner and implementer before their first launch", async () => {
    const seeded = setup();
    seeded.log.close();
    const log = new EventLog(seeded.config.dbPath, () => ({
      profile: "fable",
      runtime: "claude",
      reason: "claude_ready",
    }));
    seeded.config.fableArgv = [
      process.execPath,
      resolve("test/fixtures/fake-claude.mjs"),
      "--fable-launcher",
    ];
    process.env.CLAUDE_FAKE_ARGS_FILE = join(seeded.dir, "fable-starts.jsonl");
    process.env.CLAUDE_FAKE_MODE = "happy";
    append(
      log,
      "planner-fable",
      "planner-fable",
      "created",
      "issue-p",
      "ENG-41",
    );
    appendImplementer(
      log,
      "implementer-fable",
      "implementer-fable",
      "issue-i",
      "ENG-42",
    );
    const worker = new SessionWorker(
      log,
      new Poster() as unknown as LinearGateway,
      seeded.config,
      { pollMs: 10 },
    );
    worker.start();
    await waitFor(() =>
      log.turnStates().every((turn) => turn.status === "done"),
    );
    await worker.stop();
    expect(log.getSession("planner-fable")?.profile).toBe("fable");
    expect(log.getSession("implementer-fable")?.profile).toBe("fable");
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts).toHaveLength(2);
    expect(starts.every((row) => row.args.includes("--fable-launcher"))).toBe(
      true,
    );
    log.close();
  });
  it.each(["planner", "implementer"] as const)(
    "starts a directly preferred Claudex %s session and keeps it sticky after config changes",
    async (app) => {
      const seeded = setup();
      seeded.log.close();
      seeded.config.apps[app].harness = "claudex";
      seeded.config.claudexArgv = [
        ...seeded.config.claudeArgv,
        "--claudex-runtime",
      ];
      process.env.CLAUDE_FAKE_ARGS_FILE = join(
        seeded.dir,
        `direct-${app}.jsonl`,
      );
      process.env.CLAUDE_FAKE_MODE = "happy";
      let log: EventLog;
      log = new EventLog(seeded.config.dbPath, (selected) =>
        selectSessionProfile(log, seeded.config, selected),
      );
      if (app === "planner")
        append(log, "created", "direct-session", "created");
      else appendImplementer(log, "created", "direct-session");
      const worker = new SessionWorker(
        log,
        new Poster() as unknown as LinearGateway,
        seeded.config,
        { pollMs: 10 },
      );
      worker.start();
      await waitFor(() => log.turnStates()[0]?.status === "done");
      expect(log.getSession("direct-session")).toMatchObject({
        profile: "sol",
        runtime: "claudex",
      });
      seeded.config.apps[app].harness = "claude";
      log.append({
        deliveryId: "prompted",
        app,
        action: "prompted",
        agentSessionId: "direct-session",
        receivedAt: Date.now(),
        rawBody: Buffer.from(
          JSON.stringify({
            action: "prompted",
            agentActivity: { body: "continue" },
            agentSession: { id: "direct-session" },
          }),
        ),
      });
      worker.trigger();
      await waitFor(() => log.turnStates()[1]?.status === "done");
      await worker.stop();
      const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((row) => row.phase === "start");
      expect(starts).toHaveLength(2);
      expect(
        starts.every((row) => row.args.includes("--claudex-runtime")),
      ).toBe(true);
      expect(starts[1].args).toEqual(
        expect.arrayContaining(["--resume", "claude-session-1"]),
      );
      log.close();
    },
  );
  it("persists Sol and uses the Sol launcher when Claude is cooling down", async () => {
    const seeded = setup();
    seeded.log.close();
    seeded.config.fableArgv = [
      process.execPath,
      resolve("test/fixtures/fake-claude.mjs"),
      "--fable-launcher",
    ];
    seeded.config.claudexArgv = [
      ...seeded.config.claudeArgv,
      "--claudex-runtime",
    ];
    let log: EventLog;
    log = new EventLog(seeded.config.dbPath, (app) =>
      selectSessionProfile(log, seeded.config, app, 1000),
    );
    log.setProviderCooldown("claude", 5000, "http_503", 900);
    process.env.CLAUDE_FAKE_ARGS_FILE = join(seeded.dir, "sol-starts.jsonl");
    process.env.CLAUDE_FAKE_MODE = "happy";
    append(log, "cooldown-created", "sol-session", "created");
    const worker = new SessionWorker(
      log,
      new Poster() as unknown as LinearGateway,
      seeded.config,
      { pollMs: 10 },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    await worker.stop();
    expect(log.getSession("sol-session")?.profile).toBe("sol");
    const start = JSON.parse(
      readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").split("\n")[0]!,
    );
    expect(start.args).toContain("--claudex-runtime");
    log.close();
  });
  it("persists Sol and uses the Sol launcher when Claude is explicitly not ready", async () => {
    const seeded = setup();
    seeded.log.close();
    seeded.config.fableArgv = [
      process.execPath,
      resolve("test/fixtures/fake-claude.mjs"),
      "--fable-launcher",
    ];
    seeded.config.claudexArgv = [
      ...seeded.config.claudeArgv,
      "--claudex-runtime",
    ];
    let log: EventLog;
    log = new EventLog(seeded.config.dbPath, (app) =>
      selectSessionProfile(log, seeded.config, app),
    );
    log.setProviderState(
      "claude",
      "not_ready",
      "no_eligible_claude_failed_0",
      Date.now(),
    );
    process.env.CLAUDE_FAKE_ARGS_FILE = join(
      seeded.dir,
      "not-ready-starts.jsonl",
    );
    process.env.CLAUDE_FAKE_MODE = "happy";
    append(log, "not-ready-created", "not-ready-session", "created");
    const worker = new SessionWorker(
      log,
      new Poster() as unknown as LinearGateway,
      seeded.config,
      { pollMs: 10 },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    await worker.stop();
    expect(log.getSession("not-ready-session")?.profile).toBe("sol");
    const start = JSON.parse(
      readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").split("\n")[0]!,
    );
    expect(start.args).toContain("--claudex-runtime");
    log.close();
  });
  it.each([
    {
      criterion: "AC1",
      status: "ready",
      reason: "eligible_1_failed_0",
      expectedProfile: "fable",
      usesFable: true,
    },
    {
      criterion: "AC3",
      status: "not_ready",
      reason: "no_eligible_claude_failed_0",
      expectedProfile: "sol",
      usesFable: false,
    },
  ])(
    "$criterion signed webhook persists $expectedProfile and launches it",
    async ({ status, reason, expectedProfile, usesFable }) => {
      const seeded = setup();
      seeded.log.close();
      seeded.config.fableArgv = [
        process.execPath,
        resolve("test/fixtures/fake-claude.mjs"),
        "--fable-launcher",
      ];
      seeded.config.claudexArgv = [
        ...seeded.config.claudeArgv,
        "--claudex-runtime",
      ];
      let log: EventLog;
      log = new EventLog(seeded.config.dbPath, (app) =>
        selectSessionProfile(log, seeded.config, app),
      );
      log.setProviderState("claude", status, reason, Date.now());
      process.env.CLAUDE_FAKE_ARGS_FILE = join(
        seeded.dir,
        `webhook-${expectedProfile}.jsonl`,
      );
      process.env.CLAUDE_FAKE_MODE = "happy";
      const worker = new SessionWorker(
        log,
        new Poster() as unknown as LinearGateway,
        seeded.config,
        { pollMs: 10 },
      );
      const server = new WebhookServer({
        config: seeded.config,
        log,
        onInserted: () => worker.trigger(),
        logger: new CapturingLogger(),
      });
      worker.start();
      const address = await server.listen();
      const body = JSON.stringify({
        webhookTimestamp: Date.now(),
        action: "created",
        promptContext: "route me",
        agentSession: {
          id: `webhook-${expectedProfile}`,
          issue: {
            id: `issue-${expectedProfile}`,
            identifier: expectedProfile === "fable" ? "ENG-51" : "ENG-52",
          },
        },
      });
      const signature = createHmac(
        "sha256",
        seeded.config.apps.planner.webhookSecret,
      )
        .update(body)
        .digest("hex");
      expect(
        (
          await fetch(`http://127.0.0.1:${address.port}/webhook/planner`, {
            method: "POST",
            body,
            headers: {
              "Linear-Signature": signature,
              "Linear-Delivery": `delivery-${expectedProfile}`,
            },
          })
        ).status,
      ).toBe(200);
      await waitFor(() => log.turnStates()[0]?.status === "done");
      await worker.stop();
      await server.close();
      expect(log.getSession(`webhook-${expectedProfile}`)?.profile).toBe(
        expectedProfile,
      );
      const start = JSON.parse(
        readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").split("\n")[0]!,
      );
      expect(start.args.includes("--fable-launcher")).toBe(usesFable);
      expect(start.args.includes("--claudex-runtime")).toBe(!usesFable);
      log.close();
    },
  );
  it("fails an established Fable session closed when its launcher is unconfigured", async () => {
    // AC7 requires an already-established Fable row, which a single webhook payload cannot create while FABLE_BIN is unset.
    const seeded = setup();
    seeded.log.close();
    seeded.config.fableArgv = undefined;
    const log = new EventLog(seeded.config.dbPath, () => ({
      profile: "fable",
      runtime: "claude",
      reason: "ready",
    }));
    append(log, "created-fable", "fable-session", "created");
    log.updateClaudeSessionId("fable-session", "established-id");
    const logger = new CapturingLogger();
    const poster = new Poster();
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      seeded.config,
      { pollMs: 10, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    await worker.stop();
    expect(log.getSession("fable-session")).toMatchObject({
      profile: "fable",
      claudeSessionId: "established-id",
    });
    expect(logger.entries()).toContainEqual({
      event: "profile_launcher_unconfigured",
      linearSessionId: "fable-session",
      profile: "fable",
      runtime: "claude",
      launcher: "FABLE_BIN",
    });
    expect(
      poster.posts
        .map((post) => activityBody(post.content))
        .filter(Boolean)
        .join("\n"),
    ).toContain("FABLE_BIN");
    log.close();
  });
  it("stamps encoded Linear correlation attributes when the base OTLP endpoint is configured", async () => {
    const env = await capturedTurnEnv("base", undefined, "linear session,=id");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      "linear.session_id=linear%20session%2C%3Did,linear.issue=ENG-42,turn.id=1",
    );
  });
  it("merges operator resource attributes while daemon correlation keys win", async () => {
    const env = await capturedTurnEnv(
      "base",
      "service.namespace=daemon,linear.session_id=spoofed,linear.issue=wrong,turn.id=999,custom=a=b",
    );
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      "service.namespace=daemon,custom=a=b,linear.session_id=linear-session,linear.issue=ENG-42,turn.id=1",
    );
  });
  it("drops malformed operator resource attributes before appending the daemon stamp", async () => {
    const env = await capturedTurnEnv(
      "base",
      "garbage,linear.session_id = spoof,ok=1,,=bad",
    );
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      "ok=1,linear.session_id=linear-session,linear.issue=ENG-42,turn.id=1",
    );
  });
  it("stamps correlation attributes when only the traces OTLP endpoint is configured", async () => {
    const env = await capturedTurnEnv("traces");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      "linear.session_id=linear-session,linear.issue=ENG-42,turn.id=1",
    );
  });
  it("persists a gated trace context and posts linked turn and response spans", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        received.push(JSON.parse(raw) as Record<string, unknown>);
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    for (const key of otelTestKeys) delete process.env[key];
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const upstream = resolveOtlpTraces(process.env)!;
    const relay = new OtlpRelay({
      endpoint: upstream.endpoint,
      headers: upstream.headers,
      quietMs: 5,
    });
    await relay.start();
    process.env.CLAUDE_FAKE_ENV_FILE = join(dir, "trace-env.jsonl");
    append(log, "trace-gated", "trace-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, relay },
    );
    worker.start();
    await waitFor(
      () => log.turnStates()[0]?.status === "done" && received.length === 1,
    );
    const child = JSON.parse(
      readFileSync(process.env.CLAUDE_FAKE_ENV_FILE, "utf8").trim(),
    ) as { env: Record<string, string> };
    expect(child.env.TRACEPARENT).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const [, traceId, turnSpanId] = child.env.TRACEPARENT!.split("-");
    const db = new Database(config.dbPath, { readonly: true });
    expect(
      db
        .prepare(
          "SELECT trace_id traceId,turn_span_id turnSpanId FROM turns WHERE id=1",
        )
        .get(),
    ).toEqual({ traceId, turnSpanId });
    const rootSpanId = log.getSession("trace-session")!.rootSpanId;
    db.close();
    const resourceSpans = received[0]!.resourceSpans as Array<{
      scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
    }>;
    const [turnSpan] = resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1);
    expect(turnSpan).toMatchObject({
      traceId,
      spanId: turnSpanId,
      parentSpanId: rootSpanId,
      name: "orchestra.turn",
    });
    expect(turnSpan!.attributes).toContainEqual({
      key: "langfuse.observation.output",
      value: { stringValue: "planner answer" },
    });
    await worker.stop();
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log.close();
  });
  it("does not post daemon-authored spans for a stopped gated turn", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    for (const key of otelTestKeys) delete process.env[key];
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.CLAUDE_FAKE_MODE = "slow";
    process.env.CLAUDE_FAKE_DELAY_MS = "1000";
    const upstream = resolveOtlpTraces(process.env)!;
    const relay = new OtlpRelay({
      endpoint: upstream.endpoint,
      headers: upstream.headers,
      quietMs: 5,
    });
    await relay.start();
    append(log, "trace-stopped", "trace-stop-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, relay },
    );
    worker.start();
    await waitFor(
      () =>
        log.turnStates()[0]?.status === "running" &&
        log.getSession("trace-stop-session")?.claudeSessionId ===
          "claude-session-1",
    );
    worker.stopSession("trace-stop-session");
    await waitFor(() => log.turnStates()[0]?.status === "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toBe(0);
    await worker.stop();
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log.close();
  });
  it("keeps terminal delivery healthy when the collector returns HTTP 500", async () => {
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    let terminalAttempted = false;
    class GatedTerminalPoster extends Poster {
      override async postActivity(
        app: string,
        session: string,
        id: string,
        content: { type: string; body: string },
        ephemeral: boolean,
      ): Promise<PostResult> {
        if (!ephemeral) {
          terminalAttempted = true;
          await terminalGate;
        }
        return super.postActivity(app, session, id, content, ephemeral);
      }
    }
    const { log, config } = setup();
    const poster = new GatedTerminalPoster();
    const logger = new CapturingLogger();
    const server = createServer((_request, response) =>
      response.writeHead(500).end("private collector response body"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    for (const key of otelTestKeys) delete process.env[key];
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const upstream = resolveOtlpTraces(process.env)!;
    const relay = new OtlpRelay({
      endpoint: upstream.endpoint,
      headers: upstream.headers,
      quietMs: 5,
    });
    await relay.start();
    append(log, "trace-http-500", "trace-http-500-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger, relay },
    );
    worker.start();
    await waitFor(() => terminalAttempted);
    try {
      expect(log.turnStates()[0]?.status).toBe("awaiting_activity");
    } finally {
      releaseTerminal();
    }
    await waitFor(
      () =>
        log.turnStates()[0]?.status === "done" &&
        logger
          .entries()
          .some((entry) => entry.event === "telemetry_span_post_failed"),
    );
    expect(poster.posts).toContainEqual(
      expect.objectContaining({
        session: "trace-http-500-session",
        ephemeral: false,
        content: { type: "response", body: "planner answer" },
      }),
    );
    expect(logger.entries()).toContainEqual(
      expect.objectContaining({
        event: "session_turn_completed",
        turnId: 1,
        attempts: 1,
      }),
    );
    expect(logger.entries()).toContainEqual({
      event: "telemetry_span_post_failed",
      turnId: 1,
      error: "http 500",
    });
    expect(logger.lines.join("\n")).not.toContain(
      "private collector response body",
    );
    await worker.stop();
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log.close();
  });
  it("AC4: preserves the pre-OTel child environment when telemetry is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = await capturedTurnEnv("none");
    const expectedPrefixes = Object.freeze([
      "LC_",
      "ANTHROPIC_",
      "CLAUDE_",
    ] as const);
    const expectedKeys = Object.freeze([
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "CLIPROXY_API_KEY",
      "BASH_DEFAULT_TIMEOUT_MS",
      "BASH_MAX_TIMEOUT_MS",
      "LINEAR_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      ...Object.keys(process.env).filter((key) =>
        expectedPrefixes.some((prefix) => key.startsWith(prefix)),
      ),
    ]);
    const expected = Object.fromEntries(
      expectedKeys.flatMap((key) => {
        const value =
          key === "LINEAR_API_KEY"
            ? "linear-key"
            : key === "CLIPROXY_API_KEY"
              ? "api-key-one"
              : key === "BASH_DEFAULT_TIMEOUT_MS" ||
                  key === "BASH_MAX_TIMEOUT_MS"
                ? "900000"
                : process.env[key];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    const {
      __CF_USER_TEXT_ENCODING: macOsInjectedEncoding,
      ...daemonControlledEnv
    } = env;
    expect(daemonControlledEnv).toEqual(expected);
    if (process.platform === "darwin")
      expect(macOsInjectedEncoding).toEqual(expect.any(String));
    else expect(macOsInjectedEncoding).toBeUndefined();
    expect(Object.keys(env).filter((key) => key.startsWith("OTEL_"))).toEqual(
      [],
    );
    expect(env.TRACEPARENT).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("reloads the proxy API key between turns and preserves timeout budgets", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const envFile = join(dir, "rotated-env.jsonl");
    process.env.CLAUDE_FAKE_ENV_FILE = envFile;
    append(log, "credential-one", "credential-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    writeFileSync(
      config.cliproxyEnvFile,
      "CLIPROXY_API_KEY=api-key-two\nCLIPROXY_MANAGEMENT_KEY=management-key\n",
    );
    append(log, "credential-two", "credential-session", "prompted");
    worker.trigger();
    await waitFor(() => log.turnStates().length === 2 &&
      log.turnStates().every((turn) => turn.status === "done"));
    await worker.stop();
    const rows = readFileSync(envFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { env: Record<string, string> });
    expect(rows.map((row) => row.env.CLIPROXY_API_KEY)).toEqual([
      "api-key-one",
      "api-key-two",
    ]);
    expect(rows.map((row) => [
      row.env.BASH_DEFAULT_TIMEOUT_MS,
      row.env.BASH_MAX_TIMEOUT_MS,
    ])).toEqual([
      ["900000", "900000"],
      ["900000", "900000"],
    ]);
    log.close();
  });
  it("persists tool boundaries and logs bounded per-turn Linear MCP telemetry", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_MODE = "mcp-telemetry";
    append(log, "mcp-telemetry", "mcp-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    await worker.stop();
    expect(log.openTurnToolCalls(1)).toEqual([]);
    const db = new Database(config.dbPath, { readonly: true });
    expect(
      db.prepare(
        "SELECT tool_use_id toolUseId,tool_name toolName,state FROM turn_tool_calls WHERE turn_id=1 ORDER BY tool_use_id",
      ).all(),
    ).toEqual([
      { toolUseId: "toolu_linear_1", toolName: "mcp__linear__get_issue", state: "completed" },
      { toolUseId: "toolu_read_1", toolName: "Read", state: "completed" },
    ]);
    db.close();
    expect(logger.entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "linear_mcp_turn_init",
          status: "connected",
        }),
        expect.objectContaining({
          event: "linear_mcp_tool_result",
          toolName: "mcp__linear__get_issue",
          outcome: "error",
        }),
        expect.objectContaining({
          event: "linear_mcp_turn_close",
          classification: "turn_completed",
        }),
      ]),
    );
    expect(logger.lines.join("\n")).not.toContain("private-payload");
    expect(logger.lines.join("\n")).not.toContain("private Linear result");
    expect(
      logger.entries().filter((entry) => entry.event === "linear_mcp_turn_close"),
    ).toHaveLength(1);
    log.close();
  });
  it.each([
    ["mcp-runner-failed", "runner_failed"],
    ["mcp-shutdown", "daemon_shutdown"],
  ] as const)(
    "classifies one Linear MCP close as %s context",
    async (mode, classification) => {
      const { log, config } = setup();
      const poster = new Poster();
      const logger = new CapturingLogger();
      process.env.CLAUDE_FAKE_MODE = mode;
      append(log, `close-${mode}`, `close-${mode}-session`, "created");
      const worker = new SessionWorker(
        log,
        poster as unknown as LinearGateway,
        config,
        { pollMs: 10, reconcileMs: 20, logger },
      );
      worker.start();
      if (mode === "mcp-shutdown") {
        await waitFor(() =>
          logger.entries().some(
            (entry) => entry.event === "linear_mcp_turn_init",
          ));
        log.recordRestartIntent("test hard restart");
        await worker.stop("hard_restart");
        expect(log.turnStates()[0]?.status).toBe("running");
        expect(
          logger.entries().filter(
            (entry) => entry.event === "session_turn_deferred",
          ),
        ).toEqual([
          expect.objectContaining({ policy: "hard_restart" }),
        ]);
      } else {
        await waitFor(() => log.turnStates()[0]?.status === "failed");
        await worker.stop();
      }
      expect(
        logger.entries().filter(
          (entry) => entry.event === "linear_mcp_turn_close",
        ),
      ).toEqual([
        expect.objectContaining({ classification }),
      ]);
      expect(logger.lines.join("\n")).not.toContain("toolu_linear_1");
      log.close();
    },
  );
  it("classifies one runner-failed MCP close when post-init persistence rejects", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_MODE = "mcp-telemetry";
    vi.spyOn(log, "recordTurnToolCallStarted").mockImplementation(() => {
      throw new Error("test persistence rejected");
    });
    append(log, "mcp-persistence", "mcp-persistence-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    await worker.stop();
    expect(
      logger.entries().filter((entry) => entry.event === "linear_mcp_turn_close"),
    ).toEqual([
      expect.objectContaining({ classification: "runner_failed" }),
    ]);
    expect(
      logger.entries().find((entry) => entry.event === "session_turn_unhandled"),
    ).toMatchObject({
      error: expect.stringContaining("test persistence rejected"),
    });
    expect(poster.posts.filter((post) => !post.ephemeral)).toHaveLength(1);
    log.close();
  });
  it.each(["unreadable", "missing"] as const)(
    "fails once without progress when the proxy API key is %s",
    async (failure) => {
      const { log, config } = setup();
      const poster = new Poster();
      const logger = new CapturingLogger();
      if (failure === "unreadable")
        rmSync(config.cliproxyEnvFile);
      else
        writeFileSync(
          config.cliproxyEnvFile,
          "CLIPROXY_MANAGEMENT_KEY=management-secret\n",
        );
      append(log, `proxy-${failure}`, `proxy-${failure}-session`, "created");
      const worker = new SessionWorker(
        log,
        poster as unknown as LinearGateway,
        config,
        { pollMs: 10, reconcileMs: 20, logger },
      );
      worker.start();
      await waitFor(
        () =>
          log.turnStates()[0]?.status === "failed" &&
          poster.posts.some((post) => !post.ephemeral),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      await worker.stop();
      expect(poster.posts.filter((post) => post.ephemeral)).toEqual([]);
      expect(poster.posts.filter((post) => !post.ephemeral)).toHaveLength(1);
      const output = JSON.stringify({
        posts: poster.posts,
        logs: logger.lines,
      });
      expect(output).toContain(
        failure === "unreadable"
          ? "proxy_env_unreadable"
          : "proxy_api_key_missing",
      );
      expect(output).not.toContain(config.cliproxyEnvFile);
      expect(output).not.toContain("management-secret");
      log.close();
    },
  );
  it("persists and logs usage for a completed turn", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    append(log, "usage-success", "usage-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    expect(turnUsage(config.dbPath)).toEqual({
      status: "done",
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationTokens: 5780,
      cacheReadTokens: 15105,
      costUsd: 0.130925,
      model: "claude-fable-5",
    });
    expect(
      logger
        .entries()
        .find((entry) => entry.event === "session_turn_completed"),
    ).toMatchObject({
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationTokens: 5780,
      cacheReadTokens: 15105,
      costUsd: 0.130925,
      model: "claude-fable-5",
    });
    await worker.stop();
    log.close();
  });
  it("completes a usage-free turn with null usage", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_MODE = "no-usage";
    append(log, "usage-absent", "usage-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    expect(turnUsage(config.dbPath)).toEqual({
      status: "done",
      inputTokens: null,
      outputTokens: null,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      costUsd: null,
      model: null,
    });
    const completion = logger
      .entries()
      .find((entry) => entry.event === "session_turn_completed")!;
    expect(completion).not.toHaveProperty("inputTokens");
    expect(completion).not.toHaveProperty("costUsd");
    await worker.stop();
    log.close();
  });
  it("persists and logs usage for a failed turn", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_MODE = "denied";
    append(log, "usage-failure", "usage-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    expect(turnUsage(config.dbPath)).toEqual({
      status: "failed",
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationTokens: 5780,
      cacheReadTokens: 15105,
      costUsd: 0.130925,
      model: "claude-fable-5",
    });
    expect(
      logger.entries().find((entry) => entry.event === "session_turn_failed"),
    ).toMatchObject({
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationTokens: 5780,
      cacheReadTokens: 15105,
      costUsd: 0.130925,
      model: "claude-fable-5",
    });
    await worker.stop();
    log.close();
  });
  it("phase3 AC1/AC2/AC3: do-mode reuses worktree, starts fresh, uses literal prompt, and posts PR URL", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    append(log, "planner", "planner-session", "created");
    let worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    await worker.stop();
    process.env.CLAUDE_FAKE_MODE = "do-pr";
    appendImplementer(log, "implementer", "implementer-session");
    worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(
      () => log.turnStates()[1]?.status === "done" && poster.urls.length === 1,
    );
    await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts[1].cwd).toBe(starts[0].cwd);
    expect(starts[1].args).not.toContain("--resume");
    expect(
      starts[1].args.slice(
        starts[1].args.indexOf("-p"),
        starts[1].args.indexOf("--output-format"),
      ),
    ).toEqual(["-p", "/do ENG-42"]);
    expect(log.getSession("implementer-session")?.claudeSessionId).toBe(
      "claude-do-session",
    );
    expect(poster.urls[0]).toEqual({
      app: "implementer",
      session: "implementer-session",
      label: "Pull Request",
      url: "https://github.com/dcouple/example/pull/42",
    });
    expect(
      poster.posts
        .filter((p) => p.session === "implementer-session")
        .every((p) => p.app === "implementer"),
    ).toBe(true);
    log.close();
  });
  it("phase3 AC2/AC3-on-error: creates a missing worktree and retries an error result's PR URL", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    poster.urlFailures = 1;
    process.env.CLAUDE_FAKE_MODE = "do-pr-error";
    appendImplementer(
      log,
      "implementer-only",
      "implementer-session",
      "issue-new",
      "ENG-99",
    );
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(
      () =>
        log.turnStates()[0]?.status === "failed" && poster.urls.length === 1,
    );
    await worker.stop();
    expect(log.getSession("implementer-session")?.worktreePath).toContain(
      "ENG-99",
    );
    expect(log.externalUrlStates()[0]).toMatchObject({
      status: "posted",
      url: "https://github.com/dcouple/example/pull/42",
    });
    log.close();
  });
  it("implementer prompted turn resumes the stored Claude session with the reply text", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    process.env.CLAUDE_FAKE_MODE = "do-pr";
    appendImplementer(log, "i1", "implementer-session");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    process.env.CLAUDE_FAKE_MODE = "happy";
    log.append({
      deliveryId: "i2",
      app: "implementer",
      action: "prompted",
      agentSessionId: "implementer-session",
      receivedAt: Date.now(),
      rawBody: Buffer.from(
        JSON.stringify({
          action: "prompted",
          agentActivity: { body: "yes, use option B" },
          agentSession: { id: "implementer-session" },
        }),
      ),
    });
    worker.trigger();
    await waitFor(() => log.turnStates()[1]?.status === "done");
    await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts[1].args).toContain("--resume");
    expect(starts[1].args[starts[1].args.indexOf("--resume") + 1]).toBe(
      "claude-do-session",
    );
    expect(
      starts[1].args.slice(
        starts[1].args.indexOf("-p"),
        starts[1].args.indexOf("--output-format"),
      ),
    ).toEqual(["-p", "yes, use option B"]);
    expect(starts[1].cwd).toBe(starts[0].cwd);
    log.close();
  });
  it("phase 4 AC10 ingests a rich marker transactionally before one idempotent owner resume", async () => {
    const state = setup();
    const { dir, config } = state;
    let log = state.log;
    const poster = new Poster();
    const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    process.env.CLAUDE_FAKE_ENV_FILE = join(dir, "env.jsonl");
    process.env.CLAUDE_FAKE_MODE = "do-pr";
    appendImplementer(log, "implementer", ownerOne);
    let worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    await worker.stop();
    const worktree = log.getSession(ownerOne)!.worktreePath!;
    const session = log.getSession(ownerOne)!;
    log.setTurnTraceContext(1, session.traceId, "c".repeat(16));
    const parentTurnSpanId = log.turnSpanId(1)!;
    log.close();
    const dispatchDirectory = join(worktree, ".codex-dispatches", ownerOne);
    const basename = "backend-verifier-1700000000-1234-1";
    mkdirSync(dispatchDirectory, { recursive: true });
    writeFileSync(join(dispatchDirectory, `${basename}.done`), "0\n");
    writeFileSync(
      join(dispatchDirectory, `${basename}.prompt`),
      "verify the backend\n",
    );
    writeFileSync(
      join(dispatchDirectory, `${basename}.md`),
      "verification passed\n",
    );
    writeFileSync(
      join(dispatchDirectory, `${basename}.log`),
      "tokens used\n42\n",
    );
    writeFileSync(
      join(dispatchDirectory, `${basename}.otel.json`),
      JSON.stringify({
        version: 1,
        state: "terminal",
        owner: ownerOne,
        basename,
        role: "backend-verifier",
        started_at: 100,
        ended_at: 200,
        deadline_at: 900_100,
        trace_id: session.traceId,
        turn_span_id: parentTurnSpanId,
        dispatch_span_id: "d".repeat(16),
        model: "gpt-test",
        mode: "fresh",
        exit_code: 0,
        parse_status: "ok",
        provider_session_id: "codex-thread-1",
        provider_turn_id: "codex-turn-1",
        cumulative_tokens: 42,
      }),
    );
    process.env.CLAUDE_FAKE_MODE = "happy";
    log = new EventLog(config.dbPath);
    worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[1]?.status === "done");
    expect(log.turnStates()[1]).toMatchObject({
      linearSessionId: ownerOne,
      kind: "prompted",
      sourceKey: `prompt:${ownerOne}:dispatch:${basename}.done`,
      prompt: expect.stringContaining(
        `.codex-dispatches/${ownerOne}/${basename}.done`,
      ),
    });
    expect(log.turnStates()[1]?.prompt).toContain(
      "any sibling completed dispatches",
    );
    expect(log.invocations(ownerOne)).toEqual([
      expect.objectContaining({
        sourceKey: `dispatch:${ownerOne}:${basename}.done`,
        role: "backend-verifier",
        prompt: "verify the backend\n",
        report: "verification passed\n",
        startedAt: 100,
        endedAt: 200,
        outcome: "success",
        model: "gpt-test",
        providerConversationId: "codex-thread-1",
        providerTurnId: "codex-turn-1",
        deltaTotalTokens: 42,
        usageClassification: "accepted",
        traceId: session.traceId,
        spanId: "d".repeat(16),
      }),
    ]);
    worker.trigger();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log.turnStates()).toHaveLength(2);
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts[1].args).toContain("--resume");
    const envs = readFileSync(process.env.CLAUDE_FAKE_ENV_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      envs.every((row) => row.env.ORCHESTRA_DISPATCH_OWNER === ownerOne),
    ).toBe(true);
    expect(log.invocations(ownerOne)).toHaveLength(1);
    expect(
      logger
        .entries()
        .filter((entry) => entry.event === "dispatch_marker_resume"),
    ).toHaveLength(1);
    await worker.stop();
    log.close();
  });
  it("logs each degraded dispatch marker once across rescans and reason transitions", async () => {
    const poster = new Poster();
    for (const scenario of ["invalid", "no-parent", "transition"] as const) {
      const { dir, log, config } = setup();
      config.sessionConcurrency = 0;
      const owner =
        scenario === "invalid"
          ? ownerOne
          : scenario === "no-parent"
            ? ownerTwo
            : "a0000000-0000-0000-0000-000000000003";
      const worktree = join(dir, "dispatch-worktree");
      appendImplementer(log, `${scenario}-created`, owner);
      log.updateSessionWorktree(owner, worktree, `${scenario}-branch`);
      setTurnsStatus(config.dbPath, scenario === "invalid" ? "done" : "deleted");
      dispatchFixture(
        worktree,
        owner,
        `backend-verifier-1700000000-1234-${scenario.length}`,
      );
      const logger = new CapturingLogger();
      const worker = new SessionWorker(
        log,
        poster as unknown as LinearGateway,
        config,
        { logger },
      );
      await worker.ingestDispatches();
      if (scenario === "invalid") setTurnsStatus(config.dbPath, "done");
      if (scenario === "transition") {
        append(log, `${scenario}-prompted`, owner, "prompted");
        setTurnsStatus(config.dbPath, "done");
      }
      await worker.ingestDispatches();
      const degraded = logger
        .entries()
        .filter((entry) => entry.event === "dispatch_marker_ingest_degraded");
      expect(degraded, scenario).toHaveLength(1);
      expect(degraded[0]?.reason).toBe(
        scenario === "invalid" ? "invalid_sidecar" : "no_parent_turn",
      );
      await worker.stop();
      log.close();
    }
  });
  it("quarantines every stale ingested sibling while retaining its invocation", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const now = Date.now();
    config.sessionConcurrency = 0;
    config.dispatchQuarantineAgeMs = 1_000;
    appendImplementer(log, "quarantine-created", ownerOne);
    setTurnsStatus(config.dbPath, "done");
    const worktree = join(dir, "dispatch-worktree");
    log.updateSessionWorktree(ownerOne, worktree, "quarantine-branch");
    const basename = "backend-verifier-1700000000-1234-20";
    const fixture = dispatchFixture(worktree, ownerOne, basename);
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { now: () => now },
    );
    await worker.ingestDispatches();
    setTurnsStatus(config.dbPath, "done");
    utimesSync(
      join(fixture.directory, `${basename}.done`),
      new Date(now - 2_000),
      new Date(now - 2_000),
    );
    await worker.ingestDispatches();
    const quarantine = join(config.dispatchQuarantineDir, ownerOne);
    expect(readdirSync(quarantine).sort()).toEqual(fixture.files.sort());
    expect(readdirSync(fixture.directory)).toEqual([]);
    expect(log.invocations(ownerOne)).toEqual([
      expect.objectContaining({
        sourceKey: `dispatch:${ownerOne}:${basename}.done`,
      }),
    ]);
    await worker.stop();
    log.close();
  });
  it("leaves a young ingested dispatch bundle in the live consume path", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    config.sessionConcurrency = 0;
    config.dispatchQuarantineAgeMs = 10_000;
    appendImplementer(log, "young-created", ownerOne);
    setTurnsStatus(config.dbPath, "done");
    const worktree = join(dir, "dispatch-worktree");
    log.updateSessionWorktree(ownerOne, worktree, "young-branch");
    const fixture = dispatchFixture(
      worktree,
      ownerOne,
      "backend-verifier-1700000000-1234-21",
    );
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
    );
    await worker.ingestDispatches();
    expect(readdirSync(fixture.directory).sort()).toEqual(
      fixture.files.sort(),
    );
    expect(existsSync(config.dispatchQuarantineDir)).toBe(false);
    await worker.stop();
    log.close();
  });
  it("finishes a partial quarantine without overwriting archived siblings", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const now = Date.now();
    config.sessionConcurrency = 0;
    config.dispatchQuarantineAgeMs = 1_000;
    appendImplementer(log, "partial-created", ownerOne);
    setTurnsStatus(config.dbPath, "done");
    const worktree = join(dir, "dispatch-worktree");
    log.updateSessionWorktree(ownerOne, worktree, "partial-branch");
    const basename = "backend-verifier-1700000000-1234-22";
    const fixture = dispatchFixture(worktree, ownerOne, basename);
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { now: () => now },
    );
    await worker.ingestDispatches();
    setTurnsStatus(config.dbPath, "done");
    const quarantine = join(config.dispatchQuarantineDir, ownerOne);
    mkdirSync(quarantine, { recursive: true });
    renameSync(
      join(fixture.directory, `${basename}.prompt`),
      join(quarantine, `${basename}.prompt`),
    );
    writeFileSync(join(quarantine, `${basename}.md`), "archived report\n");
    utimesSync(
      join(fixture.directory, `${basename}.done`),
      new Date(now - 2_000),
      new Date(now - 2_000),
    );
    await worker.ingestDispatches();
    expect(
      readFileSync(join(quarantine, `${basename}.prompt`), "utf8"),
    ).toBe(`${basename}.prompt\n`);
    expect(readFileSync(join(quarantine, `${basename}.md`), "utf8")).toBe(
      "archived report\n",
    );
    expect(readFileSync(join(quarantine, `${basename}.md.1`), "utf8")).toBe(
      `${basename}.md\n`,
    );
    expect(readdirSync(quarantine).sort()).toEqual(
      [...fixture.files, `${basename}.md.1`].sort(),
    );
    expect(readdirSync(fixture.directory)).toEqual([]);
    await worker.stop();
    log.close();
  });
  it("logs a quarantine failure and completes the bundle on the next scan", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    const now = Date.now();
    config.sessionConcurrency = 0;
    config.dispatchQuarantineAgeMs = 1_000;
    appendImplementer(log, "quarantine-failure-created", ownerOne);
    setTurnsStatus(config.dbPath, "done");
    const worktree = join(dir, "dispatch-worktree");
    log.updateSessionWorktree(ownerOne, worktree, "quarantine-failure-branch");
    const basename = "backend-verifier-1700000000-1234-23";
    const fixture = dispatchFixture(worktree, ownerOne, basename);
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { logger, now: () => now },
    );
    await worker.ingestDispatches();
    setTurnsStatus(config.dbPath, "done");
    utimesSync(
      join(fixture.directory, `${basename}.done`),
      new Date(now - 2_000),
      new Date(now - 2_000),
    );
    mkdirSync(config.dispatchQuarantineDir, { recursive: true });
    const obstruction = join(config.dispatchQuarantineDir, ownerOne);
    writeFileSync(obstruction, "not a directory\n");

    await worker.ingestDispatches();
    expect(
      logger
        .entries()
        .filter(
          (entry) => entry.event === "dispatch_marker_quarantine_failed",
        ),
    ).toHaveLength(1);
    expect(readdirSync(fixture.directory).sort()).toEqual(
      fixture.files.sort(),
    );

    rmSync(obstruction);
    await worker.ingestDispatches();
    const quarantine = join(config.dispatchQuarantineDir, ownerOne);
    expect(readdirSync(quarantine).sort()).toEqual(fixture.files.sort());
    expect(readdirSync(fixture.directory)).toEqual([]);
    expect(log.invocations(ownerOne)).toEqual([
      expect.objectContaining({
        sourceKey: `dispatch:${ownerOne}:${basename}.done`,
      }),
    ]);
    await worker.stop();
    log.close();
  });
  it("does not enqueue a marker while its owner has a running turn", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    process.env.CLAUDE_FAKE_MODE = "slow";
    process.env.CLAUDE_FAKE_DELAY_MS = "500";
    appendImplementer(log, "implementer", ownerOne);
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, dispatchScanMs: 25 },
    );
    worker.start();
    await waitFor(
      () =>
        log.turnStates()[0]?.status === "running" &&
        !!log.getSession(ownerOne)?.worktreePath,
    );
    const worktree = log.getSession(ownerOne)!.worktreePath!;
    mkdirSync(join(worktree, ".codex-dispatches", ownerOne), {
      recursive: true,
    });
    writeFileSync(
      join(worktree, ".codex-dispatches", ownerOne, "active.done"),
      "0\n",
    );
    worker.trigger();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(log.turnStates()).toHaveLength(1);
    await waitFor(() => log.turnStates()[1]?.status === "done");
    await worker.stop();
    log.close();
  });
  it("scopes shared-worktree markers to the owning session", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    append(log, "planner", ownerTwo, "created");
    appendImplementer(log, "implementer", ownerOne);
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(
      () =>
        log.turnStates().length === 2 &&
        log.turnStates().every((turn) => turn.status === "done"),
    );
    const worktree = log.getSession(ownerOne)!.worktreePath!;
    mkdirSync(join(worktree, ".codex-dispatches", ownerOne), {
      recursive: true,
    });
    writeFileSync(
      join(worktree, ".codex-dispatches", ownerOne, "owned.done"),
      "0\n",
    );
    worker.trigger();
    await waitFor(
      () =>
        log.turnStates().length === 3 && log.turnStates()[2]?.status === "done",
    );
    expect(
      log.turnStates().filter((turn) => turn.linearSessionId === ownerTwo),
    ).toHaveLength(1);
    expect(log.turnStates()[2]?.linearSessionId).toBe(ownerOne);
    await worker.stop();
    log.close();
  });
  it("ignores a missing worktree during dispatch scanning", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    appendImplementer(log, "implementer", ownerOne);
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    log.updateSessionWorktree(
      ownerOne,
      join(dir, "missing-worktree"),
      "agents/missing",
    );
    worker.trigger();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log.turnStates()).toHaveLength(1);
    expect(
      logger.entries().some((entry) => entry.event === "dispatch_scan_failed"),
    ).toBe(false);
    await worker.stop();
    log.close();
  });
  it("rejects an unsafe dispatch owner for marker scanning and child environment", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    const unsafeOwner = "unsafe_session";
    process.env.CLAUDE_FAKE_ENV_FILE = join(dir, "env.jsonl");
    process.env.ORCHESTRA_DISPATCH_OWNER = "ambient-owner";
    appendImplementer(log, "implementer", unsafeOwner);
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, dispatchScanMs: 25, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    const worktree = log.getSession(unsafeOwner)!.worktreePath!;
    mkdirSync(join(worktree, ".codex-dispatches", unsafeOwner), {
      recursive: true,
    });
    writeFileSync(
      join(worktree, ".codex-dispatches", unsafeOwner, "unsafe.done"),
      "0\n",
    );
    worker.trigger();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(log.turnStates()).toHaveLength(1);
    expect(logger.entries()).toContainEqual(
      expect.objectContaining({
        event: "dispatch_scan_failed",
        linearSessionId: unsafeOwner,
        reason: "invalid dispatch owner",
      }),
    );
    const envs = readFileSync(process.env.CLAUDE_FAKE_ENV_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      envs.every((row) => row.env.ORCHESTRA_DISPATCH_OWNER === undefined),
    ).toBe(true);
    await worker.stop();
    log.close();
  });
  it("AC1-AC4: aborts a running turn, posts one stop ack, and resumes on the next prompt", async () => {
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    class GatedPoster extends Poster {
      isActive?: () => boolean;
      activeAtTerminal: boolean | undefined;
      override async postActivity(
        app: string,
        session: string,
        id: string,
        content: ProgressContent | TerminalContent,
        ephemeral: boolean,
      ): Promise<PostResult> {
        const result = super.postActivity(app, session, id, content, ephemeral);
        if (ephemeral) await progressGate;
        else this.activeAtTerminal = this.isActive?.();
        return result;
      }
    }
    const { dir, log, config } = setup();
    const poster = new GatedPoster();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    process.env.CLAUDE_FAKE_MODE = "slow";
    process.env.CLAUDE_FAKE_DELAY_MS = "1000";
    append(log, "created", "stop-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    poster.isActive = () =>
      (worker as unknown as { active: Map<number, unknown> }).active.size > 0;
    worker.start();
    await waitFor(
      () =>
        log.turnStates()[0]?.status === "running" &&
        log.getSession("stop-session")?.claudeSessionId === "claude-session-1",
    );
    const result = log.append({
      deliveryId: "stop",
      app: "planner",
      action: "prompted",
      agentSessionId: "stop-session",
      sourceActivityId: "stop-activity",
      signal: "stop",
      receivedAt: Date.now(),
      rawBody: Buffer.from("{}"),
    });
    worker.stopSession(result.stop!.agentSessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      poster.posts.some(
        (post) => !post.ephemeral && post.session === "stop-session",
      ),
    ).toBe(false);
    releaseProgress();
    await waitFor(
      () =>
        log.turnStates()[0]?.status === "interrupted" &&
        log.stopAckStates()[0]?.status === "posted",
    );
    expect(poster.posts.filter((post) => !post.ephemeral)).toEqual([
      expect.objectContaining({
        session: "stop-session",
        content: {
          type: "response",
          body: "Stopped at your request. Send a follow-up message to continue.",
        },
      }),
    ]);
    expect(poster.activeAtTerminal).toBe(false);
    const terminalIndex = poster.posts.findIndex(
      (post) => !post.ephemeral && post.session === "stop-session",
    );
    expect(
      poster.posts
        .slice(terminalIndex + 1)
        .some((post) => post.ephemeral && post.session === "stop-session"),
    ).toBe(false);
    process.env.CLAUDE_FAKE_MODE = "happy";
    append(log, "after-stop", "stop-session", "prompted");
    worker.trigger();
    await waitFor(() => log.turnStates()[1]?.status === "done");
    await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts[1].args[starts[1].args.indexOf("--resume") + 1]).toBe(
      "claude-session-1",
    );
    log.close();
  });
  it("AC3: acknowledges a stop with no active turn after cancelling pending work", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    append(log, "created", "idle-session", "created");
    const result = log.append({
      deliveryId: "idle-stop",
      app: "planner",
      action: "prompted",
      agentSessionId: "idle-session",
      sourceActivityId: "idle-stop-activity",
      signal: "stop",
      receivedAt: Date.now(),
      rawBody: Buffer.from("{}"),
    });
    expect(log.turnStates()[0]).toMatchObject({ status: "interrupted" });
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    worker.stopSession(result.stop!.agentSessionId);
    await waitFor(() => log.stopAckStates()[0]?.status === "posted");
    expect(poster.posts.filter((post) => !post.ephemeral)).toHaveLength(1);
    await worker.stop();
    log.close();
  });
  it("retries stop acknowledgments and marks them failed after the retry window", async () => {
    const first = setup();
    const retryPoster = new Poster();
    const retryLogger = new CapturingLogger();
    let clock = 1_000;
    retryPoster.failures = 1;
    first.log.append({
      deliveryId: "retry-stop",
      app: "planner",
      action: "prompted",
      agentSessionId: "retry-session",
      sourceActivityId: "retry-stop-activity",
      signal: "stop",
      receivedAt: clock,
      rawBody: Buffer.from("{}"),
    });
    const retryWorker = new SessionWorker(
      first.log,
      retryPoster as unknown as LinearGateway,
      first.config,
      { pollMs: 10, reconcileMs: 20, now: () => clock, logger: retryLogger },
    );
    retryWorker.start();
    await waitFor(() => first.log.stopAckStates()[0]?.attempts === 1);
    expect(first.log.stopAckStates()[0]).toMatchObject({
      sourceActivityId: "retry-stop-activity",
      status: "pending",
      attempts: 1,
    });
    expect(retryLogger.entries()).toContainEqual(
      expect.objectContaining({
        event: "stop_ack_retry_scheduled",
        sourceActivityId: "retry-stop-activity",
        attempts: 1,
      }),
    );
    clock = 2_000;
    await waitFor(() => first.log.stopAckStates()[0]?.status === "posted");
    expect(first.log.stopAckStates()[0]).toMatchObject({
      status: "posted",
      attempts: 2,
    });
    await retryWorker.stop();
    first.log.close();

    const second = setup();
    const failedPoster = new Poster();
    const failedLogger = new CapturingLogger();
    failedPoster.failures = 1;
    const expired = 30 * 60_000 + 1;
    second.log.append({
      deliveryId: "failed-stop",
      app: "planner",
      action: "prompted",
      agentSessionId: "failed-session",
      sourceActivityId: "failed-stop-activity",
      signal: "stop",
      receivedAt: 0,
      rawBody: Buffer.from("{}"),
    });
    const failedWorker = new SessionWorker(
      second.log,
      failedPoster as unknown as LinearGateway,
      second.config,
      { pollMs: 10, reconcileMs: 20, now: () => expired, logger: failedLogger },
    );
    failedWorker.start();
    await waitFor(() => second.log.stopAckStates()[0]?.status === "failed");
    expect(second.log.stopAckStates()[0]).toMatchObject({
      sourceActivityId: "failed-stop-activity",
      status: "failed",
      attempts: 1,
    });
    expect(failedLogger.entries()).toContainEqual(
      expect.objectContaining({
        event: "stop_ack_delivery_failed",
        sourceActivityId: "failed-stop-activity",
        attempts: 1,
      }),
    );
    await failedWorker.stop();
    second.log.close();
  });
  it("marks a stop-requested turn interrupted when the runner rejects", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    config.claudeArgv = [];
    append(log, "reject-stop", "reject-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "running");
    worker.stopSession("reject-session");
    await waitFor(() => log.turnStates()[0]?.status === "interrupted");
    expect(logger.entries()).toContainEqual(
      expect.objectContaining({
        event: "session_turn_stopped",
        linearSessionId: "reject-session",
      }),
    );
    expect(
      logger
        .entries()
        .some((entry) => entry.event === "session_turn_unhandled"),
    ).toBe(false);
    expect(poster.posts.some((post) => !post.ephemeral)).toBe(false);
    await worker.stop();
    log.close();
  });
  it("posts an ntfy notification when a terminal activity is delivered", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const received: Array<{
      title: string | undefined;
      priority: string | undefined;
      body: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({
          title: req.headers.title as string,
          priority: req.headers.priority as string,
          body,
        });
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const ntfyUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      { ...config, ntfyUrl },
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(
      () => log.turnStates()[0]?.status === "done" && received.length === 1,
    );
    await worker.stop();
    server.close();
    log.close();
    expect(received[0].title).toContain("bloom-planner replied");
    expect(received[0].title).toContain("ENG-42");
    expect(received[0].priority).toBe("default");
    expect(received[0].body).toBe("planner answer");
  });
  it("AC1/AC2/AC3-contract: creates worktree, posts response, then resumes in the same cwd", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    append(log, "d1", "linear-session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    append(log, "d2", "linear-session", "prompted");
    worker.trigger();
    await waitFor(() => log.turnStates()[1]?.status === "done");
    expect(poster.posts).toContainEqual(
      expect.objectContaining({
        content: { type: "action", action: "Read", parameter: "ticket" },
        ephemeral: true,
      }),
    );
    expect(
      poster.posts.some(
        (post) =>
          !post.ephemeral &&
          post.content.type === "response" &&
          post.content.body === "planner answer",
      ),
    ).toBe(true);
    expect(
      poster.posts.some(
        (post) =>
          !post.ephemeral &&
          activityBody(post.content)?.includes("resumed claude-session-1"),
      ),
    ).toBe(true);
    const invocations = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(invocations[1].args).toContain("--resume");
    expect(invocations[1].cwd).toBe(invocations[0].cwd);
    const completions = logger
      .entries()
      .filter((entry) => entry.event === "session_turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions[0]).toMatchObject({
      event: "session_turn_completed",
      turnId: 1,
      issueIdentifier: "ENG-42",
      linearSessionId: "linear-session",
      attempts: 1,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(completions)).not.toContain("linear-key");
    expect(JSON.stringify(completions)).not.toContain("Help plan this");
    expect(log.getSession("linear-session")?.branch).toContain("ENG-42");
    await worker.stop();
    log.close();
  });
  it("AC4-contract: emits progress and keepalive before a slow response", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    process.env.CLAUDE_FAKE_MODE = "slow";
    process.env.CLAUDE_FAKE_DELAY_MS = "120";
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    const terminal = poster.posts.findIndex((post) => !post.ephemeral);
    const before = poster.posts.slice(0, terminal);
    expect(
      before.some((post) =>
        activityBody(post.content)?.includes("still working"),
      ),
    ).toBe(true);
    expect(before.every((post) => post.ephemeral)).toBe(true);
    await worker.stop();
    log.close();
  });
  it("AC5: posts durable error after crash and accepts the next prompt", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    process.env.CLAUDE_FAKE_MODE = "crash";
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    expect(
      poster.posts.some(
        (post) => post.content.type === "error" && !post.ephemeral,
      ),
    ).toBe(true);
    process.env.CLAUDE_FAKE_MODE = "happy";
    append(log, "d2", "session", "prompted");
    worker.trigger();
    await waitFor(() => log.turnStates()[1]?.status === "done");
    await worker.stop();
    log.close();
  });
  it("AC6: serializes one issue while different issues run in parallel", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    process.env.CLAUDE_FAKE_MODE = "slow";
    process.env.CLAUDE_FAKE_DELAY_MS = "100";
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    append(log, "d1", "s1", "created", "issue-1", "ENG-1");
    append(log, "d2", "s1", "prompted");
    append(log, "d3", "s2", "created", "issue-2", "ENG-2");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() =>
      log.turnStates().every((turn) => turn.status === "done"),
    );
    await worker.stop();
    const rows = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const starts = rows.filter((row) => row.phase === "start"),
      ends = rows.filter((row) => row.phase === "end");
    const issue1 = starts.filter((row) => row.cwd.endsWith("ENG-1"));
    expect(issue1).toHaveLength(2);
    const issue2Start = starts.find((row) => row.cwd.endsWith("ENG-2"));
    const intervalFor = (start: { cwd: string; at: number }) => {
      const end = ends.find(
        (row) => row.cwd === start.cwd && row.at >= start.at,
      );
      expect(end).toBeDefined();
      return { start: start.at, end: end!.at };
    };
    expect(issue2Start).toBeDefined();
    const issue1Intervals = issue1.map(intervalFor);
    const issue2Interval = intervalFor(issue2Start!);
    expect(issue1[1].at).toBeGreaterThanOrEqual(issue1Intervals[0].end);
    expect(
      issue1Intervals.some(
        (interval) =>
          issue2Interval.start < interval.end &&
          issue2Interval.end > interval.start,
      ),
    ).toBe(true);
    log.close();
  });
  it("serializes prompted-before-created turns after provisional issue rekey", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    process.env.CLAUDE_FAKE_MODE = "slow";
    process.env.CLAUDE_FAKE_DELAY_MS = "100";
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    log.append({
      deliveryId: "d1",
      app: "planner",
      action: "prompted",
      agentSessionId: "session",
      receivedAt: Date.now(),
      rawBody: Buffer.from(
        JSON.stringify({
          action: "prompted",
          agentActivity: { body: "first" },
          agentSession: { id: "session" },
        }),
      ),
    });
    append(log, "d2", "session", "created", "issue-1", "ENG-1");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() =>
      log.turnStates().every((turn) => turn.status === "done"),
    );
    await worker.stop();
    const rows = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const starts = rows.filter((row) => row.phase === "start");
    const ends = rows.filter((row) => row.phase === "end");
    expect(starts).toHaveLength(2);
    expect(starts.every((row) => row.cwd.endsWith("ENG-1"))).toBe(true);
    expect(starts[1].at).toBeGreaterThanOrEqual(
      ends.find((row) => row.cwd === starts[0].cwd && row.at >= starts[0].at)!
        .at,
    );
    log.close();
  });
  it("releases a persisted progress barrier on restart and posts the real terminal response", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    append(log, "d1", "session", "created");
    const turn = log.claimNextTurn(1000)!;
    log.finishTurn(
      turn.id,
      "response",
      "real persisted response",
      1100,
      "activity-1",
      true,
    );
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, now: () => 1200 },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    expect(poster.posts.find((post) => !post.ephemeral)).toMatchObject({
      content: { type: "response", body: "real persisted response" },
    });
    expect(
      poster.posts.some((post) =>
        activityBody(post.content)?.includes("interrupted"),
      ),
    ).toBe(false);
    await worker.stop();
    log.close();
  });
  it("gives late terminal activities a full retry budget from their creation time", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    let clock = 2_000_000;
    poster.failures = 1;
    log.append({
      deliveryId: "d1",
      app: "planner",
      action: "created",
      agentSessionId: "session",
      issueId: "issue",
      issueIdentifier: "ENG-9",
      receivedAt: 1,
      rawBody: Buffer.from(
        JSON.stringify({
          action: "created",
          promptContext: "old",
          agentSession: {
            id: "session",
            issue: { id: "issue", identifier: "ENG-9" },
          },
        }),
      ),
    });
    const turn = log.claimNextTurn(clock - 100)!;
    log.finishTurn(turn.id, "response", "late response", clock, "activity-1");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger, now: () => clock },
    );
    worker.start();
    await waitFor(() =>
      logger
        .entries()
        .some((entry) => entry.event === "terminal_activity_retry_scheduled"),
    );
    clock += 1000;
    await waitFor(() => log.turnStates()[0]?.status === "done");
    expect(
      poster.posts
        .filter((post) => !post.ephemeral)
        .map((post) => activityBody(post.content)),
    ).toEqual(["late response", "late response"]);
    await worker.stop();
    log.close();
  });
  it("does not start a later same-issue turn until the earlier terminal activity posts", async () => {
    const { dir, log, config } = setup();
    const logger = new CapturingLogger();
    class FastRetryPoster extends Poster {
      override async postActivity(
        app: string,
        session: string,
        id: string,
        content: ProgressContent | TerminalContent,
        ephemeral: boolean,
      ): Promise<PostResult> {
        this.posts.push({ app, session, content, ephemeral, at: Date.now() });
        if (!ephemeral && this.failures-- > 0)
          return {
            ok: false,
            retriable: true,
            retryAfterMs: 50,
            error: "temporary",
          };
        return { ok: true };
      }
    }
    const poster = new FastRetryPoster();
    poster.failures = 1;
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    append(log, "d1", "session", "created", "issue-1", "ENG-1");
    append(log, "d2", "session", "prompted");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() =>
      logger
        .entries()
        .some((entry) => entry.event === "terminal_activity_retry_scheduled"),
    );
    const firstStarts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(firstStarts).toHaveLength(1);
    await waitFor(() =>
      log.turnStates().every((turn) => turn.status === "done"),
    );
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts).toHaveLength(2);
    await worker.stop();
    log.close();
  });
  it("expires retriable terminal delivery failures and unblocks the issue", async () => {
    const { log, config } = setup();
    const logger = new CapturingLogger();
    let clock = 1000;
    class ExpiringPoster extends Poster {
      override async postActivity(
        app: string,
        session: string,
        id: string,
        content: ProgressContent | TerminalContent,
        ephemeral: boolean,
      ): Promise<PostResult> {
        this.posts.push({ app, session, content, ephemeral, at: clock });
        if (
          !ephemeral &&
          "body" in content &&
          content.body === "stuck terminal response"
        )
          return {
            ok: false,
            retriable: true,
            retryAfterMs: 30 * 60_000 + 1,
            error: "temporary",
          };
        return { ok: true };
      }
    }
    const poster = new ExpiringPoster();
    append(log, "d1", "session", "created", "issue-1", "ENG-1");
    append(log, "d2", "session", "prompted");
    const turn = log.claimNextTurn(clock)!;
    log.finishTurn(
      turn.id,
      "response",
      "stuck terminal response",
      clock,
      "activity-1",
    );
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger, now: () => clock },
    );
    worker.start();
    await waitFor(() =>
      logger
        .entries()
        .some((entry) => entry.event === "terminal_activity_retry_scheduled"),
    );
    expect(log.turnStates()[1]?.status).toBe("pending");
    clock += 30 * 60_000 + 1;
    await waitFor(() =>
      logger
        .entries()
        .some((entry) => entry.event === "terminal_activity_delivery_failed"),
    );
    await waitFor(() => log.turnStates()[1]?.status === "done");
    expect(log.turnStates()[0]?.status).toBe("failed");
    expect(
      logger
        .entries()
        .find((entry) => entry.event === "terminal_activity_delivery_failed"),
    ).toMatchObject({
      event: "terminal_activity_delivery_failed",
      turnId: 1,
      linearSessionId: "session",
      attempts: 2,
      error: "temporary",
    });
    await worker.stop();
    log.close();
  });
  it("retries a durable terminal activity after a transient failure", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    poster.failures = 1;
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done", 6000);
    expect(
      logger
        .entries()
        .find((entry) => entry.event === "terminal_activity_retry_scheduled"),
    ).toMatchObject({
      event: "terminal_activity_retry_scheduled",
      turnId: 1,
      linearSessionId: "session",
      attempts: 1,
      next_attempt_at: expect.any(Number),
      error: "temporary",
    });
    expect(poster.posts.filter((post) => !post.ephemeral)).toHaveLength(2);
    await worker.stop();
    log.close();
  });
  it("logs terminal activity delivery failures with job id and attempts", async () => {
    class TerminalFailingPoster extends Poster {
      override async postActivity(
        app: string,
        session: string,
        id: string,
        content: ProgressContent | TerminalContent,
        ephemeral: boolean,
      ): Promise<PostResult> {
        await super.postActivity(app, session, id, content, ephemeral);
        return ephemeral
          ? { ok: true }
          : { ok: false, retriable: false, error: "permanent" };
      }
    }
    const { log, config } = setup();
    const poster = new TerminalFailingPoster();
    const logger = new CapturingLogger();
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    expect(
      logger
        .entries()
        .find((entry) => entry.event === "terminal_activity_delivery_failed"),
    ).toMatchObject({
      event: "terminal_activity_delivery_failed",
      turnId: 1,
      linearSessionId: "session",
      attempts: 1,
      error: "permanent",
    });
    await worker.stop();
    log.close();
  });
  it("logs unhandled turn failures with job id and attempts", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    config.targetRepoPath = join(dir, "missing-repo");
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    expect(
      logger
        .entries()
        .find((entry) => entry.event === "session_turn_unhandled"),
    ).toMatchObject({
      event: "session_turn_unhandled",
      turnId: 1,
      linearSessionId: "session",
      issueId: "issue-uuid",
      attempts: 1,
      error: expect.any(String),
    });
    await worker.stop();
    log.close();
  });
  it("captures noisy stderr tails in failure logs without exposing them in terminal activity", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_MODE = "stderr-fail";
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    expect(
      logger.entries().find((entry) => entry.event === "session_turn_failed"),
    ).toMatchObject({
      event: "session_turn_failed",
      turnId: 1,
      linearSessionId: "session",
      attempts: 1,
      stderrTail: expect.stringContaining("stderr-line-"),
    });
    expect(
      activityBody(poster.posts.find((post) => !post.ephemeral)?.content),
    ).not.toContain("stderr-line-");
    await worker.stop();
    log.close();
  });
  it("cancels progress and keepalive when the Claude runner rejects after progress starts", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    config.fableArgv = [];
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    const postsAfterFailure = poster.posts.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(poster.posts).toHaveLength(postsAfterFailure);
    expect(
      logger
        .entries()
        .find((entry) => entry.event === "session_turn_unhandled"),
    ).toMatchObject({
      event: "session_turn_unhandled",
      turnId: 1,
      attempts: 1,
      error: expect.stringContaining("Claude argv is empty"),
    });
    await worker.stop();
    log.close();
  });
  it("downloads allowlisted attachments with bearer auth, sanitizes names, and keeps git clean", async () => {
    const received: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      received.push(request.headers.authorization);
      if (request.url === "/big") {
        response.writeHead(200, { "Content-Length": String(11 * 1024 * 1024) });
        response.end();
        return;
      }
      if (request.url === "/redirect") {
        response.writeHead(302, {
          Location: `http://localhost:${(server.address() as { port: number }).port}/file`,
        });
        response.end();
        return;
      }
      response.end("attachment body");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const { log, config } = setup();
    const poster = new Poster();
    config.attachmentsEnabled = true;
    config.attachmentHosts = ["127.0.0.1"];
    const raw = {
      promptContext: "plan",
      agentSession: {
        issue: {
          attachments: [
            { url: `http://127.0.0.1:${port}/file`, title: "../../secret.txt" },
            { url: `http://127.0.0.1:${port}/big`, filename: "big.bin" },
            {
              url: `http://127.0.0.1:${port}/redirect`,
              filename: "redirect.txt",
            },
            { url: `http://example.invalid/file`, filename: "blocked.txt" },
          ],
        },
      },
    };
    log.append({
      deliveryId: "d1",
      app: "planner",
      action: "created",
      agentSessionId: "session",
      issueId: "issue",
      issueIdentifier: "ENG-8",
      receivedAt: Date.now(),
      rawBody: Buffer.from(JSON.stringify(raw)),
    });
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, attachmentTestAllowHttp: true },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    const worktree = log.getSession("session")!.worktreePath!;
    expect(readdirSync(join(worktree, ".linear-attachments"))).toHaveLength(1);
    expect(received).toEqual([
      "Bearer linear-key",
      "Bearer linear-key",
      "Bearer linear-key",
    ]);
    expect(log.turnStates()[0]?.prompt).toMatch(
      /big\.bin: failed|redirect\.txt: failed|blocked\.txt: failed/,
    );
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: worktree,
        encoding: "utf8",
      }),
    ).toBe("");
    await worker.stop();
    log.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it("aborts a stalled attachment body at the per-file deadline and continues the turn", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write("partial");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const { log, config } = setup();
    const poster = new Poster();
    config.attachmentsEnabled = true;
    config.attachmentHosts = ["127.0.0.1"];
    const raw = {
      promptContext: "plan",
      agentSession: {
        issue: {
          attachments: [
            { url: `http://127.0.0.1:${port}/stall`, title: "stall.txt" },
          ],
        },
      },
    };
    log.append({
      deliveryId: "d1",
      app: "planner",
      action: "created",
      agentSessionId: "session",
      issueId: "issue",
      issueIdentifier: "ENG-10",
      receivedAt: Date.now(),
      rawBody: Buffer.from(JSON.stringify(raw)),
    });
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      {
        pollMs: 10,
        reconcileMs: 20,
        attachmentTestAllowHttp: true,
        attachmentTimeoutMs: 50,
      },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    expect(log.turnStates()[0]?.prompt).toContain(
      "stall.txt: failed (attachment timed out)",
    );
    await worker.stop();
    log.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it("AC7-contract: reopens SQLite and resumes the persisted Claude session after restart", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    append(log, "d1", "session", "created");
    const first = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    first.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    await first.stop();
    log.close();
    const reopened = new EventLog(config.dbPath);
    append(reopened, "d2", "session", "prompted");
    const second = new SessionWorker(
      reopened,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    second.start();
    await waitFor(() => reopened.turnStates()[1]?.status === "done");
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(
      starts[1].args.slice(
        starts[1].args.indexOf("--resume"),
        starts[1].args.indexOf("--resume") + 2,
      ),
    ).toEqual(["--resume", "claude-session-1"]);
    await second.stop();
    reopened.close();
  });
  it("defers a shutdown-interrupted safe boundary and resumes it exactly once on startup", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_MODE = "slow";
    process.env.CLAUDE_FAKE_DELAY_MS = "1000";
    append(log, "shutdown-safe", "shutdown-safe-session", "created");
    const first = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    first.start();
    await waitFor(
      () =>
        log.turnStates()[0]?.status === "running" &&
        log.getSession("shutdown-safe-session")?.claudeSessionId ===
          "claude-session-1" &&
        log.openTurnToolCalls(1).length === 0,
    );
    await first.stop();
    expect(log.turnStates()[0]?.status).toBe("running");

    process.env.CLAUDE_FAKE_MODE = "happy";
    const second = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    second.start();
    await waitFor(
      () =>
        log.turnStates().length === 2 &&
        log.turnStates()[1]?.status === "done",
    );
    expect(log.turnStates().map((turn) => turn.status)).toEqual([
      "interrupted",
      "done",
    ]);
    expect(
      logger.entries().filter(
        (entry) =>
          entry.event === "restart_turn_disposition" &&
          entry.outcome === "resumed",
      ),
    ).toHaveLength(1);
    await second.stop();
    log.close();
  });
  it("requires human review after shutdown with an unresolved tool call", async () => {
    const { log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_MODE = "tool-hang";
    append(log, "shutdown-tool", "shutdown-tool-session", "created");
    const first = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    first.start();
    await waitFor(
      () =>
        log.turnStates()[0]?.status === "running" &&
        log.openTurnToolCalls(1).some(
          (call) => call.toolUseId === "toolu_read_1",
        ),
    );
    await first.stop();
    expect(log.turnStates()[0]?.status).toBe("running");

    process.env.CLAUDE_FAKE_MODE = "happy";
    const second = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    second.start();
    await waitFor(
      () =>
        log.turnStates()[0]?.status === "interrupted" &&
        poster.posts.some(
          (post) =>
            !post.ephemeral &&
            activityBody(post.content)?.includes("external tool call"),
        ),
    );
    expect(log.turnStates()).toHaveLength(1);
    expect(
      logger.entries().filter(
        (entry) =>
          entry.event === "restart_turn_disposition" &&
          entry.reason === "unresolved_tool_call",
      ),
    ).toHaveLength(1);
    await second.stop();
    log.close();
  });
  it("AC7 child-restart: SIGKILL then prompted resumes the persisted session", async () => {
    const { dir, log, config } = setup();
    log.close();
    const port = await freePort();
    const requests: unknown[] = [];
    const graphql = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            data: {
              agentActivityCreate: {
                success: true,
                agentActivity: { id: "a" },
              },
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      graphql.listen(0, "127.0.0.1", resolve),
    );
    const graphqlPort = (graphql.address() as { port: number }).port;
    const proxy = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          files: [{ provider: "claude", disabled: false, failed: false }],
        }),
      );
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as { port: number }).port;
    const proxyEnv = join(dir, "proxy.env");
    writeFileSync(
      proxyEnv,
      "CLIPROXY_API_KEY=integration-api-key\nCLIPROXY_MANAGEMENT_KEY=management-key\n",
    );
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    const env = {
      ...process.env,
      DAEMON_TEST_MODE: "1",
      PORT: String(port),
      BIND_ADDR: "127.0.0.1",
      DB_PATH: config.dbPath,
      PLANNER_WEBHOOK_SECRET: "planner-secret",
      PLANNER_LINEAR_TOKEN: "p",
      IMPLEMENTER_WEBHOOK_SECRET: "i",
      IMPLEMENTER_LINEAR_TOKEN: "i",
      SESSIONS_ENABLED: "1",
      TARGET_REPO_PATH: config.targetRepoPath!,
      WORKTREES_ROOT: config.worktreesRoot,
      LINEAR_API_KEY: "key",
      CLAUDE_BIN: `${process.execPath} ${resolve("test/fixtures/fake-claude.mjs")}`,
      CLAUDE_PERMISSION_MODE: "plan",
      ATTACHMENTS_ENABLED: "0",
      FABLE_BIN: `${process.execPath} ${resolve("test/fixtures/fake-claude.mjs")} --fable-launcher`,
      CLIPROXY_ENV_FILE: proxyEnv,
      CLIPROXY_URL: `http://127.0.0.1:${proxyPort}`,
      PROVIDER_INITIAL_PROBE_TIMEOUT_MS: "1000",
      LINEAR_GRAPHQL_URL: `http://127.0.0.1:${graphqlPort}/graphql`,
    };
    let daemonOutput = "";
    const launch = () => {
      const launched = spawn(process.execPath, [resolve("dist/index.js")], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
      launched.stdout?.on("data", (chunk) => {
        daemonOutput += String(chunk);
      });
      return launched;
    };
    const send = async (delivery: string, body: Record<string, unknown>) => {
      const encoded = JSON.stringify({ webhookTimestamp: Date.now(), ...body });
      const signature = createHmac("sha256", "planner-secret")
        .update(encoded)
        .digest("hex");
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/webhook/planner`, {
            method: "POST",
            body: encoded,
            headers: {
              "Linear-Signature": signature,
              "Linear-Delivery": delivery,
            },
          })
        ).status,
      ).toBe(200);
    };
    let child = launch();
    await healthy(port, child);
    await send("d1", {
      action: "created",
      promptContext: "plan",
      agentSession: {
        id: "session",
        issue: { id: "issue", identifier: "ENG-7" },
      },
    });
    await waitFor(() => {
      const db = new EventLog(config.dbPath);
      const done = db.turnStates()[0]?.status === "done";
      db.close();
      return done;
    });
    {
      const db = new EventLog(config.dbPath);
      expect(db.getProviderState("claude")).toMatchObject({ status: "ready" });
      expect(db.getSession("session")?.profile).toBe("fable");
      db.close();
    }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    child = launch();
    await healthy(port, child);
    await send("d2", {
      action: "prompted",
      agentActivity: { body: "continue" },
      agentSession: { id: "session" },
    });
    await waitFor(() => {
      const db = new EventLog(config.dbPath);
      const done = db.turnStates()[1]?.status === "done";
      db.close();
      return done;
    });
    {
      const db = new EventLog(config.dbPath);
      db.recordRestartIntent("test hard restart policy");
      db.close();
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    expect(
      daemonOutput
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.event === "shutdown"),
    ).toMatchObject({
      event: "shutdown",
      signal: "SIGTERM",
      policy: "hard_restart",
      runningTurns: [],
    });
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts.map((row) => row.args.includes("--fable-launcher"))).toEqual([
      true,
      true,
    ]);
    expect(starts[1].args).toContain("--resume");
    expect(starts[1].args).toContain("claude-session-1");
    expect(requests.length).toBeGreaterThan(2);
    const persisted = new EventLog(config.dbPath);
    expect(persisted.getSession("session")?.profile).toBe("fable");
    persisted.close();
    await new Promise<void>((resolve) => graphql.close(() => resolve()));
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }, 10_000);
  it("persists a compacted session id and never posts progress after the terminal response", async () => {
    const { dir, log, config } = setup();
    process.env.CLAUDE_FAKE_MODE = "new-id";
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    class DelayedPoster extends Poster {
      override async postActivity(
        app: string,
        session: string,
        id: string,
        content: ProgressContent | TerminalContent,
        ephemeral: boolean,
      ): Promise<PostResult> {
        if (ephemeral) await new Promise((resolve) => setTimeout(resolve, 30));
        return super.postActivity(app, session, id, content, ephemeral);
      }
    }
    const poster = new DelayedPoster();
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    expect(log.getSession("session")?.claudeSessionId).toBe("claude-session-2");
    process.env.CLAUDE_FAKE_MODE = "happy";
    append(log, "d2", "session", "prompted");
    worker.trigger();
    await waitFor(() => log.turnStates()[1]?.status === "done");
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts[1].args).toContain("claude-session-2");
    expect(poster.posts.at(-1)?.ephemeral).toBe(false);
    await worker.stop();
    log.close();
  });
  it.each([
    ["error-result-exit", "Planner turn failed: Claude exited with code 11"],
    ["denied", "Planner turn failed: Claude permission was denied"],
    ["no-result", "Planner turn failed: Claude exited without a result"],
    [
      "non-capacity-api-error",
      "Planner turn failed: Claude exited with code 1",
    ],
  ])(
    "AC7: %s stays on Claude and preserves its terminal classification",
    async (mode, detail) => {
      const { dir, log, config } = setup();
      const poster = new Poster();
      const logger = new CapturingLogger();
      process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
      process.env.CLAUDE_FAKE_MODE = mode;
      config.claudexArgv = [...config.claudeArgv, "--claudex-runtime"];
      config.claudexEnv = { CLAUDE_FAKE_MODE: "happy" };
      append(log, "d1", "session", "created");
      const worker = new SessionWorker(
        log,
        poster as unknown as LinearGateway,
        config,
        { pollMs: 10, reconcileMs: 20, logger },
      );
      worker.start();
      await waitFor(() => log.turnStates()[0]?.status === "failed");
      await worker.stop();
      const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((row) => row.phase === "start");
      expect(starts).toHaveLength(1);
      expect(starts[0].args).not.toContain("--claudex-runtime");
      expect(
        poster.posts
          .filter((post) => !post.ephemeral)
          .map((post) => activityBody(post.content)),
      ).toEqual([detail]);
      expect(
        logger
          .entries()
          .filter((entry) => entry.event === "session_capacity_fallback"),
      ).toHaveLength(0);
      expect(
        logger
          .entries()
          .filter((entry) => entry.event === "session_turn_failed"),
      ).toEqual([
        expect.objectContaining({
          attempts: 1,
          error: detail.replace("Planner turn failed: ", ""),
        }),
      ]);
      expect(log.getSession("session")).toMatchObject({
        runtime: "claude",
        fallbackCause: null,
      });
      log.close();
    },
  );
  it("service shutdown defers signal death before provider or terminal classification", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    process.env.CLAUDE_FAKE_MODE = "hang";
    config.claudexArgv = [...config.claudeArgv, "--claudex-runtime"];
    config.claudexEnv = { CLAUDE_FAKE_MODE: "happy" };
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => {
      if (
        log.turnStates()[0]?.status !== "running" ||
        !readdirSync(dir).includes("args.jsonl")
      )
        return false;
      const contents = readFileSync(
        process.env.CLAUDE_FAKE_ARGS_FILE!,
        "utf8",
      );
      const newline = contents.indexOf("\n");
      if (newline < 0) return false;
      const firstRecord = JSON.parse(contents.slice(0, newline));
      return firstRecord.phase === "start";
    });
    await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0].args).not.toContain("--claudex-runtime");
    expect(log.turnStates()[0]?.status).toBe("running");
    expect(log.pendingTurnActivities()).toEqual([]);
    expect(
      logger
        .entries()
        .filter((entry) => entry.event === "session_capacity_fallback"),
    ).toHaveLength(0);
    expect(
      logger.entries().filter((entry) => entry.event === "session_turn_failed"),
    ).toEqual([]);
    expect(
      logger.entries().filter((entry) => entry.event === "session_turn_deferred"),
    ).toEqual([
      expect.objectContaining({
        turnId: 1,
        reason: "service_shutdown",
      }),
    ]);
    expect(log.getSession("session")).toMatchObject({
      runtime: "claude",
      fallbackCause: null,
    });
    log.close();
  });
  it("AC7: missing Claude binary does not start Claudex and preserves the spawn failure", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    const logger = new CapturingLogger();
    const argsFile = join(dir, "args.jsonl");
    process.env.CLAUDE_FAKE_ARGS_FILE = argsFile;
    config.fableArgv = [join(dir, "missing-claude")];
    config.claudexArgv = [
      process.execPath,
      resolve("test/fixtures/fake-claude.mjs"),
      "--claudex-runtime",
    ];
    config.claudexEnv = { CLAUDE_FAKE_MODE: "happy" };
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20, logger },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    await worker.stop();
    expect(readdirSync(dir)).not.toContain("args.jsonl");
    const terminals = poster.posts
      .filter((post) => !post.ephemeral)
      .map((post) => activityBody(post.content));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toContain("Planner turn failed: spawn");
    expect(terminals[0]).toContain("ENOENT");
    expect(
      logger
        .entries()
        .filter((entry) => entry.event === "session_capacity_fallback"),
    ).toHaveLength(0);
    expect(
      logger.entries().filter((entry) => entry.event === "session_turn_failed"),
    ).toEqual([
      expect.objectContaining({
        attempts: 1,
        error: expect.stringMatching(/^spawn .* ENOENT$/),
      }),
    ]);
    expect(log.getSession("session")).toMatchObject({
      runtime: "claude",
      fallbackCause: null,
    });
    log.close();
  });
  it("phase 4 AC9 preserves the original route and provider session after capacity failure", async () => {
    const { dir, log, config } = setup();
    const poster = new Poster();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    process.env.CLAUDE_FAKE_MODE = "rate-limit-rejected";
    config.claudexArgv = [...config.claudeArgv, "--claudex-runtime"];
    config.claudexEnv = { CLAUDE_FAKE_MODE: "capacity-after-session" };
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(
      log,
      poster as unknown as LinearGateway,
      config,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    expect(log.getSession("session")).toMatchObject({
      profile: "fable",
      runtime: "claude",
      claudeSessionId: "claude-session-1",
    });
    process.env.CLAUDE_FAKE_MODE = "happy";
    append(log, "d2", "session", "prompted");
    worker.trigger();
    await waitFor(() => log.turnStates()[1]?.status === "done");
    await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1].args).toEqual(
      expect.arrayContaining(["--resume", "claude-session-1"]),
    );
    expect(starts[1].args).not.toContain("--claudex-runtime");
    log.close();
  });
});
