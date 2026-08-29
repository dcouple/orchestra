import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import { ConsoleOperationExecutor } from "../src/console-operation-executor.js";
import { canonicalJson, requestDigest, type ConsoleOperationRequest } from "../src/console-operation-schema.js";
import { writeConsoleConfigSnapshot } from "../src/console-config-snapshot.js";
import { appendTurn, executable, fixture, opsFixture, readNumber, treeSnapshot, updateRepo } from "./operations-fixtures.js";

async function macConsoleFixture(secret = "PHASE3_NEW_SECRET_SENTINEL", kind: "config.apply" | "daemon.restart" | "daemon.reload" = "config.apply") {
  const dir = mkdtempSync(join(tmpdir(), "mac-console-operation-"));
  const home = join(dir, "home"); const state = join(dir, "state"); const spool = join(state, "console-requests");
  for (const path of [home, state, join(state, "backups"), ...["staged", "ready", "executing", "control-staged", "controls", "rollback", "quarantine"].map(leaf => join(spool, leaf))])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "linear-agent-daemon")); symlinkSync(resolve("dist"), join(home, "linear-agent-daemon", "dist"));
  const envFile = join(dir, "protected.env");
  writeFileSync(envFile, "PLANNER_HARNESS='claude'\nIMPLEMENTER_HARNESS='claude'\nLINEAR_API_KEY='PHASE3_OLD_SECRET'\n", { mode: 0o640 });
  const snapshot = join(state, "console-config-snapshot.json"); await writeConsoleConfigSnapshot(envFile, snapshot, 1_000);
  const snapshotRevision = JSON.parse(readFileSync(snapshot, "utf8")).revision as string;
  const requestValue: ConsoleOperationRequest = kind === "config.apply"
    ? { version: 1, kind, snapshotRevision, changes: { plannerHarness: "claudex" }, secrets: { LINEAR_API_KEY: secret } }
    : { version: 1, kind, snapshotRevision };
  const digest = requestDigest(requestValue); const id = `console-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`;
  const db = join(dir, "events.db"); const log = new EventLog(db);
  log.scheduleOperation({ id, requestDigest: digest, type: kind === "config.apply" ? "config" : kind === "daemon.reload" ? "update" : "restart",
    reason: "fixture", actor: "local-console", requestKind: requestValue.kind,
    requestSummary: JSON.stringify({kind:requestValue.kind}), requestedAt: 1_100 });
  log.claimOperation(id, digest, 1_101);
  const requestPath = join(spool, "executing", `${id}.json`); writeFileSync(requestPath, `${canonicalJson(requestValue)}\n`, { mode: 0o600 });
  const bin = join(dir, "bin"); mkdirSync(bin);
  const restartLog = join(dir, "restarts"); const healthCount = join(dir, "health-count"); writeFileSync(healthCount, "0\n");
  writeFileSync(join(bin, "sudo"), `#!/bin/bash\nif [[ $2 == kickstart ]]; then echo restart >> '${restartLog}'; fi\nif [[ $2 == print ]]; then echo 'state = running'; fi\n`, { mode: 0o755 });
  const health = join(dir, "health.sh");
  writeFileSync(health, `#!/bin/bash\nn=$(($(cat '${healthCount}')+1)); echo $n > '${healthCount}'; IFS=, read -ra values <<< "\${HEALTH_SEQUENCE:-0}"; i=$((n-1)); [[ \${values[$i]:-0} == 0 ]]\n`, { mode: 0o755 });
  const site = join(dir, "site.env"); writeFileSync(site, ["DAEMON_PUBLIC_HOSTNAME=fixture.example.com", "DAEMON_SERVICE_USER=fixture",
    `DAEMON_SERVICE_HOME=${home}`, "DAEMON_LAUNCHD_PREFIX=com.example.fixture", "DAEMON_SOURCE_REPO_URL=https://github.com/example/repo.git"].join("\n") + "\n");
  const baseEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DAEMON_SITE_ENV: site,
    DAEMON_SITE_LIB: resolve("ops/macos/daemon-site-lib.sh"), DAEMONCTL_ALLOW_OTHER_USER: "1", DAEMONCTL_STATE_DIR: state,
    DAEMONCTL_ENV_FILE: envFile, DB_PATH: db, DAEMONCTL_OPS_CLI: resolve("dist/operations-cli.js"), NODE_BIN: process.execPath,
    DAEMONCTL_HEALTH_WAITER: health, HEALTH_SEQUENCE: "0" };
  const run = (extra: Record<string, string> = {}) => spawnSync("bash", [resolve("ops/macos/daemonctl"), "internal-console-execute"],
    { env: { ...baseEnv, ...extra }, encoding: "utf8" });
  return { dir, state, spool, envFile, snapshot, requestPath, restartLog, healthCount, secret, id, db, log, run };
}

function consoleReloadRepo(f: Awaited<ReturnType<typeof macConsoleFixture>>, failures=0) {
  const checkout=join(f.dir,"reload-checkout");mkdirSync(join(checkout,"daemon"),{recursive:true});
  const git=(...args:string[])=>execFileSync("git",args,{cwd:checkout,encoding:"utf8"}).trim();
  git("init","-b","main");git("config","user.email","fixture@example.test");git("config","user.name","Fixture");
  writeFileSync(join(checkout,"daemon","release.txt"),"accepted\n");git("add",".");git("-c","commit.gpgSign=false","commit","-m","accepted");
  const accepted=git("rev-parse","HEAD");writeFileSync(join(checkout,"daemon","release.txt"),"candidate\n");git("add",".");
  git("-c","commit.gpgSign=false","commit","-m","candidate");const target=git("rev-parse","HEAD");
  git("remote","add","origin","https://fixture.invalid/orchestra.git");
  const acceptedFile=join(f.state,"accepted-commit"),deployedFile=join(f.state,"deployed-commit");
  writeFileSync(acceptedFile,`${accepted}\n`);writeFileSync(deployedFile,`${accepted}\n`);
  const deployLog=join(f.dir,"deploy.log"),failureFile=join(f.dir,"deploy.failures");writeFileSync(failureFile,`${failures}\n`);
  const deploy=join(f.dir,"deploy.sh");writeFileSync(deploy,`#!/bin/bash\nset -euo pipefail\necho "$SOURCE_COMMIT|$1" >> '${deployLog}'\nn=$(cat '${failureFile}')\nif (( n > 0 )); then echo $((n-1)) > '${failureFile}'; exit 1; fi\necho "$SOURCE_COMMIT" > "$DEPLOYED_COMMIT_FILE"\necho "$SOURCE_COMMIT" > "$ACCEPTED_COMMIT_FILE"\n`,{mode:0o755});
  return {accepted,target,deployLog,env:{DAEMONCTL_SOURCE_CHECKOUT:checkout,DAEMONCTL_ACCEPTED_COMMIT_FILE:acceptedFile,
    DAEMONCTL_DEPLOYED_COMMIT_FILE:deployedFile,DAEMONCTL_DEPLOY:deploy}};
}

function filePayloads(root: string): Buffer[] {
  if (!existsSync(root)) return []; const info = statSync(root);
  if (info.isFile()) return [readFileSync(root)];
  return readdirSync(root).flatMap(name => filePayloads(join(root, name)));
}

describe("durable maintenance operations", () => {
  it("records pre/post tool hooks synchronously and blocks when the prehook database is unavailable", () => {
    const { dir, db } = fixture();
    let log = new EventLog(db);
    appendTurn(log, "hook", "OPS-HOOK");
    log.updateClaudeSessionId("session-hook", "claude-hook", 1001);
    log.claimNextTurn(1002);
    log.close();
    const cli = resolve("dist/operations-cli.js");
    const hook = (
      command: "tool-hook-open" | "tool-hook-complete",
      database: string,
      event: Record<string, unknown>,
    ) =>
      spawnSync(
        process.execPath,
        [cli, command, database, "1"],
        { input: JSON.stringify(event), encoding: "utf8" },
      );
    const identity = {
      tool_use_id: "toolu_hook_1",
      tool_name: "mcp__linear__update_issue",
    };
    const opened = hook("tool-hook-open", db, {
      hook_event_name: "PreToolUse",
      ...identity,
      tool_input: { private: "never persisted" },
    });
    expect(opened.status).toBe(0);
    expect(opened.stdout).toBe("");
    log = new EventLog(db);
    expect(log.openTurnToolCalls(1)).toEqual([
      expect.objectContaining({
        toolUseId: "toolu_hook_1",
        toolName: "mcp__linear__update_issue",
      }),
    ]);
    log.close();
    const completed = hook("tool-hook-complete", db, {
      hook_event_name: "PostToolUseFailure",
      ...identity,
      error: "fixture failure",
    });
    expect(completed.status).toBe(0);
    expect(completed.stdout).toBe("");
    log = new EventLog(db);
    expect(log.openTurnToolCalls(1)).toEqual([]);
    log.close();

    const blocked = hook("tool-hook-open", dir, {
      hook_event_name: "PreToolUse",
      ...identity,
    });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toBe(
      "tool call blocked: durable pre-execution record failed\n",
    );
    expect(blocked.stderr).not.toContain(dir);
  });

  it("tool hooks leave unrelated startup-recovery state untouched", () => {
    const { db } = fixture();
    const log = new EventLog(db);
    appendTurn(log, "outbox", "OPS-OUTBOX");
    log.claimNextTurn(1000);
    log.materializeOutbox("session-outbox", "[]", 1001);
    expect(log.leaseOutbox("session-outbox", "worker", 1002)).toBeDefined();
    expect(log.markOutboxSending("session-outbox", "worker", 1003)).toBe(true);
    log.close();
    const runHook = (
      command: "tool-hook-open" | "tool-hook-complete",
      hookEvent: "PreToolUse" | "PostToolUse",
    ) =>
      spawnSync(
        process.execPath,
        [resolve("dist/operations-cli.js"), command, db, "1"],
        {
          input: JSON.stringify({
            hook_event_name: hookEvent,
            tool_use_id: "toolu_outbox_1",
            tool_name: "Read",
          }),
          encoding: "utf8",
        },
      );
    const state = (): string => {
      const raw = new Database(db, { readonly: true });
      const row = raw
        .prepare(
          "SELECT state FROM telemetry_outbox WHERE session_id='session-outbox'",
        )
        .get() as { state: string };
      raw.close();
      return row.state;
    };
    const opened = runHook("tool-hook-open", "PreToolUse");
    expect(opened.status).toBe(0);
    expect(opened.stdout).toBe("");
    expect(state()).toBe("sending");
    const completed = runHook("tool-hook-complete", "PostToolUse");
    expect(completed.status).toBe(0);
    expect(completed.stdout).toBe("");
    expect(state()).toBe("sending");
  });

  it("classifies a prehook-open tool as human-required after restart", () => {
    const { db } = fixture();
    let log = new EventLog(db);
    appendTurn(log, "hook-restart", "OPS-HOOK-RESTART");
    log.updateClaudeSessionId(
      "session-hook-restart",
      "claude-hook-restart",
      1001,
    );
    log.claimNextTurn(1002);
    log.close();
    const result = spawnSync(
      process.execPath,
      [resolve("dist/operations-cli.js"), "tool-hook-open", db, "1"],
      {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_use_id: "toolu_restart_1",
          tool_name: "Bash",
        }),
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    log = new EventLog(db);
    expect(log.recoverStaleRunning(1100)).toEqual([
      expect.objectContaining({
        outcome: "resumed",
        reason: "unresolved_tool_call",
      }),
    ]);
    log.close();
  });

  it("blocks claims atomically, deduplicates restart, and releases only on a terminal safe outcome", () => {
    const { db } = fixture(); const log = new EventLog(db);
    appendTurn(log, "one", "OPS-1");
    const first = log.scheduleOperation({ id: "op-1", requestDigest: "a".repeat(64), type: "restart", reason: "routine" });
    expect(first.deduplicated).toBe(false);
    expect(log.claimNextTurn()).toBeUndefined();
    const duplicate = log.scheduleOperation({ id: "op-2", requestDigest: "b".repeat(64), type: "restart", reason: "again" });
    expect(duplicate).toMatchObject({ deduplicated: true, operation: { id: "op-1" } });
    expect(() => log.scheduleOperation({ id: "op-3", requestDigest: "c".repeat(64), type: "config", reason: "conflict" })).toThrow(/active operation/);
    expect(log.claimOperation("op-1", "wrong")).toBeUndefined();
    expect(log.claimOperation("op-1", "a".repeat(64))).toMatchObject({ state: "executing", stage: "apply", attempts: 1 });
    log.transitionOperation("op-1", "succeeded", "accepted", { mutated: true, outcome: "healthy" });
    expect(log.claimNextTurn()).toMatchObject({ issueId: "issue-one", status: "running" });
    log.close();
  });

  it("keeps blocked and unverified mutated failures gated", () => {
    const { db } = fixture(); const log = new EventLog(db);
    appendTurn(log, "one", "OPS-1");
    log.scheduleOperation({ id: "op-1", requestDigest: "a".repeat(64), type: "config", reason: "change" });
    log.transitionOperation("op-1", "executing", "replace", { mutated: true });
    expect(() => log.transitionOperation("op-1", "failed", "health", { errorStage: "health" })).toThrow(/verified rollback/);
    log.transitionOperation("op-1", "blocked", "health", { errorStage: "health" });
    expect(log.claimNextTurn()).toBeUndefined();
    expect(log.claimOperation("op-1", "a".repeat(64))).toBeUndefined();
    expect(log.operationStatus().pending).toMatchObject({ state: "blocked", recoveryCommand: "daemonctl operation retry op-1" });
    log.close();
  });

  it("parks coherent failures terminally, retries them, and keeps incoherent failures gated", () => {
    const { db } = fixture();
    const log = new EventLog(db);
    appendTurn(log, "queued", "OPS-QUEUED");
    log.scheduleOperation({
      id: "coherent",
      requestDigest: "a".repeat(64),
      type: "update",
      reason: "release",
    });
    log.claimOperation("coherent", "a".repeat(64));
    expect(
      log.parkOperationFailure(
        "coherent",
        "worktree_prepare",
        "disk full",
        "worktree_prepare",
      ),
    ).toMatchObject({ state: "failed" });
    expect(log.operationStatus().lastOutcome).toMatchObject({
      state: "failed",
      recoveryCommand: "daemonctl operation retry coherent",
    });
    expect(log.claimNextTurn()).toMatchObject({ issueId: "issue-queued" });
    expect(log.retryOperation("coherent")).toMatchObject({
      state: "pending",
      stage: null,
      errorStage: null,
    });
    log.transitionOperation("coherent", "executing", "provision", {
      mutated: true,
    });
    expect(
      log.parkOperationFailure(
        "coherent",
        "rollback_acceptance",
        "rollback failed",
        "rollback_acceptance",
      ),
    ).toMatchObject({ state: "blocked" });
    expect(log.claimNextTurn()).toBeUndefined();
    log.close();
  });

  it("requires fresh rollback verification after retrying an operation", () => {
    const { db } = fixture();
    const log = new EventLog(db);
    log.scheduleOperation({
      id: "fresh-rollback",
      requestDigest: "b".repeat(64),
      type: "update",
      reason: "retry safely",
    });
    log.transitionOperation("fresh-rollback", "executing", "provision", {
      mutated: true,
    });
    log.transitionOperation("fresh-rollback", "failed", "rolled_back", {
      errorStage: "provision",
      rollbackVerified: true,
    });

    expect(log.retryOperation("fresh-rollback")).toMatchObject({
      state: "pending",
      rollbackVerified: 0,
    });
    log.transitionOperation("fresh-rollback", "executing", "provision", {
      mutated: true,
    });
    expect(() => log.cancelOperation("fresh-rollback")).toThrow(
      "operation may not be cancelled after mutation without verified rollback",
    );
    log.close();
  });

  it("projects only safe running and operation fields", () => {
    const { db } = fixture(); const log = new EventLog(db);
    appendTurn(log, "raw-session-secret", "OPS-9");
    log.claimNextTurn(2_000);
    log.scheduleOperation({ id: "op-safe", requestDigest: "d".repeat(64), type: "update", reason: "release",
      targetRef: "refs/heads/main", targetCommit: "e".repeat(40), previousCommit: "f".repeat(40) });
    const output = JSON.stringify({ turns: log.runningTurns(3_000), status: log.operationStatus(3_000) });
    expect(output).toContain("OPS-9");
    expect(output).not.toContain("raw-session-secret");
    expect(output).not.toContain("secret-prompt");
    log.close();
  });
});

describe("macOS console operation crash recovery", () => {
  it("executes a console reload through the exact detached-worktree deploy workflow", async () => {
    const f=await macConsoleFixture("UNUSED_RELOAD_SECRET","daemon.reload");const repo=consoleReloadRepo(f);
    try {
      const result=f.run(repo.env);expect(result.status,result.stderr).toBe(0);
      expect(readFileSync(repo.deployLog,"utf8").trim().split("\n")).toEqual([expect.stringMatching(new RegExp(`^${repo.target}\\|`))]);
      expect(f.log.operationById(f.id)).toMatchObject({state:"succeeded",stage:"accepted",type:"update",
        targetRef:"checkout/HEAD",targetCommit:repo.target,previousCommit:repo.accepted,mutated:1});
      expect(f.log.operationEvents(f.id).map(event=>event.stage)).toEqual(expect.arrayContaining(["provision","accepted"]));
    } finally {f.log.close();rmSync(f.dir,{recursive:true,force:true});}
  });

  it("rolls a failed console reload back to the internally derived accepted commit", async () => {
    const f=await macConsoleFixture("UNUSED_RELOAD_SECRET","daemon.reload");const repo=consoleReloadRepo(f,1);
    try {
      const result=f.run(repo.env);expect(result.status).toBe(1);
      expect(readFileSync(repo.deployLog,"utf8").trim().split("\n").map(line=>line.split("|")[0]))
        .toEqual([repo.target,repo.accepted]);
      expect(f.log.operationById(f.id)).toMatchObject({state:"failed",stage:"rolled_back",targetCommit:repo.target,
        previousCommit:repo.accepted,mutated:1,rollbackVerified:1});
    } finally {f.log.close();rmSync(f.dir,{recursive:true,force:true});}
  });

  it("replays the still-secret executing request after a pre-intent crash without duplicate restart", async () => {
    const f = await macConsoleFixture("PRE_INTENT_SECRET_SENTINEL");
    try {
      const crashed = f.run({ DAEMONCTL_FAULT_AFTER: "candidate_rendered" }); expect(crashed.status).toBe(99);
      expect(readFileSync(f.envFile, "utf8")).toContain("PHASE3_OLD_SECRET"); expect(readdirSync(join(f.spool, "rollback"))).toEqual([]);
      expect(readFileSync(f.requestPath, "utf8")).toContain(f.secret);
      const resumed = f.run(); expect(resumed.status, resumed.stderr).toBe(0);
      expect(readFileSync(f.envFile, "utf8")).toContain(f.secret); expect(readFileSync(f.restartLog, "utf8").trim().split("\n")).toHaveLength(1);
      expect(f.log.operationById(f.id)).toMatchObject({ state: "succeeded", stage: "accepted" });
    } finally { f.log.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("accepts a secret change without retaining the sentinel outside the protected env", async () => {
    const f = await macConsoleFixture();
    try {
      const result = f.run(); expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(f.envFile, "utf8")).toContain(`LINEAR_API_KEY='${f.secret}'`);
      expect(statSync(f.envFile).mode & 0o777).toBe(0o640);
      expect(f.log.operationById(f.id)).toMatchObject({ state: "succeeded", stage: "accepted", mutated: 1 });
      expect(readFileSync(f.restartLog, "utf8").trim().split("\n")).toHaveLength(1);
      const surfaces = [result.stdout, result.stderr, JSON.stringify(f.log.listOperations()), JSON.stringify(f.log.operationEvents(f.id)),
        readFileSync(f.db), ...filePayloads(f.state), ...filePayloads(resolve("dist"))];
      for (const surface of surfaces) expect(String(surface)).not.toContain(f.secret);
      expect(readdirSync(join(f.state, "backups"))).toEqual([]);
      expect(readdirSync(join(f.spool, "executing"))).toEqual([]); expect(readdirSync(join(f.spool, "rollback"))).toEqual([]);
    } finally { f.log.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("drains a terminal success trigger after the exact post-transition crash even beyond bounded history", async () => {
    const f = await macConsoleFixture("TERMINAL_SUCCESS_SECRET_SENTINEL");
    try {
      const crashed = f.run({ DAEMONCTL_FAULT_AFTER: "terminal_accept" }); expect(crashed.status).toBe(99);
      expect(f.log.operationById(f.id)).toMatchObject({ state: "succeeded", stage: "accepted" });
      expect(readdirSync(join(f.spool, "rollback"))).toEqual([`${f.id}.json`]);
      for (let index = 0; index < 101; index += 1) {
        const id = `terminal-history-${index}`; const digest = (index + 1).toString(16).padStart(64, "0");
        f.log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "history", actor: "local-console",
          requestKind: "daemon.restart", requestedAt: 2_000 + index });
        f.log.transitionOperation(id, "succeeded", "accepted", { outcome: "history" }, 2_000 + index);
      }
      expect(f.log.listOperations(100).some(row => row.id === f.id)).toBe(false);
      const restarts = readFileSync(f.restartLog, "utf8"); let processCalls = 0;
      await new ConsoleOperationExecutor({ log: f.log, spoolDir: f.spool, executable: "/fixed/daemonctl",
        argv: ["internal-console-execute"], run: async () => { processCalls += 1; } }).run();
      expect(processCalls).toBe(0); expect(readFileSync(f.restartLog, "utf8")).toBe(restarts);
      expect(readdirSync(join(f.spool, "rollback"))).toEqual([]); expect(readdirSync(join(f.state, "backups"))).toEqual([]);
    } finally { f.log.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("drains an accepted rollback trigger after the exact post-transition crash without another restart", async () => {
    const f = await macConsoleFixture("TERMINAL_ROLLBACK_SECRET_SENTINEL");
    try {
      const preIntent = f.run({ DAEMONCTL_FAULT_AFTER: "rollback_trigger" }); expect(preIntent.status).toBe(99);
      const candidate = `${f.envFile}.new.${f.id}`; expect(readFileSync(candidate, "utf8")).toContain(f.secret);
      const crashed = f.run({ DAEMONCTL_FAULT_AFTER: "terminal_rollback_accept" }); expect(crashed.status).toBe(99);
      expect(f.log.operationById(f.id)).toMatchObject({ state: "failed", stage: "rolled_back", rollbackVerified: 1 });
      expect(readdirSync(join(f.spool, "rollback"))).toEqual([`${f.id}.json`]);
      const restarts = readFileSync(f.restartLog, "utf8"); let processCalls = 0;
      await new ConsoleOperationExecutor({ log: f.log, spoolDir: f.spool, executable: "/fixed/daemonctl",
        argv: ["internal-console-execute"], environmentFile: f.envFile, run: async () => { processCalls += 1; } }).run();
      expect(processCalls).toBe(0); expect(readFileSync(f.restartLog, "utf8")).toBe(restarts);
      expect(readdirSync(join(f.spool, "rollback"))).toEqual([]); expect(readFileSync(f.envFile, "utf8")).not.toContain(f.secret);
      expect(readdirSync(join(f.state, "backups"))).toEqual([]); expect(existsSync(candidate)).toBe(false);
      expect(filePayloads(f.state).every(value => !String(value).includes(f.secret))).toBe(true);
    } finally { f.log.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("fsyncs the request directory when a restart cancellation removes its executing artifact", async () => {
    const f = await macConsoleFixture("UNUSED_RESTART_SECRET", "daemon.restart");
    try {
      const target = f.log.operationById(f.id)!; const control = { version: 1 as const, kind: "operation.cancel" as const,
        targetOperationId: f.id, targetDigest: target.requestDigest, expectedVersion: target.stateVersion };
      f.log.createOperationControl({ id: "restart-cancel-control", digest: requestDigest(control), targetOperationId: f.id,
        targetDigest: target.requestDigest, kind: "cancel", reason: "cancel fixture", expectedVersion: target.stateVersion });
      const cancelled = f.run({ DAEMONCTL_FAULT_AFTER: "console_artifact_directories_synced" });
      expect(cancelled.status).toBe(99); expect(existsSync(f.requestPath)).toBe(false);
      expect(f.log.operationById(f.id)).toMatchObject({ state: "cancelled", cancelRequested: 1 });
      expect(existsSync(f.restartLog)).toBe(false);
    } finally { f.log.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.each(["rollback_trigger", "rollback_intent", "replace_environment", "secret_unlink"])(
    "resumes rollback after a crash at %s with one recovery restart and no secret residue", async boundary => {
      const f = await macConsoleFixture(`CRASH_SECRET_${boundary.toUpperCase()}`);
      try {
        const crashed = f.run({ DAEMONCTL_FAULT_AFTER: boundary }); expect(crashed.status).toBe(99);
        expect(readdirSync(join(f.spool, "rollback"))).toEqual([`${f.id}.json`]);
        expect(readFileSync(join(f.spool, "rollback", `${f.id}.json`), "utf8")).not.toContain(f.secret);
        const resumed = f.run(); expect(resumed.status, resumed.stderr).toBe(0);
        expect(readFileSync(f.envFile, "utf8")).toContain("PHASE3_OLD_SECRET"); expect(readFileSync(f.envFile, "utf8")).not.toContain(f.secret);
        expect(statSync(f.envFile).mode & 0o777).toBe(0o640);
        expect(f.log.operationById(f.id)).toMatchObject({ state: "failed", stage: "rolled_back", rollbackVerified: 1 });
        expect(readFileSync(f.restartLog, "utf8").trim().split("\n")).toHaveLength(1);
        expect(readdirSync(join(f.spool, "executing"))).toEqual([]); expect(readdirSync(join(f.spool, "rollback"))).toEqual([]);
        expect(readdirSync(join(f.state, "backups"))).toEqual([]);
        expect(`${crashed.stdout}${crashed.stderr}${resumed.stdout}${resumed.stderr}${JSON.stringify(f.log.listOperations())}`).not.toContain(f.secret);
      } finally { f.log.close(); rmSync(f.dir, { recursive: true, force: true }); }
    }, 20_000);

  it("restores and verifies the prior env after failed acceptance without retaining secret transients", async () => {
    const f = await macConsoleFixture("ROLLBACK_SECRET_SENTINEL");
    try {
      const result = f.run({ HEALTH_SEQUENCE: "1,0" }); expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(f.envFile, "utf8")).toContain("PHASE3_OLD_SECRET"); expect(readFileSync(f.envFile, "utf8")).not.toContain(f.secret);
      expect(f.log.operationById(f.id)).toMatchObject({ state: "failed", stage: "rolled_back", rollbackVerified: 1 });
      expect(readFileSync(f.restartLog, "utf8").trim().split("\n")).toHaveLength(2);
      expect(readdirSync(join(f.spool, "executing"))).toEqual([]); expect(readdirSync(join(f.spool, "rollback"))).toEqual([]);
      expect(readdirSync(join(f.state, "backups"))).toEqual([]);
    } finally { f.log.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("resumes rollback acceptance after a crash immediately after exact-byte restore", async () => {
    const f = await macConsoleFixture("ROLLBACK_RESTORE_CRASH_SENTINEL");
    try {
      const crashed = f.run({ HEALTH_SEQUENCE: "1", DAEMONCTL_FAULT_AFTER: "rollback_restore" }); expect(crashed.status).toBe(99);
      expect(readFileSync(f.envFile, "utf8")).toContain("PHASE3_OLD_SECRET"); expect(readFileSync(f.envFile, "utf8")).not.toContain(f.secret);
      expect(readdirSync(join(f.spool, "rollback"))).toEqual([`${f.id}.json`]);
      const resumed = f.run(); expect(resumed.status, resumed.stderr).toBe(0);
      expect(f.log.operationById(f.id)).toMatchObject({ state: "failed", stage: "rolled_back", rollbackVerified: 1 });
      expect(readFileSync(f.restartLog, "utf8").trim().split("\n")).toHaveLength(2);
      expect(readdirSync(join(f.spool, "executing"))).toEqual([]); expect(readdirSync(join(f.spool, "rollback"))).toEqual([]);
    } finally { f.log.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("blocks after failed rollback acceptance, removes secret transients, and retains only the old backup", async () => {
    const f = await macConsoleFixture("FAILED_ROLLBACK_SECRET_SENTINEL");
    try {
      const failed = f.run({ HEALTH_SEQUENCE: "1,1" }); expect(failed.status).not.toBe(0);
      expect(f.log.operationById(f.id)).toMatchObject({ state: "blocked", stage: "rollback_acceptance", mutated: 1, rollbackVerified: 0 });
      expect(readFileSync(f.envFile, "utf8")).toContain("PHASE3_OLD_SECRET"); expect(readFileSync(f.envFile, "utf8")).not.toContain(f.secret);
      expect(readdirSync(join(f.spool, "executing"))).toEqual([]); expect(readdirSync(join(f.spool, "rollback"))).toEqual([]);
      expect(readdirSync(join(f.state, "backups"))).toEqual([`${f.id}.env`]);
      expect(readFileSync(join(f.state, "backups", `${f.id}.env`), "utf8")).not.toContain(f.secret);
      expect(f.log.operationStatus().pending?.recoveryCommand).toContain(`operation retry ${f.id}`);
    } finally { f.log.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe("daemonctl command boundaries", () => {
  const daemonctl = join(process.cwd(), "ops/daemonctl");

  it("documents every public command and rejects invalid harness values before mutation", () => {
    const help = execFileSync(daemonctl, ["--help"], { encoding: "utf8" });
    for (const command of ["config", "restart", "update", "status", "sessions", "top", "subscriptions", "operation"]) expect(help).toContain(command);
    const { dir } = fixture(); const envFile = join(dir, "env"); writeFileSync(envFile, "SECRET=keep\n");
    const result = spawnSync(daemonctl, ["config", "--planner", "invalid", "--implementer", "claude", "--dry-run"], {
      env: { ...process.env, DAEMONCTL_ALLOW_NON_ROOT: "1", DAEMONCTL_ENV_FILE: envFile }, encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(execFileSync("shasum", [envFile], { encoding: "utf8" })).toBeTruthy();
    expect(execFileSync("cat", [envFile], { encoding: "utf8" })).toBe("SECRET=keep\n");
  });

  it("config dry-run is deterministic and does not expose unrelated environment values", () => {
    const { dir } = fixture(); const envFile = join(dir, "env"); writeFileSync(envFile, "SECRET_TOKEN=never-print-me\nPLANNER_HARNESS=claude\n");
    const env = { ...process.env, DAEMONCTL_ALLOW_NON_ROOT: "1", DAEMONCTL_ENV_FILE: envFile };
    const args = ["config", "--planner", "claudex", "--implementer", "claude", "--dry-run"];
    const one = execFileSync(daemonctl, args, { env, encoding: "utf8" });
    const two = execFileSync(daemonctl, args, { env, encoding: "utf8" });
    expect(two).toBe(one);
    expect(one).toContain("PLANNER_HARNESS=claudex");
    expect(one).not.toContain("never-print-me");
    expect(execFileSync("cat", [envFile], { encoding: "utf8" })).toContain("SECRET_TOKEN=never-print-me");
  });

  it("rejects malformed operation actions before dry-run without touching state", () => {
    const f = opsFixture(); const before = treeSnapshot([f.db, f.state, f.serviceLog]);
    const result = f.run(["operation", "nonsense", "id", "--dry-run"]);
    expect(result.status).toBe(2); expect(result.stderr).toContain("operation action must be retry or cancel");
    expect(treeSnapshot([f.db, f.state, f.serviceLog])).toBe(before);
  });
});

describe("public config and restart execution", () => {
  it("AC1/AC6 applies exactly two harness values, preserves mode/unrelated bytes, backs up, restarts, and accepts health", () => {
    const f = opsFixture(); const originalMode = statSync(f.envFile).mode & 0o777;
    const result = f.run(["config", "--planner", "claudex", "--implementer", "claude"]);
    expect(result.status).toBe(0); const env = readFileSync(f.envFile, "utf8");
    expect(env).toContain("SECRET_TOKEN=fixture-secret-never-output\n"); expect(env).toContain("UNRELATED=value with spaces\n");
    expect(env.match(/^PLANNER_HARNESS=/gm)).toHaveLength(1); expect(env).toContain("PLANNER_HARNESS=claudex");
    expect(env.match(/^IMPLEMENTER_HARNESS=/gm)).toHaveLength(1); expect(statSync(f.envFile).mode & 0o777).toBe(originalMode);
    const backupDir = join(f.state, "backups"), backup = readdirSync(backupDir).find(name => name.includes(".env."));
    expect(backup).toMatch(/^[-a-z0-9]+\.env\.\d{8}T\d{6}Z$/); expect(statSync(join(backupDir, backup!)).mode & 0o777).toBe(originalMode);
    expect(readNumber(f.restartCount)).toBe(1); expect(readNumber(f.healthCount)).toBeGreaterThanOrEqual(2);
    expect(result.stdout).not.toContain("fixture-secret-never-output");
    const log = new EventLog(f.db); expect(log.operationStatus().lastOutcome).toMatchObject({ state: "succeeded", stage: "accepted" }); log.close();
  });

  it.each([["health", "health.failures"], ["restart_service", "restart.failures"]] as const)("AC3 rolls back after %s failure and names the stage", (stage, file) => {
    const f = opsFixture(), before = readFileSync(f.envFile);
    writeFileSync(join(f.dir, file), "1\n");
    const result = f.run(["config", "--planner", "claudex", "--implementer", "claudex"]);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain(`\"stage\":\"${stage}\"`);
    expect(readFileSync(f.envFile)).toEqual(before); expect(readNumber(f.restartCount)).toBe(2);
    const log = new EventLog(f.db); expect(log.operationStatus().lastOutcome).toMatchObject({ state: "failed", stage: "rolled_back", errorStage: stage });
    expect(log.activeOperation()).toBeUndefined(); log.close();
  });

  it.each(["replace_environment", "restart_service"])("recovers a config executor crash after %s without duplicate restart", stage => {
    const f = opsFixture();
    const crashed = f.run(["config", "--planner", "claudex", "--implementer", "claudex"], { DAEMONCTL_FAULT_AFTER: stage });
    expect(crashed.status).toBe(99); const restartsAtCrash = readNumber(f.restartCount);
    const recovered = f.run(["internal-execute"]); expect(recovered.status).toBe(0);
    expect(readFileSync(f.envFile, "utf8")).toContain("PLANNER_HARNESS=claudex");
    expect(readNumber(f.restartCount)).toBe(1); expect(readNumber(f.restartCount)).toBeGreaterThanOrEqual(restartsAtCrash);
    const log = new EventLog(f.db); expect(log.operationStatus().lastOutcome?.state).toBe("succeeded"); log.close();
  });

  it("AC6 executes an idle normal restart immediately and reports accepted health", () => {
    const f = opsFixture(); const result = f.run(["restart"]); expect(result.status).toBe(0);
    expect(readNumber(f.restartCount)).toBe(1); expect(result.stdout).toContain('"state":"succeeded"');
    expect(result.stdout).toContain("service active and health accepted");
  });

  it("retries normal restart health acceptance while the daemon listener starts", () => {
    const f = opsFixture(); writeFileSync(join(f.dir, "health.failures"), "2\n");
    const result = f.run(["restart"], { DAEMON_HEALTH_MAX_ATTEMPTS: "3" });
    expect(result.status).toBe(0); expect(readNumber(f.restartCount)).toBe(1); expect(readNumber(f.healthCount)).toBe(3);
    expect(result.stdout).toContain("service active and health accepted");
  });
});

describe("privileged request/executor boundary", () => {
  it("requires an exact request-row digest and quarantines a mismatch without restart", () => {
    const f = opsFixture(); expect(f.run(["restart"], { DAEMONCTL_NO_ACTIVATE: "1" }).status).toBe(0);
    const ready = join(f.requests, readdirSync(f.requests).find(name => name.endsWith(".ready"))!);
    writeFileSync(ready, `${readFileSync(ready, "utf8")} `); chmodSync(ready, 0o600);
    const result = f.run(["internal-execute"]); expect(result.status).not.toBe(0); expect(readNumber(f.restartCount)).toBe(0);
    expect(readdirSync(f.requests).some(name => name.endsWith(".quarantine"))).toBe(true);
    const log = new EventLog(f.db); expect(log.operationStatus().lastOutcome).toMatchObject({ state: "cancelled", errorStage: "authorization" }); log.close();
  });

  it("executes an authenticated request exactly once across duplicate executor invocations", () => {
    const f = opsFixture(); expect(f.run(["restart"], { DAEMONCTL_NO_ACTIVATE: "1" }).status).toBe(0);
    expect(f.run(["internal-execute"]).status).toBe(0); expect(f.run(["internal-execute"]).status).toBe(0);
    expect(readNumber(f.restartCount)).toBe(1); expect(readdirSync(f.requests).filter(name => name.endsWith(".done"))).toHaveLength(1);
  });

  it("restores a failed request file before retrying the parked operation", () => {
    const f = opsFixture();
    const id = "retry-file";
    const request = JSON.stringify({ id, type: "restart", version: 1 });
    const failed = join(f.requests, `${id}.failed`);
    writeFileSync(failed, request);
    chmodSync(failed, 0o600);
    const digest = createHash("sha256").update(request).digest("hex");
    const log = new EventLog(f.db);
    log.scheduleOperation({
      id,
      requestDigest: digest,
      type: "restart",
      reason: "retry",
    });
    log.transitionOperation(id, "failed", "preflight", {
      errorStage: "preflight",
    });
    log.close();
    const result = f.run(["operation", "retry", id]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(f.requests, `${id}.done`))).toBe(true);
    expect(existsSync(failed)).toBe(false);
    expect(readNumber(f.restartCount)).toBe(1);
  });

  it("executes immediately with a running turn and releases queued work after acceptance", () => {
    const f = opsFixture(); let log = new EventLog(f.db); appendTurn(log, "running", "OPS-1"); const running = log.claimNextTurn()!;
    appendTurn(log, "queued", "OPS-2"); log.close();
    expect(f.run(["restart"]).status).toBe(0); expect(readNumber(f.restartCount)).toBe(1);
    log = new EventLog(f.db); log.finishTurn(running.id, "response", "done"); log.close();
    log = new EventLog(f.db); expect(log.claimNextTurn()).toMatchObject({ issueId: "issue-queued" }); log.close();
  });

  it("holds claims on failed acceptance and bounds repeated crash recovery without a restart storm", () => {
    const f = opsFixture(); writeFileSync(join(f.dir, "health.failures"), "20\n");
    expect(f.run(["restart"], { DAEMONCTL_NO_ACTIVATE: "1" }).status).toBe(0);
    expect(f.run(["internal-execute"]).status).not.toBe(0);
    let log = new EventLog(f.db); appendTurn(log, "held", "OPS-3"); expect(log.claimNextTurn()).toBeUndefined();
    expect(log.operationStatus().pending).toMatchObject({ state: "blocked", stage: "health" }); log.close();
    // A restart has no rollback path, so failed health remains blocked and a path re-trigger cannot execute it.
    expect(f.run(["internal-execute"]).status).not.toBe(0); expect(readNumber(f.restartCount)).toBe(1);

    const g = opsFixture(); expect(g.run(["config", "--planner", "claudex", "--implementer", "claudex"],
      { DAEMONCTL_NO_ACTIVATE: "1" }).status).toBe(0);
    for (let i = 0; i < 4; i++) g.run(["internal-execute"], { DAEMONCTL_FAULT_AFTER: "replace_environment", DAEMONCTL_MAX_ATTEMPTS: "3" });
    log = new EventLog(g.db); expect(log.operationStatus().pending).toMatchObject({ state: "blocked", stage: "retry_budget_exhausted" }); log.close();
    expect(readNumber(g.restartCount)).toBe(0);
  }, 10_000);
});

describe("hard restart, sessions, and compute public views", () => {
  it("AC12-AC14 lists safe affected turns, requires confirmation, preserves decline state, and interrupts without requeue after one confirmed restart", () => {
    const f = opsFixture(); let log = new EventLog(f.db); appendTurn(log, "private-raw-session-id", "OPS-77"); log.claimNextTurn(Date.now() - 5000); log.close();
    const noTty = f.run(["restart", "--hard"]); expect(noTty.status).not.toBe(0); expect(noTty.stderr).toContain("requires a TTY or --yes");
    expect(noTty.stdout).toContain("OPS-77"); expect(noTty.stdout).toContain('"runtime":"claude"');
    expect(noTty.stdout).not.toContain("private-raw-session-id"); expect(noTty.stdout).not.toContain("secret-prompt"); expect(readNumber(f.restartCount)).toBe(0);
    const before = treeSnapshot([f.envFile, f.state, f.serviceLog, f.restartCount]);
    const declined = f.run(["restart", "--hard"], { DAEMONCTL_CONFIRM_RESPONSE: "no" }); expect(declined.status).toBe(0); expect(declined.stdout).toContain("unchanged");
    expect(treeSnapshot([f.envFile, f.state, f.serviceLog, f.restartCount])).toBe(before);
    const confirmed = f.run(["restart", "--hard", "--yes"]); expect(confirmed.status).toBe(0); expect(readNumber(f.restartCount)).toBe(1);
    log = new EventLog(f.db); expect(log.restartIntent()).toMatchObject({ policy: "interrupt", reason: "operator restart" });
    expect(log.recoverStaleRunning()).toEqual([expect.objectContaining({ turnId: 1, outcome: "human_required", reason: "hard_restart" })]);
    expect(log.restartIntent()).toBeUndefined();
    expect(log.turnStates()).toEqual([expect.objectContaining({ status: "interrupted" })]); expect(log.claimNextTurn()).toBeUndefined(); log.close();
  });

  it("clears hard-restart intent only when a failed restart proves the original PID is still authoritative", () => {
    const confirmed = opsFixture();
    writeFileSync(join(confirmed.dir, "restart.failures"), "1\n");
    const failed = confirmed.run(["restart", "--hard", "--yes"]);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("hard restart command failed");
    let log = new EventLog(confirmed.db);
    expect(log.restartIntent()).toBeUndefined();
    log.close();

    const ambiguous = opsFixture();
    writeFileSync(join(ambiguous.dir, "restart.failures"), "1\n");
    const retained = ambiguous.run(["restart", "--hard", "--yes"], {
      FAKE_SERVICE_INACTIVE: "1",
    });
    expect(retained.status).not.toBe(0);
    log = new EventLog(ambiguous.db);
    expect(log.restartIntent()).toMatchObject({
      policy: "interrupt",
      reason: "operator restart",
    });
    log.close();
  });

  it("AC15 returns safe populated sessions, explicit empty success, and nonzero DB failure", () => {
    const f = opsFixture(); let log = new EventLog(f.db); appendTurn(log, "raw-private-id", "OPS-5"); log.claimNextTurn(1000); log.close();
    const populated = f.run(["sessions"]); expect(populated.status).toBe(0); expect(populated.stdout).toContain("OPS-5");
    expect(populated.stdout).toContain('"state":"running"'); expect(populated.stdout).not.toContain("raw-private-id"); expect(populated.stdout).not.toContain("secret-prompt");
    const empty = opsFixture().run(["sessions"]); expect(empty.status).toBe(0); expect(empty.stdout.trim()).toBe("no running turns");
    const failed = f.run(["sessions"], { DB_PATH: f.dir }); expect(failed.status).not.toBe(0); expect(failed.stdout).not.toContain("no running turns");
  });

  it("AC16 snapshots and bounds watch output with safe process identity and no argv", () => {
    const f = opsFixture(); const snapshot = f.run(["top"]); expect(snapshot.status).toBe(0);
    for (const field of ["host_load:", "cpu_memory:", "services:", "harness_processes:", "disk:", "running_turns:"]) expect(snapshot.stdout).toContain(field);
    for (const service of ["linear-agent-daemon", "cliproxyapi", "caddy"]) expect(snapshot.stdout).toContain(service);
    for (const executable of ["claude", "claudex", "codex"]) expect(snapshot.stdout).toContain(`executable=${executable}`);
    for (const secret of ["planted-secret-argv-token", "raw-session-id", "another-secret", "prompt-secret", "shell-secret"]) expect(snapshot.stdout).not.toContain(secret);
    expect(snapshot.stdout).not.toContain("executable=bash");
    const watched = f.run(["top", "--watch", "1", "--count", "2"]); expect(watched.status).toBe(0);
    expect(watched.stdout.match(/host_load:/g)).toHaveLength(2); expect(watched.stdout.match(/running_turns:/g)).toHaveLength(2);
    const interrupted = f.run(["top", "--watch", "1"], { DAEMONCTL_TEST_INTERRUPT_AFTER: "1" });
    expect(interrupted.status).toBe(130); expect(interrupted.stdout).toContain("harness_processes:");
  });
});

describe("AC21 public dry-run and CLI rubric", () => {
  it("runs every mutator twice with exact deterministic output and full state equality", () => {
    const f = opsFixture(), repo = updateRepo(f), proxyEnv = join(f.dir, "dry-proxy.env"), credentials = join(f.dir, "credentials"), deployed = join(f.dir, "deployed");
    writeFileSync(proxyEnv, "CLIPROXY_MANAGEMENT_KEY=dry-management-secret\n"); mkdirSync(credentials); writeFileSync(join(credentials, "codex-dry.json"), "dry-credential-secret");
    mkdirSync(deployed); writeFileSync(join(deployed, "version"), "old\n");
    const readonlyCurl = executable(join(f.dir, "readonly-curl"), `printf '{"files":[]}\\n'`);
    const common = { ...repo.env, DAEMONCTL_PROXY_ACCOUNTS: resolve("ops/proxy-accounts.sh"), CLIPROXY_ENV_FILE: proxyEnv,
      CLIPROXY_BIN: join(f.dir, "never-run-proxy"), CLIPROXY_CONFIG: join(f.dir, "proxy.yaml"), CURL: readonlyCurl };
    const commands: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [
      { args: ["config", "--planner", "claudex", "--implementer", "claude", "--dry-run"] },
      { args: ["restart", "--dry-run"] }, { args: ["restart", "--hard", "--dry-run"] },
      { args: ["update", "--dry-run"], env: repo.env },
      { args: ["subscriptions", "add", "codex", "--dry-run"], env: common },
      { args: ["subscriptions", "remove", "codex-dry.json", "--dry-run"], env: common },
      { args: ["subscriptions", "reauth", "codex", "codex-dry.json", "--dry-run"], env: common },
      { args: ["operation", "retry", "dry-operation", "--dry-run"] },
      { args: ["operation", "cancel", "dry-operation", "--dry-run"] },
    ];
    const watched = [f.envFile, f.db, f.state, f.serviceLog, f.provisionLog, f.restartCount, f.healthCount,
      repo.checkout, f.accepted, proxyEnv, credentials, deployed];
    const before = treeSnapshot(watched);
    for (const command of commands) {
      const one = f.run(command.args, command.env); const two = f.run(command.args, command.env);
      expect(one.status, command.args.join(" ")).toBe(0); expect(two.status).toBe(0); expect(two.stdout).toBe(one.stdout);
      expect(`${one.stdout}${one.stderr}`).not.toMatch(/fixture-secret-never-output|dry-management-secret|dry-credential-secret/);
      expect(one.stdout).toMatch(/would|deployed|\[\]/);
    }
    expect(treeSnapshot(watched)).toBe(before);
  }, 20_000);

  it("covers help and rejects malformed arguments/failures with nonzero exits", () => {
    const f = opsFixture(); expect(f.run(["--help"]).status).toBe(0);
    for (const args of [["unknown"], ["config", "--planner", "claude"], ["restart", "--bad"], ["top", "--watch", "bad"],
      ["operation", "retry"], ["subscriptions", "add", "invalid-provider", "--dry-run"]]) {
      const result = f.run(args); expect(result.status, args.join(" ")).not.toBe(0);
    }
  });
});

describe("subscription lifecycle helper", () => {
  it("lists safely, reversibly removes, and reauthenticates a retained selector", async () => {
    const { dir } = fixture(); const selector = "codex-founder.json"; const credential = join(dir, selector);
    writeFileSync(credential, "fixture-access-token-never-output");
    let disabled = false; const patches: boolean[] = [];
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ files: [{ name: selector, email: "founder@example.test", provider: "codex",
          disabled, failed: false, access_token: "fixture-access-token-never-output" }] })); return;
      }
      let body = ""; request.on("data", chunk => { body += String(chunk); }); request.on("end", () => {
        disabled = Boolean((JSON.parse(body) as { disabled: boolean }).disabled); patches.push(disabled);
        response.end("{}");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const envFile = join(dir, "proxy.env"); writeFileSync(envFile, "CLIPROXY_MANAGEMENT_KEY=management-secret-never-output\n");
    const loginLog = join(dir, "login.log"), fakeProxy = join(dir, "proxy");
    writeFileSync(fakeProxy, `#!/bin/sh\nprintf '%s\\n' "$*" > '${loginLog}'\n`); chmodSync(fakeProxy, 0o755);
    const env = { ...process.env, PROXY_URL: `http://127.0.0.1:${port}`, CLIPROXY_ENV_FILE: envFile,
      CLIPROXY_BIN: fakeProxy, CLIPROXY_CONFIG: join(dir, "proxy.yaml") };
    const helper = join(process.cwd(), "ops/proxy-accounts.sh");
    const run = (args: string[]) => new Promise<{ code: number | null; output: string }>(resolve => {
      const child = spawn(helper, args, { env, stdio: ["ignore", "pipe", "pipe"] }); let output = "";
      child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { output += String(chunk); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: -1, output: `${output}\ntimeout:${args.join(" ")}` }); }, 2_000);
      child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
    });
    const listed = await run(["list"]); expect(listed.code).toBe(0); expect(listed.output).toContain('"eligible":true');
    expect(listed.output).not.toContain("fixture-access-token-never-output"); expect(listed.output).not.toContain("management-secret-never-output");
    const removed = await run(["remove", selector, "--yes"]); expect(removed.code).toBe(0); expect(patches).toEqual([true]);
    expect(existsSync(credential)).toBe(true); expect(removed.output).toContain('"eligible":false');
    const reauthed = await run(["reauth", "codex", selector]); expect(reauthed.code).toBe(0); expect(patches).toEqual([true, false]);
    expect(reauthed.output).toContain('"eligible":true'); expect(execFileSync("cat", [loginLog], { encoding: "utf8" })).toContain("--codex-login --no-browser");
    server.closeAllConnections(); server.close();
  }, 15_000);

  it("AC18/AC20 public add and reauth run under daemon identity, restore eligibility, and never restart the proxy", async () => {
    const f = opsFixture(), selector = "codex-public.json", loginLog = join(f.dir, "public-login.log"); let disabled = false;
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ files: [{ name: selector,
          provider: "codex", email: "public@example.test", disabled, failed: false, refresh_token: "never-print-refresh-token" }] })); return;
      }
      let body = ""; request.on("data", chunk => { body += String(chunk); }); request.on("end", () => {
        disabled = Boolean((JSON.parse(body) as { disabled: boolean }).disabled); response.end("{}");
      });
    });
    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen)); const port = (server.address() as { port: number }).port;
    const proxyEnv = join(f.dir, "public-proxy.env"); writeFileSync(proxyEnv, "CLIPROXY_MANAGEMENT_KEY=public-management-secret\n");
    const proxy = executable(join(f.dir, "public-proxy"), `printf '%s\\n' "$*" >> '${loginLog}'`);
    const env = { ...f.env, DAEMONCTL_FORCE_RUNUSER: "1", DAEMONCTL_PROXY_ACCOUNTS: resolve("ops/proxy-accounts.sh"),
      PROXY_URL: `http://127.0.0.1:${port}`, CLIPROXY_ENV_FILE: proxyEnv, CLIPROXY_BIN: proxy, CLIPROXY_CONFIG: join(f.dir, "proxy.yaml"),
      CURL: execFileSync("which", ["curl"], { encoding: "utf8" }).trim() };
    const run = (args: string[]) => new Promise<{ code: number | null; output: string }>(resolveRun => {
      const child = spawn(resolve("ops/daemonctl"), args, { env, stdio: ["ignore", "pipe", "pipe"] }); let output = "";
      child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.on("data", chunk => { output += String(chunk); });
      child.on("close", code => resolveRun({ code, output }));
    });
    const added = await run(["subscriptions", "add", "codex"]); expect(added.code).toBe(0); expect(added.output).toContain('"eligible":true');
    disabled = true; const reauthed = await run(["subscriptions", "reauth", "codex", selector]); expect(reauthed.code).toBe(0);
    expect(disabled).toBe(false); expect(reauthed.output).toContain('"eligible":true');
    const runuserLog = readFileSync(String(f.env.FAKE_RUNUSER_LOG), "utf8"); expect(runuserLog.match(/-u linear-daemon --/g)).toHaveLength(2);
    expect(readFileSync(loginLog, "utf8")).toContain("--codex-login --no-browser");
    expect(existsSync(f.serviceLog) ? readFileSync(f.serviceLog, "utf8") : "").not.toContain("cliproxyapi");
    expect(`${added.output}${reauthed.output}`).not.toMatch(/public-management-secret|never-print-refresh-token/);
    server.closeAllConnections(); server.close();
  }, 15_000);

  it("executes a digest-bound console artifact through one fixed process boundary", async () => {
    const f = fixture(); const spool = join(f.dir, "console-spool");
    for (const leaf of ["ready", "executing", "controls", "rollback", "quarantine"]) mkdirSync(join(spool, leaf), { recursive: true });
    const request: ConsoleOperationRequest = { version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" };
    const id = "console-fixed"; const digest = requestDigest(request); const log = new EventLog(f.db);
    log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "fixed", actor: "local-console", requestKind: request.kind });
    const artifact = join(spool, "ready", `${id}.json`); writeFileSync(artifact, `${canonicalJson(request)}\n`, { mode: 0o600 }); chmodSync(artifact, 0o600);
    const calls: Array<[string, readonly string[]]> = [];
    await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl", argv: ["internal-console-execute"],
      run: async (executable, argv) => { calls.push([executable, argv]); } }).run();
    expect(calls).toEqual([["/fixed/daemonctl", ["internal-console-execute"]]]);
    expect(log.operationById(id)).toMatchObject({ state: "executing", actor: "local-console" });
    expect(existsSync(join(spool, "ready", `${id}.json`))).toBe(false);
    expect(existsSync(join(spool, "executing", `${id}.json`))).toBe(false);
    log.close();
  });

  it("cleans a terminal executing receipt without invoking the fixed bridge again", async () => {
    const f = fixture(); const spool = join(f.dir, "console-terminal");
    for (const leaf of ["ready", "executing", "controls", "rollback", "quarantine"]) mkdirSync(join(spool, leaf), { recursive: true });
    const requestValue: ConsoleOperationRequest = { version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" };
    const digest = requestDigest(requestValue); const id = "console-terminal"; const log = new EventLog(f.db);
    log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "fixed", actor: "local-console", requestKind: requestValue.kind });
    log.claimOperation(id, digest); log.transitionOperation(id, "succeeded", "accepted", { mutated: true, outcome: "accepted" });
    writeFileSync(join(spool, "executing", `${id}.json`), `${canonicalJson(requestValue)}\n`, { mode: 0o600 });
    let calls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
      argv: ["internal-console-execute"], run: async () => { calls += 1; } }).run();
    expect(calls).toBe(0); expect(readdirSync(join(spool, "executing"))).toEqual([]);
    expect(log.operationById(id)).toMatchObject({ state: "succeeded", attempts: 1 }); log.close();
  });

  it.each(["executable", "argv", "path", "serviceLabel"])(
    "quarantines a request-controlled %s before process or operation counters change", async field => {
      const f = fixture(); const spool = join(f.dir, `console-invalid-${field}`);
      for (const leaf of ["ready", "executing", "controls", "rollback", "quarantine"]) mkdirSync(join(spool, leaf), { recursive: true });
      const valid = { version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" } as const;
      const injected = { ...valid, [field]: field === "argv" ? ["--arbitrary"] : "/request/controlled" };
      const id = `invalid-${field}`; const log = new EventLog(f.db);
      log.scheduleOperation({ id, requestDigest: requestDigest(valid), type: "restart", reason: "fixed", actor: "local-console", requestKind: valid.kind });
      writeFileSync(join(spool, "ready", `${id}.json`), `${canonicalJson(injected)}\n`, { mode: 0o600 });
      let calls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
        argv: ["internal-console-execute"], run: async () => { calls += 1; } }).run();
      expect(calls).toBe(0); expect(log.operationById(id)).toMatchObject({ state: "pending", stateVersion: 0, attempts: 0, mutated: 0 });
      expect(readdirSync(join(spool, "quarantine"))).toEqual([`${id}.json`]); log.close();
    });

  it.each(["malformed", "digest-mismatch", "symlink"])(
    "quarantines a %s artifact without invoking the fixed bridge or mutating durable state", async kind => {
      const f = fixture(); const spool = join(f.dir, `console-invalid-${kind}`);
      for (const leaf of ["ready", "executing", "controls", "rollback", "quarantine"]) mkdirSync(join(spool, leaf), { recursive: true });
      const requestValue: ConsoleOperationRequest = { version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" };
      const id = `invalid-${kind}`; const log = new EventLog(f.db);
      log.scheduleOperation({ id, requestDigest: kind === "digest-mismatch" ? "f".repeat(64) : requestDigest(requestValue), type: "restart",
        reason: "fixed", actor: "local-console", requestKind: requestValue.kind });
      const artifact = join(spool, "ready", `${id}.json`); const target = join(f.dir, "outside-request");
      if (kind === "symlink") { writeFileSync(target, `${canonicalJson(requestValue)}\n`, { mode: 0o600 }); symlinkSync(target, artifact); }
      else writeFileSync(artifact, kind === "malformed" ? "{\n" : `${canonicalJson(requestValue)}\n`, { mode: 0o600 });
      let calls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
        argv: ["internal-console-execute"], run: async () => { calls += 1; } }).run();
      expect(calls).toBe(0); expect(log.operationById(id)).toMatchObject({ state: "pending", stateVersion: 0, attempts: 0, mutated: 0 });
      expect(readdirSync(join(spool, "quarantine"))).toEqual([`${id}.json`]);
      if (kind === "symlink") expect(readFileSync(target, "utf8")).toBe(`${canonicalJson(requestValue)}\n`); log.close();
    });
});
