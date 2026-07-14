import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import { LinearGateway } from "../src/linear.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function log(): EventLog { const dir = mkdtempSync(join(tmpdir(), "linear-gateway-")); dirs.push(dir); return new EventLog(join(dir, "db")); }

async function stub(handler: (request: { url: string; authorization?: string; body: Record<string, unknown> }) =>
  { status?: number; headers?: Record<string, string>; body: unknown } | Promise<{ status?: number; headers?: Record<string, string>; body: unknown }>) {
  const requests: Array<{ url: string; authorization?: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const request = { url: req.url!, authorization: req.headers.authorization,
        body: req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) };
      requests.push(request);
      Promise.resolve(handler(request)).then(result => {
      res.writeHead(result.status ?? 200, { "Content-Type": "application/json", ...result.headers }); res.end(JSON.stringify(result.body));
      }).catch(error => {
        res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(error) }));
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return { requests, graphqlUrl: `http://127.0.0.1:${port}/graphql`, tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const success = { data: { agentActivityCreate: { success: true, lastSyncId: 1, agentActivity: { id: "activity" } } } };

describe("LinearGateway", () => {
  it("AC3-contract: SDK mutation carries id, session, ephemeral thought and Bearer token", async () => {
    const api = await stub(() => ({ body: success })); const eventLog = log();
    const gateway = new LinearGateway(eventLog, {
      planner: { name: "planner", webhookSecret: "p", staticToken: "token-p" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "token-i" },
    }, api.graphqlUrl, api.tokenUrl);
    expect(await gateway.postAckActivity("planner", "session-1", "00000000-0000-4000-8000-000000000001", Date.now() + 1000)).toEqual({ ok: true });
    const request = api.requests[0]!;
    expect(request.authorization).toBe("Bearer token-p");
    expect(JSON.stringify(request.body)).toContain("agentActivityCreate");
    expect(request.body.variables).toMatchObject({ input: { id: "00000000-0000-4000-8000-000000000001",
      agentSessionId: "session-1", ephemeral: true, content: { type: "thought", body: "picked up — starting work" } } });
    await api.close(); eventLog.close();
  });

  it("posts non-ephemeral response and error activities", async () => {
    const api = await stub(() => ({ body: success })); const eventLog = log();
    const gateway = new LinearGateway(eventLog, {
      planner: { name: "planner", webhookSecret: "p", staticToken: "token-p" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "token-i" },
    }, api.graphqlUrl, api.tokenUrl);
    await gateway.postActivity("planner", "session", "00000000-0000-4000-8000-000000000010",
      { type: "response", body: "answer" }, false, Date.now() + 1000);
    await gateway.postActivity("planner", "session", "00000000-0000-4000-8000-000000000011",
      { type: "error", body: "failed" }, false, Date.now() + 1000);
    expect(api.requests.map(request => (request.body.variables as { input: Record<string, unknown> }).input))
      .toEqual([expect.objectContaining({ content: { type: "response", body: "answer" } }),
        expect.objectContaining({ content: { type: "error", body: "failed" } })]);
    expect(api.requests.every(request => !(request.body.variables as { input: Record<string, unknown> }).input.ephemeral)).toBe(true);
    await api.close(); eventLog.close();
  });

  it("acquires and persists a client_credentials token, then recovers it after restart", async () => {
    let grants = 0;
    const api = await stub(request => request.url === "/oauth/token"
      ? { body: { access_token: `token-${++grants}`, expires_in: 2_592_000 } } : { body: success });
    const db = log();
    const apps = {
      planner: { name: "planner" as const, webhookSecret: "p", clientId: "id", clientSecret: "secret" },
      implementer: { name: "implementer" as const, webhookSecret: "i", clientId: "id2", clientSecret: "secret2" },
    };
    const first = new LinearGateway(db, apps, api.graphqlUrl, api.tokenUrl);
    expect(await first.getAppToken("planner")).toBe("token-1");
    const second = new LinearGateway(db, apps, api.graphqlUrl, api.tokenUrl);
    expect(await second.getAppToken("planner")).toBe("token-1"); expect(grants).toBe(1);
    const grant = api.requests[0]!;
    expect(grant.body).toMatchObject({ grant_type: "client_credentials", scope: "read,write,app:assignable,app:mentionable" });
    expect(grant.authorization).toMatch(/^Basic /);
    await api.close(); db.close();
  });

  it("renews an expired persisted token", async () => {
    const api = await stub(request => request.url === "/oauth/token"
      ? { body: { access_token: "fresh", expires_in: 2_592_000 } } : { body: success });
    const db = log(); db.putToken("planner", { accessToken: "old", expiresAt: 1 });
    const gateway = new LinearGateway(db, {
      planner: { name: "planner", webhookSecret: "p", clientId: "id", clientSecret: "secret" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "i" },
    }, api.graphqlUrl, api.tokenUrl);
    expect(await gateway.getAppToken("planner")).toBe("fresh");
    await api.close(); db.close();
  });

  it("reacquires once after a GraphQL 401 and retries with the new Bearer token", async () => {
    let grants = 0; let graphqlCalls = 0;
    const api = await stub(request => {
      if (request.url === "/oauth/token") return { body: { access_token: `token-${++grants}`, expires_in: 2_592_000 } };
      graphqlCalls++;
      return graphqlCalls === 1 ? { status: 401, body: { errors: [{ message: "unauthorized" }] } } : { body: success };
    });
    const db = log();
    const gateway = new LinearGateway(db, {
      planner: { name: "planner", webhookSecret: "p", clientId: "id", clientSecret: "secret" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "i" },
    }, api.graphqlUrl, api.tokenUrl);
    expect(await gateway.postAckActivity("planner", "session", "00000000-0000-4000-8000-000000000001", Date.now() + 1000)).toEqual({ ok: true });
    expect(grants).toBe(2); expect(graphqlCalls).toBe(2);
    expect(api.requests.filter(request => request.url === "/graphql").map(request => request.authorization))
      .toEqual(["Bearer token-1", "Bearer token-2"]);
    await api.close(); db.close();
  });

  it("coalesces concurrent client_credentials grants per app", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let grants = 0;
    const api = await stub(async request => {
      if (request.url === "/oauth/token") {
        grants++;
        await gate;
        return { body: { access_token: "shared", expires_in: 2_592_000 } };
      }
      return { body: success };
    });
    const db = log();
    const gateway = new LinearGateway(db, {
      planner: { name: "planner", webhookSecret: "p", clientId: "id", clientSecret: "secret" },
      implementer: { name: "implementer", webhookSecret: "i", clientId: "id2", clientSecret: "secret2" },
    }, api.graphqlUrl, api.tokenUrl);
    const tokens = Promise.all([
      gateway.getAppToken("planner", Date.now() + 1000),
      gateway.getAppToken("planner", Date.now() + 1000),
      gateway.getAppToken("planner", Date.now() + 1000),
    ]);
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    expect(await tokens).toEqual(["shared", "shared", "shared"]);
    expect(grants).toBe(1);
    await api.close(); db.close();
  });

  it("aborts OAuth acquisition at the shared deadline", async () => {
    const api = await stub(async request => {
      if (request.url === "/oauth/token") {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { body: { access_token: "late", expires_in: 2_592_000 } };
      }
      return { body: success };
    });
    const db = log();
    const gateway = new LinearGateway(db, {
      planner: { name: "planner", webhookSecret: "p", clientId: "id", clientSecret: "secret" },
      implementer: { name: "implementer", webhookSecret: "i", clientId: "id2", clientSecret: "secret2" },
    }, api.graphqlUrl, api.tokenUrl);
    await expect(gateway.getAppToken("planner", Date.now() + 20)).rejects.toThrow(/deadline exceeded|timed out|abort/i);
    await api.close(); db.close();
  });

  it("bounds each waiter on a shared client_credentials grant by its own deadline", async () => {
    const api = await stub(async request => {
      if (request.url === "/oauth/token") {
        await new Promise(resolve => setTimeout(resolve, 80));
        return { body: { access_token: "shared", expires_in: 2_592_000 } };
      }
      return { body: success };
    });
    const db = log();
    const gateway = new LinearGateway(db, {
      planner: { name: "planner", webhookSecret: "p", clientId: "id", clientSecret: "secret" },
      implementer: { name: "implementer", webhookSecret: "i", clientId: "id2", clientSecret: "secret2" },
    }, api.graphqlUrl, api.tokenUrl);
    const short = gateway.getAppToken("planner", Date.now() + 20);
    const long = gateway.getAppToken("planner", Date.now() + 500);
    await expect(short).rejects.toThrow(/deadline exceeded/i);
    await expect(long).resolves.toBe("shared");
    expect(api.requests.filter(request => request.url === "/oauth/token")).toHaveLength(1);
    await api.close(); db.close();
  });

  it("classifies GraphQL rate-limit errors in HTTP 200 bodies as retriable with SDK retryAfter pacing", async () => {
    const api = await stub(request => request.url === "/graphql"
      ? {
          headers: { "Retry-After": "3" },
          body: { errors: [{ message: "Too many requests", extensions: { type: "ratelimited" } }] },
        }
      : { body: { access_token: "token", expires_in: 2_592_000 } });
    const db = log();
    const gateway = new LinearGateway(db, {
      planner: { name: "planner", webhookSecret: "p", staticToken: "token" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "i" },
    }, api.graphqlUrl, api.tokenUrl);
    expect(await gateway.postAckActivity("planner", "session", "00000000-0000-4000-8000-000000000001", Date.now() + 1000))
      .toMatchObject({ ok: false, retriable: true, retryAfterMs: 3000 });
    await api.close(); db.close();
  });

  it("treats token endpoint 400 invalid_client as terminal", async () => {
    const api = await stub(request => request.url === "/oauth/token"
      ? { status: 400, body: { error: "invalid_client", error_description: "bad client secret" } }
      : { body: success });
    const db = log();
    const gateway = new LinearGateway(db, {
      planner: { name: "planner", webhookSecret: "p", clientId: "id", clientSecret: "bad" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "i" },
    }, api.graphqlUrl, api.tokenUrl);
    expect(await gateway.postAckActivity("planner", "session", "00000000-0000-4000-8000-000000000001", Date.now() + 1000))
      .toMatchObject({ ok: false, retriable: false });
    expect(api.requests.filter(request => request.url === "/graphql")).toHaveLength(0);
    await api.close(); db.close();
  });

  it("treats token endpoint 503 as retriable", async () => {
    const api = await stub(request => request.url === "/oauth/token"
      ? { status: 503, body: { error: "temporarily_unavailable" } }
      : { body: success });
    const db = log();
    const gateway = new LinearGateway(db, {
      planner: { name: "planner", webhookSecret: "p", clientId: "id", clientSecret: "secret" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "i" },
    }, api.graphqlUrl, api.tokenUrl);
    expect(await gateway.postAckActivity("planner", "session", "00000000-0000-4000-8000-000000000001", Date.now() + 1000))
      .toMatchObject({ ok: false, retriable: true });
    expect(api.requests.filter(request => request.url === "/graphql")).toHaveLength(0);
    await api.close(); db.close();
  });
});
