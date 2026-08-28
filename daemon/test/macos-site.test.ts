import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const macosDir = resolve("ops/macos");
const lib = join(macosDir, "daemon-site-lib.sh");
const deploy = readFileSync(join(macosDir, "deploy.sh"), "utf8");

function renderWith(siteEnv: string) {
  const dir = mkdtempSync(join(tmpdir(), "macos-site-"));
  const site = join(dir, "site.env");
  writeFileSync(site, siteEnv);
  const out = join(dir, "out");
  const result = spawnSync("bash", ["-c", `
    set -euo pipefail
    mkdir -p "$1"
    export DAEMON_SITE_ENV="$0"
    . "${lib}"
    load_site_env
    render_site_templates "$1"
    echo "$DAEMON_LABEL $PROXY_LABEL $TUNNEL_LABEL $DAEMON_SERVICE_HOME"
  `, site, out], { encoding: "utf8" });
  return { result, out };
}

const validSite = [
  "# comment",
  "DAEMON_PUBLIC_HOSTNAME=agent.example.org",
  "DAEMON_TUNNEL_NAME=agent-tunnel",
  "DAEMON_SERVICE_USER=svcagent",
  "DAEMON_LAUNCHD_PREFIX=org.example",
  "",
].join("\n");

describe("macOS site config", () => {
  it("requires provisioned simulator wrappers before deploy", () => {
    expect(deploy).toContain('check_artifact "$MACOS_DIR/orchestra-sim" /usr/local/bin/orchestra-sim root:wheel 0755');
    expect(deploy).toContain("printf '#!/bin/sh\\nexec %s/.pnpm/bin/xcodebuildmcp");
    expect(deploy).toContain('check_artifact "$xcodebuildmcp_wrapper" /usr/local/bin/xcodebuildmcp root:wheel 0755');
  });
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64" || !existsSync("/opt/homebrew/bin/brew"))(
    "reports missing Xcode/runtime without failing a dry run", () => {
      const dir = mkdtempSync(join(tmpdir(), "provision-dry-")); const sudo = join(dir, "sudo");
      writeFileSync(sudo, readFileSync(resolve("test/fixtures/fake-sudo.sh"), "utf8")); chmodSync(sudo, 0o755);
      const result = spawnSync("bash", [join(macosDir, "provision.sh"), "--dry-run", "--site", join(macosDir, "site.env.example")], {
        encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SIM_PROVISION_DEVELOPER_DIR: "/nonexistent" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/simulator-xcode\s+pending-human: install Xcode and an iOS runtime/);
      expect(result.stdout).toMatch(/simulator-runtime\s+pending-human:/);
    },
    30_000,
  );
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64" || !existsSync("/opt/homebrew/bin/brew"))(
    "requires an available iOS simulator runtime", () => {
      const dir = mkdtempSync(join(tmpdir(), "provision-runtime-"));
      const sudo = join(dir, "sudo"), xcrun = join(dir, "xcrun"), developer = join(dir, "Developer");
      writeFileSync(sudo, readFileSync(resolve("test/fixtures/fake-sudo.sh"), "utf8")); chmodSync(sudo, 0o755);
      writeFileSync(xcrun, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_XCRUN_JSON\"\n"); chmodSync(xcrun, 0o755);
      mkdirSync(join(developer, "usr/bin"), { recursive: true }); writeFileSync(join(developer, "usr/bin/xcodebuild"), ""); chmodSync(join(developer, "usr/bin/xcodebuild"), 0o755);
      const run = (json: string) => spawnSync("bash", [join(macosDir, "provision.sh"), "--dry-run", "--site", join(macosDir, "site.env.example")], {
        encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SIM_PROVISION_DEVELOPER_DIR: developer, FAKE_XCRUN_JSON: json },
      });
      const missing = run('{"runtimes":[]}'); expect(missing.status, missing.stderr).toBe(0);
      expect(missing.stdout).toMatch(/simulator-xcode\s+already-correct/);
      expect(missing.stdout).toMatch(/simulator-runtime\s+pending-human: install an available iOS runtime/);
      const available = run('{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","isAvailable":true}]}');
      expect(available.status, available.stderr).toBe(0);
      expect(available.stdout).toMatch(/simulator-xcode\s+already-correct/);
      expect(available.stdout).toMatch(/simulator-runtime\s+already-correct/);
    },
    30_000,
  );
  it("runs sim-preflight with the daemon environment loaded", () => {
    const dir = mkdtempSync(join(tmpdir(), "daemonctl-sim-preflight-"));
    const home = join(dir, "home"), dist = join(home, "linear-agent-daemon", "dist"); mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "sim-preflight.js"), "process.stdout.write(JSON.stringify({args:process.argv.slice(2),env:process.env}))\n");
    const envFile = join(dir, "env"); writeFileSync(envFile, [
      "IOS_SIM_ENABLED=1", "IOS_SIM_RUNTIME='test runtime'", "IOS_SIM_DEVICE_TYPE=TestPhone",
      "IOS_SIM_DEVELOPER_DIR=/test/developer", "IOS_SIM_SIMCTL_BIN='test simctl'", "IOS_SIM_MAX_CONCURRENT=3",
      "XCODEBUILD_MCP_BIN=/test/xcodebuildmcp", `DB_PATH=${join(dir, "events.db")}`, "BIND_ADDR=127.0.0.2", "PORT=9999", "PLANNER_WEBHOOK_SECRET=from-file", "",
    ].join("\n"));
    const site = join(dir, "site.env"); writeFileSync(site, validSite);
    const result = spawnSync("bash", [join(macosDir, "daemonctl"), "sim-preflight", "--dry-run"], { encoding: "utf8", env: {
      ...process.env, DAEMON_SITE_LIB: lib, DAEMON_SITE_ENV: site, DAEMONCTL_ALLOW_OTHER_USER: "1", LINEAR_AGENT_HOME: home,
      DAEMONCTL_ENV_FILE: envFile, NODE_BIN: process.execPath, PLANNER_WEBHOOK_SECRET: "from-parent",
    } });
    expect(result.status, result.stderr).toBe(0); const recorded = JSON.parse(result.stdout) as { args: string[]; env: Record<string, string> };
    expect(recorded.args).toEqual(["--dry-run"]); expect(recorded.env.IOS_SIM_RUNTIME).toBe("test runtime");
    expect(recorded.env.DB_PATH).toBe(join(dir, "events.db")); expect(recorded.env.BIND_ADDR).toBe("127.0.0.2"); expect(recorded.env.PORT).toBe("9999"); expect(recorded.env.PLANNER_WEBHOOK_SECRET).toBeUndefined();
    const allowed = new Set(["PATH", "HOME", "USER", "TMPDIR", "LANG", "IOS_SIM_ENABLED", "IOS_SIM_RUNTIME", "IOS_SIM_DEVICE_TYPE",
      "IOS_SIM_DEVELOPER_DIR", "IOS_SIM_SIMCTL_BIN", "IOS_SIM_MAX_CONCURRENT", "XCODEBUILD_MCP_BIN", "DB_PATH", "BIND_ADDR", "PORT", "__CF_USER_TEXT_ENCODING"]);
    expect(Object.keys(recorded.env).filter(key => !allowed.has(key))).toEqual([]);
  });
  it("passes orchestra-sim arguments through and exits 78 when site config is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "orchestra-sim-wrapper-"));
    const code = join(dir, "code"), dist = join(code, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "sim-cli.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
    const site = join(dir, "site.env"); writeFileSync(site, validSite);
    const wrapper = join(macosDir, "orchestra-sim");
    const result = spawnSync("bash", [wrapper, "release", "UDID with spaces"], { encoding: "utf8",
      env: { ...process.env, DAEMON_SITE_LIB: lib, DAEMON_SITE_ENV: site, NODE_BIN: process.execPath, LINEAR_AGENT_CODE_DIR: code } });
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(["release", "UDID with spaces"]);
    const missing = spawnSync("bash", [wrapper, "status"], { encoding: "utf8",
      env: { ...process.env, DAEMON_SITE_LIB: lib, DAEMON_SITE_ENV: join(dir, "missing"), NODE_BIN: process.execPath, LINEAR_AGENT_CODE_DIR: code } });
    expect(missing.status).toBe(78); expect(missing.stderr).toContain("site config missing or unreadable");
  });
  it("renders every template from the site config with no placeholder left", () => {
    const { result, out } = renderWith(validSite);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "org.example.linear-agent-daemon org.example.cliproxyapi org.example.cloudflared /Users/svcagent",
    );
    const files = readdirSync(out).sort();
    expect(files).toEqual([
      "cloudflared-config.yml",
      "org.example.cliproxyapi.plist",
      "org.example.cloudflared.plist",
      "org.example.linear-agent-daemon.plist",
      "org.example.orchestra-console.plist",
      "sudoers",
    ]);
    for (const file of files) {
      const text = readFileSync(join(out, file), "utf8");
      expect(text, file).not.toMatch(/@(SERVICE_USER|SERVICE_HOME|LAUNCHD_PREFIX|PUBLIC_HOSTNAME)@/);
    }
    const daemonPlist = readFileSync(join(out, "org.example.linear-agent-daemon.plist"), "utf8");
    expect(daemonPlist).toContain("<string>org.example.linear-agent-daemon</string>");
    expect(daemonPlist).toContain("<string>svcagent</string>");
    expect(daemonPlist).toContain("/Users/svcagent/linear-agent-daemon");
    const consolePlist = readFileSync(join(out, "org.example.orchestra-console.plist"), "utf8");
    expect(consolePlist).toContain("<string>org.example.orchestra-console</string>");
    expect(consolePlist).toContain("<string>127.0.0.1</string>");
    expect(consolePlist).toContain("<string>8790</string>");
    const tunnel = readFileSync(join(out, "cloudflared-config.yml"), "utf8");
    expect(tunnel).toContain("hostname: agent.example.org");
    expect(tunnel).toContain("tunnel: @TUNNEL_ID@");
    const sudoers = readFileSync(join(out, "sudoers"), "utf8");
    expect(sudoers).toContain("system/org.example.linear-agent-daemon");
    expect(sudoers).toMatch(/^svcagent ALL=\(root\) NOPASSWD: DAEMON_SERVICES$/m);
  });

  it("rejects unknown keys, missing keys, and values unsafe for the rendered files", () => {
    const cases: Array<[string, string]> = [
      ["DAEMON_SERVICE_USER=svc\nDAEMON_LAUNCHD_PREFIX=org.x\nOTHER=1\n", "unknown key"],
      ["DAEMON_SERVICE_USER=svc\nDAEMON_LAUNCHD_PREFIX=org.x\n", "DAEMON_PUBLIC_HOSTNAME is required"],
      ["DAEMON_SERVICE_USER=svc\nDAEMON_LAUNCHD_PREFIX=org.x\nDAEMON_PUBLIC_HOSTNAME=a|b.com\n", "invalid DAEMON_PUBLIC_HOSTNAME"],
      ["DAEMON_SERVICE_USER=Svc Name\nDAEMON_LAUNCHD_PREFIX=org.x\nDAEMON_PUBLIC_HOSTNAME=a.example.com\n", "invalid DAEMON_SERVICE_USER"],
      ["DAEMON_SERVICE_USER=svc\nDAEMON_LAUNCHD_PREFIX=org.x\nDAEMON_PUBLIC_HOSTNAME=a.example.com\nDAEMON_SOURCE_REPO_URL=git@github.com:x/y.git\n", "https://"],
      ["DAEMON_SERVICE_USER=svc\nDAEMON_LAUNCHD_PREFIX=org.x\nDAEMON_PUBLIC_HOSTNAME=a.example.com\nDAEMON_CONSOLE_BIND_ADDR=0.0.0.0\n", "must be 127.0.0.1"],
      ["DAEMON_SERVICE_USER=svc\nDAEMON_LAUNCHD_PREFIX=org.x\nDAEMON_PUBLIC_HOSTNAME=a.example.com\nDAEMON_CONSOLE_PORT=70000\n", "invalid DAEMON_CONSOLE_PORT"],
    ];
    for (const [site, message] of cases) {
      const { result } = renderWith(site);
      expect(result.status, site).not.toBe(0);
      expect(result.stderr, site).toContain(message);
    }
  });

  it("keeps the macOS ops directory free of deployment-specific names", () => {
    const example = readFileSync(join(macosDir, "site.env.example"), "utf8");
    for (const file of readdirSync(macosDir)) {
      if (!statSync(join(macosDir, file)).isFile()) continue;
      const text = readFileSync(join(macosDir, file), "utf8");
      expect(text, file).not.toMatch(/blmapp|bloomapi|bloom-agents|com\.dcouple|us-central1|\bbloomi\b/);
      if (file !== "site.env.example") expect(text, file).not.toMatch(/\/Users\/linearagent/);
    }
    expect(example).toMatch(/^DAEMON_PUBLIC_HOSTNAME=linear-agent\.example\.com$/m);
    expect(example).toMatch(/^DAEMON_CONSOLE_BIND_ADDR=127\.0\.0\.1$/m);
    expect(example).toMatch(/^DAEMON_CONSOLE_PORT=8790$/m);
    expect(example).toContain("${DAEMON_LAUNCHD_PREFIX}.orchestra-console");
  });
});
