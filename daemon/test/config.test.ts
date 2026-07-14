import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DAEMON_TEST_MODE: "1",
  PLANNER_WEBHOOK_SECRET: "p", PLANNER_LINEAR_TOKEN: "pt",
  IMPLEMENTER_WEBHOOK_SECRET: "i", IMPLEMENTER_LINEAR_TOKEN: "it",
};

describe("loadConfig", () => {
  it("loads test static tokens and defaults", () => {
    const config = loadConfig(base);
    expect(config.bindAddr).toBe("127.0.0.1");
    expect(config.replayWindowMs).toBe(60_000);
    expect(config.apps.planner.staticToken).toBe("pt");
  });
  it("names missing variables", () => {
    expect(() => loadConfig({ ...base, PLANNER_WEBHOOK_SECRET: "" })).toThrow("PLANNER_WEBHOOK_SECRET");
  });
  it("requires client credentials without the test-only token override", () => {
    const env = { ...base }; delete (env as Partial<typeof base>).DAEMON_TEST_MODE;
    expect(() => loadConfig(env)).toThrow("PLANNER_LINEAR_CLIENT_ID");
  });
});
