import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const macosDir = resolve("ops/macos");
const lib = join(macosDir, "daemon-site-lib.sh");

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
      const text = readFileSync(join(macosDir, file), "utf8");
      expect(text, file).not.toMatch(/blmapp|bloomapi|bloom-agents|com\.dcouple|us-central1|\bbloomi\b/);
      if (file !== "site.env.example") expect(text, file).not.toMatch(/\/Users\/linearagent/);
    }
    expect(example).toMatch(/^DAEMON_PUBLIC_HOSTNAME=linear-agent\.example\.com$/m);
  });
});
