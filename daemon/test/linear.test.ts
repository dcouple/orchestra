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
const iso = "2026-07-14T12:00:00.000Z";
function agentSessionNode(id = "session-1", appUserId = "actor-1", issueId = "issue-1") {
  return { __typename: "AgentSession", id, createdAt: iso, updatedAt: iso, dismissedAt: null, archivedAt: null,
    endedAt: null, startedAt: null, plan: null, summary: null, sourceMetadata: null, externalLink: null,
    url: null, slugId: id, status: "active", context: "{}", externalUrls: "{}", type: "issue",
    externalLinks: [], appUser: { id: appUserId }, sourceComment: null, comment: null, creator: null,
    issue: { id: issueId }, dismissedBy: null };
}
function pageInfo(hasNextPage = false, endCursor: string | null = null) {
  return { __typename: "PageInfo", startCursor: null, endCursor, hasPreviousPage: false, hasNextPage };
}
function delegatedAgentSessionNode(id: string, appUserId: string, createdAt = iso, endedAt: string | null = null) {
  return { id, createdAt, endedAt, archivedAt: null, dismissedAt: null, status: endedAt ? "completed" : "active",
    appUser: { id: appUserId }, creator: null };
}

describe("LinearGateway", () => {
  it("lists active agent sessions with the owning app bearer and filters by app actor id", async () => {
    const api = await stub(request => {
      expect(JSON.stringify(request.body)).toContain("agentSessions");
      return { body: { data: { agentSessions: { __typename: "AgentSessionConnection",
        nodes: [
          agentSessionNode("session-1", "actor-1"),
          agentSessionNode("session-2", "other"),
          { ...agentSessionNode("session-3", "actor-1"), status: "completed", endedAt: iso },
          { ...agentSessionNode("session-4", "actor-1"), dismissedAt: iso },
          { ...agentSessionNode("session-5", "actor-1"), archivedAt: iso },
        ],
        pageInfo: pageInfo() } } } };
    });
    const eventLog = log();
    const gateway = new LinearGateway(eventLog, {
      planner: { name: "planner", webhookSecret: "p", staticToken: "token-p" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "token-i" },
    }, api.graphqlUrl, api.tokenUrl);
    await expect(gateway.listAgentSessions("planner", "actor-1", Date.now() + 1000))
      .resolves.toEqual([{ id: "session-1", app: "planner", issueId: "issue-1", createdAt: Date.parse(iso) }]);
    expect(api.requests[0]?.authorization).toBe("Bearer token-p");
    expect(api.requests[0]?.body.variables).toMatchObject({ first: 100 });
    await api.close(); eventLog.close();
  });

  it("requires app actor id before bulk session discovery", async () => {
    const api = await stub(() => ({ body: { data: { agentSessions: { nodes: [], pageInfo: pageInfo() } } } }));
    const eventLog = log();
    const gateway = new LinearGateway(eventLog, {
      planner: { name: "planner", webhookSecret: "p", staticToken: "token-p" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "token-i" },
    }, api.graphqlUrl, api.tokenUrl);
    await expect(gateway.listAgentSessions("planner", undefined, Date.now() + 1000)).rejects.toThrow(/APP_ACTOR_ID/);
    expect(api.requests).toHaveLength(0);
    await api.close(); eventLog.close();
  });

  it("pages delegated issue sessions past 20 and excludes sessions owned by other app actors", async () => {
    let issueSessionPages = 0;
    const api = await stub(request => {
      const text = JSON.stringify(request.body);
      if (text.includes("query delegatedIssues")) {
        return { body: { data: { issues: { nodes: [{ id: "issue-1", identifier: "ENG-1" }],
          pageInfo: pageInfo() } } } };
      }
      if (text.includes("query delegatedIssueAgentSessions")) {
        issueSessionPages++;
        const variables = request.body.variables as { after?: string };
        if (!variables.after) {
          return { body: { data: { issue: { agentSessions: {
            nodes: Array.from({ length: 20 }, (_, index) => delegatedAgentSessionNode(`foreign-${index}`, "other-actor")),
            pageInfo: pageInfo(true, "cursor-20"),
          } } } } };
        }
        return { body: { data: { issue: { agentSessions: {
          nodes: [
            delegatedAgentSessionNode("foreign-20", "other-actor"),
            delegatedAgentSessionNode("old-target", "actor-1", "2026-07-14T11:00:00.000Z", "2026-07-14T11:30:00.000Z"),
            delegatedAgentSessionNode("session-21", "actor-1", "2026-07-14T12:00:00.000Z"),
          ],
          pageInfo: pageInfo(),
        } } } } };
      }
      throw new Error(`unexpected request ${text}`);
    });
    const eventLog = log();
    const gateway = new LinearGateway(eventLog, {
      planner: { name: "planner", webhookSecret: "p", staticToken: "token-p" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "token-i" },
    }, api.graphqlUrl, api.tokenUrl);
    await expect(gateway.listDelegatedIssueAgentSessions("planner", "actor-1", Date.now() + 1000))
      .resolves.toEqual([{ id: "session-21", app: "planner", issueId: "issue-1", issueIdentifier: "ENG-1", createdAt: Date.parse(iso) }]);
    expect(issueSessionPages).toBe(2);
    expect(api.requests.map(request => request.body.variables)).toEqual([
      expect.objectContaining({ first: 50, delegateId: "actor-1" }),
      expect.objectContaining({ issueId: "issue-1", first: 20 }),
      expect.objectContaining({ issueId: "issue-1", first: 20, after: "cursor-20" }),
    ]);
    await api.close(); eventLog.close();
  });

  it("lists prompt activities since the session activity cursor", async () => {
    const api = await stub(request => {
      const text = JSON.stringify(request.body);
      if (text.includes("query agentSession(")) {
        return { body: { data: { agentSession: agentSessionNode("session-1", "actor-1", "issue-1") } } };
      }
      expect(text).toContain("agentSession_activities");
      return { body: { data: { agentSession: { activities: { __typename: "AgentActivityConnection",
        nodes: [{ __typename: "AgentActivity", id: "activity-1", createdAt: iso, updatedAt: iso, archivedAt: null,
          ephemeral: false, signal: null, signalMetadata: null, sourceMetadata: null, sourceComment: null,
          user: { id: "user-1" }, agentSession: { id: "session-1" },
          content: { __typename: "AgentActivityPromptContent", type: "prompt", body: "reply text" } }],
        pageInfo: pageInfo() } } } } };
    });
    const eventLog = log();
    const gateway = new LinearGateway(eventLog, {
      planner: { name: "planner", webhookSecret: "p", staticToken: "token-p" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "token-i" },
    }, api.graphqlUrl, api.tokenUrl);
    await expect(gateway.listSessionActivitiesSince("planner", "session-1", Date.parse("2026-07-14T11:59:00.000Z"), Date.now() + 1000))
      .resolves.toEqual([{ id: "activity-1", body: "reply text", createdAt: Date.parse(iso) }]);
    expect(api.requests[1]?.body.variables).toMatchObject({ id: "session-1", first: 100,
      filter: { type: { eq: "prompt" }, createdAt: { gte: "2026-07-14T11:59:00.000Z" } } });
    await api.close(); eventLog.close();
  });

  it("re-enables a disabled matching webhook and skips an already-enabled one", async () => {
    let enabled = false;
    const api = await stub(request => {
      const text = JSON.stringify(request.body);
      if (text.includes("query webhooks")) return { body: { data: { webhooks: { __typename: "WebhookConnection",
        nodes: [{ __typename: "Webhook", id: "webhook-1", label: "agent", secret: null,
          url: "https://agent.example.com/webhook/planner", updatedAt: iso, resourceTypes: ["AgentSession"],
          archivedAt: null, createdAt: iso, enabled, allPublicTeams: true, team: null, creator: null }],
        pageInfo: pageInfo() } } } };
      expect(text).toContain("updateWebhook");
      enabled = true;
      return { body: { data: { webhookUpdate: { __typename: "WebhookPayload", success: true, lastSyncId: 1,
        webhook: { id: "webhook-1" } } } } };
    });
    const eventLog = log();
    const gateway = new LinearGateway(eventLog, {
      planner: { name: "planner", webhookSecret: "p", staticToken: "token-p" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "token-i" },
    }, api.graphqlUrl, api.tokenUrl);
    await expect(gateway.ensureWebhookEnabled("planner", "https://agent.example.com/webhook/planner", Date.now() + 1000))
      .resolves.toEqual({ matched: true, updated: true });
    await expect(gateway.ensureWebhookEnabled("planner", "https://agent.example.com/webhook/planner", Date.now() + 1000))
      .resolves.toEqual({ matched: true, updated: false });
    const mutations = api.requests.filter(request => JSON.stringify(request.body).includes("updateWebhook"));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.body.variables).toMatchObject({ id: "webhook-1", input: { enabled: true } });
    await api.close(); eventLog.close();
  });

  it("updates session addedExternalUrls with the owning app bearer",async()=>{
    const api=await stub(()=>({body:{data:{agentSessionUpdate:{success:true,agentSession:{id:"session"}}}}}));const eventLog=log();
    const gateway=new LinearGateway(eventLog,{planner:{name:"planner",webhookSecret:"p",staticToken:"p"},implementer:{name:"implementer",webhookSecret:"i",staticToken:"token-i"}},api.graphqlUrl,api.tokenUrl);
    expect(await gateway.setSessionExternalUrl("implementer","session","Pull Request","https://github.com/x/y/pull/1",Date.now()+1000)).toEqual({ok:true});
    expect(api.requests[0]?.authorization).toBe("Bearer token-i");expect(JSON.stringify(api.requests[0]?.body)).toContain("agentSessionUpdate");
    expect(api.requests[0]?.body.variables).toMatchObject({id:"session",input:{addedExternalUrls:[{label:"Pull Request",url:"https://github.com/x/y/pull/1"}]}});await api.close();eventLog.close();
  });
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
    expect(grant.body).toMatchObject({ grant_type: "client_credentials", scope: "read,write,app:assignable,app:mentionable,admin" });
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
