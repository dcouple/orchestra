import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runBrowserSmoke } from "../ops/browser-smoke.mjs";

const mcpBin = process.env.PLAYWRIGHT_MCP_BIN;
const chromeBin = process.env.PLAYWRIGHT_CHROME_BIN;
const outputDir = process.env.BROWSER_E2E_OUTPUT_DIR;
if (!mcpBin || !chromeBin || !outputDir) throw new Error("browser_prerequisite_missing: PLAYWRIGHT_MCP_BIN, PLAYWRIGHT_CHROME_BIN, and BROWSER_E2E_OUTPUT_DIR are mandatory");

describe("official Playwright MCP browser", () => {
  it("drives isolated concurrent loopback journeys and finalizes current-attempt evidence", async () => {
    const [first, second] = await Promise.all([
      runBrowserSmoke({ mcpBin, chromeBin, outputDir: resolve(outputDir, "concurrent-a") }),
      runBrowserSmoke({ mcpBin, chromeBin, outputDir: resolve(outputDir, "concurrent-b") }),
    ]);
    const third = await runBrowserSmoke({ mcpBin, chromeBin, outputDir: resolve(outputDir, "fresh") });
    for (const result of [first, second, third]) {
      expect(existsSync(result.stateDir)).toBe(false);
      expect(existsSync(result.evidenceDir)).toBe(true);
      expect(result.manifest).toMatchObject({ status: "completed", observedProfile: true, storageWasClean: true });
      expect(result.manifest.artifacts.map(item => item.path)).toEqual(expect.arrayContaining([
        expect.stringMatching(/checkpoint\.png$/), expect.stringMatching(/journey\.webm$/),
        expect.stringMatching(/console\.txt$/), expect.stringMatching(/network\.txt$/), expect.stringMatching(/\.trace$/),
      ]));
      expect(JSON.parse(readFileSync(resolve(result.evidenceDir, "evidence-manifest.json"), "utf8"))).toMatchObject({ status: "completed" });
    }
    expect(new Set([first.attempt, second.attempt, third.attempt]).size).toBe(3);
  }, 60_000);

  it("classifies absent MCP and Chrome prerequisites instead of skipping", async () => {
    await expect(runBrowserSmoke({ mcpBin: "/missing/playwright-mcp", chromeBin, outputDir })).rejects.toThrow("mcp_unavailable");
    await expect(runBrowserSmoke({ mcpBin, chromeBin: "/missing/google-chrome", outputDir })).rejects.toThrow("chrome_unavailable");
    await expect(runBrowserSmoke({ mcpBin, chromeBin, outputDir, targetUrl: "http://127.0.0.1:9" })).rejects.toThrow("target_unreachable");
  });
});
