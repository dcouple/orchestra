import { randomBytes } from "node:crypto";

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
}

export interface OtlpTracesConfig {
  endpoint: string;
  headers: Record<string, string>;
}

export interface PostTurnSpansInput {
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
}

export interface PostTurnSpansResult {
  ok: boolean;
  error?: string;
}

interface OtlpAttribute {
  key: string;
  value: { stringValue: string } | { intValue: string };
}

function randomHex(bytes: number): string {
  let value = randomBytes(bytes).toString("hex");
  while (/^0+$/.test(value)) value = randomBytes(bytes).toString("hex");
  return value;
}

export function mintTraceContext(): TraceContext {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
}

function parseHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  const headers: Record<string, string> = {};
  for (const fragment of value.split(",")) {
    const separator = fragment.indexOf("=");
    if (separator < 1) continue;
    const key = fragment.slice(0, separator).trim();
    if (!key) continue;
    headers[key] = fragment.slice(separator + 1).trim();
  }
  return headers;
}

export function resolveOtlpTraces(env: NodeJS.ProcessEnv): OtlpTracesConfig | undefined {
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint = tracesEndpoint ?? (baseEndpoint === undefined ? undefined : `${baseEndpoint.replace(/\/$/, "")}/v1/traces`);
  if (endpoint === undefined) return undefined;
  return {
    endpoint,
    headers: parseHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
  };
}

function stringAttribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function intAttribute(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(value) } };
}

function unixNano(ms: number): string {
  return `${Math.trunc(ms)}000000`;
}

export async function postTurnSpans(input: PostTurnSpansInput): Promise<PostTurnSpansResult> {
  try {
    const config = resolveOtlpTraces(input.env ?? process.env);
    if (!config) return { ok: false, error: "OTLP traces endpoint is not configured" };
    const spans: Array<Record<string, unknown>> = [{
      traceId: input.traceContext.traceId,
      spanId: input.traceContext.spanId,
      name: "daemon.turn",
      kind: 1,
      startTimeUnixNano: unixNano(input.startedAt),
      endTimeUnixNano: unixNano(input.finishedAt),
      attributes: [
        stringAttribute("linear.session_id", input.linearSessionId),
        stringAttribute("linear.issue", input.issue),
        stringAttribute("turn.id", String(input.turnId)),
        stringAttribute("turn.status", input.status),
      ],
      status: { code: 0 },
    }];
    if (input.resultText !== undefined) {
      spans.push({
        traceId: input.traceContext.traceId,
        spanId: randomHex(8),
        parentSpanId: input.traceContext.spanId,
        name: "daemon.assistant_response",
        kind: 1,
        startTimeUnixNano: unixNano(input.finishedAt),
        endTimeUnixNano: unixNano(input.finishedAt),
        attributes: [
          stringAttribute("response.content", input.resultText),
          intAttribute("response.length", input.resultText.length),
        ],
        status: { code: 0 },
      });
    }
    const body = {
      resourceSpans: [{
        resource: { attributes: [stringAttribute("service.name", "linear-agent-daemon")] },
        scopeSpans: [{ scope: { name: "linear-agent-daemon" }, spans }],
      }],
    };
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: { ...config.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
    });
    await response.body?.cancel().catch(() => {});
    return response.ok ? { ok: true } : { ok: false, error: `http ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
