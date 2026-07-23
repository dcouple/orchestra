import { randomBytes } from "node:crypto";
import type { AgentInvocationRow, SessionRow } from "./eventlog.js";

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
}
export interface OtlpTracesConfig {
  endpoint: string;
  headers: Record<string, string>;
}
export type OtlpAttribute = {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { boolValue: boolean }
    | { doubleValue: number };
};
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number };
}
export interface PostSpansResult {
  ok: boolean;
  delivery: "delivered" | "failed" | "delivery_unknown";
  error?: string;
}

function randomHex(bytes: number): string {
  let value = randomBytes(bytes).toString("hex");
  while (/^0+$/.test(value)) value = randomBytes(bytes).toString("hex");
  return value;
}
export function mintTraceId(): string {
  return randomHex(16);
}
export function mintSpanId(): string {
  return randomHex(8);
}
export function traceContext(
  traceId = mintTraceId(),
  spanId = mintSpanId(),
): TraceContext {
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
}
export function mintTraceContext(): TraceContext {
  return traceContext();
}
function parseHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  const headers: Record<string, string> = {};
  for (const fragment of value.split(",")) {
    const i = fragment.indexOf("=");
    if (i < 1) continue;
    const key = fragment.slice(0, i).trim();
    if (key) headers[key] = fragment.slice(i + 1).trim();
  }
  return headers;
}
export function resolveOtlpTraces(
  env: NodeJS.ProcessEnv,
): OtlpTracesConfig | undefined {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint =
    traces ??
    (base === undefined ? undefined : `${base.replace(/\/$/, "")}/v1/traces`);
  if (!endpoint) return undefined;
  return {
    endpoint,
    headers: parseHeaders(
      env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
    ),
  };
}
const str = (key: string, value: string): OtlpAttribute => ({
  key,
  value: { stringValue: value },
});
const int = (key: string, value: number): OtlpAttribute => ({
  key,
  value: { intValue: String(Math.trunc(value)) },
});
const bool = (key: string, value: boolean): OtlpAttribute => ({
  key,
  value: { boolValue: value },
});
const nano = (ms: number): string => `${Math.trunc(ms)}000000`;
const canonical = (usage: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
}) => {
  const input = usage.inputTokens ?? 0,
    output = usage.outputTokens ?? 0,
    creation = usage.cacheCreationTokens ?? 0,
    read = usage.cacheReadTokens ?? 0;
  return [
    int("orchestra.canonical_tokens.input", input),
    int("orchestra.canonical_tokens.output", output),
    int("orchestra.canonical_tokens.cache_creation", creation),
    int("orchestra.canonical_tokens.cache_read", read),
    int("orchestra.canonical_tokens.total", input + output + creation + read),
  ];
};
export function buildTurnSpan(input: {
  traceId: string;
  rootSpanId: string;
  turnSpanId: string;
  linearSessionId: string;
  issue: string;
  turnId: number | string;
  prompt: string;
  response: string;
  runtime: string;
  profile: string;
  model?: string | null;
  status: string;
  startedAt: number;
  finishedAt: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
}): OtlpSpan {
  return {
    traceId: input.traceId,
    spanId: input.turnSpanId,
    parentSpanId: input.rootSpanId,
    name: "orchestra.turn",
    kind: 1,
    startTimeUnixNano: nano(input.startedAt),
    endTimeUnixNano: nano(input.finishedAt),
    attributes: [
      str("linear.session_id", input.linearSessionId),
      str("linear.issue", input.issue),
      str("turn.id", String(input.turnId)),
      str("turn.status", input.status),
      str("orchestra.outcome", input.status),
      str("langfuse.observation.type", "span"),
      str("langfuse.observation.input", input.prompt),
      str("langfuse.observation.output", input.response),
      str("orchestra.runtime", input.runtime),
      str("orchestra.profile", input.profile),
      ...(input.model ? [str("orchestra.model", input.model)] : []),
      int("orchestra.duration_ms", input.finishedAt - input.startedAt),
      ...canonical(input),
    ],
    status: {
      code: input.status === "response" || input.status === "done" ? 1 : 2,
    },
  };
}
export function buildInvocationSpan(
  invocation: AgentInvocationRow,
  turnSpanId: string,
): OtlpSpan {
  return {
    traceId: invocation.traceId,
    spanId: invocation.spanId ?? mintSpanId(),
    parentSpanId: turnSpanId,
    name:
      invocation.source === "codex"
        ? "orchestra.codex_dispatch"
        : "orchestra.agent",
    kind: 1,
    startTimeUnixNano: nano(invocation.startedAt ?? 0),
    endTimeUnixNano: nano(invocation.endedAt ?? invocation.startedAt ?? 0),
    attributes: [
      str("langfuse.observation.type", "span"),
      str("orchestra.agent.role", invocation.role),
      str("orchestra.runtime", invocation.runtime),
      str("orchestra.outcome", invocation.outcome ?? "unknown"),
      ...(invocation.model ? [str("orchestra.model", invocation.model)] : []),
      ...(invocation.prompt
        ? [str("langfuse.observation.input", invocation.prompt)]
        : []),
      ...(invocation.report
        ? [str("langfuse.observation.output", invocation.report)]
        : []),
      int(
        "orchestra.duration_ms",
        Math.max(0, (invocation.endedAt ?? 0) - (invocation.startedAt ?? 0)),
      ),
      ...(invocation.source === "codex"
        ? [
            int(
              "orchestra.canonical_tokens.total",
              invocation.deltaTotalTokens ?? 0,
            ),
          ]
        : canonical(invocation)),
      bool(
        "orchestra.canonical_tokens.complete",
        invocation.enrichmentState === "enriched" &&
          (invocation.source === "claude" ||
            invocation.usageClassification === "accepted" ||
            invocation.usageClassification === "reset"),
      ),
    ],
    status: { code: invocation.outcome === "success" ? 1 : 2 },
  };
}
export function buildSessionRoot(
  session: SessionRow,
  summary: {
    canonicalTokens: number;
    invocationCount: number;
    roles: string[];
    complete: boolean;
    degradedCount: number;
  },
  completedAt: number,
): OtlpSpan {
  return {
    traceId: session.traceId,
    spanId: session.rootSpanId,
    name: "orchestra.session",
    kind: 1,
    startTimeUnixNano: nano(session.startedAt),
    endTimeUnixNano: nano(completedAt),
    attributes: [
      str("linear.session_id", session.linearSessionId),
      str(
        "linear.issue",
        session.issueIdentifier ?? session.issueId ?? "unknown",
      ),
      str("orchestra.session.status", "completed"),
      str("orchestra.runtime", session.runtime),
      str("orchestra.profile", session.profile ?? "unknown"),
      int("orchestra.duration_ms", completedAt - session.startedAt),
      int("orchestra.canonical_tokens.total", summary.canonicalTokens),
      bool("orchestra.canonical_tokens.complete", summary.complete),
      bool("orchestra.telemetry_complete", summary.complete),
      int("orchestra.invocation.count", summary.invocationCount),
      int("orchestra.invocation.role_count", summary.roles.length),
      str("orchestra.invocation.roles", summary.roles.join(",")),
      int("orchestra.telemetry.degraded_count", summary.degradedCount),
    ],
    status: { code: 1 },
  };
}
export function otlpJson(spans: OtlpSpan[]): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: [str("service.name", "linear-agent-daemon")] },
        scopeSpans: [{ scope: { name: "linear-agent-daemon" }, spans }],
      },
    ],
  };
}
export async function postSpans(
  spans: OtlpSpan[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5_000,
): Promise<PostSpansResult> {
  const config = resolveOtlpTraces(env);
  if (!config)
    return {
      ok: false,
      delivery: "failed",
      error: "OTLP traces endpoint is not configured",
    };
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: { ...config.headers, "content-type": "application/json" },
      body: JSON.stringify(otlpJson(spans)),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return { ok: true, delivery: "delivered" };
    return { ok: false, delivery: "failed", error: `http ${response.status}` };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    const definite =
      cause === "ECONNREFUSED" ||
      cause === "ENOTFOUND" ||
      cause === "EAI_AGAIN";
    return {
      ok: false,
      delivery: definite ? "failed" : "delivery_unknown",
      error: error instanceof Error ? error.name : "transport_error",
    };
  }
}

// Compatibility wrapper retained for phase-3 callers while session wiring migrates.
export async function postTurnSpans(input: {
  traceContext: TraceContext;
  linearSessionId: string;
  issue: string;
  turnId: number | string;
  status: string;
  startedAt: number;
  finishedAt: number;
  resultText?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const span = buildTurnSpan({
    traceId: input.traceContext.traceId,
    rootSpanId: input.traceContext.spanId,
    turnSpanId: mintSpanId(),
    linearSessionId: input.linearSessionId,
    issue: input.issue,
    turnId: input.turnId,
    prompt: "",
    response: input.resultText ?? "",
    runtime: "unknown",
    profile: "unknown",
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  });
  const result = await postSpans(
    [span],
    input.env ?? process.env,
    input.timeoutMs ?? 5_000,
  );
  return result.ok
    ? { ok: true }
    : { ok: false, ...(result.error ? { error: result.error } : {}) };
}
