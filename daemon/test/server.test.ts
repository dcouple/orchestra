import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AckWorker } from "../src/ack.js";
import type { Config } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import { LinearGateway } from "../src/linear.js";
import { WebhookServer } from "../src/server.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "linear-server-")); dirs.push(dir);
  const log = new EventLog(join(dir, "events.db"));
  const config: Config = {
    port: 0, bindAddr: "127.0.0.1", dbPath: join(dir, "events.db"), replayWindowMs: 60_000,
    linearGraphqlUrl: "http://unused", linearTokenUrl: "http://unused",
    apps: {
      planner: { name: "planner", webhookSecret: "planner-secret", staticToken: "p" },
      implementer: { name: "implementer", webhookSecret: "implementer-secret", staticToken: "i" },
    },
  };
  const onInserted = vi.fn();
  const server = new WebhookServer({ config, log, onInserted, logger: { log: vi.fn(), error: vi.fn() } });
  return { config, log, server, onInserted };
}

function signed(body: string, secret = "planner-secret", delivery = "delivery-1") {
  return { "Linear-Signature": createHmac("sha256", secret).update(body).digest("hex"), "Linear-Delivery": delivery };
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  return port;
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`child exited before health check: ${child.exitCode}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error("child daemon did not become healthy");
}

describe("webhook HTTP integration", () => {
  it("persists a signed Issue webhook without acking or creating a turn",async()=>{
    const {log,server}=setup();const address=await server.listen();const body=JSON.stringify({webhookTimestamp:Date.now(),type:"Issue",action:"update",data:{id:"issue",identifier:"ENG-42",state:{type:"completed"}}});
    const response=await fetch(`http://127.0.0.1:${address.port}/webhook/implementer`,{method:"POST",headers:signed(body,"implementer-secret","issue-delivery"),body});
    expect(response.status).toBe(200);expect(log.count()).toBe(1);expect(log.ackCount()).toBe(0);expect(log.turnStates()).toHaveLength(0);await server.close();log.close();
  });
  it("AC1: responds under 5s and persists a signed fresh event", async () => {
    const { log, server } = setup(); const address = await server.listen();
    const body = JSON.stringify({ webhookTimestamp: Date.now(), webhookId: "wh", action: "created",
      agentSession: { id: "session", issue: { id: "issue", identifier: "ENG-42" } } });
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/planner`, { method: "POST", headers: signed(body), body });
    expect(response.status).toBe(200); expect(performance.now() - started).toBeLessThan(5000);
    expect(log.count()).toBe(1); expect(log.ackCount()).toBe(1);
    expect(log.getSession("session")).toMatchObject({ issueId: "issue", issueIdentifier: "ENG-42" });
    await server.close(); log.close();
  });

  it.each(["missing", "tampered", "stale", "malformed"])("AC2: rejects %s payloads without persistence", async kind => {
    const { log, server } = setup(); const address = await server.listen();
    let body = kind === "malformed" ? "{" : JSON.stringify({ webhookTimestamp: kind === "stale" ? Date.now() - 60_001 : Date.now() });
    let headers: Record<string, string> = signed(body);
    if (kind === "missing") delete headers["Linear-Signature"];
    if (kind === "tampered") { headers = signed(body); body += " "; }
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/planner`, { method: "POST", headers, body });
    expect(response.status).toBe(401); expect(log.count()).toBe(0);
    await server.close(); log.close();
  });

  it("rejects a planner-signed payload on the implementer route", async () => {
    const { log, server } = setup(); const address = await server.listen();
    const body = JSON.stringify({ webhookTimestamp: Date.now() });
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/implementer`, { method: "POST", headers: signed(body), body });
    expect(response.status).toBe(401); expect(log.count()).toBe(0);
    await server.close(); log.close();
  });

  it("AC4: duplicate Linear-Delivery produces one event and one ack", async () => {
    const { log, server, onInserted } = setup(); const address = await server.listen();
    const body = JSON.stringify({ webhookTimestamp: Date.now(), action: "created", agentSession: { id: "s" } });
    for (let i = 0; i < 2; i++) await fetch(`http://127.0.0.1:${address.port}/webhook/planner`, { method: "POST", headers: signed(body), body });
    expect(log.count()).toBe(1); expect(log.ackCount()).toBe(1); expect(onInserted).toHaveBeenCalledTimes(1);
    await server.close(); log.close();
  });

  it("dedupes prompted webhooks for the same agentActivity id across deliveries", async () => {
    const { log, server } = setup(); const address = await server.listen();
    const created = JSON.stringify({ webhookTimestamp: Date.now(), action: "created",
      agentSession: { id: "session", issue: { id: "issue", identifier: "ENG-42" } } });
    expect((await fetch(`http://127.0.0.1:${address.port}/webhook/planner`, { method: "POST", headers: signed(created, "planner-secret", "created"), body: created })).status).toBe(200);
    const prompted = JSON.stringify({ webhookTimestamp: Date.now(), action: "prompted",
      agentActivity: { id: "activity-1", body: "reply" }, agentSession: { id: "session" } });
    expect((await fetch(`http://127.0.0.1:${address.port}/webhook/planner`, { method: "POST", headers: signed(prompted, "planner-secret", "prompt-1"), body: prompted })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${address.port}/webhook/planner`, { method: "POST", headers: signed(prompted, "planner-secret", "prompt-2"), body: prompted })).status).toBe(200);
    expect(log.turnStates().map(turn => turn.kind)).toEqual(["created", "prompted"]);
    await server.close(); log.close();
  });

  it("AC3-contract: signed created webhook automatically drains through the ack worker to GraphQL", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const graphql = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: { agentActivityCreate: { success: true, lastSyncId: 1, agentActivity: { id: "a" } } } }));
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      graphql.once("error", reject);
      graphql.listen(0, "127.0.0.1", resolveListen);
    });
    const graphqlPort = (graphql.address() as { port: number }).port;
    const { config, log } = setup();
    config.linearGraphqlUrl = `http://127.0.0.1:${graphqlPort}/graphql`;
    const gateway = new LinearGateway(log, config.apps, config.linearGraphqlUrl, config.linearTokenUrl);
    const worker = new AckWorker(log, gateway, { pollMs: 25, reconcileMs: 100, attemptTimeoutMs: 500 });
    const server = new WebhookServer({ config, log, onInserted: () => worker.trigger(), logger: { log: vi.fn(), error: vi.fn() } });
    worker.start();
    try {
      const address = await server.listen();
      const body = JSON.stringify({ webhookTimestamp: Date.now(), webhookId: "wh", action: "created",
        agentSession: { id: "session-e2e", issue: { id: "issue" } } });
      expect((await fetch(`http://127.0.0.1:${address.port}/webhook/planner`, { method: "POST", headers: signed(body), body })).status).toBe(200);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(JSON.stringify(requests[0])).toContain("session-e2e");
      expect(log.ackStates()[0]).toMatchObject({ status: "acked", attempts: 1 });
    } finally {
      worker.stop();
      await server.close(); log.close();
      await new Promise<void>(resolveClose => graphql.close(() => resolveClose()));
    }
  });

  it("persists signed unknown shapes but skips ack and exposes minimal health", async () => {
    const { log, server } = setup(); const address = await server.listen();
    const body = JSON.stringify({ webhookTimestamp: Date.now(), surprising: true });
    expect((await fetch(`http://127.0.0.1:${address.port}/webhook/planner`, { method: "POST", headers: signed(body), body })).status).toBe(200);
    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(await health.json()).toEqual({ ok: true }); expect(log.count()).toBe(1); expect(log.ackCount()).toBe(0);
    await server.close(); log.close();
  });

  it("rejects bodies over 1 MB with 413", async () => {
    const { log, server } = setup(); const address = await server.listen();
    const response = await new Promise<string>((resolveResponse, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      let raw = "";
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error("timed out waiting for 413"));
      });
      socket.on("connect", () => {
        socket.write([
          "POST /webhook/planner HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Length: 1048577",
          "Linear-Signature: oversized",
          "Linear-Delivery: oversized-delivery",
          "",
          "",
        ].join("\r\n"));
      });
      socket.on("data", chunk => { raw += chunk.toString(); });
      socket.on("end", () => resolveResponse(raw));
      socket.on("close", () => resolveResponse(raw));
      socket.on("error", reject);
    });
    expect(response.startsWith("HTTP/1.1 413")).toBe(true); expect(log.count()).toBe(0);
    await server.close(); log.close();
  });

  it("AC5-contract: SIGKILL restart preserves rows and restores health", async () => {
    const dir = mkdtempSync(join(tmpdir(), "linear-child-")); dirs.push(dir);
    const dbPath = join(dir, "events.db"); const port = await freePort();
    const graphql = createHttpServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: { agentActivityCreate: { success: true, lastSyncId: 1, agentActivity: { id: "a" } } } }));
    });
    await new Promise<void>((resolveListen, reject) => {
      graphql.once("error", reject);
      graphql.listen(0, "127.0.0.1", resolveListen);
    });
    const graphqlPort = (graphql.address() as { port: number }).port;
    const env = { ...process.env, PORT: String(port), BIND_ADDR: "127.0.0.1", DB_PATH: dbPath,
      DAEMON_TEST_MODE: "1",
      SESSIONS_ENABLED: "0",
      RECONCILE_REQUEST_TIMEOUT_MS: "100",
      LINEAR_GRAPHQL_URL: `http://127.0.0.1:${graphqlPort}/graphql`,
      PLANNER_WEBHOOK_SECRET: "planner-secret", PLANNER_LINEAR_TOKEN: "p",
      IMPLEMENTER_WEBHOOK_SECRET: "implementer-secret", IMPLEMENTER_LINEAR_TOKEN: "i" };
    const launch = () => spawn(process.execPath, [resolve("dist/index.js")], { env, stdio: "ignore" });
    let child = launch();
    try {
      await waitForHealth(port, child);
      const body = JSON.stringify({ webhookTimestamp: Date.now(), action: "created", agentSession: { id: "session" } });
      expect((await fetch(`http://127.0.0.1:${port}/webhook/planner`, { method: "POST", headers: signed(body), body })).status).toBe(200);
      child.kill("SIGKILL"); await once(child, "exit");
      const afterKill = new EventLog(dbPath); expect(afterKill.count()).toBe(1); afterKill.close();
      child = launch(); await waitForHealth(port, child);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      const afterRestart = new EventLog(dbPath); expect(afterRestart.count()).toBe(1); afterRestart.close();
    } finally {
      if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
      await new Promise<void>(resolveClose => graphql.close(() => resolveClose()));
    }
  }, 15_000);
});
