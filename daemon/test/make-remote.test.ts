import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executable, fixture } from "./operations-fixtures.js";

describe("root Makefile remote transport", () => {
  it("uses argv plus shlex quoting so spaces, apostrophes, separators, and substitutions cannot execute", () => {
    const { dir } = fixture();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const sshLog = join(dir, "ssh.json");
    const daemonctlLog = join(dir, "daemonctl.json");
    const localSentinel = join(dir, "local-sentinel");
    const remoteSentinel = join(dir, "remote-sentinel");
    const daemonctlLogger = executable(join(bin, "daemonctl-log"), `
python3 - "$@" <<'PY'
import json,sys
json.dump(sys.argv[1:],open('${daemonctlLog}','w'))
PY
`);
    const ssh = executable(join(bin, "ssh"), `
python3 - "$@" <<'PY'
import json,os,shlex,subprocess,sys
json.dump(sys.argv[1:],open('${sshLog}','w'))
command=sys.argv[-1]
env={**os.environ,"PATH":'${bin}:/usr/bin:/bin'}
result=subprocess.run(["/bin/sh","-c",f"set -- {command}; exec {shlex.quote('${daemonctlLogger}')} \\\"$@\\\""],env=env)
raise SystemExit(result.returncode)
PY
`);
    const repo = resolve("..");
    const run = (target: string, variables: string[]) => spawnSync("make", [target, `DAEMON_SSH=${ssh}`, ...variables], {
      cwd: repo,
      env: { ...process.env },
      encoding: "utf8",
    });
    const daemonctlArgv = () => JSON.parse(readFileSync(daemonctlLog, "utf8")) as string[];
    const sshArgv = () => JSON.parse(readFileSync(sshLog, "utf8")) as string[];

    const reason = `founder's release; touch ${remoteSentinel}; $(touch ${localSentinel})`;
    const restart = run("daemon-restart", [`ARGS=--reason "${reason}"`]);
    expect(restart.status, restart.stderr).toBe(0);
    expect(daemonctlArgv()).toEqual(["/usr/local/sbin/daemonctl", "restart", "--reason", reason]);
    expect(sshArgv()).toEqual([
      "-t", "bloomi", expect.stringContaining("/usr/local/sbin/daemonctl restart --reason"),
    ]);
    expect(existsSync(localSentinel)).toBe(false);
    expect(existsSync(remoteSentinel)).toBe(false);

    const planner = `claude; touch ${remoteSentinel}`;
    const implementer = `claud'ex $(touch ${localSentinel})`;
    const config = run("daemon-config", [`PLANNER=${planner}`, `IMPLEMENTER=${implementer}`, `ARGS=--reason "two words"`]);
    expect(config.status, config.stderr).toBe(0);
    expect(daemonctlArgv()).toEqual(["/usr/local/sbin/daemonctl", "config", "--planner", planner,
      "--implementer", implementer, "--reason", "two words"]);
    expect(existsSync(localSentinel)).toBe(false);
    expect(existsSync(remoteSentinel)).toBe(false);

    const update = run("daemon-update", [`ARGS=--reason "release's candidate"`]);
    expect(update.status, update.stderr).toBe(0);
    expect(daemonctlArgv()).toEqual(["/usr/local/sbin/daemonctl", "update", "--reason", "release's candidate"]);
    const reload = run("daemon-reload", [`ARGS=--reason "reload's checkout; touch ${remoteSentinel}"`]);
    expect(reload.status, reload.stderr).toBe(0);
    expect(daemonctlArgv()).toEqual(["/usr/local/sbin/daemonctl", "reload", "--reason", `reload's checkout; touch ${remoteSentinel}`]);
    expect(existsSync(localSentinel)).toBe(false);
    expect(existsSync(remoteSentinel)).toBe(false);
  }, 15_000);
});
