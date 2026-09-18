import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeEvent } from "../src/claude.js";
import { runAgentFarmTurn } from "../src/agent-farm.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
function options(profile = "implementer", mode = "happy") {
  const cwd = mkdtempSync(join(tmpdir(), "farm-runner-"));
  dirs.push(cwd);
  return {
    cwd, profile, workspace: "bloom-mono", prompt: "--help\nENG-42 🌱 résumé",
    agentFarmBin: resolve("test/fixtures/fake-agent-farm.mjs"), argv: ["unused"],
    permissionMode: "bypassPermissions", maxTurns: 123, maxBudgetUsd: 4.5,
    toolHook: { dbPath: join(cwd, "events.db"), turnId: 42 },
    // This deliberately is not JSON. Agent Farm must not use per-turn MCP input.
    mcpConfigJson: "must not be parsed or written",
    env: { LINEAR_API_KEY: "linear-secret", CLIPROXY_API_KEY: "proxy-secret", GH_TOKEN: "github-secret",
      ARTIFACT_TOKEN: "denied", CODEX_HOME: "/daemon/home",
      ORCHESTRA_BROWSER_FAKE_REPORT: join(cwd, "report.json"),
      ORCHESTRA_BROWSER_FAKE_MODE: mode, ORCHESTRA_BROWSER_FAKE_COLLISION: "daemon" },
  };
}
function json(path: string) { return JSON.parse(readFileSync(path, "utf8")); }

describe("Agent Farm runner", () => {
  it.each(["planner", "implementer"])("spawns the printed %s argv and cwd verbatim, merging all printed env", async profile => {
    const o = options(profile);
    const events: ClaudeEvent[] = [];
    const ids: string[] = [];
    const writes = vi.mocked(writeFile);
    const result = await runAgentFarmTurn({ ...o,
      onEvent: event => { events.push(event); }, onSessionId: id => { ids.push(id); } });
    expect(result).toMatchObject({ ok: true, resultText: "farm answer", processGroupExited: true });
    const report = json(o.env.ORCHESTRA_BROWSER_FAKE_REPORT);
    const child = json(o.env.ORCHESTRA_BROWSER_FAKE_REPORT + ".child");
    expect(child.args).toEqual(report.launch.argv.slice(2));
    expect(child.args.slice(0, 2)).toEqual(["native", "wrapper-prefix"]);
    expect(child.args.slice(-2)).toEqual(["--", o.prompt]);
    expect(child.cwd).toBe(realpathSync(report.launch.cwd));
    expect(child.env).toMatchObject({ LINEAR_API_KEY: "linear-secret", CLIPROXY_API_KEY: "proxy-secret",
      GH_TOKEN: "github-secret", CODEX_HOME: report.launch.env.CODEX_HOME,
      AGENT_FARM_NATIVE_CODEX_HOME: "/native/home", PRINTED_ONLY: "kept",
      ORCHESTRA_BROWSER_FAKE_COLLISION: "printed" });
    expect(child.env.ARTIFACT_TOKEN).toBeUndefined();
    expect(report.preparationArgs.slice(0, 8)).toEqual(["run", profile, "--directory", o.cwd,
      "--workspace", "bloom-mono", "--print-launch", "--message=" + o.prompt]);
    expect(writes.mock.calls.some(([path]) => /mcp.*\.json$/.test(String(path)))).toBe(false);
    const files = readdirSync(o.cwd, { recursive: true }).map(String);
    expect(files.some(file => /mcp.*\.json$/.test(file))).toBe(false);
    expect(JSON.stringify(report.launch)).not.toMatch(/linear-secret|proxy-secret|github-secret/);
    expect(events.some(event => event.type === "linearMcpToolResult")).toBe(true);
    if (profile === "planner") {
      expect(result.linearMcpInitialized).toBe(true);
      expect(ids).toEqual(["farm-session"]);
      expect(child.args).toContain("stream-json");
      expect(child.args).toContain("123");
      expect(child.args).toContain("4.5");
      expect(report.settings).toMatchObject({ enableAllProjectMcpServers: true, hooks: { PreToolUse: expect.any(Array), PostToolUse: expect.any(Array) } });
      expect(existsSync(child.args[child.args.indexOf("--settings") + 1])).toBe(false);
    } else {
      expect(ids).toEqual(["farm-thread"]);
      expect(child.args.slice(2, 4)).toEqual(["exec", "--json"]);
      expect(child.args).not.toContain("--model");
      expect(result.usage?.model).toBe("profile-model");
    }
  });
  it.each(["planner", "implementer"])("passes resume flags before the %s message", async profile => {
    const o = options(profile);
    await runAgentFarmTurn({ ...o, resumeSessionId: "previous-thread" });
    const args = json(o.env.ORCHESTRA_BROWSER_FAKE_REPORT + ".child").args;
    if (profile === "planner") expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2))
      .toEqual(["--resume", "previous-thread"]);
    else expect(args.slice(2, -2)).toEqual(["exec", "resume", "--json", "previous-thread"]);
  });
  it.each(["planner", "implementer"])("retains %s capacity events and stderr", async profile => {
    const result = await runAgentFarmTurn(options(profile, "capacity"));
    expect(result.ok).toBe(false);
    expect(result.capacityEvidence.length).toBeGreaterThan(0);
    expect(result.stderrTail).toContain("HTTP 429 from provider, verbatim stderr\n");
  });
  it.each(["changed-harness", "invalid-launch"])("rejects %s without spawning a native child", async mode => {
    const o = options("implementer", mode);
    await expect(runAgentFarmTurn(o)).rejects.toThrow(/Agent Farm/);
    expect(existsSync(o.env.ORCHESTRA_BROWSER_FAKE_REPORT + ".child")).toBe(false);
  });
  it.each(["hang", "prepare-hang"])("owns process cleanup on abort during %s", async mode => {
    const o = options("implementer", mode);
    const controller = new AbortController();
    const pending = runAgentFarmTurn({ ...o, signal: controller.signal });
    const ready = o.env.ORCHESTRA_BROWSER_FAKE_REPORT + (mode === "hang" ? ".child" : ".ready");
    try { await vi.waitFor(() => expect(existsSync(ready)).toBe(true)); }
    finally { controller.abort(); }
    if (mode === "hang") expect(await pending).toMatchObject({ ok: false, processGroupExited: true });
    else await expect(pending).rejects.toThrow();
  });
  it("launches Playwright with isolated attempt evidence and socket paths", () => {
    const o = options();
    const state = join(o.cwd, "state"), evidence = join(o.cwd, "evidence"), socket = join(o.cwd, "socket");
    mkdirSync(state); mkdirSync(evidence); symlinkSync(state, socket);
    const stub = join(o.cwd, "playwright.mjs");
    writeFileSync(stub, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2), env:process.env}));\n', { mode: 0o755 });
    const output = execFileSync("bash", [resolve("ops/agent-farm-browser.sh")], {
      env: { ...process.env, ORCHESTRA_BROWSER_STATE_DIR: state, ORCHESTRA_BROWSER_EVIDENCE_DIR: evidence,
        ORCHESTRA_BROWSER_SOCKET_ALIAS: socket, ORCHESTRA_BROWSER_MCP_BIN: stub,
        ORCHESTRA_BROWSER_CHROME_BIN: "/custom/chrome" }, encoding: "utf8",
    });
    const child = JSON.parse(output);
    expect(child.args).toEqual(["--browser", "chrome", "--executable-path", "/custom/chrome",
      "--headless", "--isolated", "--output-dir", evidence, "--output-mode", "file", "--caps", "devtools"]);
    expect(child.env).toMatchObject({ TMPDIR: socket, TEMP: socket, TMP: socket, PWTEST_SOCKETS_DIR: socket });
  });
});
