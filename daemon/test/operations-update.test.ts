import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import { executable, git, opsFixture, readNumber, stageMain, treeSnapshot, updateRepo, type OpsFixture, type UpdateRepo } from "./operations-fixtures.js";

function statusJson(f: OpsFixture, args: string[], env: NodeJS.ProcessEnv): Record<string, unknown> {
  const result = f.run(args, env);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function operationWorktree(f: OpsFixture): { id: string; path: string; owner: string } {
  const request = readdirSync(f.requests).find(name => name.endsWith(".ready"))!;
  const id = request.replace(/\.ready$/, "");
  return {
    id,
    path: join(f.state, "worktrees", id),
    owner: join(f.state, "worktree-owners", `${id}.deploy.json`),
  };
}

describe("operator-managed checkout reload boundary", () => {
  function expectNoReloadMutation(f: OpsFixture, repo: UpdateRepo): void {
    expect(readdirSync(f.requests)).toHaveLength(0);
    expect(existsSync(f.provisionLog)).toBe(false);
    expect(readNumber(f.restartCount)).toBe(0);
    const log = new EventLog(f.db);
    expect(log.activeOperation()).toBeUndefined();
    expect(log.operationStatus().lastOutcome).toBeNull();
    log.close();
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.accepted);
    expect(readFileSync(f.deployed, "utf8").trim()).toBe(repo.accepted);
  }

  it("deploys the exact operator-staged checkout SHA without fetching and keeps update as an alias", () => {
    const f = opsFixture(), repo = updateRepo(f);
    stageMain(repo);
    const gitLog = join(f.dir, "daemonctl-git.log");
    const gitWrapper = executable(join(f.dir, "git-wrapper"), `printf '%s\\n' "$*" >> '${gitLog}'; exec git "$@"`);
    const result = f.run(["reload"], { ...repo.env, GIT_BIN: gitWrapper });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.main);
    expect(readFileSync(f.deployed, "utf8").trim()).toBe(repo.main);
    expect(git(["rev-parse", "HEAD"], repo.checkout)).toBe(repo.main);
    expect(readFileSync(f.provisionLog, "utf8")).toContain(`${repo.main}|`);
    expect(readNumber(f.restartCount)).toBe(1);
    expect(readFileSync(gitLog, "utf8")).not.toMatch(/(^|\s)fetch(\s|$)/m);
    expect(result.stdout).toContain(`deployed ${repo.accepted} -> ${repo.main}`);
    const done = join(f.requests, readdirSync(f.requests).find(name => name.endsWith(".done"))!);
    expect(JSON.parse(readFileSync(done, "utf8"))).toMatchObject({
      previous_commit: repo.accepted,
      target_commit: repo.main,
      target_ref: "checkout/HEAD",
    });
    const before = treeSnapshot([f.accepted, f.deployed, f.provisionLog, f.restartCount]);
    const again = f.run(["update"], repo.env);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(`already deployed and accepted: ${repo.main}`);
    expect(treeSnapshot([f.accepted, f.deployed, f.provisionLog, f.restartCount])).toBe(before);
  }, 15_000);

  it("re-provisions the accepted checkout when the deployed marker is missing", () => {
    const f = opsFixture(), repo = updateRepo(f);
    rmSync(f.deployed);
    const result = f.run(["reload"], repo.env);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.deployed, "utf8").trim()).toBe(repo.accepted);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.accepted);
    expect(readFileSync(f.provisionLog, "utf8")).toContain(`${repo.accepted}|`);
    expect(readNumber(f.restartCount)).toBe(1);
  });

  it("reports local revision reconciliation and fetches only for explicit status --refresh", () => {
    const f = opsFixture(), repo = updateRepo(f);
    let status = statusJson(f, ["status"], repo.env);
    expect(status).toMatchObject({ revision: {
      runningCommit: repo.accepted,
      acceptedCommit: repo.accepted,
      checkoutCommit: repo.accepted,
      remoteTrackingCommit: repo.accepted,
      refreshed: false,
      reconciliation: "current",
    } });

    status = statusJson(f, ["status", "--refresh"], repo.env);
    expect(status).toMatchObject({ revision: {
      remoteTrackingCommit: repo.main,
      refreshed: true,
      reconciliation: "remote_ahead_pull_required",
    } });

    git(["merge", "--ff-only", "refs/remotes/origin/main"], repo.checkout, repo.env);
    status = statusJson(f, ["status"], repo.env);
    expect(status).toMatchObject({ revision: {
      checkoutCommit: repo.main,
      reconciliation: "checkout_ahead_reload_required",
    } });

    writeFileSync(join(repo.checkout, "dirty"), "dirty\n");
    status = statusJson(f, ["status"], repo.env);
    expect(status).toMatchObject({ revision: { checkoutState: "dirty", reconciliation: "dirty_checkout" } });
  }, 15_000);

  it("rejects dirty, missing or malformed markers, non-HTTPS origins, and non-descendant checkouts before mutation", () => {
    {
      const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
      writeFileSync(join(repo.checkout, "dirty"), "dirty\n");
      expect(f.run(["reload"], repo.env).stderr).toContain("checkout is dirty");
      rmSync(join(repo.checkout, "dirty"));
      expectNoReloadMutation(f, repo);
    }
    for (const marker of ["absent", "malformed"] as const) {
      const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
      if (marker === "absent") rmSync(f.accepted);
      else writeFileSync(f.accepted, "not-a-sha\n");
      const result = f.run(["reload"], repo.env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/marker missing|malformed accepted commit marker/);
      expect(readdirSync(f.requests)).toHaveLength(0);
      expect(existsSync(f.provisionLog)).toBe(false);
    }
    {
      const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
      git(["remote", "set-url", "origin", repo.origin], repo.checkout);
      const result = f.run(["reload"], repo.env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("origin must use HTTPS");
      expectNoReloadMutation(f, repo);
    }
    {
      const f = opsFixture(), repo = updateRepo(f);
      git(["config", "user.email", "fixture@example.test"], repo.checkout);
      git(["config", "user.name", "Fixture"], repo.checkout);
      git(["checkout", "--orphan", "diverged"], repo.checkout);
      git(["rm", "-rf", "."], repo.checkout);
      writeFileSync(join(repo.checkout, "diverged"), "local\n");
      git(["add", "."], repo.checkout); git(["commit", "-m", "diverged"], repo.checkout);
      const result = f.run(["reload"], repo.env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a fast-forward descendant");
      expectNoReloadMutation(f, repo);
    }
  }, 30_000);

  it("revalidates the staged SHA after drain without moving the operator checkout", () => {
    const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
    expect(f.run(["reload"], { ...repo.env, DAEMONCTL_NO_ACTIVATE: "1" }).status).toBe(0);
    writeFileSync(join(repo.checkout, "changed-after-schedule"), "dirty\n");
    const result = f.run(["internal-execute"], repo.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("scheduled commits");
    const log = new EventLog(f.db);
    expect(log.operationStatus().pending).toMatchObject({ drainState: "blocked", stage: "revalidate" });
    log.close();
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.accepted);
  });

  it("reuses its exact worktree after interruption immediately after creation", () => {
    const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
    const crashed = f.run(["reload"], { ...repo.env, DAEMONCTL_FAULT_AFTER: "worktree_create" });
    expect(crashed.status).toBe(99);
    const request = readdirSync(f.requests).find(name => name.endsWith(".ready"))!;
    const updateTree = join(f.state, "worktrees", request.replace(/\.ready$/, ""));
    expect(git(["rev-parse", "HEAD"], updateTree)).toBe(repo.main);
    const recovered = f.run(["internal-execute"], repo.env);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(f.provisionLog, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.main);
    expect(git(["rev-parse", "HEAD"], repo.checkout)).toBe(repo.main);
    expect(existsSync(updateTree)).toBe(false);
  });

  it("recovers when interrupted after reserving ownership but before Git registration", () => {
    const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
    const crashed = f.run(["reload"], { ...repo.env, DAEMONCTL_FAULT_AFTER: "worktree_owner_reserved" });
    expect(crashed.status).toBe(99);
    const operation = operationWorktree(f);
    expect(existsSync(operation.path)).toBe(false);
    expect(JSON.parse(readFileSync(operation.owner, "utf8"))).toMatchObject({
      operationId: operation.id,
      role: "deploy",
      commit: repo.main,
      state: "creating",
    });
    expect(f.run(["internal-execute"], repo.env).status).toBe(0);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.main);
    expect(existsSync(operation.path)).toBe(false);
    expect(existsSync(operation.owner)).toBe(false);
  });

  it("recovers when interrupted after atomically confirming worktree ownership", () => {
    const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
    const crashed = f.run(["reload"], { ...repo.env, DAEMONCTL_FAULT_AFTER: "worktree_owner_confirmed" });
    expect(crashed.status).toBe(99);
    const operation = operationWorktree(f);
    expect(git(["rev-parse", "HEAD"], operation.path)).toBe(repo.main);
    expect(JSON.parse(readFileSync(operation.owner, "utf8"))).toMatchObject({
      operationId: operation.id,
      state: "created",
    });
    expect(f.run(["internal-execute"], repo.env).status).toBe(0);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.main);
    expect(existsSync(operation.owner)).toBe(false);
  });

  it("repairs an exactly owned stale registration with a missing directory and leaves unrelated worktrees untouched", () => {
    const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
    expect(f.run(["reload"], { ...repo.env, DAEMONCTL_FAULT_AFTER: "worktree_create" }).status).toBe(99);
    const operation = operationWorktree(f);
    const unrelated = join(f.state, "unrelated-worktree");
    git(["worktree", "add", "--detach", unrelated, repo.accepted], repo.checkout);
    rmSync(operation.path, { recursive: true, force: true });
    expect(existsSync(operation.path)).toBe(false);
    expect(f.run(["internal-execute"], repo.env).status).toBe(0);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.main);
    expect(git(["rev-parse", "HEAD"], unrelated)).toBe(repo.accepted);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("repairs an exactly owned registered path containing only a partial directory", () => {
    const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
    expect(f.run(["reload"], { ...repo.env, DAEMONCTL_FAULT_AFTER: "worktree_create" }).status).toBe(99);
    const operation = operationWorktree(f);
    rmSync(operation.path, { recursive: true, force: true });
    mkdirSync(operation.path);
    writeFileSync(join(operation.path, "partial"), "incomplete creation\n");
    const recovered = f.run(["internal-execute"], repo.env);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.main);
    expect(existsSync(operation.path)).toBe(false);
  });

  it("reuses its exact worktree after the executor is killed during provisioning", () => {
    const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
    expect(f.run(["reload"], { ...repo.env, DAEMONCTL_NO_ACTIVATE: "1" }).status).toBe(0);
    const crashed = f.run(["internal-execute"], { ...repo.env, FAKE_PROVISION_INTERRUPT: "1" });
    expect(crashed.signal).toBe("SIGKILL");
    const request = readdirSync(f.requests).find(name => name.endsWith(".ready"))!;
    const updateTree = join(f.state, "worktrees", request.replace(/\.ready$/, ""));
    expect(git(["rev-parse", "HEAD"], updateTree)).toBe(repo.main);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.accepted);
    expect(f.run(["internal-execute"], repo.env).status).toBe(0);
    expect(readFileSync(f.provisionLog, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.main);
    expect(git(["rev-parse", "HEAD"], repo.checkout)).toBe(repo.main);
    expect(existsSync(updateTree)).toBe(false);
  });

  it("preserves a foreign registered worktree even when it is clean at the expected commit", () => {
    const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
    expect(f.run(["reload"], { ...repo.env, DAEMONCTL_NO_ACTIVATE: "1" }).status).toBe(0);
    const operation = operationWorktree(f);
    git(["worktree", "add", "--detach", operation.path, repo.main], repo.checkout);
    const result = f.run(["internal-execute"], repo.env);
    expect(result.status).not.toBe(0);
    expect(git(["rev-parse", "HEAD"], operation.path)).toBe(repo.main);
    expect(existsSync(operation.owner)).toBe(false);
    const log = new EventLog(f.db);
    expect(log.operationStatus().pending).toMatchObject({ drainState: "blocked", stage: "worktree_prepare" });
    expect(log.operationById(operation.id)?.outcome).toContain("exact operation ownership");
    log.close();
  });

  it("rejects wrong or weak ownership metadata and preserves the registered path", () => {
    for (const invalid of ["content", "mode"] as const) {
      const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
      expect(f.run(["reload"], { ...repo.env, DAEMONCTL_FAULT_AFTER: "worktree_owner_reserved" }).status).toBe(99);
      const operation = operationWorktree(f);
      if (invalid === "content") {
        const owner = JSON.parse(readFileSync(operation.owner, "utf8")) as Record<string, unknown>;
        owner.operationId = "different-operation";
        writeFileSync(operation.owner, `${JSON.stringify(owner)}\n`);
      } else {
        chmodSync(operation.owner, 0o644);
      }
      git(["worktree", "add", "--detach", operation.path, repo.main], repo.checkout);
      const result = f.run(["internal-execute"], repo.env);
      expect(result.status).not.toBe(0);
      expect(git(["rev-parse", "HEAD"], operation.path)).toBe(repo.main);
      const log = new EventLog(f.db);
      expect(log.operationStatus().pending).toMatchObject({ drainState: "blocked", stage: "worktree_prepare" });
      log.close();
    }
  }, 20_000);

  it("durably blocks instead of touching a conflicting operation worktree path", () => {
    const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
    expect(f.run(["reload"], { ...repo.env, DAEMONCTL_NO_ACTIVATE: "1" }).status).toBe(0);
    const request = readdirSync(f.requests).find(name => name.endsWith(".ready"))!;
    const updateTree = join(f.state, "worktrees", request.replace(/\.ready$/, ""));
    mkdirSync(updateTree, { recursive: true });
    writeFileSync(join(updateTree, "unrelated"), "do not remove\n");
    const result = f.run(["internal-execute"], repo.env);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(updateTree, "unrelated"), "utf8")).toBe("do not remove\n");
    const log = new EventLog(f.db);
    expect(log.operationStatus().pending).toMatchObject({ drainState: "blocked", stage: "worktree_prepare" });
    log.close();
  });

  it("rolls back a failed reload, blocks an unaccepted rollback, and resumes after post-provision crash", () => {
    const f = opsFixture(), repo = updateRepo(f); stageMain(repo);
    writeFileSync(join(f.dir, "provision.failures"), "1\n");
    expect(f.run(["reload"], repo.env).status).not.toBe(0);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.accepted);
    expect(readFileSync(f.deployed, "utf8").trim()).toBe(repo.accepted);
    expect(git(["rev-parse", "HEAD"], repo.checkout)).toBe(repo.main);
    let log = new EventLog(f.db);
    expect(log.operationStatus().lastOutcome).toMatchObject({ state: "failed", stage: "rolled_back", errorStage: "provision" });
    log.close();

    const g = opsFixture(), blockedRepo = updateRepo(g); stageMain(blockedRepo);
    writeFileSync(join(g.dir, "provision.failures"), "2\n");
    expect(g.run(["reload"], blockedRepo.env).status).not.toBe(0);
    log = new EventLog(g.db);
    expect(log.operationStatus().pending).toMatchObject({ drainState: "blocked", stage: "rollback_acceptance" });
    log.close();

    const h = opsFixture(), crashRepo = updateRepo(h); stageMain(crashRepo);
    expect(h.run(["reload"], { ...crashRepo.env, DAEMONCTL_FAULT_AFTER: "provision" }).status).toBe(99);
    expect(readFileSync(h.accepted, "utf8").trim()).toBe(crashRepo.main);
    expect(readFileSync(h.deployed, "utf8").trim()).toBe(crashRepo.main);
    expect(git(["rev-parse", "HEAD"], crashRepo.checkout)).toBe(crashRepo.main);
    expect(h.run(["internal-execute"], crashRepo.env).status).toBe(0);
    expect(readFileSync(h.provisionLog, "utf8").trim().split("\n")).toHaveLength(1);
  }, 30_000);
});
