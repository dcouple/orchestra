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
    const gcloudLog = join(dir, "gcloud.json");
    const sudoLog = join(dir, "sudo.json");
    const localSentinel = join(dir, "local-sentinel");
    const remoteSentinel = join(dir, "remote-sentinel");
    const sudo = executable(join(bin, "sudo"), `
python3 - "$@" <<'PY'
import json,sys
json.dump(sys.argv[1:],open('${sudoLog}','w'))
PY
`);
    const gcloud = executable(join(bin, "gcloud"), `
python3 - "$@" <<'PY'
import json,sys
json.dump(sys.argv[1:],open('${gcloudLog}','w'))
PY
command=""
for value in "$@"; do case "$value" in --command=*) command="\${value#*=}" ;; esac; done
[[ -n "$command" ]]
PATH='${bin}:/usr/bin:/bin' /bin/sh -c "$command"
`);
    expect(sudo).toBe(join(bin, "sudo"));
    const repo = resolve("..");
    const run = (target: string, variables: string[]) => spawnSync("make", [target, `GCLOUD=${gcloud}`, ...variables], {
      cwd: repo,
      env: { ...process.env },
      encoding: "utf8",
    });
    const sudoArgv = () => JSON.parse(readFileSync(sudoLog, "utf8")) as string[];
    const gcloudArgv = () => JSON.parse(readFileSync(gcloudLog, "utf8")) as string[];

    const reason = `founder's release; touch ${remoteSentinel}; $(touch ${localSentinel})`;
    const restart = run("daemon-restart", [`ARGS=--reason "${reason}"`]);
    expect(restart.status, restart.stderr).toBe(0);
    expect(sudoArgv()).toEqual(["/usr/local/sbin/daemonctl", "restart", "--reason", reason]);
    expect(gcloudArgv()).toEqual([
      "compute", "ssh", "linear-agent", "--project=bloom-agents", "--zone=us-central1-a",
      expect.stringContaining("--command=sudo /usr/local/sbin/daemonctl restart --reason"), "--", "-t",
    ]);
    expect(existsSync(localSentinel)).toBe(false);
    expect(existsSync(remoteSentinel)).toBe(false);

    const planner = `claude; touch ${remoteSentinel}`;
    const implementer = `claud'ex $(touch ${localSentinel})`;
    const config = run("daemon-config", [`PLANNER=${planner}`, `IMPLEMENTER=${implementer}`, `ARGS=--reason "two words"`]);
    expect(config.status, config.stderr).toBe(0);
    expect(sudoArgv()).toEqual(["/usr/local/sbin/daemonctl", "config", "--planner", planner,
      "--implementer", implementer, "--reason", "two words"]);
    expect(existsSync(localSentinel)).toBe(false);
    expect(existsSync(remoteSentinel)).toBe(false);

    const ref = `refs/heads/release; touch ${remoteSentinel}`;
    const update = run("daemon-update", [`REF=${ref}`, `ARGS=--reason "release's candidate"`]);
    expect(update.status, update.stderr).toBe(0);
    expect(sudoArgv()).toEqual(["/usr/local/sbin/daemonctl", "update", "--ref", ref, "--reason", "release's candidate"]);
    expect(existsSync(localSentinel)).toBe(false);
    expect(existsSync(remoteSentinel)).toBe(false);
  }, 15_000);
});
