import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeEvent } from "../src/claude.js";
import { codexArgs, codexMcpOverrides, runCodexTurn } from "../src/codex.js";

const dirs: string[] = [];
afterEach(() => {
  delete process.env.CODEX_FAKE_MODE;
  delete process.env.CODEX_FAKE_ARGS_FILE;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const fixture = resolve("test/fixtures/fake-codex.mjs");
function cwd(): string {
  const value = mkdtempSync(join(tmpdir(), "codex-runner-"));
  dirs.push(value);
  return value;
}
const linearMcp = JSON.stringify({
  mcpServers: {
    linear: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer linear-key" },
    },
  },
});
function options(overrides: Record<string, unknown> = {}) {
  return {
    cwd: cwd(),
    prompt: "$astra-ticket ENG-42",
    argv: [process.execPath, fixture],
    model: "gpt-6-astra",
    mcpConfigJson: linearMcp,
    env: { LINEAR_API_KEY: "linear-key" },
    ...overrides,
  };
}

describe("codex runner", () => {
  it("builds a bypassed exec command with MCP overrides and secrets by env reference", () => {
    expect(codexArgs(options({ argv: ["codex", "--profile", "x"] }))).toEqual([
      "--profile", "x", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox",
      "--model", "gpt-6-astra",
      "-c", 'mcp_servers.linear.url="https://mcp.linear.app/mcp"',
      "-c", 'mcp_servers.linear.bearer_token_env_var="LINEAR_API_KEY"',
      "$astra-ticket ENG-42",
    ]);
    expect(codexArgs(options({ argv: ["codex"], resumeSessionId: "thread-9" })))
      .toEqual([
        "exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox",
        "--model", "gpt-6-astra",
        "-c", 'mcp_servers.linear.url="https://mcp.linear.app/mcp"',
        "-c", 'mcp_servers.linear.bearer_token_env_var="LINEAR_API_KEY"',
        "thread-9", "$astra-ticket ENG-42",
      ]);
  });
  it("translates stdio servers and foreign headers into TOML overrides", () => {
    const json = JSON.stringify({
      mcpServers: {
        playwright: { command: "/usr/local/bin/playwright-mcp", args: ["--headless"], env: { HOME: "/tmp/h" } },
        other: { type: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer someone-else" } },
      },
    });
    expect(codexMcpOverrides(json, { LINEAR_API_KEY: "linear-key" })).toEqual([
      "-c", 'mcp_servers.playwright.command="/usr/local/bin/playwright-mcp"',
      "-c", 'mcp_servers.playwright.args=["--headless"]',
      "-c", 'mcp_servers.playwright.env={"HOME"="/tmp/h"}',
      "-c", 'mcp_servers.other.url="https://x.example/mcp"',
      "-c", 'mcp_servers.other.http_headers={"Authorization"="Bearer someone-else"}',
    ]);
  });
  it("reports the thread id, tool lifecycle, Linear MCP outcomes, final text, and usage", async () => {
    const events: ClaudeEvent[] = [];
    const ids: string[] = [];
    const argsFile = join(cwd(), "args.jsonl");
    process.env.CODEX_FAKE_ARGS_FILE = argsFile;
    const result = await runCodexTurn(options({
      onEvent: (event) => { events.push(event); },
      onSessionId: (id) => { ids.push(id); },
      env: { LINEAR_API_KEY: "linear-key", GH_TOKEN: "gh", ARTIFACT_TOKEN: "denied" },
    }));
    expect(result).toMatchObject({
      ok: true, isError: false, sessionId: "codex-thread-1", sawResult: true, exitCode: 0,
      resultText: "Opened https://github.com/dcouple/example/pull/42",
      usage: { inputTokens: 40072, cacheReadTokens: 13824, cacheCreationTokens: 0, outputTokens: 46, model: "gpt-6-astra" },
      processGroupExited: true,
    });
    expect(ids).toEqual(["codex-thread-1"]);
    expect(events).toEqual([
      { type: "text", text: "Reading the ticket." },
      { type: "toolUse", toolUseId: "item_1", name: "command_execution",
        input: { command: "/bin/zsh -lc 'git status'", aggregated_output: "", exit_code: null, status: "in_progress" } },
      { type: "toolResult", toolUseId: "item_1", outcome: "success" },
      { type: "toolUse", toolUseId: "item_2", name: "mcp__linear__get_issue",
        input: { server: "linear", tool: "get_issue", arguments: { id: "private" }, status: "failed", error: { message: "private Linear result" } } },
      { type: "toolResult", toolUseId: "item_2", outcome: "error" },
      { type: "linearMcpToolResult", toolUseId: "item_2", toolName: "mcp__linear__get_issue", outcome: "error" },
      { type: "text", text: "Opened https://github.com/dcouple/example/pull/42" },
    ]);
    const row = JSON.parse(readFileSync(argsFile, "utf8").trim()) as { args: string[]; env: Record<string, string> };
    expect(row.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(row.env).toMatchObject({ LINEAR_API_KEY: "linear-key", GH_TOKEN: "gh" });
    expect(row.env.ARTIFACT_TOKEN).toBeUndefined();
  });
  it("marks a failed turn as an error and keeps capacity evidence", async () => {
    process.env.CODEX_FAKE_MODE = "turn-failed";
    const result = await runCodexTurn(options());
    expect(result).toMatchObject({ ok: false, isError: true, sawResult: false, exitCode: 1 });
    expect(result.capacityEvidence).toEqual(["usage limit reached, rate limit exceeded"]);
    expect(result.stderrTail).toContain("rate limit exceeded");
    expect(result.resultText).toBeUndefined();
  });
  it("surfaces provider failures that happen before a thread starts", async () => {
    process.env.CODEX_FAKE_MODE = "spawn-fail";
    const result = await runCodexTurn(options());
    expect(result).toMatchObject({ ok: false, sawResult: false, exitCode: 3 });
    expect(result.sessionId).toBeUndefined();
    expect(result.stderrTail).toContain("HTTP 429");
  });
  it("ends the process group on abort", async () => {
    process.env.CODEX_FAKE_MODE = "hang";
    const controller = new AbortController();
    const pending = runCodexTurn(options({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.processGroupTerminationAttempted).toBe(true);
    expect(result.processGroupExited).toBe(true);
  });
});
