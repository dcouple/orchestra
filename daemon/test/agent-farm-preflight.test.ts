import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executable, fixture } from "./operations-fixtures.js";

for (const script of ["ops/daemonctl", "ops/macos/daemonctl"]) {
  describe(`${script} Agent Farm preflight`, () => {
    function setup(setting: string) {
      const { dir } = fixture();
      mkdirSync(join(dir, "linear-agent-daemon"));
      const envFile = join(dir, "env"), site = join(dir, "site.env");
      writeFileSync(envFile, `SECRET_TOKEN=fixture-secret-never-output\nPLANNER_HARNESS=claude\n${setting}`);
      writeFileSync(site, `${readFileSync(resolve("ops/macos/site.env.example"), "utf8")}\nDAEMON_SERVICE_HOME=${dir}\n`);
      const run = (role: string, dry: boolean, callerEnv: Record<string, string> = {}) => spawnSync("bash", [resolve(script), "config",
        "--planner", role === "planner" ? "agent-farm:planner" : "claude",
        "--implementer", role === "implementer" ? "agent-farm:implementer" : "claude", ...(dry ? ["--dry-run"] : [])], {
        encoding: "utf8", env: { ...process.env, ...callerEnv, DAEMONCTL_ALLOW_NON_ROOT: "1", DAEMONCTL_ALLOW_OTHER_USER: "1",
          DAEMONCTL_ENV_FILE: envFile, DAEMONCTL_STATE_DIR: join(dir, "state"), DAEMONCTL_REQUEST_DIR: join(dir, "requests"),
          DAEMON_SITE_LIB: resolve("ops/macos/daemon-site-lib.sh"), DAEMON_SITE_ENV: site },
      });
      return { dir, envFile, run };
    }

    it.each(["planner", "implementer"])("refuses a missing binary for %s before dry-run or apply mutates state", role => {
      const f = setup("AGENT_FARM_BIN=/missing/agent-farm\n");
      const before = readFileSync(f.envFile), files = readdirSync(f.dir);
      for (const dry of [true, false]) {
        const result = f.run(role, dry);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("cannot select agent-farm:<profile>");
        expect(result.stderr).toContain("executable under the daemon PATH");
        expect(result.stderr).toContain("AGENT_FARM_BIN");
        expect(result.stdout + result.stderr).not.toContain("fixture-secret-never-output");
        expect(readFileSync(f.envFile)).toEqual(before);
        expect(readdirSync(f.dir)).toEqual(files);
      }
    });

    it.each(["non-executable", "broken wrapper"])("refuses a %s", kind => {
      const f = setup("");
      const binary = join(f.dir, "agent-farm");
      writeFileSync(binary, kind === "broken wrapper" ? '#!/bin/sh\nexec /missing/agent-farm "$@"\n' : "#!/bin/sh\nexit 0\n");
      chmodSync(binary, kind === "broken wrapper" ? 0o755 : 0o644);
      writeFileSync(f.envFile, `AGENT_FARM_BIN='${binary}'\n`);
      const result = f.run("implementer", false);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pass --help");
      expect(readFileSync(f.envFile, "utf8")).toBe(`AGENT_FARM_BIN='${binary}'\n`);
      expect(readdirSync(f.dir)).not.toContain("state");
      expect(readdirSync(f.dir)).not.toContain("requests");
    });

    it("ignores a binary available only in the caller PATH or caller AGENT_FARM_BIN", () => {
      const f = setup("AGENT_FARM_BIN=caller-only-farm\n");
      const bin = join(f.dir, "bin"); mkdirSync(bin);
      const binary = join(bin, "caller-only-farm"); executable(binary, "#!/bin/sh\nexit 0\n");
      const result = f.run("implementer", true, { PATH: `${bin}:${process.env.PATH}`, AGENT_FARM_BIN: binary });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("daemon PATH");
    });

    it("resolves a bare name using the daemon env PATH and preserves operator values", () => {
      const f = setup("");
      const bin = join(f.dir, "bin"); mkdirSync(bin);
      executable(join(bin, "operator-farm"), "#!/bin/sh\n[ \"$1\" = --help ]\n");
      const content = `AGENT_FARM_BIN=operator-farm\nPATH='${bin}:/usr/bin:/bin'\n`;
      writeFileSync(f.envFile, content);
      const result = f.run("planner", true);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(f.envFile, "utf8")).toBe(content);
    });

    it("requires a PATH wrapper for the default CLI installed outside daemon PATH", () => {
      const f = setup("");
      const bin = join(f.dir, "bin"); mkdirSync(bin);
      const pnpmBin = join(f.dir, ".pnpm/bin"); mkdirSync(pnpmBin, { recursive: true });
      executable(join(pnpmBin, "agent-farm"), "#!/bin/sh\n[ \"$1\" = --help ]\n");
      const content = `PATH='${bin}:/usr/bin:/bin'\n`;
      writeFileSync(f.envFile, content);
      const rejected = f.run("implementer", true, { AGENT_FARM_BIN: join(pnpmBin, "agent-farm") });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("default agent-farm");
      const wrapper = readFileSync(resolve("ops/macos/agent-farm.sh.template"), "utf8").replaceAll("@SERVICE_HOME@", f.dir);
      executable(join(bin, "agent-farm"), wrapper);
      const accepted = f.run("implementer", true);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(readFileSync(f.envFile, "utf8")).toBe(content);
    });
  });
}
