import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";

const dirs: string[] = [];
function path(): string {
  const dir = mkdtempSync(join(tmpdir(), "linear-eventlog-"));
  dirs.push(dir);
  return join(dir, "events.db");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function event(overrides: Record<string, unknown> = {}) {
  return {
    deliveryId: "delivery-1",
    app: "planner" as const,
    action: "created",
    agentSessionId: "session-1",
    issueId: "issue-uuid-1",
    issueIdentifier: "ENG-42",
    webhookId: "webhook-1",
    receivedAt: 1000,
    rawBody: Buffer.from("{}"),
    ...overrides,
  };
}

describe("EventLog", () => {
  it("atomically appends an event and pending ack, then deduplicates redelivery", () => {
    const log = new EventLog(path());
    expect(log.append(event()).inserted).toBe(true);
    expect(log.append(event()).inserted).toBe(false);
    expect(log.count()).toBe(1);
    expect(log.ackCount()).toBe(1);
    expect(log.pendingAcks(1000)).toHaveLength(1);
    expect(log.ackStates()[0]).toMatchObject({
      nextAttemptAt: 1000,
      failureKind: null,
    });
    log.close();
  });

  it("does not dedupe separate deliveries sharing a webhook id", () => {
    const log = new EventLog(path());
    log.append(event());
    log.append(event({ deliveryId: "delivery-2" }));
    expect(log.count()).toBe(2);
    expect(log.ackCount()).toBe(1);
    log.close();
  });

  it("creates no ack row for prompted or unrecognized events", () => {
    const log = new EventLog(path());
    log.append(event({ action: "prompted" }));
    expect(log.ackCount()).toBe(0);
    expect(log.turnStates()).toHaveLength(1);
    log.close();
  });

  it.each(["auth", "continue", "select", "stop", "future-value"])(
    "never creates a prompt turn for signal %s",
    (signal) => {
      const log = new EventLog(path());
      log.append(event());
      const result = log.append(
        event({
          deliveryId: `signal-${signal}`,
          action: "prompted",
          sourceActivityId: `activity-${signal}`,
          signal,
        }),
      );
      expect(log.turnStates()).toHaveLength(1);
      expect(result.stop).toEqual(
        signal === "stop"
          ? { agentSessionId: "session-1", app: "planner" }
          : undefined,
      );
      log.close();
    },
  );

  it("stop cancels pending turns and stages one idempotent acknowledgment", () => {
    const log = new EventLog(path());
    log.append(event());
    log.append(
      event({
        deliveryId: "pending",
        action: "prompted",
        sourceActivityId: "prompt-1",
      }),
    );
    const stop = event({
      deliveryId: "stop-1",
      action: "prompted",
      sourceActivityId: "stop-activity",
      signal: "stop",
    });
    expect(log.append(stop).stop).toEqual({
      agentSessionId: "session-1",
      app: "planner",
    });
    log.append(event({ ...stop, deliveryId: "stop-2" }));
    expect(log.turnStates().map((turn) => turn.status)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(log.stopAckStates()).toHaveLength(1);
    expect(log.pendingStopAcks(1000)[0]).toMatchObject({
      linearSessionId: "session-1",
      status: "pending",
    });
    log.close();
  });

  it("does not re-fire a webhook stop replayed by reconciliation while a follow-up is running", () => {
    const log = new EventLog(path());
    log.append(event());
    const first = log.claimNextTurn(1001)!;
    log.markTurnStopped(first.id, 1002);
    expect(
      log.append(
        event({
          deliveryId: "webhook-stop",
          action: "prompted",
          sourceActivityId: "stop-source",
          signal: "stop",
        }),
      ).stop,
    ).toEqual({ agentSessionId: "session-1", app: "planner" });
    log.append(
      event({
        deliveryId: "follow-up",
        action: "prompted",
        sourceActivityId: "follow-up-source",
      }),
    );
    const followUp = log.claimNextTurn(1003)!;
    expect(followUp.status).toBe("running");
    const replay = log.append(
      event({
        deliveryId: "reconcile:prompt:session-1:stop-source",
        action: "prompted",
        sourceActivityId: "stop-source",
        signal: "stop",
      }),
    );
    expect(replay.inserted).toBe(true);
    expect(replay.stop).toBeUndefined();
    expect(
      log.turnStates().find((turn) => turn.id === followUp.id)?.status,
    ).toBe("running");
    expect(log.stopAckStates()).toHaveLength(1);
    expect(
      log.append(
        event({
          deliveryId: "second-stop",
          action: "prompted",
          sourceActivityId: "second-stop-source",
          signal: "stop",
        }),
      ).stop,
    ).toEqual({ agentSessionId: "session-1", app: "planner" });
    expect(log.stopAckStates()).toHaveLength(2);
    log.close();
  });

  it("keeps distinct real prompts without activity ids as separate turns", () => {
    const log = new EventLog(path());
    log.append(event());
    log.append(
      event({
        deliveryId: "prompt-1",
        action: "prompted",
        issueId: undefined,
        issueIdentifier: undefined,
      }),
    );
    log.append(
      event({
        deliveryId: "prompt-2",
        action: "prompted",
        issueId: undefined,
        issueIdentifier: undefined,
      }),
    );
    expect(log.turnStates().map((turn) => turn.kind)).toEqual([
      "created",
      "prompted",
      "prompted",
    ]);
    log.close();
  });

  it("fans out planner and implementer turns for both created and prompted events", () => {
    const log = new EventLog(path());
    log.append(event());
    log.append(
      event({
        deliveryId: "delivery-2",
        action: "prompted",
        issueId: undefined,
        issueIdentifier: undefined,
      }),
    );
    log.append(
      event({
        deliveryId: "delivery-3",
        app: "implementer",
        agentSessionId: "implementer-session",
      }),
    );
    log.append(
      event({
        deliveryId: "delivery-4",
        app: "implementer",
        agentSessionId: "implementer-session",
        action: "prompted",
      }),
    );
    expect(log.turnStates()).toHaveLength(4);
    expect(log.claimNextTurn(1100)).toMatchObject({
      kind: "created",
      issueId: "issue-uuid-1",
    });
    expect(log.claimNextTurn(1100)).toBeUndefined();
    log.finishTurn(1, "response", "done", 1200);
    log.markTurnActivityPosted(1, 1201);
    expect(log.claimNextTurn(1300)).toMatchObject({
      kind: "prompted",
      issueId: "issue-uuid-1",
    });
    log.close();
  });

  it("persists dedicated external URLs and cleanup jobs across reopen", () => {
    const dbPath = path();
    const log = new EventLog(dbPath);
    log.append(event());
    log.updateSessionWorktree("session-1", "/worktree", "agents/ENG-42", 1001);
    log.append(
      event({
        deliveryId: "impl",
        app: "implementer",
        agentSessionId: "impl-session",
        receivedAt: 1002,
      }),
    );
    log.updateSessionWorktree(
      "impl-session",
      "/worktree",
      "agents/ENG-42",
      1003,
    );
    for (let i = 0; i < 2; i++) {
      const turn = log.claimNextTurn(1003 + i)!;
      log.finishTurn(turn.id, "response", "done", 1003 + i);
      log.markTurnActivityPosted(turn.id, 1003 + i);
    }
    expect(log.sessionByIssueIdentifier("ENG-42")?.linearSessionId).toBe(
      "impl-session",
    );
    log.stageExternalUrl(
      "impl-session",
      "implementer",
      "Pull Request",
      "https://github.com/x/y/pull/1",
      1004,
    );
    log.stageExternalUrl(
      "impl-session",
      "implementer",
      "Pull Request",
      "https://github.com/x/y/pull/1",
      1005,
    );
    log.append(
      event({
        deliveryId: "issue-done",
        app: "implementer",
        agentSessionId: undefined,
        action: "update",
        type: "Issue",
        stateType: "completed",
        receivedAt: 1006,
      }),
    );
    expect(log.externalUrlStates()).toHaveLength(1);
    expect(log.cleanupStates()).toHaveLength(1);
    log.close();
    const reopened = new EventLog(dbPath);
    expect(reopened.pendingExternalUrls(1006)).toHaveLength(1);
    expect(reopened.claimNextCleanup(1006)).toMatchObject({
      linearSessionId: "impl-session",
      app: "implementer",
    });
    reopened.close();
  });
  it("makes turn and cleanup claims mutually exclusive per issue", () => {
    const log = new EventLog(path());
    log.append(event({ app: "implementer" }));
    log.updateSessionWorktree("session-1", "/worktree", "agents/ENG-42", 1001);
    log.append(
      event({
        deliveryId: "done",
        app: "implementer",
        agentSessionId: undefined,
        action: "update",
        type: "Issue",
        stateType: "completed",
        receivedAt: 1002,
      }),
    );
    expect(log.claimNextCleanup(1002)).toBeUndefined();
    const first = log.claimNextTurn(1002)!;
    log.finishTurn(first.id, "response", "done", 1003);
    log.markTurnActivityPosted(first.id, 1003);
    expect(log.claimNextCleanup(1004)).toBeDefined();
    log.append(
      event({
        deliveryId: "planner",
        app: "planner",
        agentSessionId: "planner",
        receivedAt: 1005,
      }),
    );
    expect(log.claimNextTurn(1005)).toBeUndefined();
    log.markCleanupDone(1);
    expect(log.claimNextTurn(1006)).toMatchObject({
      linearSessionId: "planner",
    });
    log.close();
  });

  it("rekeys prompted-before-created turns and blocks later same-issue work until terminal activity posts", () => {
    const log = new EventLog(path());
    log.append(
      event({
        deliveryId: "prompted-first",
        action: "prompted",
        issueId: undefined,
        issueIdentifier: undefined,
      }),
    );
    expect(log.turnStates()[0]).toMatchObject({
      issueId: "session-1",
      status: "pending",
    });
    log.append(event({ deliveryId: "created-second" }));
    expect(log.turnStates().map((turn) => turn.issueId)).toEqual([
      "issue-uuid-1",
      "issue-uuid-1",
    ]);
    expect(log.claimNextTurn(1100)).toMatchObject({
      id: 1,
      kind: "prompted",
      issueId: "issue-uuid-1",
    });
    expect(log.claimNextTurn(1101)).toBeUndefined();
    log.finishTurn(1, "response", "done", 1200);
    expect(log.claimNextTurn(1201)).toBeUndefined();
    log.markTurnActivityPosted(1, 1300);
    expect(log.claimNextTurn(1301)).toMatchObject({
      id: 2,
      kind: "created",
      issueId: "issue-uuid-1",
    });
    log.close();
  });

  it("uses terminal activity creation time for the retry window", () => {
    const log = new EventLog(path());
    log.append(event({ receivedAt: 1000 }));
    expect(log.claimNextTurn(2000)).toMatchObject({ id: 1 });
    log.finishTurn(1, "response", "late response", 2_000_000);
    expect(log.pendingTurnActivities(2_000_000, 30 * 60_000)[0]).toMatchObject({
      turnId: 1,
      createdAt: 2_000_000,
      receivedAt: 1000,
    });
    log.close();
  });

  it("stores usage atomically with turn completion", () => {
    const dbPath = path();
    const log = new EventLog(dbPath);
    log.append(event());
    const turn = log.claimNextTurn(1100)!;
    log.finishTurn(turn.id, "response", "done", 1200, "activity-1", false, {
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationTokens: 5780,
      cacheReadTokens: 15105,
      costUsd: 0.130925,
      model: "claude-fable-5",
    });
    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .prepare(
          `SELECT usage_input_tokens inputTokens, usage_output_tokens outputTokens,
      usage_cache_creation_tokens cacheCreationTokens, usage_cache_read_tokens cacheReadTokens,
      cost_usd costUsd, model FROM turns WHERE id=?`,
        )
        .get(turn.id),
    ).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationTokens: 5780,
      cacheReadTokens: 15105,
      costUsd: 0.130925,
      model: "claude-fable-5",
    });
    db.close();
    log.close();
  });

  it("still returns expired pending terminal activities so the worker can fail them", () => {
    const log = new EventLog(path());
    log.append(event());
    expect(log.claimNextTurn(1000)).toMatchObject({ id: 1 });
    log.finishTurn(1, "response", "stuck", 1000);
    log.markTurnActivityRetry(1, 1000 + 30 * 60_000 + 1);
    expect(
      log.pendingTurnActivities(1000 + 30 * 60_000 + 1, 30 * 60_000)[0],
    ).toMatchObject({ turnId: 1, createdAt: 1000, status: "pending" });
    log.close();
  });

  it("preserves session fields, persists state, and reconciles interrupted turns", () => {
    const dbPath = path();
    const log = new EventLog(dbPath);
    log.append(event());
    log.updateSessionWorktree("session-1", "/worktree", "agents/ENG-42", 1001);
    log.updateClaudeSessionId("session-1", "claude-1", 1002);
    log.append(
      event({
        deliveryId: "delivery-2",
        action: "prompted",
        issueId: undefined,
        issueIdentifier: undefined,
      }),
    );
    expect(log.getSession("session-1")).toMatchObject({
      issueId: "issue-uuid-1",
      issueIdentifier: "ENG-42",
      worktreePath: "/worktree",
      branch: "agents/ENG-42",
      claudeSessionId: "claude-1",
      runtime: "claude",
      fallbackCause: null,
    });
    log.clearClaudeSessionId("session-1", 1003);
    expect(log.getSession("session-1")?.claudeSessionId).toBeNull();
    expect(log.requireBrowser("session-1", "browser-run", 1005)).toBe(true);
    expect(log.requireBrowser("session-1", "replacement", 1006)).toBe(false);
    expect(log.getSession("session-1")).toMatchObject({ browserRequired: 1, browserRunId: "browser-run" });
    expect(log.getSession("session-1")).toMatchObject({
      runtime: "claude",
      fallbackCause: null,
      claudeSessionId: null,
    });
    expect(log.claimNextTurn(1100)?.id).toBe(1);
    expect(log.interruptStaleRunning(1200)).toEqual([1]);
    expect(log.pendingTurnActivities(1200)[0]).toMatchObject({
      kind: "error",
      turnId: 1,
    });
    expect(log.claimNextTurn(1201)).toBeUndefined();
    log.markTurnActivityPosted(1, 1300);
    expect(log.turnStates()[0]?.status).toBe("interrupted");
    expect(log.claimNextTurn(1301)).toMatchObject({ id: 2, kind: "prompted" });
    log.close();
    const reopened = new EventLog(dbPath);
    expect(reopened.getSession("session-1")).toMatchObject({
      runtime: "claude",
      claudeSessionId: null,
      browserRequired: 1,
      browserRunId: "browser-run",
    });
    reopened.close();
  });

  it("persists bounded tool-call state and resumes a safe stale turn exactly once", () => {
    const dbPath = path();
    let log = new EventLog(dbPath);
    log.append(event());
    log.updateClaudeSessionId("session-1", "claude-1", 1001);
    expect(log.claimNextTurn(1100)?.id).toBe(1);
    log.recordTurnToolCallStarted(1, "tool-1", "mcp__linear__get_issue", 1101);
    expect(log.openTurnToolCalls(1)).toEqual([
      expect.objectContaining({
        turnId: 1,
        toolUseId: "tool-1",
        toolName: "mcp__linear__get_issue",
        state: "open",
      }),
    ]);
    expect(log.recordTurnToolCallCompleted(1, "tool-1", 1102)).toBe(true);
    log.close();

    log = new EventLog(dbPath);
    expect(log.openTurnToolCalls(1)).toEqual([]);
    expect(log.recoverStaleRunning(1200)).toEqual([
      {
        turnId: 1,
        outcome: "resumed",
        reason: "safe_boundary",
        resumeTurnId: 2,
      },
    ]);
    expect(log.turnStates()).toEqual([
      expect.objectContaining({ id: 1, status: "interrupted" }),
      expect.objectContaining({
        id: 2,
        status: "pending",
        kind: "prompted",
        sourceKey: "restart-resume:1",
      }),
    ]);
    expect(log.pendingTurnActivities(1200)).toEqual([]);
    expect(log.recoverStaleRunning(1201)).toEqual([]);
    expect(log.turnStates()).toHaveLength(2);
    expect(log.claimNextTurn(1202)).toMatchObject({ id: 2, status: "running" });
    log.close();
  });

  it("requires human review exactly once at an unresolved external-tool boundary", () => {
    const log = new EventLog(path());
    log.append(event());
    log.updateClaudeSessionId("session-1", "claude-1", 1001);
    log.claimNextTurn(1100);
    log.recordTurnToolCallStarted(
      1,
      "x".repeat(300),
      "dangerous-tool".repeat(20),
      1101,
    );
    expect(log.openTurnToolCalls(1)[0]).toMatchObject({
      toolUseId: expect.stringMatching(/^sha256:/),
      toolName: expect.stringMatching(/^dangerous-tool/),
    });
    expect(log.openTurnToolCalls(1)[0]!.toolName).toHaveLength(120);
    expect(log.recoverStaleRunning(1200)).toEqual([
      {
        turnId: 1,
        outcome: "human_required",
        reason: "unresolved_tool_call",
        resumeTurnId: null,
      },
    ]);
    expect(log.pendingTurnActivities(1200)).toEqual([
      expect.objectContaining({
        turnId: 1,
        activityId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        kind: "error",
      }),
    ]);
    expect(log.turnStates()).toHaveLength(1);
    expect(log.recoverStaleRunning(1201)).toEqual([]);
    expect(log.pendingTurnActivities(1201)).toHaveLength(1);
    log.close();
  });

  it("atomically retains hard-restart intent when stale disposition rolls back", () => {
    const dbPath = path();
    const log = new EventLog(dbPath);
    log.append(event());
    log.updateClaudeSessionId("session-1", "claude-1", 1001);
    log.claimNextTurn(1100);
    expect(log.recordRestartIntent("operator restart", 1101)).toEqual({
      policy: "interrupt",
      reason: "operator restart",
      createdAt: 1101,
    });
    const db = new Database(dbPath);
    db.exec(`CREATE TRIGGER fail_restart_human BEFORE INSERT ON turn_activities
      WHEN NEW.turn_id=1
      BEGIN SELECT RAISE(ABORT, 'fixture disposition crash'); END;`);
    expect(() => log.recoverStaleRunning(1200)).toThrow(
      /fixture disposition crash/,
    );
    expect(log.turnStates()[0]).toMatchObject({ status: "running" });
    expect(log.restartIntent()).toMatchObject({ policy: "interrupt" });
    db.exec("DROP TRIGGER fail_restart_human");
    expect(log.recoverStaleRunning(1201)).toEqual([
      {
        turnId: 1,
        outcome: "human_required",
        reason: "hard_restart",
        resumeTurnId: null,
      },
    ]);
    expect(log.restartIntent()).toBeUndefined();
    expect(log.turnStates()).toHaveLength(1);
    db.close();
    log.close();
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
    expect(reopened.pendingAcks(2000)[0]).toMatchObject({
      status: "failed",
      lastError: "temporary",
      failureKind: "retriable",
    });
    expect(reopened.getToken("planner")).toEqual({
      accessToken: "token",
      expiresAt: 5000,
    });
    reopened.close();
  });

  it("survives close/reopen with an active maintenance drain", () => {
    const dbPath = path(); const first = new EventLog(dbPath);
    first.scheduleOperation({ id: "durable-op", requestDigest: "a".repeat(64), type: "update", reason: "release",
      targetRef: "refs/heads/main", targetCommit: "b".repeat(40), previousCommit: "c".repeat(40) });
    first.close();
    const reopened = new EventLog(dbPath);
    expect(reopened.operationStatus().pending).toMatchObject({ id: "durable-op", drainState: "pending", targetRef: "refs/heads/main" });
    reopened.close();
  });

  it("migrates a populated pre-usage turns table with null usage", () => {
    const dbPath = path();
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY,
        event_id INTEGER NOT NULL UNIQUE,
        linear_session_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('created','prompted')),
        prompt TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','running','awaiting_activity','done','failed','interrupted')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at INTEGER,
        finished_at INTEGER
      );
      INSERT INTO turns (id, event_id, linear_session_id, issue_id, kind, prompt, status, attempts)
      VALUES (1, 1, 'old-session', 'old-issue', 'created', 'old prompt', 'done', 1);
    `);
    old.close();

    const log = new EventLog(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const columns = (
      db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    const indexes = (
      db.prepare("PRAGMA index_list(turns)").all() as Array<{
        name: string;
        unique: number;
      }>
    ).map((index) => ({
      name: index.name,
      unique: index.unique,
    }));
    expect(columns).toContain("source_key");
    expect(columns).toEqual(
      expect.arrayContaining([
        "usage_input_tokens",
        "usage_output_tokens",
        "usage_cache_creation_tokens",
        "usage_cache_read_tokens",
        "cost_usd",
        "model",
        "trace_id",
      ]),
    );
    expect(indexes).toContainEqual({ name: "idx_turns_source_key", unique: 1 });
    expect(
      db
        .prepare(
          `SELECT linear_session_id linearSessionId, prompt, status,
      usage_input_tokens inputTokens, usage_output_tokens outputTokens,
      usage_cache_creation_tokens cacheCreationTokens, usage_cache_read_tokens cacheReadTokens,
      cost_usd costUsd, model, trace_id traceId FROM turns WHERE id=1`,
        )
        .get(),
    ).toEqual({
      linearSessionId: "old-session",
      prompt: "old prompt",
      status: "done",
      inputTokens: null,
      outputTokens: null,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      costUsd: null,
      model: null,
      traceId: null,
    });
    db.close();
    log.close();
  });

  it("uses a stable body hash fallback when Linear-Delivery is absent", () => {
    const log = new EventLog(path());
    expect(log.append(event({ deliveryId: undefined })).deliveryId).toMatch(
      /^sha256:/,
    );
    expect(log.append(event({ deliveryId: undefined })).inserted).toBe(false);
    log.close();
  });
  it("assigns a profile only on first insert and preserves it in every projection", () => {
    let selections = 0;
    const log = new EventLog(path(), (app) => {
      selections++;
      expect(app).toBe("planner");
      return { profile: "fable", runtime: "claude", reason: "claude_ready" };
    });
    const first = log.append(event());
    const duplicate = log.append(
      event({ deliveryId: "delivery-2", action: "prompted" }),
    );
    expect(first).toMatchObject({
      assignedProfile: "fable",
      assignedRuntime: "claude",
      assignmentReason: "claude_ready",
    });
    expect(duplicate.assignedProfile).toBeUndefined();
    expect(selections).toBe(1);
    log.updateSessionWorktree("session-1", "/worktree", "branch");
    expect(log.getSession("session-1")).toMatchObject({
      profile: "fable",
      runtime: "claude",
    });
    expect(log.sessionByIssueIdentifier("ENG-42")?.profile).toBe("fable");
    expect(log.plannerSessionsForReconcile()[0]?.profile).toBe("fable");
    expect(log.sessionsWithWorktrees()[0]?.profile).toBe("fable");
    log.close();
  });
  it("stores provider state without mutating an established session route", () => {
    const log = new EventLog(path(), () => ({
      profile: "fable",
      runtime: "claude",
      reason: "ready",
    }));
    log.append(event());
    expect(log.getSession("session-1")).toMatchObject({
      profile: "fable",
      runtime: "claude",
      profileFallback: null,
    });
    log.setProviderState("claude", "ready", "eligible_1_failed_0", 100);
    log.setProviderCooldown("claude", 900, "http_503", 200);
    expect(log.getProviderState("claude")).toEqual({
      provider: "claude",
      status: "cooldown",
      reason: "http_503",
      cooldownUntil: 900,
      updatedAt: 200,
    });
    expect(log.getSession("session-1")).toMatchObject({
      profile: "fable",
      runtime: "claude",
    });
    log.close();
  });
  it("persists one session trace, unique turn spans, and preserves execution end", () => {
    const dbPath = path();
    const log = new EventLog(dbPath);
    log.append(event());
    const session = log.getSession("session-1")!;
    expect(session.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(session.rootSpanId).toMatch(/^[0-9a-f]{16}$/);
    const turn = log.claimNextTurn(1100)!;
    log.setTurnTraceContext(turn.id, session.traceId, "1".repeat(16));
    log.finishTurn(turn.id, "response", "done", 1200);
    log.markTurnActivityPosted(turn.id, 1300);
    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .prepare(
          "SELECT trace_id traceId,turn_span_id turnSpanId,execution_finished_at executionFinishedAt,finished_at finishedAt FROM turns",
        )
        .get(),
    ).toEqual({
      traceId: session.traceId,
      turnSpanId: "1".repeat(16),
      executionFinishedAt: 1200,
      finishedAt: 1300,
    });
    db.close();
    log.close();
  });
  it("deduplicates Claude invocations and terminal transitions are monotonic", () => {
    const log = new EventLog(path());
    log.append(event());
    const turn = log.claimNextTurn(1001)!;
    const session = log.getSession("session-1")!;
    const input = {
      linearSessionId: "session-1",
      turnId: turn.id,
      toolUseId: "tool-1",
      role: "researcher",
      prompt: "inspect",
      traceId: session.traceId,
      startedAt: 1002,
    };
    expect(log.claimClaudeInvocation(input).id).toBe(
      log.claimClaudeInvocation(input).id,
    );
    log.completeClaudeStream(
      "session-1",
      "tool-1",
      "done",
      "success",
      1010,
      1020,
    );
    expect(log.markClaudeNativeSeen("session-1", "tool-1", 1011)).toBe(true);
    expect(
      log.degradeClaudeInvocation(
        "session-1",
        "tool-1",
        "relay_delivery_unknown",
        "restart",
      ),
    ).toBe(true);
    expect(
      log.enrichClaudeInvocation({
        linearSessionId: "session-1",
        toolUseId: "tool-1",
        spanId: "2".repeat(16),
        startedAt: 1002,
        endedAt: 1010,
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(false);
    expect(log.invocations("session-1")[0]?.enrichmentState).toBe(
      "relay_delivery_unknown",
    );
    log.close();
  });
  it("applies the conservative Codex cumulative ordering state machine", () => {
    const log = new EventLog(path());
    log.append(event());
    const turn = log.claimNextTurn(1001)!;
    const trace = log.getSession("session-1")!.traceId;
    const base = {
      linearSessionId: "session-1",
      turnId: turn.id,
      role: "implementer",
      traceId: trace,
      providerConversationId: "thread",
      outcome: "success",
    };
    expect(
      log.ingestCodexInvocation({
        ...base,
        sourceKey: "one",
        mode: "fresh",
        startedAt: 10,
        endedAt: 20,
        cumulativeTotalTokens: 100,
      }).deltaTotalTokens,
    ).toBe(100);
    expect(
      log.ingestCodexInvocation({
        ...base,
        sourceKey: "two",
        mode: "resume",
        startedAt: 21,
        endedAt: 30,
        cumulativeTotalTokens: 140,
      }).deltaTotalTokens,
    ).toBe(40);
    expect(
      log.ingestCodexInvocation({
        ...base,
        sourceKey: "old",
        mode: "resume",
        startedAt: 15,
        endedAt: 16,
        cumulativeTotalTokens: 120,
      }).usageClassification,
    ).toBe("out_of_order");
    expect(
      log.ingestCodexInvocation({
        ...base,
        sourceKey: "reset",
        mode: "resume",
        startedAt: 31,
        endedAt: 40,
        cumulativeTotalTokens: 20,
      }),
    ).toMatchObject({
      usageClassification: "reset",
      deltaTotalTokens: 20,
      usageEpoch: 1,
    });
    expect(
      log.ingestCodexInvocation({
        ...base,
        sourceKey: "collision",
        mode: "fresh",
        startedAt: 41,
        endedAt: 50,
        cumulativeTotalTokens: 30,
      }).usageClassification,
    ).toBe("identity_collision");
    log.close();
  });
  it("phase 4 AC11 never replays an ambiguous outbox that restarted after entering sending", () => {
    const dbPath = path();
    let log = new EventLog(dbPath);
    log.append(event());
    log.materializeOutbox("session-1", "[]", 2000);
    expect(log.leaseOutbox("session-1", "worker", 2001)).toBeDefined();
    expect(log.markOutboxSending("session-1", "worker", 2002)).toBe(true);
    log.close();
    log = new EventLog(dbPath);
    expect(log.outbox("session-1")?.state).toBe("delivery_unknown");
    expect(log.leaseOutbox("session-1", "again", 3000)).toBeUndefined();
    log.close();
  });
  it("migrates legacy session rows with NULL profiles", () => {
    const dbPath = path();
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE sessions (
      linear_session_id TEXT PRIMARY KEY, app TEXT NOT NULL, issue_id TEXT, issue_identifier TEXT,
      worktree_path TEXT, branch TEXT, claude_session_id TEXT, mode TEXT NOT NULL DEFAULT 'planner',
      status TEXT NOT NULL DEFAULT 'active', last_seen_at INTEGER NOT NULL, last_seen_activity_at INTEGER
    ); INSERT INTO sessions(linear_session_id,app,mode,status,last_seen_at) VALUES('legacy','planner','planner','active',1);`);
    old.close();
    const log = new EventLog(dbPath);
    expect(log.getSession("legacy")).toMatchObject({
      profile: null,
      profileFallback: null,
    });
    const db = new Database(dbPath, { readonly: true });
    expect(
      (
        db.prepare("PRAGMA table_info(sessions)").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    ).toEqual(expect.arrayContaining(["profile", "profile_fallback"]));
    db.close();
    log.close();
  });
});
