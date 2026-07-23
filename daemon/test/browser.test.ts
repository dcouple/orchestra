import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runBrowserSmoke } from "../ops/browser-smoke.mjs";
import { browserAttemptEnv, cleanupBrowserAttempt, createBrowserAttempt, mergeMcpConfig } from "../src/browser.js";
import { runTurn } from "../src/claude.js";

const mcpBin = process.env.PLAYWRIGHT_MCP_BIN;
const chromeBin = process.env.PLAYWRIGHT_CHROME_BIN;
const outputDir = process.env.BROWSER_E2E_OUTPUT_DIR;
if (!mcpBin || !chromeBin || !outputDir) throw new Error("browser_prerequisite_missing: PLAYWRIGHT_MCP_BIN, PLAYWRIGHT_CHROME_BIN, and BROWSER_E2E_OUTPUT_DIR are mandatory");

async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("timed out waiting for real browser lifecycle state"); await new Promise(resolveDelay => setTimeout(resolveDelay, 25)); }
}
function processAlive(pid: number): boolean {
  try { const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim(); return !!state && !state.startsWith("Z"); }
  catch { return false; }
}
async function lifecycleFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><h1>Lifecycle fixture</h1>"); });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise(resolveClose => server.close(() => resolveClose())) };
}

async function runAbnormalLifecycle(mode: "failure" | "timeout" | "abort") {
  const fixture = await lifecycleFixture();
  const attempt = await createBrowserAttempt({ artifactsDir: resolve(outputDir, "abnormal", mode), browserEnabled: true,
    playwrightMcpBin: mcpBin, playwrightChromeBin: chromeBin }, `${mode}-run`);
  const readyFile = join(attempt.evidenceDir, "lifecycle-ready.json");
  const controller = new AbortController();
  const signal = mode === "timeout" ? AbortSignal.timeout(5_000) : mode === "abort" ? controller.signal : undefined;
  try {
    const promise = runTurn({ cwd: resolve("."), prompt: mode, argv: [process.execPath, resolve("test/fixtures/browser-owner.mjs")],
      permissionMode: "plan", maxTurns: 5, mcpConfigJson: mergeMcpConfig("{}", attempt),
      env: { ...browserAttemptEnv(attempt), ORCHESTRA_BROWSER_LIFECYCLE_MODE: mode, ORCHESTRA_BROWSER_LIFECYCLE_URL: fixture.url },
      ...(signal ? { signal } : {}) });
    if (mode === "abort") { await waitFor(() => existsSync(readyFile)); controller.abort(); }
    const result = await promise;
    const ready = JSON.parse(readFileSync(readyFile, "utf8")) as { driverPid: number; mcpPid: number; processes: Array<{ pid: number; command: string }> };
    await waitFor(() => ready.processes.every(process => !processAlive(process.pid)));
    await cleanupBrowserAttempt(attempt);
    return { attempt, ready, result };
  } finally { await fixture.close(); }
}

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

  it("keeps runtime temporary paths short while storing state beneath the attempt", async () => {
    const attempt = await createBrowserAttempt({ artifactsDir: resolve(outputDir, `long-${"x".repeat(96)}`), browserEnabled: true,
      playwrightMcpBin: mcpBin, playwrightChromeBin: chromeBin }, "long-runtime-run");
    try {
      expect(attempt.stateDir.length).toBeGreaterThan(108);
      expect(attempt.socketAlias.length).toBeLessThan(80);
      expect(readlinkSync(attempt.socketAlias)).toBe(attempt.stateDir);
      expect(attempt.mcpServer.env).toMatchObject({
        TMPDIR: attempt.socketAlias, TEMP: attempt.socketAlias, TMP: attempt.socketAlias,
        PWTEST_SOCKETS_DIR: attempt.socketAlias,
      });
    } finally { await cleanupBrowserAttempt(attempt); }
  });

  it("launches Chrome when the evidence root exceeds the socket path limit", async () => {
    const result = await runBrowserSmoke({ mcpBin, chromeBin, outputDir: resolve(outputDir, `long-${"y".repeat(96)}`) });
    expect(result.stateDir.length).toBeGreaterThan(108);
    expect(existsSync(result.stateDir)).toBe(false);
    expect(result.manifest).toMatchObject({ status: "completed", observedProfile: true, storageWasClean: true });
  }, 30_000);

  it("classifies absent MCP and Chrome prerequisites instead of skipping", async () => {
    await expect(runBrowserSmoke({ mcpBin: "/missing/playwright-mcp", chromeBin, outputDir })).rejects.toThrow("mcp_unavailable");
    await expect(runBrowserSmoke({ mcpBin, chromeBin: "/missing/google-chrome", outputDir })).rejects.toThrow("chrome_unavailable");
    await expect(runBrowserSmoke({ mcpBin, chromeBin, outputDir, targetUrl: "http://127.0.0.1:9" })).rejects.toThrow("target_unreachable");
  });

  it.each(["failure", "timeout", "abort"] as const)("kills real MCP/Chrome descendants and retains evidence after %s", async mode => {
    const { attempt, ready, result } = await runAbnormalLifecycle(mode);
    expect(ready.processes.some(process => process.pid === ready.mcpPid && /@playwright[+/]mcp|playwright-mcp/.test(process.command))).toBe(true);
    expect(ready.processes.some(process => /Google Chrome|google-chrome/.test(process.command))).toBe(true);
    expect(result).toMatchObject({ ok: false, processGroupTerminationAttempted: true, processGroupExited: true });
    if (mode === "failure") expect(result).toMatchObject({ exitCode: 17, sawResult: true });
    else expect(result.signal).toBe("SIGTERM");
    expect(existsSync(attempt.stateDir)).toBe(false);
    expect(existsSync(attempt.evidenceDir)).toBe(true);
    expect(readFileSync(join(attempt.evidenceDir, "lifecycle-retained.txt"), "utf8")).toContain("real MCP and Chrome started");
  }, 30_000);
});
