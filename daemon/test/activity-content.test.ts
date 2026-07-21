import { describe, expect, it } from "vitest";
import { toolUseContent } from "../src/sessions.js";

describe("toolUseContent", () => {
  it("maps a description-shaped tool use to Linear action content", () => {
    const content = toolUseContent({ type: "toolUse", name: "Read", input: { description: "ticket" } });

    expect(content).toEqual({ type: "action", action: "Read", parameter: "ticket" });
    expect("body" in content).toBe(false);
  });

  it("uses non-empty fallbacks for empty tool names and inputs", () => {
    const content = toolUseContent({ type: "toolUse", name: " ", input: () => undefined });

    expect(content).toEqual({ type: "action", action: "tool", parameter: "running" });
    expect(content.action.length).toBeGreaterThan(0);
    expect(content.parameter.length).toBeGreaterThan(0);
  });

  it("uses a command as the action parameter", () => {
    expect(toolUseContent({ type: "toolUse", name: "Bash", input: { command: "pnpm test" } }))
      .toEqual({ type: "action", action: "Bash", parameter: "pnpm test" });
  });
});
