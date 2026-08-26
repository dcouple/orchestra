import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DAEMON_TEST_MODE: "1",
  SESSIONS_ENABLED: "0",
  PLANNER_WEBHOOK_SECRET: "p", PLANNER_LINEAR_TOKEN: "pt",
  IMPLEMENTER_WEBHOOK_SECRET: "i", IMPLEMENTER_LINEAR_TOKEN: "it",
};

describe("loadConfig", () => {
  it("loads test static tokens and defaults", () => {
    const config = loadConfig(base);
    expect(config.bindAddr).toBe("127.0.0.1");
    expect(config.replayWindowMs).toBe(60_000);
    expect(config.webhookBaseUrl).toBe("http://127.0.0.1:8787");
    expect(config.artifactToken).toBeUndefined();
    expect(config.mcpEnvPassthrough).toBeUndefined();
    expect(config.artifactsDir).toBe("/var/lib/linear-agent-daemon/artifacts");
    expect(config.dispatchQuarantineDir).toBe(
      "/var/lib/linear-agent-daemon/dispatch-quarantine",
    );
    expect(config.dispatchQuarantineAgeMs).toBe(86_400_000);
    expect(config.dispatchResumeGraceMs).toBe(600_000);
    expect(config).toMatchObject({ browserEnabled: true, playwrightMcpBin: "/usr/local/bin/playwright-mcp",
      playwrightChromeBin: "/usr/bin/google-chrome", browserAttemptTimeoutMs: 14_400_000 });
    expect(config.artifactMaxBodyBytes).toBe(32 * 1024 * 1024);
    expect(config.reconcileIntervalMs).toBe(60_000);
    expect(config.reconcileRequestTimeoutMs).toBe(10_000);
    expect(config).toMatchObject({
      linearMcpUrl: "https://mcp.linear.app/mcp",
      linearMcpMonitorIntervalMs: 60_000,
      linearMcpMonitorTimeoutMs: 10_000,
    });
    expect(config.apps.planner.staticToken).toBe("pt");
    expect(config.apps.planner.harness).toBe("claude");
    expect(config.apps.implementer.harness).toBe("claude");
    expect(config.sessionsEnabled).toBe(false);
    expect(config.claudeArgv).toEqual(["claude"]);
    expect(config.claudexArgv).toBeUndefined();
    expect(config.fableArgv).toBeUndefined();
    expect(config).toMatchObject({ cliproxyEnvFile: "/etc/linear-agent-daemon/cliproxyapi.env",
      cliproxyUrl: "http://127.0.0.1:8317", providerProbeIntervalMs: 60_000,
      providerStateStaleMs: 300_000, providerInitialProbeTimeoutMs: 5_000 });
    expect(config).toMatchObject({ bashDefaultTimeoutMs: 900_000, bashMaxTimeoutMs: 900_000 });
    expect(config).toMatchObject({doPermissionMode:"bypassPermissions",doMaxTurns:300});
  });
  it.each([undefined, "", "  ", " , ,"])(
    "treats an empty MCP_ENV_PASSTHROUGH value %s as unset",
    (value) => {
      expect(
        loadConfig({ ...base, MCP_ENV_PASSTHROUGH: value })
          .mcpEnvPassthrough,
      ).toBeUndefined();
    },
  );
  it("trims and deduplicates MCP environment passthrough names", () => {
    expect(
      loadConfig({ ...base, MCP_ENV_PASSTHROUGH: " A , B ,,A " })
        .mcpEnvPassthrough,
    ).toEqual(["A", "B"]);
  });
  it.each([
    ["CLIPROXY_MANAGEMENT_KEY", "denied child secret"],
    ["ARTIFACT_TOKEN", "denied child secret"],
    ["PLANNER_WEBHOOK_SECRET", "denied child secret"],
    ["PLANNER_LINEAR_CLIENT_SECRET", "denied child secret"],
    ["PLANNER_LINEAR_TOKEN", "denied child secret"],
    ["OAUTH_X", "denied child secret"],
    ["X_OAUTH_TOKEN", "denied child secret"],
    ["CLIPROXY_API_KEY", "daemon-owned"],
    ["BASH_DEFAULT_TIMEOUT_MS", "daemon-owned"],
    ["BASH_MAX_TIMEOUT_MS", "daemon-owned"],
    ["LINEAR_API_KEY", "daemon-owned"],
    ["ARTIFACT_HOST_TOKEN", "daemon-owned"],
    ["9BAD", "environment variable name"],
    ["A-B", "environment variable name"],
    ["A B", "environment variable name"],
  ])(
    "rejects reserved or malformed MCP passthrough key %s",
    (key, reason) => {
      let message = "";
      try {
        loadConfig({ ...base, MCP_ENV_PASSTHROUGH: `GOOD,${key},OTHER` });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("MCP_ENV_PASSTHROUGH");
      expect(message).toContain(key);
      expect(message).toContain(reason);
    },
  );
  it("loads independent harness preferences and names invalid settings", () => {
    const config = loadConfig({ ...base, PLANNER_HARNESS: "claudex", IMPLEMENTER_HARNESS: "claude" });
    expect(config.apps.planner.harness).toBe("claudex");
    expect(config.apps.implementer.harness).toBe("claude");
    expect(() => loadConfig({ ...base, PLANNER_HARNESS: "sol" })).toThrow("PLANNER_HARNESS");
    expect(() => loadConfig({ ...base, IMPLEMENTER_HARNESS: "fable" })).toThrow("IMPLEMENTER_HARNESS");
  });
  it.each([
    ["PLANNER_HARNESS", ""],
    ["PLANNER_HARNESS", "   "],
    ["IMPLEMENTER_HARNESS", ""],
    ["IMPLEMENTER_HARNESS", " \t "],
  ])("rejects a configured empty %s value", (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(name);
  });
  it("loads Fable and provider probe overrides", () => {
    expect(loadConfig({ ...base, FABLE_BIN: "node fable.mjs", CLIPROXY_ENV_FILE: "/tmp/proxy.env",
      CLIPROXY_URL: "http://proxy:8317/", PROVIDER_PROBE_INTERVAL_MS: "2000",
      PROVIDER_STATE_STALE_MS: "9000", PROVIDER_INITIAL_PROBE_TIMEOUT_MS: "750" })).toMatchObject({
        fableArgv: ["node", "fable.mjs"], cliproxyEnvFile: "/tmp/proxy.env", cliproxyUrl: "http://proxy:8317",
        providerProbeIntervalMs: 2000, providerStateStaleMs: 9000, providerInitialProbeTimeoutMs: 750,
      });
    expect(() => loadConfig({ ...base, PROVIDER_INITIAL_PROBE_TIMEOUT_MS: "0" })).toThrow("PROVIDER_INITIAL_PROBE_TIMEOUT_MS");
  });
  it("validates Claude Bash timeout overrides", () => {
    expect(loadConfig({ ...base, BASH_DEFAULT_TIMEOUT_MS: "360000",
      BASH_MAX_TIMEOUT_MS: "1200000" })).toMatchObject({
        bashDefaultTimeoutMs: 360_000, bashMaxTimeoutMs: 1_200_000,
      });
    for (const [name, value] of [
      ["BASH_DEFAULT_TIMEOUT_MS", "0"],
      ["BASH_DEFAULT_TIMEOUT_MS", "1.5"],
      ["BASH_MAX_TIMEOUT_MS", "nope"],
    ])
      expect(() => loadConfig({ ...base, [name]: value })).toThrow(name);
    expect(() => loadConfig({ ...base, BASH_DEFAULT_TIMEOUT_MS: "900001",
      BASH_MAX_TIMEOUT_MS: "900000" })).toThrow(
        "BASH_MAX_TIMEOUT_MS must be greater than or equal to BASH_DEFAULT_TIMEOUT_MS",
      );
  });
  it("loads and validates Linear MCP monitor settings", () => {
    expect(loadConfig({
      ...base,
      LINEAR_MCP_URL: "https://linear.example.test/mcp/",
      LINEAR_MCP_MONITOR_INTERVAL_MS: "30000",
      LINEAR_MCP_MONITOR_TIMEOUT_MS: "2500",
    })).toMatchObject({
      linearMcpUrl: "https://linear.example.test/mcp",
      linearMcpMonitorIntervalMs: 30_000,
      linearMcpMonitorTimeoutMs: 2_500,
    });
    expect(() => loadConfig({
      ...base,
      LINEAR_MCP_MONITOR_INTERVAL_MS: "0",
    })).toThrow("LINEAR_MCP_MONITOR_INTERVAL_MS");
    expect(() => loadConfig({
      ...base,
      LINEAR_MCP_MONITOR_TIMEOUT_MS: "nope",
    })).toThrow("LINEAR_MCP_MONITOR_TIMEOUT_MS");
  });
  it("forces production do-mode autonomy and parses its budget",()=>{
    expect(()=>loadConfig({...base,DAEMON_TEST_MODE:undefined,WEBHOOK_BASE_URL:"https://agent.example.com",DO_PERMISSION_MODE:"plan"})).toThrow("DO_PERMISSION_MODE");
    expect(loadConfig({...base,DO_PERMISSION_MODE:"plan",DO_MAX_TURNS:"400",DO_MAX_BUDGET_USD:"25.5"}))
      .toMatchObject({doPermissionMode:"plan",doMaxTurns:400,doMaxBudgetUsd:25.5});
  });
  it("loads planner-session defaults and names required variables", () => {
    expect(() => loadConfig({ ...base, SESSIONS_ENABLED: "1" })).toThrow("TARGET_REPO_PATH");
    expect(() => loadConfig({ ...base, SESSIONS_ENABLED: "1", TARGET_REPO_PATH: "/repo" })).toThrow("LINEAR_API_KEY");
    const config = loadConfig({ ...base, SESSIONS_ENABLED: "1", TARGET_REPO_PATH: "/repo", LINEAR_API_KEY: "key",
      DB_PATH: "/state/events.db", CLAUDE_BIN: "node fixture.mjs" });
    expect(config).toMatchObject({ sessionsEnabled: true, worktreesRoot: "/state/worktrees", targetRepoPath: "/repo",
      claudeArgv: ["node", "fixture.mjs"], claudePermissionMode: "bypassPermissions", claudeMaxTurns: 100,
      sessionConcurrency: 5, keepaliveMs: 900_000, attachmentsEnabled: true, attachmentHosts: ["uploads.linear.app"] });
    expect(loadConfig({ ...base, SESSION_CONCURRENCY: "3" }).sessionConcurrency).toBe(3);
  });
  it("names missing variables", () => {
    expect(() => loadConfig({ ...base, PLANNER_WEBHOOK_SECRET: "" })).toThrow("PLANNER_WEBHOOK_SECRET");
  });
  it("parses and validates the optional Claudex runtime", () => {
    expect(loadConfig({ ...base, CLAUDEX_BIN: "claude --model gpt-5.6-sol",
      CLAUDEX_ENV: '{"ANTHROPIC_BASE_URL":"http://proxy","ENABLE_TOOL_SEARCH":"true"}' }))
      .toMatchObject({ claudexArgv: ["claude", "--model", "gpt-5.6-sol"],
        claudexEnv: { ANTHROPIC_BASE_URL: "http://proxy", ENABLE_TOOL_SEARCH: "true" } });
    expect(() => loadConfig({ ...base, CLAUDEX_BIN: "   " })).toThrow("CLAUDEX_BIN must not be empty");
    expect(() => loadConfig({ ...base, CLAUDEX_ENV: "{}" })).toThrow("requires CLAUDEX_BIN");
    expect(() => loadConfig({ ...base, CLAUDEX_BIN: "claude", CLAUDEX_ENV: "[]" })).toThrow("JSON object");
    expect(() => loadConfig({ ...base, CLAUDEX_BIN: "claude", CLAUDEX_ENV: '{"X":1}' })).toThrow("string values");
    expect(() => loadConfig({ ...base, CLAUDEX_BIN: "claude", CLAUDEX_ENV: "{" })).toThrow("valid JSON");
    expect(() => loadConfig({ ...base, CLAUDEX_BIN: "claude", CLAUDEX_ENV: "   " })).toThrow("valid JSON");
  });
  it("requires client credentials without the test-only token override", () => {
    const env = { ...base }; delete (env as Partial<typeof base>).DAEMON_TEST_MODE;
    (env as Record<string, string>).WEBHOOK_BASE_URL = "https://agent.example.com";
    expect(() => loadConfig(env)).toThrow("PLANNER_LINEAR_CLIENT_ID");
  });
  it("loads reconciliation webhook keys and trims the base URL", () => {
    const config = loadConfig({ ...base, WEBHOOK_BASE_URL: "https://agent.example.com///",
      RECONCILE_INTERVAL_MS: "30000", RECONCILE_REQUEST_TIMEOUT_MS: "2000",
      PLANNER_APP_ACTOR_ID: "planner-actor", IMPLEMENTER_APP_ACTOR_ID: "implementer-actor" });
    expect(config).toMatchObject({ webhookBaseUrl: "https://agent.example.com", reconcileIntervalMs: 30000,
      reconcileRequestTimeoutMs: 2000 });
    expect(config.apps.planner.appActorId).toBe("planner-actor");
    expect(config.apps.implementer.appActorId).toBe("implementer-actor");
  });
  it("loads artifact settings", () => {
    const config = loadConfig({ ...base, DB_PATH: "/state/events.db", ARTIFACT_TOKEN: " secret ",
      ARTIFACTS_DIR: "/srv/artifacts", ARTIFACT_MAX_BODY_BYTES: "4096" });
    expect(config).toMatchObject({ artifactToken: "secret", artifactsDir: "/srv/artifacts", artifactMaxBodyBytes: 4096 });
  });
  it("loads dispatch quarantine overrides", () => {
    const config = loadConfig({
      ...base,
      DB_PATH: "/state/events.db",
      DISPATCH_QUARANTINE_DIR: " /srv/dispatch-quarantine ",
      DISPATCH_QUARANTINE_AGE_MS: "172800000",
      DISPATCH_RESUME_GRACE_MS: "120000",
    });
    expect(config).toMatchObject({
      dispatchQuarantineDir: "/srv/dispatch-quarantine",
      dispatchQuarantineAgeMs: 172_800_000,
      dispatchResumeGraceMs: 120_000,
    });
    expect(() =>
      loadConfig({ ...base, DISPATCH_QUARANTINE_AGE_MS: "0" }),
    ).toThrow("DISPATCH_QUARANTINE_AGE_MS");
    expect(() =>
      loadConfig({ ...base, DISPATCH_RESUME_GRACE_MS: "0" }),
    ).toThrow("DISPATCH_RESUME_GRACE_MS");
  });
  it("loads strict browser capability overrides", () => {
    expect(loadConfig(base).browserEnabled).toBe(true);
    expect(loadConfig({ ...base, BROWSER_ENABLED: "0" }).browserEnabled).toBe(false);
    expect(loadConfig({ ...base, BROWSER_ENABLED: "1", PLAYWRIGHT_MCP_BIN: "/mcp", PLAYWRIGHT_CHROME_BIN: "/chrome",
      BROWSER_ATTEMPT_TIMEOUT_MS: "1234" })).toMatchObject({ browserEnabled: true, playwrightMcpBin: "/mcp",
        playwrightChromeBin: "/chrome", browserAttemptTimeoutMs: 1234 });
    expect(() => loadConfig({ ...base, BROWSER_ENABLED: "yes" })).toThrow("BROWSER_ENABLED must be 0 or 1");
    expect(() => loadConfig({ ...base, BROWSER_ATTEMPT_TIMEOUT_MS: "0" })).toThrow("BROWSER_ATTEMPT_TIMEOUT_MS");
  });
  it("loads and strictly validates iOS simulator capability settings", () => {
    expect(loadConfig(base)).toMatchObject({ iosSimEnabled: false,
      xcodebuildMcpBin: "/usr/local/bin/xcodebuildmcp",
      iosSimDeveloperDir: "/Applications/Xcode.app/Contents/Developer",
      iosSimMaxConcurrent: 2, iosSimIdleTimeoutMs: 900_000,
      iosSimReaperIntervalMs: 60_000, simctlArgv: ["xcrun", "simctl"] });
    expect(loadConfig({ ...base, IOS_SIM_ENABLED: "1", IOS_SIM_RUNTIME: " iOS 26.5 ",
      IOS_SIM_DEVICE_TYPE: " iPhone 17 ", XCODEBUILD_MCP_BIN: "/mcp",
      IOS_SIM_DEVELOPER_DIR: "/Xcode", IOS_SIM_MAX_CONCURRENT: "3",
      IOS_SIM_IDLE_TIMEOUT_MS: "100", IOS_SIM_REAPER_INTERVAL_MS: "50",
      IOS_SIM_SIMCTL_BIN: "node fake.mjs" })).toMatchObject({ iosSimEnabled: true,
        iosSimRuntime: "iOS 26.5", iosSimDeviceType: "iPhone 17", xcodebuildMcpBin: "/mcp",
        iosSimDeveloperDir: "/Xcode", iosSimMaxConcurrent: 3, iosSimIdleTimeoutMs: 100,
        iosSimReaperIntervalMs: 50, simctlArgv: ["node", "fake.mjs"] });
    expect(() => loadConfig({ ...base, IOS_SIM_ENABLED: "yes" })).toThrow("IOS_SIM_ENABLED must be 0 or 1");
    expect(() => loadConfig({ ...base, IOS_SIM_ENABLED: "1" })).toThrow(
      "IOS_SIM_RUNTIME and IOS_SIM_DEVICE_TYPE are required when IOS_SIM_ENABLED=1");
    for (const key of ["IOS_SIM_MAX_CONCURRENT", "IOS_SIM_IDLE_TIMEOUT_MS", "IOS_SIM_REAPER_INTERVAL_MS"])
      expect(() => loadConfig({ ...base, [key]: "0" })).toThrow(key);
  });
  it("requires WEBHOOK_BASE_URL outside test mode", () => {
    const env = { ...base, PLANNER_LINEAR_CLIENT_ID: "p-id", PLANNER_LINEAR_CLIENT_SECRET: "p-secret",
      IMPLEMENTER_LINEAR_CLIENT_ID: "i-id", IMPLEMENTER_LINEAR_CLIENT_SECRET: "i-secret" };
    delete (env as Partial<typeof base>).DAEMON_TEST_MODE;
    expect(() => loadConfig(env)).toThrow("WEBHOOK_BASE_URL");
  });
});
