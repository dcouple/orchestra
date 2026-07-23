import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CleanupWorker } from "../src/cleanup.js";
import { EventLog } from "../src/eventlog.js";
import type { LinearGateway, PostResult } from "../src/linear.js";
import { WorktreeManager } from "../src/worktrees.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function git(args: string[], cwd?: string) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cleanup-"));
  dirs.push(dir);
  const seed = join(dir, "seed"),
    origin = join(dir, "origin.git"),
    repo = join(dir, "repo"),
    root = join(dir, "trees");
  mkdirSync(seed);
  git(["init", "-b", "main"], seed);
  git(["config", "user.email", "test@example.com"], seed);
  git(["config", "user.name", "Test"], seed);
  git(["commit", "--allow-empty", "-m", "initial"], seed);
  git(["clone", "--bare", seed, origin]);
  git(["clone", origin, repo]);
  const log = new EventLog(join(dir, "events.db"));
  const manager = new WorktreeManager(root, repo);
  const tree = await manager.ensureWorktree("ENG-42");
  log.append({
    deliveryId: "impl",
    app: "implementer",
    action: "created",
    agentSessionId: "session",
    issueId: "issue",
    issueIdentifier: "ENG-42",
    receivedAt: 1,
    rawBody: Buffer.from("{}"),
  });
  log.updateSessionWorktree("session", tree.path, tree.branch, 2);
  const turn = log.claimNextTurn(2)!;
  log.finishTurn(turn.id, "response", "done", 2);
  log.markTurnActivityPosted(turn.id, 2);
  return { dir, repo, root, log, tree };
}
class Poster {
  posts: string[] = [];
  async postActivity(
    _a: string,
    _s: string,
    _id: string,
    c: { body: string },
  ): Promise<PostResult> {
    this.posts.push(c.body);
    return { ok: true };
  }
}
function complete(log: EventLog) {
  log.append({
    deliveryId: "done",
    app: "implementer",
    action: "update",
    type: "Issue",
    stateType: "completed",
    issueId: "issue",
    issueIdentifier: "ENG-42",
    receivedAt: 3,
    rawBody: Buffer.from("{}"),
  });
}
async function waitFor(p: () => boolean) {
  const end = Date.now() + 3000;
  while (!p()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("CleanupWorker", () => {
  it("AC5 removes a clean worktree and branch with a recorded external URL, including ignored attachments", async () => {
    const s = await setup();
    mkdirSync(join(s.tree.path, ".linear-attachments"));
    writeFileSync(join(s.tree.path, ".linear-attachments", "a"), "x");
    s.log.stageExternalUrl(
      "session",
      "implementer",
      "Pull Request",
      "https://github.com/dcouple/example/pull/42",
      3,
    );
    complete(s.log);
    s.log.append({
      deliveryId: "planner",
      app: "planner",
      action: "created",
      agentSessionId: "planner-session",
      issueId: "issue",
      issueIdentifier: "ENG-42",
      receivedAt: 3,
      rawBody: Buffer.from("{}"),
    });
    s.log.updateSessionWorktree(
      "planner-session",
      s.tree.path,
      s.tree.branch,
      3,
    );
    const plannerTurn = s.log.claimNextTurn(3)!;
    s.log.finishTurn(plannerTurn.id, "response", "done", 3);
    s.log.markTurnActivityPosted(plannerTurn.id, 3);
    const worker = new CleanupWorker(
      s.log,
      new Poster() as unknown as LinearGateway,
      s.root,
      s.repo,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() => s.log.cleanupStates()[0]?.status === "done");
    await worker.stop();
    expect(existsSync(s.tree.path)).toBe(false);
    expect(s.log.getSession("session")?.worktreePath).toBeNull();
    expect(s.log.getSession("planner-session")?.worktreePath).toBeNull();
    expect(() =>
      git(["show-ref", "--verify", "refs/heads/agents/ENG-42"], s.repo),
    ).toThrow();
    s.log.close();
  });
  it("retains a clean present worktree when no pull request URL was recorded", async () => {
    const s = await setup();
    complete(s.log);
    const poster = new Poster();
    const worker = new CleanupWorker(
      s.log,
      poster as unknown as LinearGateway,
      s.root,
      s.repo,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(
      () => s.log.cleanupNotificationStates()[0]?.status === "posted",
    );
    await worker.stop();
    expect(s.log.cleanupStates()[0]?.status).toBe("retained");
    expect(poster.posts[0]).toContain("no pull request was recorded");
    expect(poster.posts[0]).toContain(s.tree.path);
    expect(existsSync(s.tree.path)).toBe(true);
    s.log.close();
  });
  it("AC6 retains a dirty worktree and durably posts its path", async () => {
    const s = await setup();
    writeFileSync(join(s.tree.path, "dirty.txt"), "x");
    complete(s.log);
    const poster = new Poster();
    const worker = new CleanupWorker(
      s.log,
      poster as unknown as LinearGateway,
      s.root,
      s.repo,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(
      () => s.log.cleanupNotificationStates()[0]?.status === "posted",
    );
    await worker.stop();
    expect(s.log.cleanupStates()[0]?.status).toBe("retained");
    expect(poster.posts[0]).toContain(s.tree.path);
    expect(existsSync(s.tree.path)).toBe(true);
    s.log.close();
  });
  it("reclaims an expired running job after restart", async () => {
    const s = await setup();
    s.log.stageExternalUrl(
      "session",
      "implementer",
      "Pull Request",
      "https://github.com/dcouple/example/pull/42",
      3,
    );
    complete(s.log);
    expect(s.log.claimNextCleanup(10)).toBeDefined();
    const worker = new CleanupWorker(
      s.log,
      new Poster() as unknown as LinearGateway,
      s.root,
      s.repo,
      { pollMs: 10, reconcileMs: 20, leaseMs: 1, now: () => 20 },
    );
    worker.start();
    await waitFor(() => s.log.cleanupStates()[0]?.status === "done");
    await worker.stop();
    s.log.close();
  });
  it("reclaims a fresh running cleanup at startup so same-issue turns are not wedged", async () => {
    const s = await setup();
    s.log.stageExternalUrl(
      "session",
      "implementer",
      "Pull Request",
      "https://github.com/dcouple/example/pull/42",
      3,
    );
    complete(s.log);
    expect(s.log.claimNextCleanup(10)).toBeDefined();
    s.log.append({
      deliveryId: "planner",
      app: "planner",
      action: "created",
      agentSessionId: "planner-session",
      issueId: "issue",
      issueIdentifier: "ENG-42",
      receivedAt: 11,
      rawBody: Buffer.from("{}"),
    });
    expect(s.log.claimNextTurn(12)).toBeUndefined();
    const worker = new CleanupWorker(
      s.log,
      new Poster() as unknown as LinearGateway,
      s.root,
      s.repo,
      { pollMs: 1000, reconcileMs: 1000, now: () => 12 },
    );
    worker.start();
    expect(s.log.cleanupStates()[0]?.status).toBe("pending");
    expect(s.log.claimNextTurn(13)).toMatchObject({
      linearSessionId: "planner-session",
    });
    await worker.stop();
    s.log.close();
  });
  it("does not reclaim a running cleanup during periodic reconcile", async () => {
    const s = await setup();
    s.log.stageExternalUrl(
      "session",
      "implementer",
      "Pull Request",
      "https://github.com/dcouple/example/pull/42",
      3,
    );
    complete(s.log);
    let now = 10;
    const worker = new CleanupWorker(
      s.log,
      new Poster() as unknown as LinearGateway,
      s.root,
      s.repo,
      { pollMs: 1000, reconcileMs: 1000, leaseMs: 1, now: () => now },
    );
    const internals = worker as unknown as {
      worktrees: { remove(issueIdentifier: string): Promise<void> };
      reconcile(): Promise<void>;
    };
    const originalRemove = internals.worktrees.remove.bind(internals.worktrees);
    const started = deferred();
    const release = deferred();
    internals.worktrees.remove = async (issueIdentifier: string) => {
      started.resolve();
      await release.promise;
      await originalRemove(issueIdentifier);
    };
    const drain = worker.trigger();
    await started.promise;
    expect(s.log.cleanupStates()[0]?.status).toBe("running");
    now = 20;
    const reconcile = internals.reconcile();
    await Promise.resolve();
    expect(s.log.cleanupStates()[0]?.status).toBe("running");
    release.resolve();
    await Promise.all([drain, reconcile]);
    expect(s.log.cleanupStates()[0]?.status).toBe("done");
    s.log.close();
  });
  it("finishes crash recovery when the worktree is already removed but its branch remains", async () => {
    const s = await setup();
    complete(s.log);
    git(["worktree", "remove", s.tree.path], s.repo);
    const worker = new CleanupWorker(
      s.log,
      new Poster() as unknown as LinearGateway,
      s.root,
      s.repo,
      { pollMs: 10, reconcileMs: 20 },
    );
    worker.start();
    await waitFor(() => s.log.cleanupStates()[0]?.status === "done");
    await worker.stop();
    expect(s.log.getSession("session")?.worktreePath).toBeNull();
    expect(() =>
      git(["show-ref", "--verify", "refs/heads/agents/ENG-42"], s.repo),
    ).toThrow();
    s.log.close();
  });
  it("waits for durable Claude enrichment before materializing the immutable root and cleanup", async () => {
    const s = await setup();
    const session = s.log.getSession("session")!;
    s.log.claimClaudeInvocation({
      linearSessionId: "session",
      turnId: 1,
      toolUseId: "agent-1",
      role: "reviewer",
      prompt: "review",
      traceId: session.traceId,
      startedAt: 2,
    });
    s.log.completeClaudeStream(
      "session",
      "agent-1",
      "approved",
      "success",
      3,
      100,
    );
    s.log.stageExternalUrl(
      "session",
      "implementer",
      "Pull Request",
      "https://github.com/dcouple/example/pull/42",
      3,
    );
    complete(s.log);
    let now = 10;
    const worker = new CleanupWorker(
      s.log,
      new Poster() as unknown as LinearGateway,
      s.root,
      s.repo,
      { pollMs: 10_000, reconcileMs: 10_000, now: () => now },
    );
    await worker.trigger();
    expect(s.log.outbox("session")).toBeUndefined();
    expect(existsSync(s.tree.path)).toBe(true);
    expect(s.log.markClaudeNativeSeen("session", "agent-1", 20)).toBe(true);
    expect(
      s.log.enrichClaudeInvocation({
        linearSessionId: "session",
        toolUseId: "agent-1",
        spanId: "a".repeat(16),
        startedAt: 2,
        endedAt: 30,
        inputTokens: 5,
        outputTokens: 7,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(true);
    now = 1010;
    await worker.trigger();
    expect(s.log.outbox("session")?.state).toBe("failed");
    expect(existsSync(s.tree.path)).toBe(false);
    expect(s.log.aggregateSession("session")).toMatchObject({
      canonicalTokens: 12,
      complete: true,
    });
    s.log.close();
  });

  it("phase 4 AC11 never degrades an expired Agent while its turn executes, then flushes enrichment before one root", async () => {
    const s = await setup();
    const session = s.log.getSession("session")!;
    s.log.append({
      deliveryId: "followup",
      app: "implementer",
      action: "prompted",
      agentSessionId: "session",
      sourceActivityId: "followup",
      issueId: "issue",
      issueIdentifier: "ENG-42",
      receivedAt: 4,
      rawBody: Buffer.from("{}"),
    });
    const open = s.log.claimNextTurn(5)!;
    s.log.setTurnTraceContext(open.id, session.traceId, "e".repeat(16));
    s.log.claimClaudeInvocation({
      linearSessionId: "session",
      turnId: open.id,
      toolUseId: "agent-open",
      role: "reviewer",
      prompt: "review",
      traceId: session.traceId,
      startedAt: 5,
    });
    s.log.completeClaudeStream(
      "session",
      "agent-open",
      "approved",
      "success",
      6,
      7,
    );
    s.log.stageExternalUrl(
      "session",
      "implementer",
      "Pull Request",
      "https://github.com/dcouple/example/pull/42",
      6,
    );
    complete(s.log);
    let now = 100;
    const relay = {
      flushSession: async () => {
        expect(s.log.nonterminalInvocations("session")).toHaveLength(1);
        s.log.markClaudeNativeSeen("session", "agent-open", 6);
        s.log.enrichClaudeInvocation({
          linearSessionId: "session",
          toolUseId: "agent-open",
          spanId: "f".repeat(16),
          startedAt: 5,
          endedAt: 6,
          inputTokens: 3,
          outputTokens: 4,
          cacheCreationTokens: 1,
          cacheReadTokens: 2,
        });
      },
    };
    const worker = new CleanupWorker(
      s.log,
      new Poster() as unknown as LinearGateway,
      s.root,
      s.repo,
      {
        pollMs: 10_000,
        reconcileMs: 10_000,
        now: () => now,
        relay: relay as never,
      },
    );
    await worker.trigger();
    expect(s.log.invocations("session")[0]?.enrichmentState).toBe("pending");
    expect(s.log.outbox("session")).toBeUndefined();
    s.log.finishTurn(open.id, "response", "done", 101);
    s.log.markTurnActivityPosted(open.id, 102);
    now = 103;
    await worker.trigger();
    expect(s.log.invocations("session")[0]?.enrichmentState).toBe("enriched");
    expect(s.log.outbox("session")?.state).toBe("failed");
    const payload = JSON.parse(s.log.outbox("session")!.payload) as Array<{
      name: string;
    }>;
    expect(
      payload.filter((span) => span.name === "orchestra.session"),
    ).toHaveLength(1);
    expect(existsSync(s.tree.path)).toBe(false);
    s.log.close();
  });

  it("phase 4 AC11 finalizes every planner and implementer session before shared-worktree removal", async () => {
    const s = await setup();
    s.log.stageExternalUrl(
      "session",
      "implementer",
      "Pull Request",
      "https://github.com/dcouple/example/pull/42",
      3,
    );
    s.log.append({
      deliveryId: "planner",
      app: "planner",
      action: "created",
      agentSessionId: "planner-session",
      issueId: "issue",
      issueIdentifier: "ENG-42",
      receivedAt: 3,
      rawBody: Buffer.from("{}"),
    });
    s.log.updateSessionWorktree(
      "planner-session",
      s.tree.path,
      s.tree.branch,
      3,
    );
    const plannerTurn = s.log.claimNextTurn(4)!;
    s.log.finishTurn(plannerTurn.id, "response", "planned", 5);
    s.log.markTurnActivityPosted(plannerTurn.id, 6);
    complete(s.log);
    const worker = new CleanupWorker(
      s.log,
      new Poster() as unknown as LinearGateway,
      s.root,
      s.repo,
      { pollMs: 10_000, reconcileMs: 10_000 },
    );
    await worker.trigger();
    expect(s.log.outbox("session")?.state).toBe("failed");
    expect(s.log.outbox("planner-session")?.state).toBe("failed");
    for (const id of ["session", "planner-session"]) {
      const spans = JSON.parse(s.log.outbox(id)!.payload) as Array<{
        name: string;
      }>;
      expect(
        spans.filter((span) => span.name === "orchestra.session"),
      ).toHaveLength(1);
    }
    expect(existsSync(s.tree.path)).toBe(false);
    expect(s.log.cleanupStates()[0]?.status).toBe("done");
    s.log.close();
  });
});
