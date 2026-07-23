import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { AppName, Config } from "./config.js";
import { runTurn, type ClaudeEvent, type RunTurnResult } from "./claude.js";
import {
  BROWSER_RELAUNCH_SENTINEL,
  browserAttemptEnv,
  browserWasRequested,
  cleanupBrowserAttempt,
  createBrowserAttempt,
  createBrowserRequest,
  mergeMcpConfig,
  removeBrowserRequest,
} from "./browser.js";
import type {
  CodexInvocationInput,
  EventLog,
  ExternalUrlRow,
  StopAckRow,
  TurnActivityRow,
  TurnRow,
} from "./eventlog.js";
import type { LinearGateway, PostResult, ProgressContent } from "./linear.js";
import { buildTurnSpan, mintSpanId, postSpans, traceContext } from "./otel.js";
import type { OtlpRelay, RelayCapability } from "./otel-relay.js";
import {
  readCliproxyApiKey,
  readCliproxyManagementKey,
} from "./proxy-env.js";
import { WorktreeManager } from "./worktrees.js";

interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
export interface SessionWorkerOptions {
  pollMs?: number;
  reconcileMs?: number;
  dispatchScanMs?: number;
  now?: () => number;
  logger?: Logger;
  attachmentTestAllowHttp?: boolean;
  attachmentTimeoutMs?: number;
  onTurnComplete?: () => void;
  relay?: OtlpRelay;
}
export type ShutdownPolicy = "recover" | "hard_restart";

const PROVIDER_COOLDOWN_MS = 10 * 60_000;

export function classifyProviderFailure(
  result: RunTurnResult,
): { state: string; reason: string } | undefined {
  const spawn = result.spawnError ?? "";
  if (/ECONNREFUSED/i.test(spawn))
    return { state: "transport_failure", reason: "spawn_econnrefused" };
  if (/ENOTFOUND/i.test(spawn))
    return { state: "transport_failure", reason: "spawn_enotfound" };
  const stderr = result.stderrTail ?? "";
  if (/connection\s+refused/i.test(stderr))
    return { state: "transport_failure", reason: "connection_refused" };
  const status =
    /(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:\s+code)?[=: ]+)(401|403|5\d\d)\b[^\n]*(?:base\s*URL|proxy|anthropic)/i.exec(
      stderr,
    )?.[1];
  if (status)
    return {
      state: status.startsWith("5") ? "transport_failure" : "auth_failure",
      reason: `http_${status}`,
    };
  return undefined;
}

export function selectSessionProfile(
  log: EventLog,
  config: Config,
  app: AppName,
  now = Date.now(),
): {
  profile: "fable" | "sol";
  runtime: "claude" | "claudex";
  reason: string;
} {
  if (config.apps[app].harness === "claudex")
    return { profile: "sol", runtime: "claudex", reason: "claudex_preferred" };
  if (!config.fableArgv)
    return {
      profile: "sol",
      runtime: "claudex",
      reason: "fable_not_configured",
    };
  const state = log.getProviderState("claude");
  if (!state)
    return {
      profile: "sol",
      runtime: "claudex",
      reason: "claude_state_missing",
    };
  if (state.cooldownUntil !== null && state.cooldownUntil > now)
    return { profile: "sol", runtime: "claudex", reason: "claude_cooldown" };
  if (now - state.updatedAt > config.providerStateStaleMs)
    return { profile: "sol", runtime: "claudex", reason: "claude_state_stale" };
  if (state.status !== "ready")
    return {
      profile: "sol",
      runtime: "claudex",
      reason: state.reason ?? "claude_not_ready",
    };
  return { profile: "fable", runtime: "claude", reason: "claude_ready" };
}

export class ProviderReadinessPoller {
  private timer?: NodeJS.Timeout;
  private probing: Promise<void> | undefined;
  constructor(
    private readonly log: EventLog,
    private readonly config: Config,
    private readonly logger: Logger = console,
    private readonly probeOverride?: () => Promise<unknown>,
  ) {}
  probe(now = Date.now()): Promise<void> {
    this.probing ??= this.performProbe(now).finally(() => {
      this.probing = undefined;
    });
    return this.probing;
  }
  private async performProbe(now: number): Promise<void> {
    const before = this.log.getProviderState("claude");
    let status = "not_ready";
    let reason = "probe_error";
    try {
      const payload = this.probeOverride
        ? await this.probeOverride()
        : await this.fetchAuthFiles();
      const rows = Array.isArray(payload)
        ? payload
        : Array.isArray(object(payload)?.files)
          ? (object(payload)!.files as unknown[])
          : [];
      const claude = rows
        .map(object)
        .filter(
          (row): row is Record<string, unknown> =>
            !!row && row.provider === "claude",
        );
      const eligible = claude.filter((row) => row.disabled === false);
      const failed = claude.filter((row) => row.failed === true).length;
      status = eligible.length > 0 ? "ready" : "not_ready";
      reason =
        eligible.length > 0
          ? `eligible_${eligible.length}_failed_${failed}`
          : `no_eligible_claude_failed_${failed}`;
    } catch (error) {
      reason =
        error instanceof Error && error.message.startsWith("probe_")
          ? error.message
          : "probe_error";
    }
    const activeCooldown =
      before?.cooldownUntil != null && before.cooldownUntil > now;
    if (activeCooldown) {
      status = "cooldown";
      reason = before.reason ?? "provider_cooldown";
    }
    this.log.setProviderState(
      "claude",
      status,
      reason,
      now,
      activeCooldown ? before.cooldownUntil : null,
    );
    const after = this.log.getProviderState("claude")!;
    if (
      !before ||
      before.status !== after.status ||
      before.reason !== after.reason ||
      before.cooldownUntil !== after.cooldownUntil
    )
      this.logger.log(
        jsonLog({
          event: "provider_state_changed",
          provider: "claude",
          status: after.status,
          reason: after.reason,
          cooldownUntil: after.cooldownUntil,
        }),
      );
  }
  private async fetchAuthFiles(): Promise<unknown> {
    const key = await readCliproxyManagementKey(this.config.cliproxyEnvFile);
    const signal = AbortSignal.timeout(
      this.config.providerInitialProbeTimeoutMs,
    );
    const response = await fetch(
      `${this.config.cliproxyUrl}/v0/management/auth-files`,
      {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      },
    ).catch((error) => {
      if (signal.aborted) throw new Error("probe_timeout");
      throw error;
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`probe_http_${response.status}`);
    }
    return response.json();
  }
  start(): void {
    this.timer = setInterval(
      () => void this.probe(),
      this.config.providerProbeIntervalMs,
    );
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

const DISPATCH_OWNER_PATTERN = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function bodyFrom(value: unknown): string | undefined {
  const node = object(value);
  if (!node) return undefined;
  return (
    text(node.body) ?? text(object(node.content)?.body) ?? text(node.prompt)
  );
}
export function toolUseContent(
  event: Extract<ClaudeEvent, { type: "toolUse" }>,
): ProgressContent {
  const input = object(event.input);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(event.input ?? {})?.slice(0, 500);
  } catch {}
  const detail = text(input?.description) ?? text(input?.command) ?? serialized;
  return {
    type: "action",
    action: text(event.name) ?? "tool",
    parameter: detail || "running",
  };
}
function jsonLog(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

class ProgressQueue {
  private queue: Array<{ id: string; content: ProgressContent }> = [];
  private running: Promise<void> | undefined;
  private cancelled = false;
  lastSuccess: number;
  constructor(
    private readonly post: (
      id: string,
      content: ProgressContent,
    ) => Promise<PostResult>,
    private readonly now: () => number,
    private readonly logger: Logger,
  ) {
    this.lastSuccess = now();
  }
  push(content: ProgressContent): void {
    if (this.cancelled) return;
    if (this.queue.length >= 20) this.queue.shift();
    this.queue.push({ id: randomUUID(), content });
    this.running ??= this.drain();
  }
  private async drain(): Promise<void> {
    while (!this.cancelled) {
      const item = this.queue.shift();
      if (!item) break;
      const result = await this.post(item.id, item.content);
      if (result.ok) this.lastSuccess = this.now();
      else
        this.logger.error(
          JSON.stringify({
            event: "session_progress_failed",
            error: result.error,
          }),
        );
    }
    this.running = undefined;
    if (!this.cancelled && this.queue.length) this.running = this.drain();
  }
  async cancelAndWait(): Promise<void> {
    this.cancelled = true;
    this.queue.length = 0;
    await this.running;
  }
}

export class SessionWorker {
  private timer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private dispatchTimer?: NodeJS.Timeout;
  private stopped = false;
  private draining = false;
  private activityDrain: Promise<void> | undefined;
  private dispatchScan: Promise<void> | undefined;
  private readonly active = new Map<
    number,
    {
      promise: Promise<void>;
      controller: AbortController;
      linearSessionId: string;
    }
  >();
  private readonly stopRequested = new Set<number>();
  private readonly shutdownDeferred = new Set<number>();
  private shutdownPolicy: ShutdownPolicy = "recover";
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly worktrees: WorktreeManager;
  private readonly legacyProfileLogged = new Set<string>();
  // A marker may produce at most one degraded log line per daemon process.
  private readonly degradedLogged = new Set<string>();

  constructor(
    private readonly log: EventLog,
    private readonly gateway: LinearGateway,
    private readonly config: Config,
    private readonly options: SessionWorkerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.worktrees = new WorktreeManager(
      config.worktreesRoot,
      config.targetRepoPath!,
    );
  }
  start(): void {
    this.stopped = false;
    for (const disposition of this.log.recoverStaleRunning(this.now()))
      this.logger.log(
        jsonLog({
          event: "restart_turn_disposition",
          turnId: disposition.turnId,
          outcome: disposition.outcome,
          reason: disposition.reason,
          ...(disposition.resumeTurnId !== null
            ? { resumeTurnId: disposition.resumeTurnId }
            : {}),
        }),
      );
    this.timer = setInterval(() => {
      void this.drain();
      void this.triggerActivityDrain();
    }, this.options.pollMs ?? 250);
    this.reconcileTimer = setInterval(
      () => void this.triggerActivityDrain(),
      this.options.reconcileMs ?? 60_000,
    );
    this.dispatchTimer = setInterval(
      () => void this.triggerDispatchScan(),
      this.options.dispatchScanMs ?? 5_000,
    );
    this.timer.unref();
    this.reconcileTimer.unref();
    this.dispatchTimer.unref();
    void this.triggerDispatchScan();
    void this.drain();
    void this.triggerActivityDrain();
  }
  trigger(): void {
    queueMicrotask(() => {
      void this.triggerDispatchScan();
      void this.drain();
    });
  }
  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (
        !this.stopped &&
        this.active.size < this.config.sessionConcurrency
      ) {
        const turn = this.log.claimNextTurn(this.now());
        if (!turn) break;
        const controller = new AbortController();
        const promise = this.process(turn, controller.signal)
          .catch((error) => {
            if (this.stopRequested.has(turn.id)) {
              this.log.markTurnStopped(turn.id, this.now());
              this.logger.log(
                jsonLog({
                  event: "session_turn_stopped",
                  turnId: turn.id,
                  linearSessionId: turn.linearSessionId,
                }),
              );
              return;
            }
            if (this.shutdownDeferred.has(turn.id)) {
              this.logger.log(
                jsonLog({
                  event: "session_turn_deferred",
                  turnId: turn.id,
                  linearSessionId: turn.linearSessionId,
                  reason: "service_shutdown",
                  policy: this.shutdownPolicy,
                }),
              );
              return;
            }
            this.logger.error(
              jsonLog({
                event: "session_turn_unhandled",
                turnId: turn.id,
                linearSessionId: turn.linearSessionId,
                issueId: turn.issueId,
                attempts: turn.attempts,
                error: String(error),
              }),
            );
            const role = turn.app === "implementer" ? "Implementer" : "Planner";
            try {
              this.log.finishTurn(
                turn.id,
                "error",
                `${role} turn failed: ${error instanceof Error ? error.message : String(error)}`,
                this.now(),
              );
            } catch {}
          })
          .finally(() => {
            this.stopRequested.delete(turn.id);
            this.active.delete(turn.id);
            void this.triggerActivityDrain();
            void this.drain();
          });
        this.active.set(turn.id, {
          promise,
          controller,
          linearSessionId: turn.linearSessionId,
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private async process(turn: TurnRow, signal: AbortSignal): Promise<void> {
    const session = this.log.getSession(turn.linearSessionId);
    if (!session) throw new Error(`Missing session ${turn.linearSessionId}`);
    const identifier =
      session.issueIdentifier ?? session.issueId ?? turn.issueId;
    const worktree = await this.worktrees.ensureWorktree(identifier);
    this.log.updateSessionWorktree(
      turn.linearSessionId,
      worktree.path,
      worktree.branch,
      this.now(),
    );
    const implementer = session.mode === "implementer";
    const runtime = session.runtime;
    const resuming = turn.kind === "prompted" && !!session.claudeSessionId;
    const cliproxyApiKey = await readCliproxyApiKey(
      this.config.cliproxyEnvFile,
    );
    let prompt =
      implementer && !resuming
        ? `/do ${identifier}`
        : this.composePrompt(turn, identifier);
    if ((!implementer || resuming) && this.config.attachmentsEnabled)
      prompt += await this.downloadAttachments(turn.rawBody, worktree.path);
    this.log.setTurnPrompt(turn.id, prompt);
    const postProgress = (id: string, content: ProgressContent) =>
      this.gateway.postActivity(
        turn.app,
        turn.linearSessionId,
        id,
        content,
        true,
        this.now() + 10_000,
      );
    const progress = new ProgressQueue(postProgress, this.now, this.logger);
    progress.push({
      type: "thought",
      body: implementer
        ? resuming
          ? "resuming implementation session"
          : "implementation started — running /do"
        : "session started — reading the ticket",
    });
    const keepalive = setInterval(
      () => {
        if (this.now() - progress.lastSuccess >= this.config.keepaliveMs)
          progress.push({
            type: "thought",
            body: implementer
              ? "still working on implementation"
              : "still working on this turn",
          });
      },
      Math.max(10, Math.min(this.config.keepaliveMs, 60_000)),
    );
    keepalive.unref();
    const linearMcpConfigJson = JSON.stringify({
      mcpServers: {
        linear: {
          type: "http",
          url: this.config.linearMcpUrl,
          headers: { Authorization: `Bearer ${this.config.linearApiKey}` },
        },
      },
    });
    const requestFile =
      implementer &&
      !resuming &&
      this.config.browserEnabled &&
      session.browserRequired !== 1
        ? await createBrowserRequest(this.config, turn.linearSessionId)
        : undefined;
    const telemetryConfigured = this.options.relay !== undefined;
    const telemetryEnv: NodeJS.ProcessEnv = {};
    const turnSpanId = telemetryConfigured ? mintSpanId() : undefined;
    let capability: RelayCapability | undefined;
    if (telemetryConfigured) {
      const ownedKeys = new Set([
        "linear.session_id",
        "linear.issue",
        "turn.id",
      ]);
      const baseAttributes = (process.env.OTEL_RESOURCE_ATTRIBUTES ?? "")
        .split(",")
        .flatMap((fragment) => {
          const pair = fragment.trim();
          const separator = pair.indexOf("=");
          if (!pair || separator < 1) return [];
          const key = pair.slice(0, separator).trim();
          if (!key || ownedKeys.has(key)) return [];
          return [`${key}=${pair.slice(separator + 1)}`];
        });
      telemetryEnv.OTEL_RESOURCE_ATTRIBUTES = [
        ...baseAttributes,
        `linear.session_id=${encodeURIComponent(turn.linearSessionId)}`,
        `linear.issue=${encodeURIComponent(identifier)}`,
        `turn.id=${encodeURIComponent(String(turn.id))}`,
      ].join(",");
      const context = traceContext(session.traceId, turnSpanId!);
      telemetryEnv.TRACEPARENT = context.traceparent;
      capability = this.options.relay!.createCapability({
        linearSessionId: turn.linearSessionId,
        traceId: session.traceId,
        turnSpanId: turnSpanId!,
      });
      telemetryEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = capability.endpoint;
      telemetryEnv.ORCHESTRA_OTEL_RELAY_ENDPOINT = capability.endpoint;
      telemetryEnv.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/protobuf";
      telemetryEnv.OTEL_TRACES_EXPORTER = "otlp";
      telemetryEnv.OTEL_METRICS_EXPORTER = "none";
      telemetryEnv.OTEL_LOGS_EXPORTER = "none";
      telemetryEnv.OTEL_BSP_SCHEDULE_DELAY = "1000";
      this.log.setTurnTraceContext(turn.id, session.traceId, turnSpanId!);
    }
    const durableProfile = session.profile ?? "sol";
    if (
      session.profile === null &&
      !this.legacyProfileLogged.has(turn.linearSessionId)
    ) {
      this.legacyProfileLogged.add(turn.linearSessionId);
      this.logger.log(
        jsonLog({
          event: "legacy_session_profile_defaulted",
          linearSessionId: turn.linearSessionId,
          profile: "sol",
        }),
      );
    }
    let linearMcpInitialized = false;
    let linearMcpCloseLogged = false;
    let eventCallbackError: unknown;
    const logLinearMcpClose = (
      classification: "turn_completed" | "runner_failed" | "daemon_shutdown",
    ): void => {
      if (!linearMcpInitialized || linearMcpCloseLogged) return;
      linearMcpCloseLogged = true;
      this.logger.log(
        jsonLog({
          event: "linear_mcp_turn_close",
          turnId: turn.id,
          classification,
        }),
      );
    };
    const common = {
      cwd: worktree.path,
      permissionMode: implementer
        ? this.config.doPermissionMode
        : this.config.claudePermissionMode,
      maxTurns: implementer
        ? this.config.doMaxTurns
        : this.config.claudeMaxTurns,
      ...(implementer && this.config.doMaxBudgetUsd !== undefined
        ? { maxBudgetUsd: this.config.doMaxBudgetUsd }
        : {}),
      mcpConfigJson: linearMcpConfigJson,
      toolHook: {
        dbPath: this.config.dbPath,
        turnId: turn.id,
      },
      env: {
        CLIPROXY_API_KEY: cliproxyApiKey,
        BASH_DEFAULT_TIMEOUT_MS: String(this.config.bashDefaultTimeoutMs),
        BASH_MAX_TIMEOUT_MS: String(this.config.bashMaxTimeoutMs),
        LINEAR_API_KEY: this.config.linearApiKey!,
        GH_TOKEN: process.env.GH_TOKEN,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        ...(DISPATCH_OWNER_PATTERN.test(turn.linearSessionId)
          ? { ORCHESTRA_DISPATCH_OWNER: turn.linearSessionId }
          : {}),
        ...(requestFile ? { ORCHESTRA_BROWSER_REQUEST_FILE: requestFile } : {}),
        ...telemetryEnv,
      },
      signal,
      onEvent: async (event: ClaudeEvent) => {
        try {
          if (event.type === "text")
            progress.push({ type: "thought", body: event.text });
          else if (event.type === "toolUse") {
            this.log.recordTurnToolCallStarted(
              turn.id,
              event.toolUseId,
              event.name,
              this.now(),
            );
            progress.push(toolUseContent(event));
          } else if (event.type === "toolResult") {
            this.log.recordTurnToolCallCompleted(
              turn.id,
              event.toolUseId,
              this.now(),
            );
          } else if (event.type === "linearMcpInit") {
            linearMcpInitialized = true;
            this.logger.log(
              jsonLog({
                event: "linear_mcp_turn_init",
                turnId: turn.id,
                status: event.status,
              }),
            );
          } else if (event.type === "linearMcpToolResult") {
            this.logger.log(
              jsonLog({
                event: "linear_mcp_tool_result",
                turnId: turn.id,
                toolName: event.toolName,
                outcome: event.outcome,
              }),
            );
          } else if (event.type === "agentStart") {
            this.log.claimClaudeInvocation({
              linearSessionId: turn.linearSessionId,
              turnId: turn.id,
              toolUseId: event.toolUseId,
              role: event.role,
              prompt: event.prompt,
              traceId: session.traceId,
              startedAt: this.now(),
            });
            if (capability)
              this.options.relay?.registerAgent(capability, {
                linearSessionId: turn.linearSessionId,
                toolUseId: event.toolUseId,
                role: event.role,
                prompt: event.prompt,
              });
          } else {
            const completedAt = this.now();
            this.log.completeClaudeStream(
              turn.linearSessionId,
              event.toolUseId,
              event.report,
              event.outcome,
              completedAt,
              completedAt + 30_000,
            );
            if (capability) {
              const row = this.log
                .invocations(turn.linearSessionId)
                .find(
                  (item) =>
                    item.sourceKey ===
                    `claude:${turn.linearSessionId}:${event.toolUseId}`,
                );
              this.options.relay?.completeAgent(capability, {
                linearSessionId: turn.linearSessionId,
                toolUseId: event.toolUseId,
                role: row?.role ?? "agent",
                prompt: row?.prompt ?? "",
                report: event.report,
                outcome: event.outcome,
                streamCompletedAt: completedAt,
              });
            }
          }
        } catch (error) {
          eventCallbackError ??= error;
        }
      },
    };
    const runtimeArgv =
      runtime === "claudex"
        ? this.config.claudexArgv!
        : durableProfile === "fable"
          ? this.config.fableArgv
          : this.config.claudeArgv;
    const cleanupRejectedRun = async (error: unknown): Promise<never> => {
      clearInterval(keepalive);
      await progress.cancelAndWait();
      logLinearMcpClose(
        this.shutdownDeferred.has(turn.id)
          ? "daemon_shutdown"
          : "runner_failed",
      );
      throw error;
    };
    let browserRequired = session.browserRequired === 1;
    let browserRunId = session.browserRunId ?? undefined;
    const run = async (
      argv: string[],
      runPrompt = prompt,
      resume = resuming,
      trustedEnv = runtime === "claudex" ? this.config.claudexEnv : undefined,
    ): Promise<RunTurnResult> => {
      const attempt = browserRequired
        ? await createBrowserAttempt(this.config, browserRunId!)
        : undefined;
      const timeout = attempt
        ? AbortSignal.timeout(this.config.browserAttemptTimeoutMs)
        : undefined;
      const runSignal = timeout ? AbortSignal.any([signal, timeout]) : signal;
      if (attempt)
        this.logger.log(
          jsonLog({
            event: "browser_attempt_started",
            linearSessionId: turn.linearSessionId,
            browserRunId,
            browserAttemptId: attempt.attemptId,
            evidenceDir: attempt.evidenceDir,
          }),
        );
      try {
        const currentSessionId = this.log.getSession(
          turn.linearSessionId,
        )?.claudeSessionId;
        const {
          ORCHESTRA_BROWSER_REQUEST_FILE: _requestFile,
          ...postHandshakeEnv
        } = common.env;
        const turnResult = await runTurn({
          ...common,
          mcpConfigJson: attempt
            ? mergeMcpConfig(linearMcpConfigJson, attempt)
            : linearMcpConfigJson,
          env: attempt
            ? { ...postHandshakeEnv, ...browserAttemptEnv(attempt) }
            : common.env,
          signal: runSignal,
          prompt: runPrompt,
          ...(resume && currentSessionId
            ? { resumeSessionId: currentSessionId }
            : {}),
          argv,
          ...(trustedEnv ? { trustedEnv } : {}),
          onSessionId: (id) => {
            this.log.updateClaudeSessionId(
              turn.linearSessionId,
              id,
              this.now(),
            );
          },
        });
        if (eventCallbackError !== undefined) throw eventCallbackError;
        return timeout?.aborted && !signal.aborted
          ? {
              ...turnResult,
              ok: false,
              isError: true,
              spawnError: `browser attempt timed out after ${this.config.browserAttemptTimeoutMs}ms`,
            }
          : turnResult;
      } finally {
        if (attempt) {
          await cleanupBrowserAttempt(attempt);
          this.logger.log(
            jsonLog({
              event: "browser_attempt_finished",
              linearSessionId: turn.linearSessionId,
              browserRunId,
              browserAttemptId: attempt.attemptId,
              stateRemoved: true,
            }),
          );
        }
      }
    };
    let result: RunTurnResult;
    if (!runtimeArgv) {
      const launcher = runtime === "claudex" ? "CLAUDEX_BIN" : "FABLE_BIN";
      this.logger.error(jsonLog({ event: "profile_launcher_unconfigured", linearSessionId: turn.linearSessionId,
        profile: durableProfile, runtime, launcher }));
      result = { ok: false, isError: true, exitCode: null, signal: null,
        spawnError: runtime === "claudex"
          ? "Claudex runtime launcher is not configured; set CLAUDEX_BIN"
          : "Fable profile launcher is not configured; set FABLE_BIN after validating fable-models.env",
        permissionDenials: [], sawResult: false, capacityEvidence: [] };
    } else result = await run(runtimeArgv).catch(cleanupRejectedRun);
    if (
      !requestFile &&
      browserRequired &&
      result.resultText?.trim() === BROWSER_RELAUNCH_SENTINEL
    )
      result = {
        ...result,
        ok: false,
        isError: true,
        spawnError:
          "browser relaunch sentinel repeated after Playwright attachment",
      };
    if (requestFile) {
      const requested = await browserWasRequested(requestFile);
      await removeBrowserRequest(requestFile);
      const sentinel = result.resultText?.trim() === BROWSER_RELAUNCH_SENTINEL;
      if (requested !== sentinel) {
        if (requested || sentinel)
          result = {
            ...result,
            ok: false,
            isError: true,
            spawnError:
              "browser request marker and relaunch sentinel did not agree",
          };
      } else if (requested) {
        if (!result.sessionId)
          result = {
            ...result,
            ok: false,
            isError: true,
            spawnError:
              "browser relaunch requested before a Claude session ID was established",
          };
        else {
          browserRunId = randomUUID();
          if (
            !this.log.requireBrowser(
              turn.linearSessionId,
              browserRunId,
              this.now(),
            )
          )
            result = {
              ...result,
              ok: false,
              isError: true,
              spawnError:
                "browser relaunch sentinel repeated for an already browser-required session",
            };
          else {
            browserRequired = true;
            this.logger.log(
              jsonLog({
                event: "browser_relaunch_required",
                linearSessionId: turn.linearSessionId,
                browserRunId,
              }),
            );
            result = await run(
              runtimeArgv!,
              `Resume /do ${identifier} after browser capability attachment.`,
              true,
            ).catch(cleanupRejectedRun);
            if (result.resultText?.trim() === BROWSER_RELAUNCH_SENTINEL)
              result = {
                ...result,
                ok: false,
                isError: true,
                spawnError:
                  "browser relaunch sentinel repeated after Playwright attachment",
              };
          }
        }
      }
    }
    if (
      this.shutdownDeferred.has(turn.id) &&
      !this.stopRequested.has(turn.id)
    ) {
      clearInterval(keepalive);
      await progress.cancelAndWait();
      logLinearMcpClose("daemon_shutdown");
      this.logger.log(
        jsonLog({
          event: "session_turn_deferred",
          turnId: turn.id,
          linearSessionId: turn.linearSessionId,
          reason: "service_shutdown",
          policy: this.shutdownPolicy,
        }),
      );
      return;
    }
    const recordProviderFailure = (
      profile: "fable" | "sol",
      provider: "claude" | "codex",
      classified: { state: string; reason: string },
    ): number => {
      const cooldownUntil = this.now() + PROVIDER_COOLDOWN_MS;
      this.log.setProviderCooldown(
        provider,
        cooldownUntil,
        classified.reason,
        this.now(),
      );
      this.logger.log(
        jsonLog({
          event: "provider_state_changed",
          provider,
          status: "cooldown",
          reason: classified.reason,
          cooldownUntil,
        }),
      );
      this.logger.error(
        jsonLog({
          event: "provider_failure_classified",
          linearSessionId: turn.linearSessionId,
          profile,
          provider,
          classifiedState: classified.state,
          reason: classified.reason,
          cooldownUntil,
        }),
      );
      return cooldownUntil;
    };
    if (!result.ok) {
      const classified = classifyProviderFailure(result);
      if (classified) {
        const provider =
          runtime === "claudex"
            ? "codex"
            : durableProfile === "fable"
              ? "claude"
              : "codex";
        recordProviderFailure(durableProfile, provider, classified);
      }
      if (result.capacityEvidence.length) {
        const provider = runtime === "claudex" ? "codex" : "claude";
        recordProviderFailure(durableProfile, provider, {
          state: "capacity_failure",
          reason: result.capacityEvidence.join(","),
        });
      }
    }
    clearInterval(keepalive);
    const finishedAt = this.now();
    if (this.stopRequested.has(turn.id)) {
      logLinearMcpClose("runner_failed");
      this.log.markTurnStopped(turn.id, finishedAt);
      this.logger.log(
        jsonLog({
          event: "session_turn_stopped",
          turnId: turn.id,
          linearSessionId: turn.linearSessionId,
        }),
      );
      await progress.cancelAndWait();
      this.log.touchSession(turn.linearSessionId, this.now());
      this.log.clearTurnProgressBarrier(turn.id);
      return;
    }
    logLinearMcpClose(result.ok ? "turn_completed" : "runner_failed");
    if (implementer && result.resultText) {
      const url = this.extractPullRequestUrl(result.resultText);
      if (url)
        this.log.stageExternalUrl(
          turn.linearSessionId,
          turn.app,
          "Pull Request",
          url,
          finishedAt,
        );
      else
        this.logger.log(
          jsonLog({
            event: "implementer_pr_url_not_found",
            turnId: turn.id,
            linearSessionId: turn.linearSessionId,
          }),
        );
    }
    const usageLog = result.usage
      ? {
          ...(result.usage.inputTokens !== undefined
            ? { inputTokens: result.usage.inputTokens }
            : {}),
          ...(result.usage.outputTokens !== undefined
            ? { outputTokens: result.usage.outputTokens }
            : {}),
          ...(result.usage.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: result.usage.cacheCreationTokens }
            : {}),
          ...(result.usage.cacheReadTokens !== undefined
            ? { cacheReadTokens: result.usage.cacheReadTokens }
            : {}),
          ...(result.usage.costUsd !== undefined
            ? { costUsd: result.usage.costUsd }
            : {}),
          ...(result.usage.model !== undefined
            ? { model: result.usage.model }
            : {}),
        }
      : {};
    const postTelemetry = (
      status: "response" | "error",
      response: string,
    ): void => {
      if (!turnSpanId) return;
      const usage = result.usage;
      const span = buildTurnSpan({
        traceId: session.traceId,
        rootSpanId: session.rootSpanId,
        turnSpanId,
        linearSessionId: turn.linearSessionId,
        issue: identifier,
        turnId: turn.id,
        prompt,
        response,
        runtime,
        profile: durableProfile,
        ...(usage?.model ? { model: usage.model } : {}),
        status,
        startedAt: turn.startedAt ?? turn.receivedAt,
        finishedAt,
        ...(usage?.inputTokens !== undefined
          ? { inputTokens: usage.inputTokens }
          : {}),
        ...(usage?.outputTokens !== undefined
          ? { outputTokens: usage.outputTokens }
          : {}),
        ...(usage?.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: usage.cacheCreationTokens }
          : {}),
        ...(usage?.cacheReadTokens !== undefined
          ? { cacheReadTokens: usage.cacheReadTokens }
          : {}),
      });
      void postSpans([span])
        .then((postResult) => {
          if (!postResult.ok)
            this.logger.error(
              jsonLog({
                event: "telemetry_span_post_failed",
                turnId: turn.id,
                error: postResult.error,
              }),
            );
        })
        .catch((error) =>
          this.logger.error(
            jsonLog({
              event: "telemetry_span_post_failed",
              turnId: turn.id,
              error: error instanceof Error ? error.name : "post_error",
            }),
          ),
        );
    };
    if (result.ok) {
      this.log.finishTurn(
        turn.id,
        "response",
        result.resultText || "Turn completed.",
        finishedAt,
        randomUUID(),
        true,
        result.usage,
      );
      postTelemetry("response", result.resultText || "Turn completed.");
      this.logger.log(
        jsonLog({
          event: "session_turn_completed",
          turnId: turn.id,
          issueIdentifier: identifier,
          linearSessionId: turn.linearSessionId,
          attempts: turn.attempts,
          durationMs: Math.max(
            0,
            finishedAt - (turn.startedAt ?? turn.receivedAt),
          ),
          ...usageLog,
        }),
      );
    } else {
      const failedRuntime = runtime === "claudex" ? "Claudex" : "Claude";
      const runtimeDetail =
        result.spawnError ??
        (result.permissionDenials.length
          ? `${failedRuntime} permission was denied`
          : result.signal
            ? `${failedRuntime} exited on ${result.signal}`
            : !result.sawResult
              ? `${failedRuntime} exited without a result`
              : `${failedRuntime} exited with code ${result.exitCode}`);
      const detail = result.capacityEvidence.length
        ? `${failedRuntime} capacity failure (${result.capacityEvidence.join(", ")})`
        : runtimeDetail;
      this.log.finishTurn(
        turn.id,
        "error",
        `${implementer ? "Implementer" : "Planner"} turn failed: ${detail}`,
        finishedAt,
        randomUUID(),
        true,
        result.usage,
      );
      postTelemetry(
        "error",
        `${implementer ? "Implementer" : "Planner"} turn failed: ${detail}`,
      );
      this.logger.error(
        jsonLog({
          event: "session_turn_failed",
          turnId: turn.id,
          issueIdentifier: identifier,
          linearSessionId: turn.linearSessionId,
          attempts: turn.attempts,
          durationMs: Math.max(
            0,
            finishedAt - (turn.startedAt ?? turn.receivedAt),
          ),
          error: detail,
          ...(result.stderrTail ? { stderrTail: result.stderrTail } : {}),
          ...usageLog,
        }),
      );
    }
    await progress.cancelAndWait();
    this.log.touchSession(turn.linearSessionId, this.now());
    this.log.clearTurnProgressBarrier(turn.id);
  }

  private extractPullRequestUrl(value: string): string | undefined {
    return /https:\/\/(?:github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+|gitlab\.com\/[^\s]+\/-\/merge_requests\/\d+|[^\s/]+\/[^\s]+\/(?:pull|merge_requests?)\/\d+)/i
      .exec(value)?.[0]
      ?.replace(/[),.;]+$/, "");
  }

  private composePrompt(turn: TurnRow, identifier: string): string {
    let payload: Record<string, unknown> = {};
    try {
      payload = object(JSON.parse(turn.rawBody.toString("utf8"))) ?? {};
    } catch {}
    const session = object(payload.agentSession);
    if (turn.kind === "created") {
      const context =
        text(payload.promptContext) ??
        text(session?.promptContext) ??
        bodyFrom(payload.agentActivity);
      return `You are bloom-planner, a planning/discussion agent on Linear issue ${identifier}. Discuss, research, and converge; when the user asks for a plan/spec, use this repo's existing skills (/create-feature, /create-epic, /create-issue). Read the ticket via the Linear MCP tools if context is missing.\n\n${context ?? "Read the Linear ticket and begin the planning discussion."}`;
    }
    const activity =
      bodyFrom(payload.agentActivity) ?? bodyFrom(session?.agentActivity);
    const comments = Array.isArray(payload.previousComments)
      ? payload.previousComments.map(bodyFrom).filter(Boolean)
      : [];
    return (
      activity ??
      comments.at(-1) ??
      "Continue the planning discussion using the latest Linear context."
    );
  }

  private triggerDispatchScan(): Promise<void> {
    if (this.dispatchScan) return this.dispatchScan;
    this.dispatchScan = this.scanDispatchMarkers().finally(() => {
      this.dispatchScan = undefined;
    });
    return this.dispatchScan;
  }
  ingestDispatches(): Promise<void> {
    return this.triggerDispatchScan();
  }
  private async availableQuarantinePath(
    directory: string,
    name: string,
  ): Promise<string> {
    for (let suffix = 0; ; suffix++) {
      const candidate = resolve(
        directory,
        suffix === 0 ? name : `${name}.${suffix}`,
      );
      try {
        await lstat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
        throw error;
      }
    }
  }
  private async moveDispatchFile(
    source: string,
    destination: string,
  ): Promise<void> {
    try {
      await rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      await unlink(source);
    }
  }
  private async quarantineDispatchBundle(
    directory: string,
    linearSessionId: string,
    base: string,
    doneFile: string,
  ): Promise<string> {
    const destinationDirectory = resolve(
      this.config.dispatchQuarantineDir,
      linearSessionId,
    );
    await mkdir(destinationDirectory, { recursive: true });
    const names = (await readdir(directory))
      .filter((name) => name.startsWith(`${base}.`))
      .sort((a, b) => {
        if (a === doneFile) return 1;
        if (b === doneFile) return -1;
        return a.localeCompare(b);
      });
    for (const name of names) {
      const destination = await this.availableQuarantinePath(
        destinationDirectory,
        name,
      );
      await this.moveDispatchFile(
        resolve(directory, name),
        destination,
      );
    }
    return destinationDirectory;
  }
  private async scanDispatchMarkers(): Promise<void> {
    if (this.stopped) return;
    try {
      // Dispatch scanning only visits sessions with durable worktrees, so it cannot assign a profile.
      for (const session of this.log.sessionsWithWorktrees()) {
        if (
          !session.worktreePath ||
          this.log.hasOpenTurn(session.linearSessionId)
        )
          continue;
        if (!DISPATCH_OWNER_PATTERN.test(session.linearSessionId)) {
          this.logger.error(
            jsonLog({
              event: "dispatch_scan_failed",
              linearSessionId: session.linearSessionId,
              reason: "invalid dispatch owner",
            }),
          );
          continue;
        }
        const directory = resolve(
          session.worktreePath,
          ".codex-dispatches",
          session.linearSessionId,
        );
        try {
          const files = (await readdir(directory))
            .filter((file) => file.endsWith(".done"))
            .sort();
          const markers: Array<{
            file: string;
            base: string;
            sidecar: Record<string, unknown> | undefined;
            prompt: string;
            report: string;
            done: string;
            logText: string;
          }> = [];
          const bounded = async (path: string, limit: number) => {
            const bytes = await readFile(path).catch(() => Buffer.alloc(0));
            return bytes.subarray(0, limit).toString("utf8");
          };
          for (const file of files) {
            const base = file.slice(0, -5);
            let sidecar: Record<string, unknown> | undefined;
            try {
              sidecar = object(
                JSON.parse(
                  await bounded(
                    resolve(directory, `${base}.otel.json`),
                    64 * 1024,
                  ),
                ),
              );
            } catch {}
            markers.push({
              file,
              base,
              sidecar,
              prompt: await bounded(
                resolve(directory, `${base}.prompt`),
                1024 * 1024,
              ),
              report: await bounded(
                resolve(directory, `${base}.md`),
                1024 * 1024,
              ),
              done: await bounded(resolve(directory, file), 4096),
              logText: await bounded(
                resolve(directory, `${base}.log`),
                1024 * 1024,
              ),
            });
          }
          markers.sort((a, b) => {
            const ak = text(a.sidecar?.provider_session_id) ?? a.file,
              bk = text(b.sidecar?.provider_session_id) ?? b.file;
            return (
              ak.localeCompare(bk) ||
              (Number(a.sidecar?.started_at) || 0) -
                (Number(b.sidecar?.started_at) || 0) ||
              (Number(a.sidecar?.ended_at) || 0) -
                (Number(b.sidecar?.ended_at) || 0)
            );
          });
          for (const entry of markers) {
            if (this.log.hasOpenTurn(session.linearSessionId)) break;
            const { file, base, sidecar } = entry;
            const marker = `.codex-dispatches/${session.linearSessionId}/${file}`;
            const roleMatch =
              /^([A-Za-z0-9][A-Za-z0-9_-]*)-[0-9]+-[0-9]+-[0-9]+$/.exec(base);
            const expectedRole = roleMatch?.[1];
            const sidecarShapeValid =
              sidecar?.state === "terminal" &&
              sidecar.owner === session.linearSessionId &&
              sidecar.basename === base &&
              typeof expectedRole === "string" &&
              sidecar.role === expectedRole &&
              typeof sidecar.trace_id === "string" &&
              sidecar.trace_id === session.traceId &&
              typeof sidecar.turn_span_id === "string" &&
              /^[0-9a-f]{16}$/.test(sidecar.turn_span_id) &&
              typeof sidecar.dispatch_span_id === "string" &&
              /^[0-9a-f]{16}$/.test(sidecar.dispatch_span_id) &&
              Number.isFinite(sidecar.started_at) &&
              Number.isFinite(sidecar.ended_at) &&
              Number.isFinite(sidecar.deadline_at) &&
              Number(sidecar.ended_at) >= Number(sidecar.started_at) &&
              (sidecar.mode === "fresh" || sidecar.mode === "resume");
            const sidecarTurnId =
              sidecarShapeValid && typeof sidecar.turn_span_id === "string"
                ? this.log.turnIdForSpan(
                    session.linearSessionId,
                    sidecar.turn_span_id,
                  )
                : undefined;
            const valid = sidecarShapeValid && sidecarTurnId !== undefined;
            const turnId =
              sidecarTurnId ?? this.log.latestTurnId(session.linearSessionId);
            const degradedKey = `${session.linearSessionId}:${file}`;
            const sourceKey = `dispatch:${session.linearSessionId}:${file}`;
            try {
              const age =
                this.now() - (await stat(resolve(directory, file))).mtimeMs;
              if (
                age > this.config.dispatchQuarantineAgeMs &&
                (this.log.hasCodexInvocation(sourceKey) || !turnId)
              ) {
                const destination = await this.quarantineDispatchBundle(
                  directory,
                  session.linearSessionId,
                  base,
                  file,
                );
                this.logger.log(
                  jsonLog({
                    event: "dispatch_marker_quarantined",
                    linearSessionId: session.linearSessionId,
                    marker,
                    destination,
                  }),
                );
                continue;
              }
            } catch (error) {
              this.logger.error(
                jsonLog({
                  event: "dispatch_marker_quarantine_failed",
                  linearSessionId: session.linearSessionId,
                  marker,
                  error: String(error),
                }),
              );
              continue;
            }
            if (!turnId) {
              if (!this.degradedLogged.has(degradedKey)) {
                this.degradedLogged.add(degradedKey);
                this.logger.error(
                  jsonLog({
                    event: "dispatch_marker_ingest_degraded",
                    linearSessionId: session.linearSessionId,
                    reason: "no_parent_turn",
                  }),
                );
              }
              continue;
            }
            const exitCode =
              typeof sidecar?.exit_code === "number" &&
              Number.isFinite(sidecar.exit_code)
                ? sidecar.exit_code
                : Number(entry.done.trim());
            const cumulative =
              typeof sidecar?.cumulative_tokens === "number" &&
              Number.isFinite(sidecar.cumulative_tokens)
                ? sidecar.cumulative_tokens
                : undefined;
            const invocation: CodexInvocationInput = {
              linearSessionId: session.linearSessionId,
              turnId,
              sourceKey,
              role:
                valid && typeof sidecar.role === "string"
                  ? sidecar.role
                  : (expectedRole ?? "codex"),
              prompt: entry.prompt,
              report: entry.report,
              ...(valid
                ? {
                    startedAt: Number(sidecar.started_at),
                    endedAt: Number(sidecar.ended_at),
                    deadlineAt: Number(sidecar.deadline_at),
                    traceId: String(sidecar.trace_id),
                    spanId: String(sidecar.dispatch_span_id),
                  }
                : { traceId: session.traceId }),
              outcome:
                Number.isFinite(exitCode) && exitCode === 0
                  ? "success"
                  : "failed",
              ...(valid && typeof sidecar.model === "string"
                ? { model: sidecar.model }
                : {}),
              ...(valid && typeof sidecar.provider_session_id === "string"
                ? { providerConversationId: sidecar.provider_session_id }
                : {}),
              ...(valid && typeof sidecar.provider_turn_id === "string"
                ? { providerTurnId: sidecar.provider_turn_id }
                : {}),
              ...(valid &&
              (sidecar.mode === "fresh" || sidecar.mode === "resume")
                ? { mode: sidecar.mode }
                : {}),
              ...(valid && cumulative !== undefined
                ? { cumulativeTotalTokens: cumulative }
                : {}),
              ...(valid && Number.isFinite(sidecar.input_tokens)
                ? { inputTokens: Number(sidecar.input_tokens) }
                : {}),
              ...(valid && Number.isFinite(sidecar.output_tokens)
                ? { outputTokens: Number(sidecar.output_tokens) }
                : {}),
              ...(valid && Number.isFinite(sidecar.cache_creation_tokens)
                ? { cacheCreationTokens: Number(sidecar.cache_creation_tokens) }
                : {}),
              ...(valid && Number.isFinite(sidecar.cache_read_tokens)
                ? { cacheReadTokens: Number(sidecar.cache_read_tokens) }
                : {}),
            };
            if (
              !valid &&
              !this.degradedLogged.has(degradedKey) &&
              !this.log.hasCodexInvocation(sourceKey)
            ) {
              this.degradedLogged.add(degradedKey);
              this.logger.error(
                jsonLog({
                  event: "dispatch_marker_ingest_degraded",
                  linearSessionId: session.linearSessionId,
                  reason: "invalid_sidecar",
                }),
              );
            }
            const result = this.log.ingestCodexMarker(
              invocation,
              {
                deliveryId: `dispatch:${session.linearSessionId}:${file}`,
                app: session.app,
                action: "prompted",
                agentSessionId: session.linearSessionId,
                sourceActivityId: `dispatch:${file}`,
                issueId: session.issueId ?? undefined,
                issueIdentifier: session.issueIdentifier ?? undefined,
                receivedAt: this.now(),
                rawBody: Buffer.from(
                  JSON.stringify({
                    agentActivity: {
                      body: `A detached Codex dispatch completed. At turn start, pick up ${marker}, any sibling completed dispatches in the same owner directory, and their report/log files; continue the pipeline, then delete each dispatch's files after consuming them.`,
                    },
                  }),
                ),
              },
              this.now(),
            ).append;
            if (result.inserted) {
              this.logger.log(
                jsonLog({
                  event: "dispatch_marker_resume",
                  linearSessionId: session.linearSessionId,
                  marker,
                }),
              );
              void this.drain();
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          this.logger.error(
            jsonLog({
              event: "dispatch_scan_failed",
              linearSessionId: session.linearSessionId,
              error: String(error),
            }),
          );
        }
      }
    } catch (error) {
      this.logger.error(
        jsonLog({ event: "dispatch_scan_failed", error: String(error) }),
      );
    }
  }

  private attachmentNodes(raw: Buffer): Array<{ url: string; name: string }> {
    let payload: Record<string, unknown> = {};
    try {
      payload = object(JSON.parse(raw.toString("utf8"))) ?? {};
    } catch {
      return [];
    }
    const found: Array<{ url: string; name: string }> = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const node = object(value);
      if (!node) return;
      const url = text(node.url);
      const name = text(node.title) ?? text(node.filename);
      if (url && name) found.push({ url, name });
      for (const child of Object.values(node))
        if (typeof child === "object") visit(child);
    };
    const scope = (value: unknown): void => {
      const node = object(value);
      if (!node) return;
      for (const [key, child] of Object.entries(node)) {
        if (key === "attachments") visit(child);
        else if (typeof child === "object")
          Array.isArray(child) ? child.forEach(scope) : scope(child);
      }
    };
    scope(object(object(payload.agentSession)?.issue));
    scope(object(payload.agentActivity));
    return found.slice(0, 10);
  }

  private async downloadAttachments(
    raw: Buffer,
    worktree: string,
  ): Promise<string> {
    const nodes = this.attachmentNodes(raw);
    if (!nodes.length) return "";
    const root = resolve(worktree, ".linear-attachments");
    await mkdir(root, { recursive: true });
    const realWorktree = await realpath(worktree);
    const realRoot = await realpath(root);
    if (!realRoot.startsWith(`${realWorktree}${sep}`))
      throw new Error("Attachment directory escaped worktree");
    const notes: string[] = [];
    const names = new Set<string>();
    for (const node of nodes) {
      let name = node.name.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
      const base = name;
      let suffix = 1;
      while (names.has(name)) name = `${base}-${suffix++}`;
      names.add(name);
      const destination = resolve(realRoot, name);
      if (!destination.startsWith(`${realRoot}${sep}`)) {
        notes.push(`${name}: rejected unsafe filename`);
        continue;
      }
      try {
        const bytes = await this.fetchAttachment(node.url);
        const handle = await open(destination, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
        notes.push(`${name}: .linear-attachments/${name}`);
      } catch (error) {
        try {
          await unlink(destination);
        } catch {}
        notes.push(
          `${name}: failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    return `\n\nLinear attachments:\n${notes.map((note) => `- ${note}`).join("\n")}`;
  }

  private async fetchAttachment(rawUrl: string): Promise<Buffer> {
    const controller = new AbortController();
    const timeoutMs = this.options.attachmentTimeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    let url = new URL(rawUrl);
    let redirected = false;
    try {
      for (let redirects = 0; redirects < 5; redirects++) {
        const protocolAllowed =
          url.protocol === "https:" ||
          (this.options.attachmentTestAllowHttp === true &&
            url.protocol === "http:");
        if (
          !protocolAllowed ||
          !this.config.attachmentHosts.includes(url.hostname)
        )
          throw new Error("attachment host is not allowed");
        const response = await fetch(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: redirected
            ? {}
            : { Authorization: `Bearer ${this.config.linearApiKey}` },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => {});
          if (!location)
            throw new Error("attachment redirect missing location");
          url = new URL(location, url);
          redirected = true;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`attachment HTTP ${response.status}`);
        }
        const length = Number(response.headers.get("content-length"));
        if (length > 10 * 1024 * 1024) {
          await response.body?.cancel().catch(() => {});
          throw new Error("attachment exceeds 10 MB");
        }
        const reader = response.body?.getReader();
        if (!reader) return Buffer.alloc(0);
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 10 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("attachment exceeds 10 MB");
          }
          chunks.push(value);
        }
        return Buffer.concat(chunks);
      }
      throw new Error("too many attachment redirects");
    } catch (error) {
      if (controller.signal.aborted) throw new Error("attachment timed out");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private triggerActivityDrain(): Promise<void> {
    if (this.activityDrain) return this.activityDrain;
    this.activityDrain = this.drainActivities().finally(() => {
      this.activityDrain = undefined;
    });
    return this.activityDrain;
  }
  private async drainActivities(): Promise<void> {
    if (this.stopped) return;
    for (const ack of this.log.pendingStopAcks(this.now())) {
      if (
        [...this.active.values()].some(
          (active) => active.linearSessionId === ack.linearSessionId,
        )
      )
        continue;
      await this.postStopAck(ack);
    }
    for (const activity of this.log.pendingTurnActivities(this.now()))
      await this.postTerminal(activity);
    for (const external of this.log.pendingExternalUrls(this.now()))
      await this.postExternalUrl(external);
  }
  private async postStopAck(ack: StopAckRow): Promise<void> {
    const result = await this.gateway.postActivity(
      ack.app,
      ack.linearSessionId,
      ack.activityId,
      { type: "response", body: ack.body },
      false,
      this.now() + 10_000,
    );
    if (result.ok) {
      this.log.markStopAckPosted(ack.sourceActivityId);
      return;
    }
    if (result.retriable && this.now() < ack.createdAt + 30 * 60_000) {
      const nextAttemptAt =
        this.now() + Math.max(result.retryAfterMs ?? 0, 1_000);
      this.log.markStopAckRetry(ack.sourceActivityId, nextAttemptAt);
      this.logger.error(
        jsonLog({
          event: "stop_ack_retry_scheduled",
          sourceActivityId: ack.sourceActivityId,
          linearSessionId: ack.linearSessionId,
          attempts: ack.attempts + 1,
          next_attempt_at: nextAttemptAt,
          error: result.error,
        }),
      );
      return;
    }
    this.log.markStopAckFailed(ack.sourceActivityId);
    this.logger.error(
      jsonLog({
        event: "stop_ack_delivery_failed",
        sourceActivityId: ack.sourceActivityId,
        linearSessionId: ack.linearSessionId,
        attempts: ack.attempts + 1,
        error: result.error,
      }),
    );
  }
  private async postExternalUrl(row: ExternalUrlRow): Promise<void> {
    const result = await this.gateway.setSessionExternalUrl(
      row.app,
      row.linearSessionId,
      row.label,
      row.url,
      this.now() + 10_000,
    );
    if (result.ok) {
      this.log.markExternalUrlPosted(row.id);
      return;
    }
    if (result.retriable && this.now() < row.createdAt + 30 * 60_000) {
      this.log.markExternalUrlRetry(
        row.id,
        result.error,
        this.now() + Math.max(result.retryAfterMs ?? 0, 1_000),
      );
      return;
    }
    this.log.markExternalUrlFailed(row.id, result.error);
    this.logger.error(
      jsonLog({
        event: "external_url_delivery_failed",
        id: row.id,
        error: result.error,
      }),
    );
  }
  // One-way push notification (ntfy) when an agent posts a terminal response
  // or error, so a human hears about questions without watching Linear.
  private notifyTerminal(activity: TurnActivityRow): void {
    const url = this.config.ntfyUrl;
    if (!url) return;
    const session = this.log.getSession(activity.linearSessionId);
    const app =
      activity.app === "implementer" ? "bloom-implementer" : "bloom-planner";
    const issue =
      session?.issueIdentifier ?? session?.issueId ?? "unknown issue";
    const title = `${app} ${activity.kind === "error" ? "error" : "replied"}: ${issue}`;
    const body =
      activity.body.length > 500
        ? `${activity.body.slice(0, 500)}…`
        : activity.body;
    void fetch(url, {
      method: "POST",
      headers: {
        Title: title.replace(/[^\x20-\x7e]/g, "?"),
        Priority: activity.kind === "error" ? "high" : "default",
        Tags: activity.kind === "error" ? "rotating_light" : "speech_balloon",
      },
      body,
    })
      .then((response) => {
        if (!response.ok)
          this.logger.error(
            jsonLog({ event: "notify_failed", status: response.status }),
          );
      })
      .catch((error) =>
        this.logger.error(
          jsonLog({ event: "notify_failed", error: String(error) }),
        ),
      );
  }

  private async postTerminal(activity: TurnActivityRow): Promise<void> {
    const result = await this.gateway.postActivity(
      activity.app,
      activity.linearSessionId,
      activity.activityId,
      { type: activity.kind, body: activity.body },
      false,
      this.now() + 10_000,
    );
    if (result.ok) {
      this.log.markTurnActivityPosted(activity.turnId, this.now());
      this.notifyTerminal(activity);
      this.options.onTurnComplete?.();
      return;
    }
    if (result.retriable && this.now() < activity.createdAt + 30 * 60_000) {
      const nextAttemptAt =
        this.now() + Math.max(result.retryAfterMs ?? 0, 1_000);
      this.log.markTurnActivityRetry(activity.turnId, nextAttemptAt);
      this.logger.error(
        jsonLog({
          event: "terminal_activity_retry_scheduled",
          turnId: activity.turnId,
          linearSessionId: activity.linearSessionId,
          attempts: activity.attempts + 1,
          next_attempt_at: nextAttemptAt,
          error: result.error,
        }),
      );
      return;
    }
    this.log.markTurnActivityFailed(
      activity.turnId,
      `terminal_activity_delivery_failed: ${result.error}`,
      this.now(),
    );
    this.logger.error(
      jsonLog({
        event: "terminal_activity_delivery_failed",
        turnId: activity.turnId,
        linearSessionId: activity.linearSessionId,
        attempts: activity.attempts + 1,
        error: result.error,
      }),
    );
  }
  stopSession(linearSessionId: string): void {
    for (const [turnId, active] of this.active) {
      if (active.linearSessionId !== linearSessionId) continue;
      this.stopRequested.add(turnId);
      active.controller.abort();
    }
    void this.triggerActivityDrain();
  }
  async stop(policy: ShutdownPolicy = "recover"): Promise<void> {
    this.stopped = true;
    this.shutdownPolicy = policy;
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    for (const [turnId, active] of this.active) {
      if (!this.stopRequested.has(turnId)) this.shutdownDeferred.add(turnId);
      active.controller.abort();
    }
    await Promise.allSettled(
      [...this.active.values()].map((active) => active.promise),
    );
    await this.activityDrain;
    await this.dispatchScan;
  }
}
