import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ops = resolve("ops/macos");
const helper = join(ops, "agent-farm-provision.sh");
const pin = readFileSync(helper, "utf8").match(/^AGENT_FARM_COMMIT=(\w+)$/m)![1];
const version = readFileSync(helper, "utf8").match(/^AGENT_FARM_VERSION=(.+)$/m)![1];

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "agent-farm-provision-"));
  const checkout = join(home, ".local/share/agent-farm", pin);
  const root = join(home, ".config/agent-farm");
  const run = (dry: boolean, commit = pin) => spawnSync("bash", ["-c", `
    set -euo pipefail
    AGENT_HOME="$1"
    SCRIPT_DIR="$2"
    DRY_RUN="$3"
    agent() { env HOME="$AGENT_HOME" "$@"; }
    record() { printf '%s %s\\n' "$1" "$2"; }
    fail() { echo "ERROR: $*" >&2; exit 1; }
    . "$SCRIPT_DIR/agent-farm-provision.sh"
    AGENT_FARM_COMMIT="$4"
    provision_agent_farm
  `, "bash", home, ops, dry ? "1" : "0", commit], { encoding: "utf8", timeout: 10_000 });
  const seed = () => {
    mkdirSync(join(checkout, "dist"), { recursive: true });
    mkdirSync(join(checkout, "plugins/dcouple/profiles"), { recursive: true });
    mkdirSync(join(root, "profiles"), { recursive: true });
    mkdirSync(join(root, ".plugins"));
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    const checksums: Record<string, string> = {};
    for (const name of ["planner", "implementer"]) {
      const relative = `profiles/${name}.yaml`, content = `agent: ${name}\n`;
      writeFileSync(join(checkout, "plugins/dcouple", relative), content);
      writeFileSync(join(root, relative), content);
      checksums[relative] = createHash("sha256").update(content).digest("hex");
    }
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ version, type: "module" }));
    // Only the upstream read-only validation/inspection boundary is mocked.
    // The provisioner runs real git, symlink, file, receipt, and hash checks.
    writeFileSync(join(checkout, "dist/plugins.js"), `export function validatePlugin() { return ${JSON.stringify({ info: { name: "dcouple", version: "0.1.3" }, checksums })}; }\n`);
    writeFileSync(join(checkout, "dist/cli.js"), `#!/bin/sh
      case "$1" in
        --help) exit 0 ;;
        inspect) test -f "$4/profiles/$2.yaml"; exit $? ;;
        *) echo 'unexpected mutation' >&2; exit 99 ;;
      esac
    `);
    chmodSync(join(checkout, "dist/cli.js"), 0o755);
    symlinkSync(join(checkout, "dist/cli.js"), join(home, ".local/bin/agent-farm"));
    writeFileSync(join(root, ".plugins/dcouple.json"), JSON.stringify({ name: "dcouple", version: "0.1.3", checksums }));
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git("init"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    git("remote", "add", "origin", "https://github.com/dcouple/agent-farm.git");
    return git("rev-parse", "HEAD");
  };
  return { home, checkout, root, run, seed };
}

describe("Agent Farm macOS provisioning convergence", () => {
  it("reports a fresh installation without creating managed state", () => {
    const f = fixture(), result = f.run(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("agent-farm-cli would-apply\nagent-farm-plugin would-apply\nagent-farm-profiles would-apply\nagent-farm-workspace pending-item-5: workspace placement\n");
    expect(spawnSync("ls", ["-A", f.home], { encoding: "utf8" }).stdout).toBe("");
  });

  it("keeps converged files byte-identical on dry run and repeated apply", () => {
    const f = fixture(), commit = f.seed();
    const receipt = readFileSync(join(f.root, ".plugins/dcouple.json"));
    for (const dry of [true, false, false]) {
      const result = f.run(dry, commit);
      expect(result.status, result.stderr).toBe(0);
      for (const setting of ["cli", "plugin", "profiles"]) expect(result.stdout).toContain(`agent-farm-${setting} already-correct`);
      expect(readFileSync(join(f.root, ".plugins/dcouple.json"))).toEqual(receipt);
    }
  });

  it("detects local profile edits without modifying them during inventory", () => {
    const f = fixture(), commit = f.seed(), profile = join(f.root, "profiles/planner.yaml");
    writeFileSync(profile, "agent: local-planner\n");
    const result = f.run(true, commit);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("agent-farm-plugin would-apply");
    expect(result.stdout).toContain("agent-farm-profiles would-apply");
    expect(readFileSync(profile, "utf8")).toBe("agent: local-planner\n");
  });

  it("checks installed bytes and refuses symlink destinations even with a matching receipt", () => {
    const f = fixture(); f.seed();
    const profile = join(f.root, "profiles/implementer.yaml");
    const check = () => spawnSync(process.execPath, [join(ops, "agent-farm-state.mjs"), f.checkout, f.root], { encoding: "utf8" });
    writeFileSync(profile, "agent: local-implementer\n");
    expect(check().stderr).toContain("Installed plugin file differs");
    unlinkSync(profile); symlinkSync(join(f.checkout, "plugins/dcouple/profiles/implementer.yaml"), profile);
    const result = check();
    expect(result.status).toBe(1); expect(result.stderr).toContain("Symlink destination");
  });

  it("refuses a dirty source checkout instead of rebuilding it", () => {
    const f = fixture(), commit = f.seed();
    writeFileSync(join(f.checkout, "package.json"), JSON.stringify({ version: "9.9.9", type: "module" }));
    const result = f.run(false, commit);
    expect(result.status).toBe(1); expect(result.stderr).toContain("checkout differs from the pin");
    expect(readFileSync(join(f.checkout, "package.json"), "utf8")).toContain("9.9.9");
  });
});
