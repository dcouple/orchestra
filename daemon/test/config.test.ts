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
    expect(config.reconcileIntervalMs).toBe(60_000);
    expect(config.reconcileRequestTimeoutMs).toBe(10_000);
    expect(config.apps.planner.staticToken).toBe("pt");
    expect(config.sessionsEnabled).toBe(false);
    expect(config.claudeArgv).toEqual(["claudex"]);
    expect(config).toMatchObject({doPermissionMode:"bypassPermissions",doMaxTurns:300});
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
  it("requires WEBHOOK_BASE_URL outside test mode", () => {
    const env = { ...base, PLANNER_LINEAR_CLIENT_ID: "p-id", PLANNER_LINEAR_CLIENT_SECRET: "p-secret",
      IMPLEMENTER_LINEAR_CLIENT_ID: "i-id", IMPLEMENTER_LINEAR_CLIENT_SECRET: "i-secret" };
    delete (env as Partial<typeof base>).DAEMON_TEST_MODE;
    expect(() => loadConfig(env)).toThrow("WEBHOOK_BASE_URL");
  });
});
