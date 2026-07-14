import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";

const dirs: string[] = [];
function path(): string { const dir = mkdtempSync(join(tmpdir(), "linear-eventlog-")); dirs.push(dir); return join(dir, "events.db"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function event(overrides: Record<string, unknown> = {}) {
  return { deliveryId: "delivery-1", app: "planner" as const, action: "created", agentSessionId: "session-1",
    issueId: "issue-uuid-1", issueIdentifier: "ENG-42", webhookId: "webhook-1", receivedAt: 1000, rawBody: Buffer.from("{}"), ...overrides };
}

describe("EventLog", () => {
  it("atomically appends an event and pending ack, then deduplicates redelivery", () => {
    const log = new EventLog(path());
    expect(log.append(event()).inserted).toBe(true);
    expect(log.append(event()).inserted).toBe(false);
    expect(log.count()).toBe(1);
    expect(log.ackCount()).toBe(1);
    expect(log.pendingAcks(1000)).toHaveLength(1);
    expect(log.ackStates()[0]).toMatchObject({ nextAttemptAt: 1000, failureKind: null });
    log.close();
  });

  it("does not dedupe separate deliveries sharing a webhook id", () => {
    const log = new EventLog(path());
    log.append(event());
    log.append(event({ deliveryId: "delivery-2" }));
    expect(log.count()).toBe(2);
    expect(log.ackCount()).toBe(2);
    log.close();
  });

  it("creates no ack row for prompted or unrecognized events", () => {
    const log = new EventLog(path());
    log.append(event({ action: "prompted" }));
    expect(log.ackCount()).toBe(0);
    expect(log.turnStates()).toHaveLength(1);
    log.close();
  });

  it("fans out planner and implementer created turns, but implementer prompted is ignored", () => {
    const log = new EventLog(path());
    log.append(event());
    log.append(event({ deliveryId: "delivery-2", action: "prompted", issueId: undefined, issueIdentifier: undefined }));
    log.append(event({ deliveryId: "delivery-3", app: "implementer" }));
    log.append(event({ deliveryId: "delivery-4", app: "implementer", action: "prompted" }));
    expect(log.turnStates()).toHaveLength(3);
    expect(log.claimNextTurn(1100)).toMatchObject({ kind: "created", issueId: "issue-uuid-1" });
    expect(log.claimNextTurn(1100)).toBeUndefined();
    log.finishTurn(1, "response", "done", 1200);
    log.markTurnActivityPosted(1, 1201);
    expect(log.claimNextTurn(1300)).toMatchObject({ kind: "prompted", issueId: "issue-uuid-1" });
    log.close();
  });

  it("persists dedicated external URLs and cleanup jobs across reopen", () => {
    const dbPath = path(); const log = new EventLog(dbPath);
    log.append(event()); log.updateSessionWorktree("session-1", "/worktree", "agents/ENG-42", 1001);
    log.append(event({ deliveryId:"impl",app:"implementer",agentSessionId:"impl-session",receivedAt:1002 }));
    log.updateSessionWorktree("impl-session","/worktree","agents/ENG-42",1003);
    for(let i=0;i<2;i++){const turn=log.claimNextTurn(1003+i)!;log.finishTurn(turn.id,"response","done",1003+i);log.markTurnActivityPosted(turn.id,1003+i);}
    expect(log.sessionByIssueIdentifier("ENG-42")?.linearSessionId).toBe("impl-session");
    log.stageExternalUrl("impl-session","implementer","Pull Request","https://github.com/x/y/pull/1",1004);
    log.stageExternalUrl("impl-session","implementer","Pull Request","https://github.com/x/y/pull/1",1005);
    log.append(event({deliveryId:"issue-done",app:"implementer",agentSessionId:undefined,action:"update",type:"Issue",stateType:"completed",receivedAt:1006}));
    expect(log.externalUrlStates()).toHaveLength(1); expect(log.cleanupStates()).toHaveLength(1);
    log.close(); const reopened=new EventLog(dbPath);
    expect(reopened.pendingExternalUrls(1006)).toHaveLength(1);
    expect(reopened.claimNextCleanup(1006)).toMatchObject({linearSessionId:"impl-session",app:"implementer"});
    reopened.close();
  });
  it("makes turn and cleanup claims mutually exclusive per issue",()=>{
    const log=new EventLog(path());log.append(event({app:"implementer"}));log.updateSessionWorktree("session-1","/worktree","agents/ENG-42",1001);
    log.append(event({deliveryId:"done",app:"implementer",agentSessionId:undefined,action:"update",type:"Issue",stateType:"completed",receivedAt:1002}));
    expect(log.claimNextCleanup(1002)).toBeUndefined();const first=log.claimNextTurn(1002)!;log.finishTurn(first.id,"response","done",1003);log.markTurnActivityPosted(first.id,1003);
    expect(log.claimNextCleanup(1004)).toBeDefined();log.append(event({deliveryId:"planner",app:"planner",agentSessionId:"planner",receivedAt:1005}));
    expect(log.claimNextTurn(1005)).toBeUndefined();log.markCleanupDone(1);expect(log.claimNextTurn(1006)).toMatchObject({linearSessionId:"planner"});log.close();
  });

  it("rekeys prompted-before-created turns and blocks later same-issue work until terminal activity posts", () => {
    const log = new EventLog(path());
    log.append(event({ deliveryId: "prompted-first", action: "prompted", issueId: undefined, issueIdentifier: undefined }));
    expect(log.turnStates()[0]).toMatchObject({ issueId: "session-1", status: "pending" });
    log.append(event({ deliveryId: "created-second" }));
    expect(log.turnStates().map(turn => turn.issueId)).toEqual(["issue-uuid-1", "issue-uuid-1"]);
    expect(log.claimNextTurn(1100)).toMatchObject({ id: 1, kind: "prompted", issueId: "issue-uuid-1" });
    expect(log.claimNextTurn(1101)).toBeUndefined();
    log.finishTurn(1, "response", "done", 1200);
    expect(log.claimNextTurn(1201)).toBeUndefined();
    log.markTurnActivityPosted(1, 1300);
    expect(log.claimNextTurn(1301)).toMatchObject({ id: 2, kind: "created", issueId: "issue-uuid-1" });
    log.close();
  });

  it("uses terminal activity creation time for the retry window", () => {
    const log = new EventLog(path());
    log.append(event({ receivedAt: 1000 }));
    expect(log.claimNextTurn(2000)).toMatchObject({ id: 1 });
    log.finishTurn(1, "response", "late response", 2_000_000);
    expect(log.pendingTurnActivities(2_000_000, 30 * 60_000)[0])
      .toMatchObject({ turnId: 1, createdAt: 2_000_000, receivedAt: 1000 });
    log.close();
  });

  it("still returns expired pending terminal activities so the worker can fail them", () => {
    const log = new EventLog(path());
    log.append(event());
    expect(log.claimNextTurn(1000)).toMatchObject({ id: 1 });
    log.finishTurn(1, "response", "stuck", 1000);
    log.markTurnActivityRetry(1, 1000 + 30 * 60_000 + 1);
    expect(log.pendingTurnActivities(1000 + 30 * 60_000 + 1, 30 * 60_000)[0])
      .toMatchObject({ turnId: 1, createdAt: 1000, status: "pending" });
    log.close();
  });

  it("preserves session fields, persists state, and reconciles interrupted turns", () => {
    const dbPath = path(); const log = new EventLog(dbPath);
    log.append(event());
    log.updateSessionWorktree("session-1", "/worktree", "agents/ENG-42", 1001);
    log.updateClaudeSessionId("session-1", "claude-1", 1002);
    log.append(event({ deliveryId: "delivery-2", action: "prompted", issueId: undefined, issueIdentifier: undefined }));
    expect(log.getSession("session-1")).toMatchObject({ issueId: "issue-uuid-1", issueIdentifier: "ENG-42",
      worktreePath: "/worktree", branch: "agents/ENG-42", claudeSessionId: "claude-1" });
    expect(log.claimNextTurn(1100)?.id).toBe(1);
    expect(log.interruptStaleRunning(1200)).toEqual([1]);
    expect(log.pendingTurnActivities(1200)[0]).toMatchObject({ kind: "error", turnId: 1 });
    expect(log.claimNextTurn(1201)).toBeUndefined();
    log.markTurnActivityPosted(1, 1300);
    expect(log.turnStates()[0]?.status).toBe("interrupted");
    expect(log.claimNextTurn(1301)).toMatchObject({ id: 2, kind: "prompted" });
    log.close();
    const reopened = new EventLog(dbPath);
    expect(reopened.getSession("session-1")?.claudeSessionId).toBe("claude-1");
    reopened.close();
  });

  it("survives close/reopen with ack state and tokens", () => {
    const dbPath = path();
    const first = new EventLog(dbPath);
    first.append(event());
    const [ack] = first.pendingAcks(1000);
    first.markRetriableFailure(ack!.eventId, "temporary", 2000, "failed");
    first.putToken("planner", { accessToken: "token", expiresAt: 5000 });
    first.close();
    const reopened = new EventLog(dbPath);
    expect(reopened.count()).toBe(1);
    expect(reopened.pendingAcks(2000)[0]).toMatchObject({ status: "failed", lastError: "temporary", failureKind: "retriable" });
    expect(reopened.getToken("planner")).toEqual({ accessToken: "token", expiresAt: 5000 });
    reopened.close();
  });

  it("uses a stable body hash fallback when Linear-Delivery is absent", () => {
    const log = new EventLog(path());
    expect(log.append(event({ deliveryId: undefined })).deliveryId).toMatch(/^sha256:/);
    expect(log.append(event({ deliveryId: undefined })).inserted).toBe(false);
    log.close();
  });
});
