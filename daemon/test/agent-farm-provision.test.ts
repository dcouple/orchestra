import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
    sudo() {
      local args=() value
      for value in "$@"; do
        case "$value" in
          /usr/local/libexec) value="$AGENT_HOME/libexec" ;;
          /usr/local/libexec/orchestra-agent-farm-browser) value="$AGENT_HOME/libexec/orchestra-agent-farm-browser" ;;
        esac
        args+=("$value")
      done
      if [[ $1 == install ]]; then
        # Root ownership belongs to the real provisioner; the fixture stays local.
        if [[ \${args[1]} == -o ]]; then args=(install "\${args[@]:5}"); fi
      fi
      "\${args[@]}"
    }
    record() { printf '%s %s\\n' "$1" "$2"; }
    fail() { echo "ERROR: $*" >&2; exit 1; }
    . "$SCRIPT_DIR/agent-farm-provision.sh"
    provision_agent_farm
  `, "bash", home, ops, dry ? "1" : "0", String(addExit)], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, CLIPROXY_API_KEY: "proxy-secret-fixture" },
  });
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
        inspect)
          profile=$2; shift 2
          workspace=
          while [ "$#" -gt 0 ]; do
            case "$1" in
              --workspace) workspace=$2; shift 2 ;;
              --config-root) root=$2; shift 2 ;;
              *) exit 99 ;;
            esac
          done
          test -f "$root/profiles/$profile.yaml" || exit 1
          [ -z "$workspace" ] || test -f "$root/workspaces/$workspace.yaml"
          exit $? ;;
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
    expect(result.stdout).toBe("agent-farm-cli would-apply\nagent-farm-plugin would-apply\nagent-farm-profiles would-apply\nagent-farm-provider would-apply\nagent-farm-workspace would-apply\nagent-farm-browser would-apply\n");
    expect(spawnSync("ls", ["-A", f.home], { encoding: "utf8" }).stdout).toBe("");
  });

  it("places provider references without secrets and converges by bytes", () => {
    const f = fixture(); f.seed();
    const settings = join(f.root, "settings.json");
    const inventory = f.run(true);
    expect(inventory.status, inventory.stderr).toBe(0);
    expect(inventory.stdout).toContain("agent-farm-provider would-apply");
    expect(existsSync(settings)).toBe(false);
    const first = f.run(false);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("agent-farm-provider applied");
    const bytes = readFileSync(settings, "utf8");
    expect(JSON.parse(bytes)).toEqual({ provider: {
      name: "cliproxy", base_url: "http://127.0.0.1:8317", api_key_env: "CLIPROXY_API_KEY",
    } });
    expect(bytes).not.toContain("proxy-secret-fixture");
    expect(statSync(settings).mode & 0o777).toBe(0o640);
    for (const dry of [true, false]) {
      const result = f.run(dry);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("agent-farm-provider already-correct");
      expect(readFileSync(settings, "utf8")).toBe(bytes);
    }
    // Equivalent JSON with different formatting still needs byte convergence.
    const compact = JSON.stringify(JSON.parse(bytes));
    writeFileSync(settings, compact);
    const changed = f.run(true);
    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.stdout).toContain("agent-farm-provider would-apply");
    expect(readFileSync(settings, "utf8")).toBe(compact);
    const repaired = f.run(false);
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain("agent-farm-provider applied");
    expect(readFileSync(settings, "utf8")).toBe(bytes);
  });

  it.each(["settings", "config-root"])("refuses a symlink %s provider destination", destination => {
    const f = fixture(); f.seed();
    const target = join(f.home, "unrelated-settings.json");
    const original = '{"provider":{"name":"unrelated"}}\n';
    writeFileSync(target, original);
    if (destination === "settings") symlinkSync(target, join(f.root, "settings.json"));
    else {
      const realRoot = join(f.home, "real-config");
      renameSync(f.root, realRoot);
      writeFileSync(join(realRoot, "settings.json"), original);
      symlinkSync(realRoot, f.root);
    }
    const result = f.run(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("provider destination is a symlink");
    expect(readFileSync(target, "utf8")).toBe(original);
    if (destination === "config-root")
      expect(readFileSync(join(f.root, "settings.json"), "utf8")).toBe(original);
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

  it("places the workspace and launcher, preserving unrelated workspaces", () => {
    const f = fixture(); f.seed();
    mkdirSync(join(f.root, "workspaces"));
    const unrelated = join(f.root, "workspaces/unrelated.yaml");
    writeFileSync(unrelated, "connections: {}\n");
    const first = f.run(false);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("agent-farm-workspace applied");
    expect(first.stdout).toContain("agent-farm-browser applied");
    expect(readFileSync(join(f.root, "workspaces/bloom-mono.yaml")))
      .toEqual(readFileSync(resolve("ops/agent-farm/bloom-mono.yaml")));
    expect(readFileSync(join(f.home, "libexec/orchestra-agent-farm-browser")))
      .toEqual(readFileSync(resolve("ops/agent-farm-browser.sh")));
    expect(statSync(join(f.root, "workspaces/bloom-mono.yaml")).mode & 0o777).toBe(0o640);
    expect(statSync(join(f.home, "libexec/orchestra-agent-farm-browser")).mode & 0o777).toBe(0o755);
    const second = f.run(false);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("agent-farm-workspace already-correct");
    expect(second.stdout).toContain("agent-farm-browser already-correct");
    expect(readFileSync(unrelated, "utf8")).toBe("connections: {}\n");
  });
  it("refuses a symlink workspace without changing its target", () => {
    const f = fixture(); f.seed();
    mkdirSync(join(f.root, "workspaces"));
    const target = join(f.home, "unrelated.yaml");
    writeFileSync(target, "connections: {}\n");
    symlinkSync(target, join(f.root, "workspaces/bloom-mono.yaml"));
    const result = f.run(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workspace destination is a symlink");
    expect(readFileSync(target, "utf8")).toBe("connections: {}\n");
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
