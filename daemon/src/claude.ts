import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type ClaudeEvent =
  | { type: "text"; text: string }
  | { type: "toolUse"; toolUseId: string; name: string; input: unknown }
  | {
      type: "toolResult";
      toolUseId: string;
      outcome: "success" | "error";
    }
  | { type: "linearMcpInit"; status: string }
  | {
      type: "linearMcpToolResult";
      toolUseId: string;
      toolName: string;
      outcome: "success" | "error";
    }
  | { type: "agentStart"; toolUseId: string; role: string; prompt: string }
  | {
      type: "agentResult";
      toolUseId: string;
      report: string;
      outcome: "success" | "error";
    };

export interface RunTurnOptions {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  argv: string[];
  permissionMode: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  mcpConfigJson: string;
  toolHook?: {
    dbPath: string;
    turnId: number;
    operationsCliPath?: string;
  };
  env?: NodeJS.ProcessEnv;
  trustedEnv?: Record<string, string>;
  onEvent?: (event: ClaudeEvent) => void | Promise<void>;
  onSessionId?: (id: string) => void | Promise<void>;
  signal?: AbortSignal;
}

interface CommandHook {
  type: "command";
  command: string;
  args: string[];
  timeout: number;
}

export function buildToolHookSettings(
  dbPath: string,
  turnId: number,
  operationsCliPath = fileURLToPath(
    new URL("./operations-cli.js", import.meta.url),
  ),
): Record<string, unknown> {
  if (!Number.isSafeInteger(turnId) || turnId <= 0)
    throw new Error("tool hook turn id must be a positive integer");
  if (!dbPath || !operationsCliPath)
    throw new Error("tool hook paths must not be empty");
  const hook = (command: "tool-hook-open" | "tool-hook-complete"): CommandHook => ({
    type: "command",
    command: process.execPath,
    args: [operationsCliPath, command, dbPath, String(turnId)],
    timeout: 10,
  });
  return {
    hooks: {
      PreToolUse: [{ hooks: [hook("tool-hook-open")] }],
      PostToolUse: [{ hooks: [hook("tool-hook-complete")] }],
      PostToolUseFailure: [{ hooks: [hook("tool-hook-complete")] }],
    },
  };
}
export interface TurnUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheCreationTokens: number | undefined;
  cacheReadTokens: number | undefined;
  costUsd: number | undefined;
  model: string | undefined;
}
export interface RunTurnResult {
  ok: boolean;
  sessionId?: string;
  resultText?: string;
  isError: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  permissionDenials: unknown[];
  sawResult: boolean;
  stderrTail?: string;
  capacityEvidence: string[];
  processGroupTerminationAttempted?: boolean;
  processGroupExited?: boolean;
  usage?: TurnUsage;
  modelUsage?: Record<string, unknown>;
  linearMcpInitialized?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function linearMcpInitStatus(event: Record<string, unknown>): string | undefined {
  const servers = event.mcp_servers;
  let rawStatus: unknown;
  if (Array.isArray(servers)) {
    const linear = servers
      .map(record)
      .find((server) => server?.name === "linear");
    rawStatus = linear?.status;
  } else {
    const linear = record(servers)?.linear;
    rawStatus = typeof linear === "string" ? linear : record(linear)?.status;
  }
  if (typeof rawStatus !== "string") return undefined;
  const status = rawStatus.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return status ? status.slice(0, 64) : "unknown";
}

const OTEL_CHILD_ENV_KEYS: ReadonlySet<string> = new Set([
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SERVICE_NAME",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES",
]);

const DAEMON_OWNED_CHILD_ENV_KEYS: ReadonlySet<string> = new Set([
  "CLIPROXY_API_KEY",
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_TIMEOUT_MS",
  "LINEAR_API_KEY",
  "ARTIFACT_HOST_TOKEN",
]);

function isDeniedChildSecret(key: string): boolean {
  return (
    key === "CLIPROXY_MANAGEMENT_KEY" ||
    key === "ARTIFACT_TOKEN" ||
    key.endsWith("_WEBHOOK_SECRET") ||
    key.endsWith("_LINEAR_CLIENT_SECRET") ||
    key.endsWith("_LINEAR_TOKEN") ||
    key.startsWith("OAUTH_") ||
    key.endsWith("_OAUTH_TOKEN")
  );
}

function childEnv(
  extra: NodeJS.ProcessEnv | undefined,
  trusted: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  const include = (
    key: string,
    value: string | undefined,
    extraOnly = false,
  ): void => {
    if (value === undefined) return;
    if (
      key === "PATH" ||
      key === "HOME" ||
      key === "USER" ||
      key === "LOGNAME" ||
      key === "TMPDIR" ||
      key === "TEMP" ||
      key === "TMP" ||
      key === "LANG" ||
      key.startsWith("LC_") ||
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("CLAUDE_") ||
      key === "CLIPROXY_API_KEY" ||
      key === "BASH_DEFAULT_TIMEOUT_MS" ||
      key === "BASH_MAX_TIMEOUT_MS" ||
      key === "LINEAR_API_KEY" ||
      key === "GH_TOKEN" ||
      key === "GITHUB_TOKEN" ||
      key.startsWith("ORCHESTRA_BROWSER_") ||
      (extraOnly && OTEL_CHILD_ENV_KEYS.has(key)) ||
      (extraOnly &&
        (key === "TRACEPARENT" ||
          key === "ORCHESTRA_DISPATCH_OWNER" ||
          key === "ARTIFACT_HOST_TOKEN" ||
          key === "ORCHESTRA_OTEL_RELAY_ENDPOINT"))
    ) {
      allowed[key] = value;
    }
  };
  for (const [key, value] of Object.entries(process.env)) include(key, value);
  for (const [key, value] of Object.entries(extra ?? {}))
    include(key, value, true);
  for (const [key, value] of Object.entries(trusted ?? {}))
    if (
      !DAEMON_OWNED_CHILD_ENV_KEYS.has(key) &&
      !key.startsWith("OTEL_") &&
      key !== "TRACEPARENT" &&
      key !== "ORCHESTRA_OTEL_RELAY_ENDPOINT"
    )
      allowed[key] = value;
  for (const key of Object.keys(allowed))
    if (isDeniedChildSecret(key)) delete allowed[key];
  return allowed;
}

function collectCapacityEvidence(
  event: Record<string, unknown>,
  evidence: Set<string>,
): void {
  if (event.type === "rate_limit_event") {
    const info = record(event.rate_limit_info);
    const rejected =
      info?.status === "rejected" || info?.overageStatus === "rejected";
    const disabled =
      typeof info?.overageDisabledReason === "string" &&
      !!info.overageDisabledReason;
    const status429 =
      event.apiErrorStatus === 429 || info?.apiErrorStatus === 429;
    if (rejected || disabled || status429) {
      const cause = rejected
        ? "rejected"
        : disabled
          ? info?.overageDisabledReason === "out_of_credits"
            ? "out_of_credits"
            : "overage_disabled"
          : "429";
      evidence.add(`rate_limit_event:${cause}`);
    }
  }
  if (event.type === "system" && event.subtype === "api_retry") {
    const error = typeof event.error === "string" ? event.error : undefined;
    const status = event.error_status;
    if (
      ["rate_limit", "overloaded", "billing_error"].includes(error ?? "") ||
      status === 429 ||
      status === 529
    )
      evidence.add(`api_retry:${error ?? status}`);
  }
  if (event.type === "result") {
    if (event.error_status === 429) evidence.add("result:429");
    if (Array.isArray(event.errors))
      for (const raw of event.errors) {
        const type = record(raw)?.type;
        if (type === "rate_limit_error" || type === "overloaded_error")
          evidence.add(`result:${type}`);
      }
  }
  if (event.type === "assistant" && event.error === "rate_limit")
    evidence.add("assistant:rate_limit");
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
  const settingsPath = join(configDir, "settings.json");
  if (options.toolHook)
    await writeFile(
      settingsPath,
      JSON.stringify(
        buildToolHookSettings(
          options.toolHook.dbPath,
          options.toolHook.turnId,
          options.toolHook.operationsCliPath,
        ),
      ),
      { mode: 0o600 },
    );
  const args = [
    ...prefix,
    "-p",
    options.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  if (options.toolHook) args.push("--settings", settingsPath);
  args.push(
    "--permission-mode",
    options.permissionMode,
    "--max-turns",
    String(options.maxTurns),
    "--mcp-config",
    configPath,
  );
  if (options.maxBudgetUsd !== undefined)
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  const child = spawn(bin, args, {
    cwd: options.cwd,
    env: childEnv(options.env, options.trustedEnv),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let latestId: string | undefined;
  let resultText: string | undefined;
  let isError = false;
  let sawResult = false;
  let denials: unknown[] = [];
  let spawnError: string | undefined;
  let stderrTail = "";
  const capacityEvidence = new Set<string>();
  let usage: TurnUsage | undefined;
  let modelUsageResult: Record<string, unknown> | undefined;
  let eventQueue = Promise.resolve();
  const toolNames = new Map<string, string>();
  const agentToolUses = new Set<string>();
  let sawLinearMcpInit = false;
  const emit = (event: ClaudeEvent): void => {
    if (options.onEvent)
      eventQueue = eventQueue.then(() => options.onEvent!(event));
  };
  const sessionQueue: Promise<void>[] = [];
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
    collectCapacityEvidence(event, capacityEvidence);
    if (event.type === "system" && event.subtype === "init") {
      const status = linearMcpInitStatus(event);
      if (status) {
        sawLinearMcpInit = true;
        emit({ type: "linearMcpInit", status });
      }
    }
    if (typeof event.session_id === "string" && event.session_id !== latestId) {
      latestId = event.session_id;
      if (options.onSessionId)
        sessionQueue.push(Promise.resolve(options.onSessionId(latestId)));
    }
    if (event.type === "assistant") {
      const message = record(event.message);
      if (Array.isArray(message?.content))
        for (const raw of message.content) {
          const block = record(raw);
          if (!block) continue;
          if (block.type === "text" && typeof block.text === "string")
            emit({ type: "text", text: block.text });
          if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          ) {
            toolNames.set(block.id, block.name);
            emit({
              type: "toolUse",
              toolUseId: block.id,
              name: block.name,
              input: block.input,
            });
            const input = record(block.input);
            if (
              block.name === "Agent" ||
              block.name === "Task"
            ) {
              agentToolUses.add(block.id);
              emit({
                type: "agentStart",
                toolUseId: block.id,
                role:
                  typeof input?.subagent_type === "string"
                    ? input.subagent_type
                    : "agent",
                prompt: typeof input?.prompt === "string" ? input.prompt : "",
              });
            }
          }
        }
    }
    if (event.type === "user") {
      const message = record(event.message);
      if (Array.isArray(message?.content))
        for (const raw of message.content) {
          const block = record(raw);
          if (
            block?.type !== "tool_result" ||
            typeof block.tool_use_id !== "string"
          )
            continue;
          const outcome = block.is_error === true ? "error" : "success";
          emit({
            type: "toolResult",
            toolUseId: block.tool_use_id,
            outcome,
          });
          const toolName = toolNames.get(block.tool_use_id);
          if (toolName?.startsWith("mcp__linear__"))
            emit({
              type: "linearMcpToolResult",
              toolUseId: block.tool_use_id,
              toolName: toolName.slice(0, 120),
              outcome,
            });
          if (!agentToolUses.has(block.tool_use_id)) continue;
          const report =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((item) =>
                      typeof item === "string"
                        ? item
                        : typeof record(item)?.text === "string"
                          ? String(record(item)!.text)
                          : "",
                    )
                    .join("")
                : "";
          emit({
            type: "agentResult",
            toolUseId: block.tool_use_id,
            report,
            outcome,
          });
        }
    }
    if (event.type === "result") {
      sawResult = true;
      isError = event.is_error === true || event.subtype !== "success";
      if (typeof event.result === "string") resultText = event.result;
      if (Array.isArray(event.permission_denials))
        denials = event.permission_denials;
      if (denials.length) isError = true;
      const rawUsage = record(event.usage);
      const modelUsage = record(event.modelUsage);
      if (modelUsage) modelUsageResult = modelUsage;
      const models = modelUsage ? Object.keys(modelUsage) : [];
      const parsedUsage: TurnUsage = {
        inputTokens: nonnegativeNumber(rawUsage?.input_tokens)
          ? rawUsage.input_tokens
          : undefined,
        outputTokens: nonnegativeNumber(rawUsage?.output_tokens)
          ? rawUsage.output_tokens
          : undefined,
        cacheCreationTokens: nonnegativeNumber(
          rawUsage?.cache_creation_input_tokens,
        )
          ? rawUsage.cache_creation_input_tokens
          : undefined,
        cacheReadTokens: nonnegativeNumber(rawUsage?.cache_read_input_tokens)
          ? rawUsage.cache_read_input_tokens
          : undefined,
        costUsd: nonnegativeNumber(event.total_cost_usd)
          ? event.total_cost_usd
          : undefined,
        model: models.length ? models.join(",") : undefined,
      };
      if (Object.values(parsedUsage).some((value) => value !== undefined))
        usage = parsedUsage;
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderrTail = appendTail(stderrTail, chunk as Buffer);
  });
  child.once("error", (error) => {
    spawnError = error.message;
  });
  let killTimer: NodeJS.Timeout | undefined;
  let processGroupTerminationAttempted = false;
  const killGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  };
  const groupAlive = (): boolean => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch { return false; }
  };
  const awaitGroupExit = async (deadlineMs: number): Promise<void> => {
    const deadline = Date.now() + deadlineMs;
    while (groupAlive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  };
  const abort = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    processGroupTerminationAttempted = true;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), 5_000);
    killTimer.unref();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const closed = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abort);
    // The stream process may exit before stdio MCP/browser descendants. End and
    // await the detached group before callers remove attempt-scoped state.
    if (groupAlive()) {
      processGroupTerminationAttempted = true;
      killGroup("SIGTERM");
      await awaitGroupExit(1_000);
    }
    if (groupAlive()) {
      processGroupTerminationAttempted = true;
      killGroup("SIGKILL");
      await awaitGroupExit(1_000);
    }
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
      ...(resultText !== undefined ? { resultText } : {}),
      isError,
      exitCode: closed.code,
      signal: closed.signal,
      ...(spawnError ? { spawnError } : {}),
      permissionDenials: denials,
      sawResult,
      ...(stderrTail ? { stderrTail } : {}),
      capacityEvidence: [...capacityEvidence],
      processGroupTerminationAttempted,
      processGroupExited: !groupAlive(),
      ...(usage ? { usage } : {}),
      ...(modelUsageResult ? { modelUsage: modelUsageResult } : {}),
      ...(sawLinearMcpInit ? { linearMcpInitialized: true } : {}),
    };
  } finally {
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abort);
    await rm(configDir, { recursive: true, force: true });
  }
}
