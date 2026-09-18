import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ops = resolve("ops/macos");
const helper = join(ops, "agent-farm-provision.sh");
const version = readFileSync(helper, "utf8").match(/^AGENT_FARM_VERSION=(.+)$/m)![1];

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "agent-farm-provision-"));
  const packageRoot = join(home, ".pnpm/global/v11/fixture package/node_modules/@dcouple/agent-farm");
  const root = join(home, ".config/agent-farm");
  const run = (dry: boolean, addExit = 0) => spawnSync("bash", ["-c", `
    set -euo pipefail
    AGENT_HOME="$1"
    SCRIPT_DIR="$2"
    DRY_RUN="$3"
    ADD_EXIT="$4"
    agent() {
      if [[ $1 == /usr/local/bin/pnpm ]]; then
        shift
        case "$1" in
          list) cat "$AGENT_HOME/pnpm-list.json"; return ;;
          add) printf '%s\\n' "$*" >> "$AGENT_HOME/pnpm-add.log"; return "$ADD_EXIT" ;;
          *) return 99 ;;
        esac
      fi
      env HOME="$AGENT_HOME" "$@"
    }
    record() { printf '%s %s\\n' "$1" "$2"; }
    fail() { echo "ERROR: $*" >&2; exit 1; }
    . "$SCRIPT_DIR/agent-farm-provision.sh"
    provision_agent_farm
  `, "bash", home, ops, dry ? "1" : "0", String(addExit)], { encoding: "utf8", timeout: 10_000 });
  const seed = () => {
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    mkdirSync(join(packageRoot, "plugins/dcouple/profiles"), { recursive: true });
    mkdirSync(join(root, "profiles"), { recursive: true });
    mkdirSync(join(root, ".plugins"));
    mkdirSync(join(home, ".pnpm/bin"), { recursive: true });
    const checksums: Record<string, string> = {};
    for (const name of ["planner", "implementer"]) {
      const relative = `profiles/${name}.yaml`, content = `agent: ${name}\n`;
      writeFileSync(join(packageRoot, "plugins/dcouple", relative), content);
      writeFileSync(join(root, relative), content);
      checksums[relative] = createHash("sha256").update(content).digest("hex");
    }
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version, type: "module" }));
    // Upstream package discovery and CLI boundaries are mocked.
    // The provisioner runs real binary, marker, receipt, and hash checks.
    writeFileSync(join(packageRoot, "dist/plugins.js"), `export function validatePlugin() { return ${JSON.stringify({ info: { name: "dcouple", version: "0.1.3" }, checksums })}; }\n`);
    writeFileSync(join(packageRoot, "dist/cli.js"), `#!/bin/sh
      case "$1" in
        --help) exit 0 ;;
        inspect) test -f "$4/profiles/$2.yaml"; exit $? ;;
        plugin) printf '{"changed":0}\n'; exit 0 ;;
        *) echo 'unexpected mutation' >&2; exit 99 ;;
      esac
    `);
    chmodSync(join(packageRoot, "dist/cli.js"), 0o755);
    symlinkSync(join(packageRoot, "dist/cli.js"), join(home, ".pnpm/bin/agent-farm"));
    writeFileSync(join(root, ".plugins/dcouple.json"), JSON.stringify({ name: "dcouple", version: "0.1.3", checksums }));
    writeFileSync(join(home, ".pnpm/agent-farm-version"), `${version}\n`);
    writeFileSync(join(home, "pnpm-list.json"), JSON.stringify([{ dependencies: { "@dcouple/agent-farm": { path: packageRoot, version } } }]));
  };
  return { home, packageRoot, root, run, seed };
}

describe("Agent Farm macOS provisioning convergence", () => {
  it("reports a fresh installation without creating managed state", () => {
    const f = fixture(), result = f.run(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("agent-farm-cli would-apply\nagent-farm-plugin would-apply\nagent-farm-profiles would-apply\nagent-farm-workspace pending-item-5: workspace placement\n");
    expect(spawnSync("ls", ["-A", f.home], { encoding: "utf8" }).stdout).toBe("");
  });

  it("keeps converged files byte-identical on dry run and repeated apply", () => {
    const f = fixture(); f.seed();
    const receipt = readFileSync(join(f.root, ".plugins/dcouple.json"));
    for (const dry of [true, false, false]) {
      const result = f.run(dry);
      expect(result.status, result.stderr).toBe(0);
      for (const setting of ["cli", "plugin", "profiles"]) expect(result.stdout).toContain(`agent-farm-${setting} already-correct`);
      expect(readFileSync(join(f.root, ".plugins/dcouple.json"))).toEqual(receipt);
    }
  });

  it("detects local profile edits without modifying them during inventory", () => {
    const f = fixture(); f.seed();
    const profile = join(f.root, "profiles/planner.yaml");
    writeFileSync(profile, "agent: local-planner\n");
    const result = f.run(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("agent-farm-plugin would-apply");
    expect(result.stdout).toContain("agent-farm-profiles would-apply");
    expect(readFileSync(profile, "utf8")).toBe("agent: local-planner\n");
  });

  it("checks installed bytes and refuses symlink destinations even with a matching receipt", () => {
    const f = fixture(); f.seed();
    const profile = join(f.root, "profiles/implementer.yaml");
    const check = () => spawnSync(process.execPath, [join(ops, "agent-farm-state.mjs"), f.packageRoot, f.root], { encoding: "utf8" });
    writeFileSync(profile, "agent: local-implementer\n");
    expect(check().stderr).toContain("Installed plugin file differs");
    unlinkSync(profile); symlinkSync(join(f.packageRoot, "plugins/dcouple/profiles/implementer.yaml"), profile);
    const result = check();
    expect(result.status).toBe(1); expect(result.stderr).toContain("Symlink destination");
  });

  it("reinstalls a mismatched version marker using the pinned registry spec", () => {
    const f = fixture(); f.seed();
    const marker = join(f.home, ".pnpm/agent-farm-version");
    writeFileSync(marker, "0.0.1\n");
    const result = f.run(false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("agent-farm-cli applied");
    expect(readFileSync(join(f.home, "pnpm-add.log"), "utf8")).toBe(`add --global @dcouple/agent-farm@${version}\n`);
    expect(readFileSync(marker, "utf8")).toBe(`${version}\n`);
    const second = f.run(false);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("agent-farm-cli already-correct");
    expect(readFileSync(join(f.home, "pnpm-add.log"), "utf8")).toBe(`add --global @dcouple/agent-farm@${version}\n`);
  });

  it("preserves the marker when pnpm installation fails", () => {
    const f = fixture(); f.seed();
    const marker = join(f.home, ".pnpm/agent-farm-version");
    writeFileSync(marker, "0.0.1\n");
    const result = f.run(false, 7);
    expect(result.status).toBe(7);
    expect(readFileSync(marker, "utf8")).toBe("0.0.1\n");
  });

  it("reports unresolved package placement in dry run and fails apply", () => {
    const f = fixture(); f.seed();
    writeFileSync(join(f.home, "pnpm-list.json"), "[]");
    const inventory = f.run(true);
    expect(inventory.status, inventory.stderr).toBe(0);
    expect(inventory.stdout).toContain("agent-farm-cli already-correct");
    expect(inventory.stdout).toContain("agent-farm-plugin would-apply");
    const apply = f.run(false);
    expect(apply.status).toBe(1);
    expect(apply.stderr).toContain("installed package path did not resolve");
  });
});
