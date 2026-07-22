import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import { appendTurn, executable, fixture, opsFixture, readNumber, treeSnapshot, updateRepo } from "./operations-fixtures.js";

describe("durable maintenance operations", () => {
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
    expect(log.claimOperation("op-1", "a".repeat(64))).toMatchObject({ state: "draining", attempts: 1 });
    log.transitionOperation("op-1", "succeeded", "accepted", { mutated: true, outcome: "healthy" });
    expect(log.claimNextTurn()).toMatchObject({ issueId: "issue-one", status: "running" });
    log.close();
  });

  it("keeps blocked and unverified mutated failures drained", () => {
    const { db } = fixture(); const log = new EventLog(db);
    appendTurn(log, "one", "OPS-1");
    log.scheduleOperation({ id: "op-1", requestDigest: "a".repeat(64), type: "config", reason: "change" });
    log.transitionOperation("op-1", "executing", "replace", { mutated: true });
    expect(() => log.transitionOperation("op-1", "failed", "health", { errorStage: "health" })).toThrow(/verified rollback/);
    log.transitionOperation("op-1", "blocked", "health", { errorStage: "health" });
    expect(log.claimNextTurn()).toBeUndefined();
    expect(log.claimOperation("op-1", "a".repeat(64))).toBeUndefined();
    expect(log.operationStatus().pending).toMatchObject({ drainState: "blocked", recoveryCommand: "daemonctl operation retry op-1" });
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

  it("waits for the last running turn, keeps queued work gated, then releases only after acceptance", () => {
    const f = opsFixture(); let log = new EventLog(f.db); appendTurn(log, "running", "OPS-1"); const running = log.claimNextTurn()!;
    appendTurn(log, "queued", "OPS-2"); log.close();
    expect(f.run(["restart"]).status).toBe(0); expect(readNumber(f.restartCount)).toBe(0);
    log = new EventLog(f.db); expect(log.claimNextTurn()).toBeUndefined(); log.finishTurn(running.id, "response", "done"); log.close();
    expect(f.run(["internal-execute"]).status).toBe(0); expect(readNumber(f.restartCount)).toBe(1);
    log = new EventLog(f.db); expect(log.claimNextTurn()).toMatchObject({ issueId: "issue-queued" }); log.close();
  });

  it("holds claims on failed acceptance and bounds repeated crash recovery without a restart storm", () => {
    const f = opsFixture(); writeFileSync(join(f.dir, "health.failures"), "20\n");
    expect(f.run(["restart"], { DAEMONCTL_NO_ACTIVATE: "1" }).status).toBe(0);
    expect(f.run(["internal-execute"]).status).not.toBe(0);
    let log = new EventLog(f.db); appendTurn(log, "held", "OPS-3"); expect(log.claimNextTurn()).toBeUndefined();
    expect(log.operationStatus().pending).toMatchObject({ drainState: "blocked", stage: "health" }); log.close();
    // A restart has no rollback path, so failed health remains blocked and a path re-trigger cannot execute it.
    expect(f.run(["internal-execute"]).status).not.toBe(0); expect(readNumber(f.restartCount)).toBe(1);

    const g = opsFixture(); expect(g.run(["config", "--planner", "claudex", "--implementer", "claudex"],
      { DAEMONCTL_NO_ACTIVATE: "1" }).status).toBe(0);
    for (let i = 0; i < 4; i++) g.run(["internal-execute"], { DAEMONCTL_FAULT_AFTER: "replace_environment", DAEMONCTL_MAX_ATTEMPTS: "3" });
    log = new EventLog(g.db); expect(log.operationStatus().pending).toMatchObject({ drainState: "blocked", stage: "retry_budget_exhausted" }); log.close();
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
    log = new EventLog(f.db); expect(log.interruptStaleRunning()).toHaveLength(1);
    expect(log.turnStates()).toEqual([expect.objectContaining({ status: "interrupted" })]); expect(log.claimNextTurn()).toBeUndefined(); log.close();
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
});
