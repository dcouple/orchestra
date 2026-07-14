import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import type { AgentPromptActivity, AgentSessionSummary, LinearGateway, WebhookEnsureResult } from "../src/linear.js";
import { ReconcileWorker } from "../src/reconcile.js";

const dirs: string[] = [];
function path(): string { const dir = mkdtempSync(join(tmpdir(), "linear-reconcile-")); dirs.push(dir); return join(dir, "events.db"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 0, bindAddr: "127.0.0.1", dbPath: ":memory:", replayWindowMs: 60_000,
    linearGraphqlUrl: "http://unused", linearTokenUrl: "http://unused", webhookBaseUrl: "https://agent.example.com",
    reconcileIntervalMs: 60_000, reconcileRequestTimeoutMs: 1_000,
    apps: {
      planner: { name: "planner", webhookSecret: "p", staticToken: "p", appActorId: "planner-actor" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "i", appActorId: "implementer-actor" },
    },
    sessionsEnabled: false, worktreesRoot: "/tmp/worktrees", claudeArgv: ["claude"], claudePermissionMode: "plan",
    claudeMaxTurns: 5, doPermissionMode: "plan", doMaxTurns: 50, sessionConcurrency: 2, keepaliveMs: 900_000,
    attachmentsEnabled: false, attachmentHosts: ["uploads.linear.app"],
    ...overrides,
  };
}

class FakeGateway {
  sessions: Record<string, AgentSessionSummary[]> = { planner: [], implementer: [] };
  activities = new Map<string, AgentPromptActivity[]>();
  ensureResults: WebhookEnsureResult[] = [];
  ensureCalls: Array<{ app: string; url: string }> = [];
  activityCalls: Array<{ app: string; session: string; since: number | null }> = [];
  sessionCalls: Array<{ app: string; appActorId?: string }> = [];
  sessionGate: Promise<void> | undefined;

  async ensureWebhookEnabled(app: string, url: string): Promise<WebhookEnsureResult> {
    this.ensureCalls.push({ app, url });
    return this.ensureResults.shift() ?? { matched: true, updated: false };
  }
  async listAgentSessions(app: "planner" | "implementer", appActorId?: string): Promise<AgentSessionSummary[]> {
    this.sessionCalls.push({ app, ...(appActorId ? { appActorId } : {}) });
    if (this.sessionGate) await this.sessionGate;
    return this.sessions[app] ?? [];
  }
  async listDelegatedIssueAgentSessions(): Promise<AgentSessionSummary[]> { return []; }
  async listSessionActivitiesSince(app: "planner" | "implementer", session: string, since: number | null): Promise<AgentPromptActivity[]> {
    this.activityCalls.push({ app, session, since });
    return this.activities.get(session) ?? [];
  }
}

function created(log: EventLog, deliveryId: string, app: "planner" | "implementer", session = `${app}-session`, issue = "issue-1", identifier = "ENG-1"): void {
  log.append({ deliveryId, app, action: "created", agentSessionId: session, issueId: issue, issueIdentifier: identifier,
    receivedAt: 1_000, rawBody: Buffer.from(JSON.stringify({ action: "created", agentSession: { id: session, issue: { id: issue, identifier } } })) });
}

describe("ReconcileWorker", () => {
  it("AC1: reconciled created sessions dedupe with real webhooks in all orderings", async () => {
    for (const ordering of ["reconcile-then-real", "real-while-running", "real-after-done"] as const) {
      const log = new EventLog(path());
      const gateway = new FakeGateway();
      gateway.sessions.planner = [{ id: "session-1", app: "planner", issueId: "issue-1", issueIdentifier: "ENG-1" }];
      const onInserted = vi.fn();
      const worker = new ReconcileWorker(log, gateway as unknown as LinearGateway, config(), { onInserted, logger: { log: vi.fn(), error: vi.fn() }, now: () => 2_000 });
      if (ordering === "reconcile-then-real") {
        await worker.trigger();
        created(log, "real-created", "planner", "session-1", "issue-1", "ENG-1");
      } else if (ordering === "real-while-running") {
        let release!: () => void;
        gateway.sessionGate = new Promise<void>(resolve => { release = resolve; });
        const sweep = worker.trigger();
        await Promise.resolve();
        created(log, "real-created", "planner", "session-1", "issue-1", "ENG-1");
        release();
        await sweep;
      } else {
        created(log, "real-created", "planner", "session-1", "issue-1", "ENG-1");
        const turn = log.claimNextTurn(1_100)!;
        log.finishTurn(turn.id, "response", "done", 1_200);
        log.markTurnActivityPosted(turn.id, 1_300);
        await worker.trigger();
      }
      expect(log.turnStates()).toHaveLength(1);
      expect(log.ackCount()).toBe(1);
      await worker.stop();
      log.close();
    }
  });

  it("AC2: catches up planner prompt activities with durable body and cursor, but not implementer replies", async () => {
    const log = new EventLog(path());
    created(log, "planner-created", "planner", "planner-session", "issue-1", "ENG-1");
    log.updateLastSeenActivity("planner-session", 5_000, 1_001);
    created(log, "implementer-created", "implementer", "implementer-session", "issue-2", "ENG-2");
    const gateway = new FakeGateway();
    gateway.activities.set("planner-session", [{ id: "activity-1", body: "the real reply text", createdAt: 5_100 }]);
    gateway.activities.set("implementer-session", [{ id: "activity-2", body: "implementer reply", createdAt: 5_100 }]);
    const worker = new ReconcileWorker(log, gateway as unknown as LinearGateway, config(), { logger: { log: vi.fn(), error: vi.fn() }, now: () => 6_000 });
    await worker.trigger();
    expect(gateway.activityCalls).toEqual([{ app: "planner", session: "planner-session", since: 5_000 }]);
    expect(log.turnStates().map(turn => turn.kind)).toEqual(["created", "created", "prompted"]);
    const first = log.claimNextTurn(6_001)!; log.finishTurn(first.id, "response", "done", 6_002); log.markTurnActivityPosted(first.id, 6_003);
    const implementer = log.claimNextTurn(6_004)!; log.finishTurn(implementer.id, "response", "done", 6_005); log.markTurnActivityPosted(implementer.id, 6_006);
    const prompt = log.claimNextTurn(6_007)!;
    expect(prompt.rawBody.toString("utf8")).toContain("the real reply text");
    await worker.trigger();
    log.append({ deliveryId: "real-prompt", app: "planner", action: "prompted", agentSessionId: "planner-session",
      sourceActivityId: "activity-1", receivedAt: 7_000, rawBody: Buffer.from(JSON.stringify({ action: "prompted",
        agentSession: { id: "planner-session" }, agentActivity: { id: "activity-1", body: "the real reply text" } })) });
    log.append({ deliveryId: "implementer-prompt", app: "implementer", action: "prompted", agentSessionId: "implementer-session",
      sourceActivityId: "activity-2", receivedAt: 7_001, rawBody: Buffer.from("{}") });
    expect(log.turnStates()).toHaveLength(3);
    expect(log.getSession("planner-session")?.lastSeenActivityAt).toBe(5_100);
    await worker.stop();
    log.close();
  });

  it("AC3: checks both app webhooks even when sessions are disabled", async () => {
    const log = new EventLog(path());
    const gateway = new FakeGateway();
    gateway.ensureResults = [{ matched: true, updated: true }, { matched: true, updated: false }];
    const worker = new ReconcileWorker(log, gateway as unknown as LinearGateway, config({ sessionsEnabled: false }),
      { logger: { log: vi.fn(), error: vi.fn() }, now: () => 1_000 });
    await worker.trigger();
    expect(gateway.ensureCalls).toEqual([
      { app: "planner", url: "https://agent.example.com/webhook/planner" },
      { app: "implementer", url: "https://agent.example.com/webhook/implementer" },
    ]);
    await worker.stop();
    log.close();
  });

  it("skips session synthesis without app actor ids while still checking webhooks", async () => {
    const log = new EventLog(path());
    const gateway = new FakeGateway();
    const logger = { log: vi.fn(), error: vi.fn() };
    const worker = new ReconcileWorker(log, gateway as unknown as LinearGateway, config({
      sessionsEnabled: false,
      apps: {
        planner: { name: "planner", webhookSecret: "p", staticToken: "p" },
        implementer: { name: "implementer", webhookSecret: "i", staticToken: "i" },
      },
    }), { logger, now: () => 1_000 });
    await worker.trigger();
    expect(gateway.ensureCalls).toEqual([
      { app: "planner", url: "https://agent.example.com/webhook/planner" },
      { app: "implementer", url: "https://agent.example.com/webhook/implementer" },
    ]);
    expect(gateway.sessionCalls).toEqual([]);
    expect(logger.error.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringContaining("reconcile_sessions_skipped_missing_app_actor_id"),
      expect.stringContaining("reconcile_sessions_skipped_missing_app_actor_id"),
    ]);
    await worker.stop();
    log.close();
  });
});
