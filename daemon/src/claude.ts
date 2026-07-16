import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type ClaudeEvent =
  | { type: "text"; text: string }
  | { type: "toolUse"; name: string; input: unknown };

export interface RunTurnOptions {
  cwd: string; prompt: string; resumeSessionId?: string; argv: string[]; permissionMode: string;
  maxTurns: number; maxBudgetUsd?: number; mcpConfigJson: string; env?: NodeJS.ProcessEnv;
  onEvent?: (event: ClaudeEvent) => void | Promise<void>;
  onSessionId?: (id: string) => void | Promise<void>;
  signal?: AbortSignal;
}
export interface RunTurnResult {
  ok: boolean; sessionId?: string; resultText?: string; isError: boolean; exitCode: number | null;
  signal: NodeJS.Signals | null; spawnError?: string; permissionDenials: unknown[]; sawResult: boolean;
  stderrTail?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function childEnv(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  const include = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    if (key === "PATH" || key === "HOME" || key === "USER" || key === "LOGNAME" || key === "TMPDIR" || key === "TEMP" || key === "TMP" || key === "LANG"
      || key.startsWith("LC_") || key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_") || key === "LINEAR_API_KEY"
      || key === "GH_TOKEN" || key === "GITHUB_TOKEN") {
      allowed[key] = value;
    }
  };
  for (const [key, value] of Object.entries(process.env)) include(key, value);
  for (const [key, value] of Object.entries(extra ?? {})) include(key, value);
  return allowed;
}

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > 8192 ? next.slice(next.length - 8192) : next;
}

export async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const [bin, ...prefix] = options.argv;
  if (!bin) throw new Error("Claude argv is empty");
  const configDir = await mkdtemp(join(tmpdir(), "linear-claude-mcp-"));
  const configPath = join(configDir, "mcp-config.json");
  await writeFile(configPath, options.mcpConfigJson, { mode: 0o600 });
  const args = [...prefix, "-p", options.prompt, "--output-format", "stream-json", "--verbose"];
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  args.push("--permission-mode", options.permissionMode, "--max-turns", String(options.maxTurns), "--mcp-config", configPath);
  if (options.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(options.maxBudgetUsd));
  const child = spawn(bin, args, { cwd: options.cwd, env: childEnv(options.env), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let latestId: string | undefined;
  let resultText: string | undefined;
  let isError = false;
  let sawResult = false;
  let denials: unknown[] = [];
  let spawnError: string | undefined;
  let stderrTail = "";
  const pending: Promise<void>[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    const event = record(value); if (!event) return;
    if (typeof event.session_id === "string" && event.session_id !== latestId) {
      latestId = event.session_id;
      if (options.onSessionId) pending.push(Promise.resolve(options.onSessionId(latestId)));
    }
    if (event.type === "assistant") {
      const message = record(event.message);
      if (Array.isArray(message?.content)) for (const raw of message.content) {
        const block = record(raw); if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && options.onEvent)
          pending.push(Promise.resolve(options.onEvent({ type: "text", text: block.text })));
        if (block.type === "tool_use" && typeof block.name === "string" && options.onEvent)
          pending.push(Promise.resolve(options.onEvent({ type: "toolUse", name: block.name, input: block.input })));
      }
    }
    if (event.type === "result") {
      sawResult = true;
      isError = event.is_error === true || event.subtype !== "success";
      if (typeof event.result === "string") resultText = event.result;
      if (Array.isArray(event.permission_denials)) denials = event.permission_denials;
      if (denials.length) isError = true;
    }
  });
  child.stderr?.on("data", chunk => { stderrTail = appendTail(stderrTail, chunk as Buffer); });
  child.once("error", error => { spawnError = error.message; });
  let killTimer: NodeJS.Timeout | undefined;
  const killGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  };
  const abort = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), 5_000); killTimer.unref();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abort);
    await Promise.allSettled(pending);
    const ok = !spawnError && closed.code === 0 && closed.signal === null && sawResult && !isError;
    return {
      ok, ...(latestId ? { sessionId: latestId } : {}), ...(resultText !== undefined ? { resultText } : {}), isError,
      exitCode: closed.code, signal: closed.signal, ...(spawnError ? { spawnError } : {}), permissionDenials: denials, sawResult,
      ...(stderrTail ? { stderrTail } : {}),
    };
  } finally {
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abort);
    await rm(configDir, { recursive: true, force: true });
  }
}
