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
    expect(config.apps.planner.staticToken).toBe("pt");
    expect(config.sessionsEnabled).toBe(false);
    expect(config.claudeArgv).toEqual(["claude"]);
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
    expect(() => loadConfig(env)).toThrow("PLANNER_LINEAR_CLIENT_ID");
  });
});
