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
import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanupWorker } from "../src/cleanup.js";
import { EventLog } from "../src/eventlog.js";
import type { IssueStateResult, LinearGateway } from "../src/linear.js";
import { WorktreeReconciler } from "../src/worktree-reconciler.js";
import { WorktreeManager } from "../src/worktrees.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function harness(now = 1_000) {
  const dir = mkdtempSync(join(tmpdir(), "worktree-reconciler-"));
  dirs.push(dir);
  const seed = join(dir, "seed");
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  const root = join(dir, "trees");
  const bundles = join(dir, "bundles");
  mkdirSync(seed);
  git(["init", "-b", "main"], seed);
  git(["config", "user.email", "test@example.com"], seed);
  git(["config", "user.name", "Test"], seed);
  git(["commit", "--allow-empty", "-m", "initial"], seed);
  git(["clone", "--bare", seed, origin]);
  git(["clone", origin, repo]);
  const log = new EventLog(join(dir, "events.db"));
  const worktrees = new WorktreeManager(root, repo);
  const states = new Map<string, IssueStateResult>();
  const gateway = {
    issueState: vi.fn(async (_app: string, identifier: string) =>
      states.get(identifier) ?? { kind: "not_found" },
    ),
  } as unknown as LinearGateway;
  const enqueued = vi.fn();
  const logger = { log: vi.fn(), error: vi.fn() };
  const clock = { value: now };
  const reconciler = new WorktreeReconciler(
    log,
    gateway,
    worktrees,
    {
      worktreesRoot: root,
      worktreeUnlinkedGraceMs: 100,
      worktreeBundlesDir: bundles,
    },
    { now: () => clock.value, onEnqueued: enqueued, logger },
  );
  return {
    dir,
    origin,
    repo,
    root,
    bundles,
    log,
    worktrees,
    states,
    gateway,
    enqueued,
    logger,
    clock,
    reconciler,
  };
}

async function addSession(
  h: ReturnType<typeof harness>,
  identifier: string,
  issueId: string,
  withPath = true,
) {
  const tree = await h.worktrees.ensureWorktree(identifier);
  h.log.append({
    deliveryId: `session-${identifier}`,
    app: "implementer",
    action: "created",
    agentSessionId: `session-${identifier}`,
    issueId,
    issueIdentifier: identifier,
    receivedAt: 1,
    rawBody: Buffer.from("{}"),
  });
  if (withPath)
    h.log.updateSessionWorktree(
      `session-${identifier}`,
      tree.path,
      tree.branch,
      2,
    );
  const turn = h.log.claimNextTurn(2)!;
  h.log.finishTurn(turn.id, "response", "done", 2);
  h.log.markTurnActivityPosted(turn.id, 2);
  return tree;
}

describe("WorktreeReconciler", () => {
  it("closes a resolved session-backed worktree end-to-end without an Issue webhook", async () => {
    const h = harness();
    const tree = await addSession(h, "ENG-1", "issue-1");
    h.log.stageExternalUrl(
      "session-ENG-1",
      "implementer",
      "Pull Request",
      "https://github.com/dcouple/example/pull/1",
      3,
    );
    h.states.set("ENG-1", {
      kind: "found",
      issueId: "issue-1",
      stateType: "completed",
    });
    expect(h.log.count()).toBe(1);
    await h.reconciler.trigger();
    expect(h.log.cleanupStates()).toEqual([
      { id: 1, status: "pending", issueId: "issue-1" },
    ]);
    expect(h.enqueued).toHaveBeenCalledOnce();
    const cleanup = new CleanupWorker(
      h.log,
      h.gateway,
      h.root,
      h.repo,
      {
        worktrees: h.worktrees,
        bundlesDir: h.bundles,
        now: () => h.clock.value,
      },
    );
    await cleanup.trigger();
    expect(h.log.count()).toBe(1);
    expect(h.log.cleanupStates()).toEqual([
      { id: 1, status: "done", issueId: "issue-1" },
    ]);
    expect(existsSync(tree.path)).toBe(false);
    expect(() =>
      git(["show-ref", "--verify", "refs/heads/agents/ENG-1"], h.repo),
    ).toThrow();
    await cleanup.stop();
    h.log.close();
  });

  it.each(["completed", "canceled"])(
    "directly preserves and removes a no-session %s worktree",
    async (stateType) => {
      const h = harness();
      const tree = await h.worktrees.ensureWorktree(
        stateType === "completed" ? "ENG-2" : "ENG-3",
      );
      writeFileSync(join(tree.path, "dirty.txt"), stateType);
      const identifier = tree.branch.replace("agents/", "");
      h.states.set(identifier, {
        kind: "found",
        issueId: `issue-${identifier}`,
        stateType,
      });
      await h.reconciler.trigger();
      expect(existsSync(tree.path)).toBe(false);
      expect(
        git(
          ["show", `refs/heads/${tree.branch}:dirty.txt`],
          h.origin,
        ).trim(),
      ).toBe(stateType);
      expect(h.logger.log).toHaveBeenCalledWith(
        expect.stringContaining("worktree_reconciled"),
      );
      h.log.close();
    },
  );

  it("starts and expires only the persisted unlinked grace clock", async () => {
    const h = harness();
    const tree = await h.worktrees.ensureWorktree("ENG-4");
    await h.reconciler.trigger();
    expect(h.log.unlinkedObservation("ENG-4")?.firstObservedAt).toBe(1_000);
    expect(existsSync(tree.path)).toBe(true);
    h.clock.value = 1_099;
    await h.reconciler.trigger();
    expect(existsSync(tree.path)).toBe(true);
    h.clock.value = 1_100;
    await h.reconciler.trigger();
    expect(existsSync(tree.path)).toBe(false);
    expect(h.log.unlinkedObservation("ENG-4")).toBeUndefined();
    h.log.close();
  });

  it("gives a recreated unlinked worktree a fresh grace clock", async () => {
    const h = harness();
    const original = await h.worktrees.ensureWorktree("ENG-12");
    await h.reconciler.trigger();
    expect(h.log.unlinkedObservation("ENG-12")?.firstObservedAt).toBe(1_000);

    await h.worktrees.remove("ENG-12");
    expect(existsSync(original.path)).toBe(false);
    const recreated = await h.worktrees.ensureWorktree("ENG-12");
    h.clock.value = 10_000;
    await h.reconciler.trigger();

    expect(existsSync(recreated.path)).toBe(true);
    expect(h.log.unlinkedObservation("ENG-12")?.firstObservedAt).toBe(10_000);
    h.log.close();
  });

  it("skips lookup errors without writing the grace clock", async () => {
    const h = harness();
    const tree = await h.worktrees.ensureWorktree("ENG-5");
    h.states.set("ENG-5", { kind: "error", error: "timeout" });
    await h.reconciler.trigger();
    expect(existsSync(tree.path)).toBe(true);
    expect(h.log.unlinkedObservation("ENG-5")).toBeUndefined();
    h.log.close();
  });

  it("leaves unresolved worktrees and clears stale unlinked observations", async () => {
    const h = harness();
    const tree = await h.worktrees.ensureWorktree("ENG-6");
    const snapshot = await h.worktrees.snapshot("ENG-6");
    h.log.observeUnlinkedWorktree("ENG-6", tree.path, snapshot!.identity, 1);
    h.states.set("ENG-6", {
      kind: "found",
      issueId: "issue-6",
      stateType: "started",
    });
    await h.reconciler.trigger();
    expect(existsSync(tree.path)).toBe(true);
    expect(h.log.unlinkedObservation("ENG-6")).toBeUndefined();
    expect(h.log.cleanupStates()).toEqual([]);
    h.log.close();
  });

  it("never touches a foreign directory", async () => {
    const h = harness();
    mkdirSync(h.root);
    const foreign = join(h.root, "ENG-7");
    git(["clone", h.origin, foreign]);
    await h.reconciler.trigger();
    expect(existsSync(foreign)).toBe(true);
    expect(h.gateway.issueState).not.toHaveBeenCalled();
    h.log.close();
  });

  it("repromotes a retained cleanup and signals the cleanup worker", async () => {
    const h = harness();
    await addSession(h, "ENG-8", "issue-8");
    h.log.enqueueCleanupFromReconcile("issue-8", "ENG-8", 3);
    const job = h.log.claimNextCleanup(3)!;
    h.log.retainCleanup(job.id, "old preservation failure", 3);
    h.states.set("ENG-8", {
      kind: "found",
      issueId: "issue-8",
      stateType: "completed",
    });
    await h.reconciler.trigger();
    expect(h.log.cleanupStates()[0]?.status).toBe("pending");
    expect(h.enqueued).toHaveBeenCalledOnce();
    h.log.close();
  });

  it("start performs one immediate coalesced sweep with no standing timer", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.worktrees.ensureWorktree("ENG-9");
    h.reconciler.start();
    const first = h.reconciler.trigger();
    const second = h.reconciler.trigger();
    expect(first).toBe(second);
    await first;
    expect(vi.getTimerCount()).toBe(0);
    await h.reconciler.stop();
    h.log.close();
  });

  it("keeps a worktree when ensureWorktree reuses it during the lookup", async () => {
    const h = harness();
    const tree = await h.worktrees.ensureWorktree("ENG-10");
    let release!: (result: IssueStateResult) => void;
    const lookup = new Promise<IssueStateResult>((resolve) => {
      release = resolve;
    });
    vi.mocked(h.gateway.issueState).mockReturnValueOnce(lookup);
    h.reconciler.start();
    while (!vi.mocked(h.gateway.issueState).mock.calls.length)
      await new Promise((resolve) => setTimeout(resolve, 0));
    let stopped = false;
    const stop = h.reconciler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await h.worktrees.ensureWorktree("ENG-10");
    release({
      kind: "found",
      issueId: "issue-10",
      stateType: "completed",
    });
    await stop;
    expect(existsSync(tree.path)).toBe(true);
    expect(git(["branch", "--show-current"], tree.path).trim()).toBe(
      "agents/ENG-10",
    );
    expect(
      git(["show-ref", "--verify", "refs/heads/agents/ENG-10"], h.repo).trim(),
    ).toContain("refs/heads/agents/ENG-10");
    expect(h.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"candidate_changed"'),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
    h.log.close();
  });

  it("is sequentially idempotent after a completed-state preservation and removal", async () => {
    const h = harness();
    const tree = await h.worktrees.ensureWorktree("ENG-11");
    writeFileSync(join(tree.path, "dirty.txt"), "preserve once");
    h.states.set("ENG-11", {
      kind: "found",
      issueId: "issue-11",
      stateType: "completed",
    });
    const preserve = vi.spyOn(h.worktrees, "preserveAndRemove");

    await h.reconciler.trigger();
    expect(preserve).toHaveBeenCalledOnce();
    expect(existsSync(tree.path)).toBe(false);
    expect(
      git(
        ["show", "refs/heads/agents/ENG-11:dirty.txt"],
        h.origin,
      ).trim(),
    ).toBe("preserve once");
    const jobsAfterFirst = h.log.cleanupStates();
    const observationAfterFirst = h.log.unlinkedObservation("ENG-11");
    const logsAfterFirst = h.logger.log.mock.calls.length;
    const errorsAfterFirst = h.logger.error.mock.calls.length;

    await h.reconciler.trigger();

    expect(preserve).toHaveBeenCalledOnce();
    expect(h.log.cleanupStates()).toEqual(jobsAfterFirst);
    expect(h.log.unlinkedObservation("ENG-11")).toEqual(
      observationAfterFirst,
    );
    expect(h.logger.log.mock.calls.length).toBe(logsAfterFirst);
    expect(h.logger.error.mock.calls.length).toBe(errorsAfterFirst);
    expect(existsSync(h.bundles)).toBe(false);
    h.log.close();
  });
});
