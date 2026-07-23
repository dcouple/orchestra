import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type LinearMcpMonitorState = "unknown" | "healthy" | "unhealthy";
export type LinearMcpErrorCategory =
  | "timeout"
  | "authentication"
  | "transport"
  | "protocol"
  | "unknown";

export interface LinearMcpProbeInput {
  url: string;
  token: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type LinearMcpProbe = (input: LinearMcpProbeInput) => Promise<void>;

interface ProbeClient {
  connect(transport: Transport): Promise<void>;
  listTools(): Promise<unknown>;
  close(): Promise<void>;
}

interface ProbeTransport extends Transport {
  close(): Promise<void>;
}

export interface LinearMcpProbeDependencies {
  createClient?: () => ProbeClient;
  createTransport?: (
    url: URL,
    requestInit: RequestInit,
  ) => ProbeTransport;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
}

export interface NormalizedLinearMcpError {
  category: LinearMcpErrorCategory;
  code: string;
}

interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface LinearMcpScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LinearMcpMonitorOptions {
  url: string;
  token: string;
  intervalMs: number;
  timeoutMs: number;
  probe?: LinearMcpProbe;
  now?: () => number;
  logger?: Logger;
  scheduler?: LinearMcpScheduler;
}

export interface LinearMcpMonitorSnapshot {
  state: LinearMcpMonitorState;
  consecutiveFailures: number;
  retryCount: number;
}

const defaultScheduler: LinearMcpScheduler = {
  setInterval: (callback, intervalMs) => {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return timer;
  },
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return error !== null && typeof error === "object"
    ? (error as Record<string, unknown>)
    : undefined;
}

function errorCode(error: unknown): string | number | undefined {
  const record = errorRecord(error);
  const direct = record?.code;
  if (typeof direct === "string" || typeof direct === "number") return direct;
  const cause = errorRecord(record?.cause);
  return typeof cause?.code === "string" || typeof cause?.code === "number"
    ? cause.code
    : undefined;
}

export function normalizeLinearMcpError(
  error: unknown,
): NormalizedLinearMcpError {
  const record = errorRecord(error);
  const name = typeof record?.name === "string" ? record.name : "";
  const code = errorCode(error);
  if (code === "LINEAR_MCP_CLEANUP_TIMEOUT")
    return { category: "timeout", code: "cleanup_timeout" };
  if (code === "LINEAR_MCP_CLEANUP_FAILED")
    return { category: "transport", code: "cleanup_failed" };
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "ABORT_ERR" ||
    code === "ETIMEDOUT"
  )
    return { category: "timeout", code: "timeout" };
  if (
    name === "UnauthorizedError" ||
    code === 401 ||
    code === 403 ||
    code === "401" ||
    code === "403"
  )
    return { category: "authentication", code: `http_${String(code || 401)}` };
  if (
    typeof code === "string" &&
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EHOSTUNREACH",
      "ENETUNREACH",
    ].includes(code)
  )
    return { category: "transport", code: code.toLowerCase() };
  if (
    name === "StreamableHTTPError" &&
    typeof code === "number" &&
    code >= 500
  )
    return { category: "transport", code: "http_5xx" };
  if (
    name === "McpError" ||
    name === "SyntaxError" ||
    (typeof code === "number" && code >= -32700 && code <= -32000)
  )
    return { category: "protocol", code: "mcp_protocol" };
  return { category: "unknown", code: "unknown" };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("linear_mcp_probe_aborted");
  error.name = "AbortError";
  return error;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError(signal)), {
      once: true,
    });
  });
}

function boundedCleanupError(
  code: "LINEAR_MCP_CLEANUP_TIMEOUT" | "LINEAR_MCP_CLEANUP_FAILED",
): Error {
  const error = new Error(
    code === "LINEAR_MCP_CLEANUP_TIMEOUT"
      ? "linear_mcp_cleanup_timeout"
      : "linear_mcp_cleanup_failed",
  );
  error.name =
    code === "LINEAR_MCP_CLEANUP_TIMEOUT"
      ? "LinearMcpCleanupTimeoutError"
      : "LinearMcpCleanupError";
  Object.assign(error, { code });
  return error;
}

async function closeProbeResources(
  client: ProbeClient,
  transport: ProbeTransport,
  timeoutMs: number,
  timeoutSignal: (timeoutMs: number) => AbortSignal,
): Promise<void> {
  const cleanupSignal = timeoutSignal(timeoutMs);
  const closing = Promise.allSettled([
    Promise.resolve().then(() => client.close()),
    Promise.resolve().then(() => transport.close()),
  ]);
  const cleanupTimedOut = rejectOnAbort(cleanupSignal).catch(() => {
    throw boundedCleanupError("LINEAR_MCP_CLEANUP_TIMEOUT");
  });
  const results = await Promise.race([closing, cleanupTimedOut]);
  if (results.some((result) => result.status === "rejected"))
    throw boundedCleanupError("LINEAR_MCP_CLEANUP_FAILED");
}

/**
 * Runs one MCP initialization/list-tools/close cycle. The listTools response is
 * deliberately discarded so schemas and descriptions never reach telemetry.
 */
export async function probeLinearMcp(
  input: LinearMcpProbeInput,
  dependencies: LinearMcpProbeDependencies = {},
): Promise<void> {
  const timeoutSignal = dependencies.timeoutSignal ?? AbortSignal.timeout;
  const timeout = timeoutSignal(input.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  const requestInit: RequestInit = {
    headers: { Authorization: `Bearer ${input.token}` },
    signal,
  };
  // The SDK's concrete transport declares an optional sessionId in a form
  // incompatible with this repo's exactOptionalPropertyTypes setting.
  const transport: ProbeTransport =
    dependencies.createTransport?.(new URL(input.url), requestInit) ??
    (new StreamableHTTPClientTransport(new URL(input.url), {
      requestInit,
    }) as unknown as ProbeTransport);
  const client =
    dependencies.createClient?.() ??
    new Client({ name: "orchestra-linear-mcp-monitor", version: "1.0.0" });
  const aborted = rejectOnAbort(signal);
  try {
    await Promise.race([client.connect(transport), aborted]);
    await Promise.race([client.listTools(), aborted]);
  } finally {
    await closeProbeResources(
      client,
      transport,
      input.timeoutMs,
      timeoutSignal,
    );
  }
}

export class LinearMcpMonitor {
  private state: LinearMcpMonitorState = "unknown";
  private consecutiveFailures = 0;
  private timer: unknown;
  private stopped = true;
  private cleanupBlocked = false;
  private inFlight: Promise<void> | undefined;
  private activeController: AbortController | undefined;
  private readonly probe: LinearMcpProbe;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly scheduler: LinearMcpScheduler;

  constructor(private readonly options: LinearMcpMonitorOptions) {
    this.probe = options.probe ?? probeLinearMcp;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = this.scheduler.setInterval(
      () => void this.trigger(),
      this.options.intervalMs,
    );
    void this.trigger();
  }

  trigger(): Promise<void> {
    if (this.stopped || this.cleanupBlocked) return Promise.resolve();
    this.inFlight ??= this.runProbe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  snapshot(): LinearMcpMonitorSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      retryCount: this.consecutiveFailures,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.scheduler.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.activeController?.abort();
    await this.inFlight;
  }

  private async runProbe(): Promise<void> {
    const startedAt = this.now();
    const previousState = this.state;
    const controller = new AbortController();
    this.activeController = controller;
    try {
      await this.probe({
        url: this.options.url,
        token: this.options.token,
        timeoutMs: this.options.timeoutMs,
        signal: controller.signal,
      });
      if (this.stopped) return;
      this.state = "healthy";
      this.consecutiveFailures = 0;
      this.logger.log(
        JSON.stringify({
          event: "linear_mcp_probe",
          state: this.state,
          previousState,
          transitioned: previousState !== this.state,
          consecutiveFailures: 0,
          retryCount: 0,
          durationMs: Math.max(0, this.now() - startedAt),
        }),
      );
    } catch (error) {
      if (this.stopped && controller.signal.aborted) return;
      this.state = "unhealthy";
      this.consecutiveFailures += 1;
      const normalized = normalizeLinearMcpError(error);
      if (normalized.code === "cleanup_timeout") this.cleanupBlocked = true;
      this.logger.error(
        JSON.stringify({
          level: "error",
          event: "linear_mcp_probe",
          state: this.state,
          previousState,
          transitioned: previousState !== this.state,
          consecutiveFailures: this.consecutiveFailures,
          retryCount: this.consecutiveFailures,
          durationMs: Math.max(0, this.now() - startedAt),
          errorCategory: normalized.category,
          errorCode: normalized.code,
        }),
      );
    } finally {
      if (this.activeController === controller)
        this.activeController = undefined;
    }
  }
}
