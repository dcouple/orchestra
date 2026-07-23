import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_TOOLS } from "../ops/browser-smoke.mjs";

describe("browser publication contract", () => {
  it("keeps the verifier allowlist identical to the exercised MCP boundary", () => {
    const verifier = readFileSync(resolve("../claude/agents/frontend-verifier.md"), "utf8");
    const toolsLine = verifier.split("\n").find(line => line.startsWith("tools:"))!;
    for (const tool of REQUIRED_TOOLS) expect(toolsLine).toContain(`mcp__playwright__${tool}`);
    expect(toolsLine).not.toContain("claude-in-chrome");
    expect(toolsLine).not.toContain("browser_run_code_unsafe");
  });

  it("requires completed current-attempt manifests and clean publication", () => {
    const verifier = readFileSync(resolve("../claude/agents/frontend-verifier.md"), "utf8");
    const result = readFileSync(resolve("../references/agents/frontend-verifier/verification-result.md"), "utf8");
    const qa = readFileSync(resolve("../references/qa-verification.md"), "utf8");
    const doSkill = readFileSync(resolve("../claude/skills/do/SKILL.md"), "utf8");
    for (const text of [verifier, result, qa, doSkill]) expect(text).toContain("evidence-manifest.json");
    for (const kind of ["screenshot", "trace", "console", "network", "video"]) expect(`${verifier}\n${result}`).toContain(kind);
    expect(doSkill).toContain("git status --short");
    expect(doSkill).toContain("ORCHESTRA_BROWSER_RELAUNCH_REQUIRED");
    expect(doSkill).toContain("older-attempt");
  });
});
