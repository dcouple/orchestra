import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executable, fixture } from "./operations-fixtures.js";

const provision = readFileSync(resolve("ops/macos/provision.sh"), "utf8");
const deploy = readFileSync(resolve("ops/macos/deploy.sh"), "utf8");
const functions = provision.slice(provision.indexOf("install_if_changed()"), provision.indexOf("version_at_least()"));
const apply = provision.slice(provision.indexOf("\nroot_files_changed=0\n"), provision.indexOf('\nfor spec in "daemon-site-lib.sh:', provision.indexOf("\nroot_files_changed=0\n")));
const inventory = provision.slice(provision.indexOf("  sudo test ! -L /usr/local/bin/agent-farm"), provision.indexOf('\n  for spec in "$SCRIPT_DIR/daemon-site-lib.sh:'));
const check = deploy.slice(deploy.indexOf("check_artifact()"), deploy.indexOf("\nRENDER_DIR=$(mktemp"));

function setup() {
  const { dir } = fixture(), rendered = join(dir, "render"), installed = join(dir, "bin/agent-farm");
  mkdirSync(rendered); mkdirSync(join(dir, "bin")); mkdirSync(join(dir, ".pnpm/bin"), { recursive: true });
  const content = readFileSync(resolve("ops/macos/agent-farm.sh.template"), "utf8").replaceAll("@SERVICE_HOME@", dir);
  writeFileSync(join(rendered, "agent-farm"), content);
  const run = (action: "apply" | "inventory" | "check", owner = "root:wheel") => spawnSync("bash", ["-c", `
    set -euo pipefail
    RENDER_DIR="$1"
    installed="$2"
    fixture_owner="$3"
    # Root ownership is simulated; bytes and permissions use local real files.
    stat() {
      if [[ $2 == %Su:%Sg ]]; then printf '%s\\n' "$fixture_owner"; else
        python3 -c 'import os,stat,sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode))[2:])' "$3"
      fi
    }
    sudo() {
      local args=() value
      for value in "$@"; do
        [[ $value != /usr/local/bin/agent-farm ]] || value="$installed"
        args+=("$value")
      done
      if [[ $1 == install ]]; then
        [[ \${args[1]} == -o && \${args[2]} == root && \${args[3]} == -g && \${args[4]} == wheel ]]
        args=(install "\${args[@]:5}")
      fi
      "\${args[@]}"
    }
    record() { printf '%s %s\\n' "$1" "$2"; }
    fail() { echo "$*" >&2; exit 1; }
    ${functions}
    ${action === "apply" ? apply : action === "inventory" ? inventory : `drift=0\n${check}\ncheck_artifact "$RENDER_DIR/agent-farm" "$installed" root:wheel 0755\n(( drift == 0 )) || exit 78`}
  `, "bash", rendered, installed, owner], { encoding: "utf8" });
  return { dir, installed, content, run };
}

describe("Agent Farm wrapper provisioning and deploy drift", () => {
  it("inventories, applies, converges, and repairs byte or mode drift", () => {
    const f = setup();
    expect(f.run("inventory").stdout).toBe("agent-farm-wrapper would-apply\n");
    expect(existsSync(f.installed)).toBe(false);
    expect(f.run("apply").stdout).toBe("agent-farm-wrapper applied\n");
    expect(readFileSync(f.installed, "utf8")).toBe(f.content);
    expect(statSync(f.installed).mode & 0o777).toBe(0o755);
    expect(f.run("inventory").stdout).toBe("agent-farm-wrapper already-correct\n");
    expect(f.run("apply").stdout).toBe("agent-farm-wrapper already-correct\n");
    expect(f.run("check").status).toBe(0);
    for (const drift of ["bytes", "mode"]) {
      if (drift === "bytes") writeFileSync(f.installed, "#!/bin/sh\nexit 0\n");
      else chmodSync(f.installed, 0o644);
      expect(f.run("inventory").stdout).toContain("would-apply");
      const rejected = f.run("check"); expect(rejected.status).toBe(78); expect(rejected.stderr).toContain("needs-provision:");
      const repaired = f.run("apply"); expect(repaired.status, repaired.stderr).toBe(0); expect(repaired.stdout).toContain("applied");
      expect(readFileSync(f.installed, "utf8")).toBe(f.content);
      expect(statSync(f.installed).mode & 0o777).toBe(0o755);
    }
    expect(f.run("check", "fixture:staff").status).toBe(78);
    expect(deploy).toContain('check_artifact "$RENDER_DIR/agent-farm" /usr/local/bin/agent-farm root:wheel 0755');
  });

  it("refuses a symlink destination without touching its target", () => {
    const f = setup(), target = join(f.dir, "operator-file"); writeFileSync(target, "preserve\n"); symlinkSync(target, f.installed);
    expect(f.run("inventory").stdout).toContain("would-apply");
    expect(f.run("check").status).toBe(78);
    const rejected = f.run("apply"); expect(rejected.status).toBe(1); expect(rejected.stderr).toContain("destination is a symlink");
    expect(readFileSync(target, "utf8")).toBe("preserve\n");
  });

  it("resolves the wrapper on a restricted PATH and forwards argv to the pnpm CLI", () => {
    const f = setup(); const result = f.run("apply"); expect(result.status, result.stderr).toBe(0);
    executable(join(f.dir, ".pnpm/bin/agent-farm"), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    const launched = spawnSync("/usr/bin/env", ["-i", `PATH=${join(f.dir, "bin")}:/usr/bin:/bin`, "agent-farm", "run", "profile with spaces", "--print-launch"], { encoding: "utf8" });
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout).toBe("run\nprofile with spaces\n--print-launch\n");
  });
});
