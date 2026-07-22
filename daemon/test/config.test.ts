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
    expect(config.artifactsDir).toBe("/var/lib/linear-agent-daemon/artifacts");
    expect(config.artifactMaxBodyBytes).toBe(32 * 1024 * 1024);
    expect(config.reconcileIntervalMs).toBe(60_000);
    expect(config.reconcileRequestTimeoutMs).toBe(10_000);
    expect(config.apps.planner.staticToken).toBe("pt");
    expect(config.sessionsEnabled).toBe(false);
    expect(config.claudeArgv).toEqual(["claude"]);
    expect(config.claudexArgv).toBeUndefined();
    expect(config.fableArgv).toBeUndefined();
    expect(config).toMatchObject({ cliproxyEnvFile: "/etc/linear-agent-daemon/cliproxyapi.env",
      cliproxyUrl: "http://127.0.0.1:8317", providerProbeIntervalMs: 60_000,
      providerStateStaleMs: 300_000, providerInitialProbeTimeoutMs: 5_000 });
    expect(config).toMatchObject({doPermissionMode:"bypassPermissions",doMaxTurns:300});
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
      sessionConcurrency: 2, keepaliveMs: 900_000, attachmentsEnabled: true, attachmentHosts: ["uploads.linear.app"] });
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
  it("requires WEBHOOK_BASE_URL outside test mode", () => {
    const env = { ...base, PLANNER_LINEAR_CLIENT_ID: "p-id", PLANNER_LINEAR_CLIENT_SECRET: "p-secret",
      IMPLEMENTER_LINEAR_CLIENT_ID: "i-id", IMPLEMENTER_LINEAR_CLIENT_SECRET: "i-secret" };
    delete (env as Partial<typeof base>).DAEMON_TEST_MODE;
    expect(() => loadConfig(env)).toThrow("WEBHOOK_BASE_URL");
  });
});
