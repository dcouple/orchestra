import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  appendTail,
  awaitDetachedExit,
  childEnv,
  type ClaudeEvent,
  type RunTurnResult,
  type TurnUsage,
} from "./claude.js";

/**
 * Runs one turn on the native Codex CLI (`codex exec --json`) and reports it in
 * the same shape as the Claude runner, so the session worker treats both alike.
 * Codex has no permission mode, turn cap, or daemon tool hooks: every turn runs
 * `--dangerously-bypass-approvals-and-sandbox` like the pipeline's dispatches.
 */
export interface CodexTurnOptions {
  cwd: string;
  prompt: string;
  argv: string[];
  model: string;
  resumeSessionId?: string;
  mcpConfigJson: string;
  mcpEnvPassthrough?: readonly string[];
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: ClaudeEvent) => void | Promise<void>;
  onSessionId?: (id: string) => void | Promise<void>;
  signal?: AbortSignal;
}

const CAPACITY_PATTERN =
  /rate.?limit|usage limit|quota|insufficient_quota|overloaded|\b(429|503|529)\b/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  const table = record(value);
  if (table)
    return `{${Object.entries(table)
      .map(([key, entry]) => `${JSON.stringify(key)}=${toml(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * Translate the daemon's Claude-shaped MCP config into `codex -c` overrides.
 * A bearer header whose token is the child's own LINEAR_API_KEY is passed by
 * env-var reference so the secret never appears on the command line.
 */
export function codexMcpOverrides(
  mcpConfigJson: string,
  env: NodeJS.ProcessEnv = {},
): string[] {
  const servers = record(record(JSON.parse(mcpConfigJson))?.mcpServers) ?? {};
  const overrides: string[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const server = record(raw);
    if (!server) continue;
    const key = `mcp_servers.${name}`;
    if (typeof server.url === "string") {
      overrides.push(`${key}.url=${toml(server.url)}`);
      const headers = { ...(record(server.headers) ?? {}) };
      if (
        env.LINEAR_API_KEY &&
        headers.Authorization === `Bearer ${env.LINEAR_API_KEY}`
      ) {
        delete headers.Authorization;
        overrides.push(`${key}.bearer_token_env_var="LINEAR_API_KEY"`);
      }
      if (Object.keys(headers).length)
        overrides.push(`${key}.http_headers=${toml(headers)}`);
    } else if (typeof server.command === "string") {
      overrides.push(`${key}.command=${toml(server.command)}`);
      if (Array.isArray(server.args))
        overrides.push(`${key}.args=${toml(server.args)}`);
      const serverEnv = record(server.env);
      if (serverEnv && Object.keys(serverEnv).length)
        overrides.push(`${key}.env=${toml(serverEnv)}`);
    }
  }
  return overrides.flatMap((override) => ["-c", override]);
}

export function codexArgs(options: CodexTurnOptions): string[] {
  const [, ...prefix] = options.argv;
  const args = [...prefix, "exec"];
  if (options.resumeSessionId) args.push("resume");
  args.push(
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    options.model,
    ...codexMcpOverrides(options.mcpConfigJson, options.env),
  );
  if (options.resumeSessionId) args.push(options.resumeSessionId);
  args.push("--", options.prompt);
  return args;
}

function toolName(item: Record<string, unknown>): string | undefined {
  switch (item.type) {
    case "command_execution":
      return "command_execution";
    case "file_change":
      return "file_change";
    case "web_search":
      return "web_search";
    case "mcp_tool_call":
      return `mcp__${String(item.server ?? "")}__${String(item.tool ?? "")}`;
    default:
      return undefined;
  }
}

function toolOutcome(item: Record<string, unknown>): "success" | "error" {
  if (item.status === "failed" || item.status === "declined") return "error";
  if (typeof item.exit_code === "number" && item.exit_code !== 0)
    return "error";
  if (item.error !== undefined && item.error !== null) return "error";
  return "success";
}

export async function runCodexTurn(
  options: CodexTurnOptions,
): Promise<RunTurnResult> {
  const [bin] = options.argv;
  if (!bin) throw new Error("Codex argv is empty");
  const child = spawn(bin, codexArgs(options), {
    cwd: options.cwd,
    env: childEnv(options.env, undefined, options.mcpEnvPassthrough),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let latestId: string | undefined;
  let lastAssistantText: string | undefined;
  let isError = false;
  let sawResult = false;
  let spawnError: string | undefined;
  let stderrTail = "";
  const capacityEvidence = new Set<string>();
  let usage: TurnUsage | undefined;
  let eventQueue = Promise.resolve();
  const sessionQueue: Promise<void>[] = [];
  const started = new Set<string>();
  const emit = (event: ClaudeEvent): void => {
    if (options.onEvent)
      eventQueue = eventQueue.then(() => options.onEvent!(event));
  };
  const noteFailure = (message: string): void => {
    stderrTail = appendTail(stderrTail, Buffer.from(`${message}\n`));
    if (CAPACITY_PATTERN.test(message))
      capacityEvidence.add(message.slice(0, 200));
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const event = record(value);
    if (!event) return;
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      if (event.thread_id !== latestId) {
        latestId = event.thread_id;
        if (options.onSessionId)
          sessionQueue.push(Promise.resolve(options.onSessionId(latestId)));
      }
      return;
    }
    const item = record(event.item);
    if (item && typeof item.id === "string") {
      if (item.type === "agent_message") {
        if (event.type === "item.completed" && typeof item.text === "string") {
          emit({ type: "text", text: item.text });
          if (item.text.trim()) lastAssistantText = item.text.trim();
        }
        return;
      }
      const name = toolName(item);
      if (!name) return;
      if (!started.has(item.id)) {
        started.add(item.id);
        // Completed-only events can contain private tool output. Forward only
        // request fields to the daemon's externally visible progress stream.
        const input = item.type === "mcp_tool_call"
          ? { server: item.server, tool: item.tool, arguments: item.arguments }
          : item.type === "command_execution"
            ? { command: item.command }
            : item.type === "file_change"
              ? { changes: item.changes }
              : { query: item.query };
        emit({ type: "toolUse", toolUseId: item.id, name, input });
      }
      if (event.type === "item.completed") {
        const outcome = toolOutcome(item);
        emit({ type: "toolResult", toolUseId: item.id, outcome });
        if (item.type === "mcp_tool_call" && item.server === "linear")
          emit({
            type: "linearMcpToolResult",
            toolUseId: item.id,
            toolName: name.slice(0, 120),
            outcome,
          });
      }
      return;
    }
    if (event.type === "turn.completed") {
      sawResult = true;
      const raw = record(event.usage);
      const count = (key: string): number | undefined =>
        typeof raw?.[key] === "number" && (raw[key] as number) >= 0
          ? (raw[key] as number)
          : undefined;
      const totalInput = count("input_tokens");
      const cacheRead = count("cached_input_tokens");
      const cacheWrite = count("cache_write_input_tokens");
      const parsed: TurnUsage = {
        // Codex includes cached tokens in input_tokens; daemon buckets are exclusive.
        inputTokens: totalInput === undefined ? undefined
          : Math.max(0, totalInput - (cacheRead ?? 0) - (cacheWrite ?? 0)),
        outputTokens: count("output_tokens"),
        cacheCreationTokens: cacheWrite,
        cacheReadTokens: cacheRead,
        costUsd: undefined,
        model: options.model,
      };
      if (Object.values(parsed).some((entry) => entry !== undefined))
        usage = parsed;
      return;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      isError = true;
      const error = record(event.error);
      const message =
        typeof error?.message === "string"
          ? error.message
          : typeof event.message === "string"
            ? event.message
            : event.type;
      noteFailure(message);
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderrTail = appendTail(stderrTail, chunk as Buffer);
  });
  child.once("error", (error) => {
    spawnError = error.message;
  });
  const closed = await awaitDetachedExit(child, options.signal);
  await Promise.allSettled(sessionQueue);
  await eventQueue;
  const ok =
    !spawnError &&
    closed.code === 0 &&
    closed.signal === null &&
    sawResult &&
    !isError;
  return {
    ok,
    ...(latestId ? { sessionId: latestId } : {}),
    ...(sawResult && lastAssistantText !== undefined
      ? { resultText: lastAssistantText }
      : {}),
    isError,
    exitCode: closed.code,
    signal: closed.signal,
    ...(spawnError ? { spawnError } : {}),
    permissionDenials: [],
    sawResult,
    ...(stderrTail ? { stderrTail } : {}),
    capacityEvidence: [...capacityEvidence],
    processGroupTerminationAttempted: closed.processGroupTerminationAttempted,
    processGroupExited: closed.processGroupExited,
    ...(usage ? { usage } : {}),
  };
}
