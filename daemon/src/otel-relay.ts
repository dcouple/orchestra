import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { gunzipSync } from "node:zlib";
import {
  attributeMap,
  bytesHex,
  decodeOtlpTrace,
  encodeOtlpTrace,
  otlpSpans,
  setBoolAttribute,
  setIntAttribute,
  setStringAttribute,
  type ProtoObject,
} from "./otel-proto.js";

export interface AgentMetadata {
  linearSessionId: string;
  toolUseId: string;
  role: string;
  prompt: string;
  report?: string;
  outcome?: string;
  streamCompletedAt?: number;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model?: string;
}

export interface RelayCallbacks {
  markNativeSeen?(
    metadata: AgentMetadata,
    at: number,
  ): boolean | Promise<boolean>;
  markEnriched?(
    metadata: AgentMetadata,
    input: {
      spanId: string;
      startedAt: number;
      endedAt: number;
      usage: AgentUsage;
    },
  ): boolean | Promise<boolean>;
  markForwardedUnenriched?(
    metadata: AgentMetadata,
    reason: string,
  ): boolean | Promise<boolean>;
  onTerminal?(linearSessionId: string): void;
}

export interface OtlpRelayOptions {
  endpoint: string;
  headers: Record<string, string>;
  ttlMs?: number;
  maxRequests?: number;
  maxBytes?: number;
  maxRequestBytes?: number;
  maxCapabilityConcurrency?: number;
  maxGlobalConcurrency?: number;
  maxCapabilityBufferedBytes?: number;
  maxGlobalBufferedBytes?: number;
  pruneMs?: number;
  upstreamTimeoutMs?: number;
  quietMs?: number;
  hardDeadlineMs?: number;
  logger?: Pick<Console, "log" | "error">;
  callbacks?: RelayCallbacks;
}

export interface RelayCapability {
  path: string;
  endpoint: string;
  expiresAt: number;
  traceId: string;
  turnSpanId: string;
  linearSessionId: string;
}

interface RelayPolicy {
  ttlMs: number;
  maxRequests: number;
  maxBytes: number;
  maxRequestBytes: number;
  maxCapabilityConcurrency: number;
  maxGlobalConcurrency: number;
  maxCapabilityBufferedBytes: number;
  maxGlobalBufferedBytes: number;
  pruneMs: number;
  upstreamTimeoutMs: number;
  quietMs: number;
  hardDeadlineMs: number;
}

interface BufferedBatch {
  original: Buffer;
  contentEncoding?: string;
  decoded: ProtoObject | undefined;
  agentToolUseIds: string[];
  unsafeReason?: string;
  mutated: boolean;
  forwarded: boolean;
  receivedAt: number;
  indexedBytes: number;
}

interface SpanRecord {
  span: ProtoObject;
  batch: BufferedBatch;
  spanId: string;
  parentSpanId?: string;
  name: string;
  agent: boolean;
  toolUseId?: string;
}

interface CapabilityState extends RelayCapability {
  token: string;
  requests: number;
  bytes: number;
  active: number;
  metadata: Map<string, AgentMetadata>;
  nativeFirstSeen: Map<string, number>;
  evictedTools: Map<string, { at: number; reason: string }>;
  terminalTools: Set<string>;
  pending: BufferedBatch[];
  pendingBytes: number;
  graph: Map<string, SpanRecord>;
  graphBytes: number;
  lastActivityAt: number;
  timer: NodeJS.Timeout | undefined;
  flushing: Promise<void>;
}

const DEFAULTS: RelayPolicy = {
  ttlMs: 3_600_000,
  maxRequests: 4_096,
  maxBytes: 256 * 1024 * 1024,
  maxRequestBytes: 8 * 1024 * 1024,
  maxCapabilityConcurrency: 8,
  maxGlobalConcurrency: 32,
  maxCapabilityBufferedBytes: 32 * 1024 * 1024,
  maxGlobalBufferedBytes: 128 * 1024 * 1024,
  pruneMs: 60_000,
  upstreamTimeoutMs: 5_000,
  quietMs: 1_000,
  hardDeadlineMs: 30_000,
};

class AdmissionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.name : "relay_error";
}

function attr(
  attrs: Map<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = attrs.get(key);
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function numberAttr(attrs: Map<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = attrs.get(key);
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function timestampMs(value: unknown): number {
  const raw =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : 0;
  return Number.isFinite(raw) ? Math.trunc(raw / 1_000_000) : 0;
}

function cloneAttributes(span: ProtoObject): ProtoObject[] {
  return ((span.attributes as ProtoObject[] | undefined) ?? []).map(
    (attribute) => ({
      ...attribute,
      ...(attribute.value && typeof attribute.value === "object"
        ? { value: { ...(attribute.value as ProtoObject) } }
        : {}),
    }),
  );
}

export class OtlpRelay {
  private server: Server | undefined;
  private origin = "";
  private pruneTimer?: NodeJS.Timeout;
  private globalActive = 0;
  private globalBuffered = 0;
  private globalGraphBytes = 0;
  private stopped = false;
  private readonly states = new Map<string, CapabilityState>();
  private readonly policy: RelayPolicy;
  private readonly logger: Pick<Console, "log" | "error">;

  constructor(private readonly options: OtlpRelayOptions) {
    this.policy = {
      ttlMs: options.ttlMs ?? DEFAULTS.ttlMs,
      maxRequests: options.maxRequests ?? DEFAULTS.maxRequests,
      maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
      maxRequestBytes: options.maxRequestBytes ?? DEFAULTS.maxRequestBytes,
      maxCapabilityConcurrency:
        options.maxCapabilityConcurrency ?? DEFAULTS.maxCapabilityConcurrency,
      maxGlobalConcurrency:
        options.maxGlobalConcurrency ?? DEFAULTS.maxGlobalConcurrency,
      maxCapabilityBufferedBytes:
        options.maxCapabilityBufferedBytes ??
        DEFAULTS.maxCapabilityBufferedBytes,
      maxGlobalBufferedBytes:
        options.maxGlobalBufferedBytes ?? DEFAULTS.maxGlobalBufferedBytes,
      pruneMs: options.pruneMs ?? DEFAULTS.pruneMs,
      upstreamTimeoutMs:
        options.upstreamTimeoutMs ?? DEFAULTS.upstreamTimeoutMs,
      quietMs: options.quietMs ?? DEFAULTS.quietMs,
      hardDeadlineMs: options.hardDeadlineMs ?? DEFAULTS.hardDeadlineMs,
    };
    this.logger = options.logger ?? console;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.stopped = false;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        this.logger.error(
          JSON.stringify({
            event: "otel_relay_request_failed",
            error: safeError(error),
          }),
        );
        if (!response.headersSent)
          response
            .writeHead(200, { "content-type": "application/x-protobuf" })
            .end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address() as { port: number };
    this.origin = `http://127.0.0.1:${address.port}`;
    this.pruneTimer = setInterval(() => void this.prune(), this.policy.pruneMs);
    this.pruneTimer.unref();
  }

  createCapability(
    input: { linearSessionId: string; traceId: string; turnSpanId: string },
    now = Date.now(),
  ): RelayCapability {
    if (!this.server || this.stopped) throw new Error("relay_not_running");
    const token = randomBytes(32).toString("base64url");
    const path = `/${token}/v1/traces`;
    const state: CapabilityState = {
      ...input,
      token,
      path,
      endpoint: `${this.origin}${path}`,
      expiresAt: now + this.policy.ttlMs,
      requests: 0,
      bytes: 0,
      active: 0,
      metadata: new Map(),
      nativeFirstSeen: new Map(),
      evictedTools: new Map(),
      terminalTools: new Set(),
      pending: [],
      pendingBytes: 0,
      graph: new Map(),
      graphBytes: 0,
      lastActivityAt: now,
      timer: undefined,
      flushing: Promise.resolve(),
    };
    this.states.set(token, state);
    return state;
  }

  registerAgent(capability: RelayCapability, metadata: AgentMetadata): void {
    const state = this.stateFor(capability);
    if (!state) return;
    state.metadata.set(metadata.toolUseId, metadata);
    void this.settleEvictedTool(state, metadata).catch((error) => {
      this.logger.error(
        JSON.stringify({
          event: "otel_relay_callback_failed",
          error: safeError(error),
        }),
      );
    });
    if (state.nativeFirstSeen.has(metadata.toolUseId))
      this.schedule(state, this.policy.quietMs);
  }

  completeAgent(capability: RelayCapability, metadata: AgentMetadata): void {
    const state = this.stateFor(capability);
    if (!state) return;
    state.metadata.set(metadata.toolUseId, metadata);
    void this.settleEvictedTool(state, metadata).catch((error) => {
      this.logger.error(
        JSON.stringify({
          event: "otel_relay_callback_failed",
          error: safeError(error),
        }),
      );
    });
    if (state.pending.length) this.schedule(state, this.policy.quietMs * 2);
  }

  async flushSession(linearSessionId: string): Promise<void> {
    await Promise.all(
      [...this.states.values()]
        .filter((state) => state.linearSessionId === linearSessionId)
        .map((state) => this.flush(state, false, "session_flush")),
    );
  }

  private stateFor(capability: RelayCapability): CapabilityState | undefined {
    return this.states.get(capability.path.split("/")[1] ?? "");
  }

  private async prune(now = Date.now()): Promise<void> {
    for (const [key, state] of this.states) {
      if (state.expiresAt > now) continue;
      if (state.timer) clearTimeout(state.timer);
      this.states.delete(key);
      await this.flush(state, true, "capability_expired");
      this.releaseGraph(state);
    }
  }

  private reserveAdmission(
    request: IncomingMessage,
    state: CapabilityState,
  ): number | undefined {
    if (state.requests >= this.policy.maxRequests)
      throw new AdmissionError(429, "request_limit");
    if (
      state.active >= this.policy.maxCapabilityConcurrency ||
      this.globalActive >= this.policy.maxGlobalConcurrency
    ) {
      throw new AdmissionError(429, "concurrency_limit");
    }
    const rawLength = request.headers["content-length"];
    const length = rawLength === undefined ? undefined : Number(rawLength);
    if (length !== undefined && (!Number.isFinite(length) || length < 0))
      throw new AdmissionError(413, "invalid_length");
    if (length !== undefined && length > this.policy.maxRequestBytes)
      throw new AdmissionError(413, "request_too_large");
    if (length !== undefined && state.bytes + length > this.policy.maxBytes) {
      throw new AdmissionError(413, "capability_bytes_exhausted");
    }
    state.requests += 1;
    state.active += 1;
    this.globalActive += 1;
    if (length !== undefined) state.bytes += length;
    return length;
  }

  private async read(
    request: IncomingMessage,
    state: CapabilityState,
    reserved?: number,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Uint8Array);
        const next = size + bytes.length;
        if (next > this.policy.maxRequestBytes)
          throw new AdmissionError(413, "request_too_large");
        const alreadyReserved = reserved ?? 0;
        const extra =
          Math.max(0, next - alreadyReserved) -
          Math.max(0, size - alreadyReserved);
        if (extra > 0) {
          if (state.bytes + extra > this.policy.maxBytes)
            throw new AdmissionError(413, "capability_bytes_exhausted");
          state.bytes += extra;
        }
        size = next;
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, size);
    } finally {
      if (reserved !== undefined && size < reserved)
        state.bytes -= reserved - size;
    }
  }

  private reject(response: ServerResponse, status: number): void {
    response.writeHead(status).end();
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const match = /^\/([^/]+)\/v1\/traces$/.exec(request.url ?? "");
    const state = match ? this.states.get(match[1]!) : undefined;
    if (
      request.method !== "POST" ||
      !state ||
      this.stopped ||
      state.expiresAt <= Date.now()
    ) {
      this.reject(response, 404);
      return;
    }

    let reserved: number | undefined;
    try {
      reserved = this.reserveAdmission(request, state);
    } catch (error) {
      if (error instanceof AdmissionError) {
        this.reject(response, error.status);
        return;
      }
      throw error;
    }

    try {
      let original: Buffer;
      try {
        original = await this.read(request, state, reserved);
      } catch (error) {
        if (error instanceof AdmissionError) {
          this.reject(response, error.status);
          return;
        }
        throw error;
      }
      let prepared: BufferedBatch;
      try {
        prepared = this.prepareBatch(
          original,
          request.headers["content-encoding"],
        );
      } catch (error) {
        if (error instanceof AdmissionError) {
          this.reject(response, error.status);
          return;
        }
        throw error;
      }
      if (prepared.decoded && prepared.indexedBytes > original.length) {
        const extra = prepared.indexedBytes - original.length;
        if (state.bytes + extra > this.policy.maxBytes) {
          this.reject(response, 413);
          return;
        }
        state.bytes += extra;
      }
      this.buffer(state, prepared);
      state.lastActivityAt = Date.now();
      this.schedule(state, this.policy.quietMs);
      response
        .writeHead(200, { "content-type": "application/x-protobuf" })
        .end();
    } finally {
      state.active -= 1;
      this.globalActive -= 1;
    }
  }

  private prepareBatch(
    original: Buffer,
    rawEncoding: string | string[] | undefined,
  ): BufferedBatch {
    const contentEncoding = Array.isArray(rawEncoding)
      ? rawEncoding.join(",")
      : rawEncoding;
    let payload = original;
    if (contentEncoding) {
      if (contentEncoding.toLowerCase() !== "gzip") {
        return {
          original,
          contentEncoding,
          decoded: undefined,
          agentToolUseIds: [],
          mutated: false,
          forwarded: false,
          receivedAt: Date.now(),
          indexedBytes: original.length,
        };
      }
      try {
        payload = gunzipSync(original, {
          maxOutputLength: this.policy.maxRequestBytes,
        });
      } catch (error) {
        if (error instanceof RangeError)
          throw new AdmissionError(413, "request_too_large");
        return {
          original,
          contentEncoding,
          decoded: undefined,
          agentToolUseIds: [],
          mutated: false,
          forwarded: false,
          receivedAt: Date.now(),
          indexedBytes: original.length,
        };
      }
    }
    if (payload.length > this.policy.maxRequestBytes) {
      throw new AdmissionError(413, "request_too_large");
    }
    try {
      const decoded = decodeOtlpTrace(payload);
      const roundTrip = Buffer.from(encodeOtlpTrace(decoded));
      const agentToolUseIds = this.agentToolUseIds(decoded);
      if (!roundTrip.equals(payload)) {
        return {
          original,
          ...(contentEncoding ? { contentEncoding } : {}),
          decoded: undefined,
          agentToolUseIds,
          unsafeReason: "unsupported_wire",
          mutated: false,
          forwarded: false,
          receivedAt: Date.now(),
          indexedBytes: payload.length,
        };
      }
      return {
        original,
        ...(contentEncoding ? { contentEncoding } : {}),
        decoded,
        agentToolUseIds,
        mutated: false,
        forwarded: false,
        receivedAt: Date.now(),
        indexedBytes: payload.length,
      };
    } catch {
      return {
        original,
        ...(contentEncoding ? { contentEncoding } : {}),
        decoded: undefined,
        agentToolUseIds: [],
        unsafeReason: "malformed_payload",
        mutated: false,
        forwarded: false,
        receivedAt: Date.now(),
        indexedBytes: payload.length,
      };
    }
  }

  private agentToolUseIds(decoded: ProtoObject): string[] {
    const result = new Set<string>();
    for (const span of otlpSpans(decoded)) {
      const attrs = attributeMap(span);
      const name = String(span.name ?? "");
      const tool = attr(
        attrs,
        "tool.name",
        "tool_name",
        "gen_ai.tool.name",
        "claude_code.tool.name",
      );
      const toolUseId = attr(
        attrs,
        "tool_use_id",
        "claude_code.tool_use_id",
        "tool.use_id",
      );
      if (toolUseId && this.isAgentSpan(name, attrs, tool)) {
        result.add(toolUseId);
      }
    }
    return [...result];
  }

  private buffer(state: CapabilityState, batch: BufferedBatch): void {
    const wouldExceedCapability =
      state.graphBytes + state.pendingBytes + batch.indexedBytes >
      this.policy.maxCapabilityBufferedBytes;
    const wouldExceedGlobal =
      this.globalGraphBytes + this.globalBuffered + batch.indexedBytes >
      this.policy.maxGlobalBufferedBytes;
    if (batch.decoded && (wouldExceedCapability || wouldExceedGlobal)) {
      batch.decoded = undefined;
      batch.unsafeReason = "buffer_limit";
      this.logger.error(
        JSON.stringify({
          event: "otel_relay_buffer_degraded",
          reason: "buffer_limit",
        }),
      );
      for (const toolUseId of batch.agentToolUseIds) {
        state.evictedTools.set(toolUseId, {
          at: batch.receivedAt,
          reason: "buffer_limit",
        });
      }
      void this.forwardBatch(batch);
      return;
    }
    if (batch.decoded) {
      state.graphBytes += batch.indexedBytes;
      this.globalGraphBytes += batch.indexedBytes;
      this.indexBatch(state, batch);
    }
    state.pending.push(batch);
    state.pendingBytes += batch.original.length;
    this.globalBuffered += batch.original.length;
  }

  private indexBatch(state: CapabilityState, batch: BufferedBatch): void {
    for (const span of otlpSpans(batch.decoded!)) {
      const spanId = bytesHex(span.spanId);
      if (!spanId || state.graph.has(spanId)) continue;
      const attrs = attributeMap(span);
      const name = String(span.name ?? "");
      const tool = attr(
        attrs,
        "tool.name",
        "tool_name",
        "gen_ai.tool.name",
        "claude_code.tool.name",
      );
      const toolUseId = attr(
        attrs,
        "tool_use_id",
        "claude_code.tool_use_id",
        "tool.use_id",
      );
      const agent = this.isAgentSpan(name, attrs, tool);
      const record: SpanRecord = {
        span,
        batch,
        spanId,
        name,
        agent,
        ...(bytesHex(span.parentSpanId)
          ? { parentSpanId: bytesHex(span.parentSpanId)! }
          : {}),
        ...(toolUseId ? { toolUseId } : {}),
      };
      state.graph.set(spanId, record);
      if (agent && toolUseId && !state.nativeFirstSeen.has(toolUseId)) {
        state.nativeFirstSeen.set(toolUseId, batch.receivedAt);
      }
    }
  }

  private isAgentSpan(
    name: string,
    attrs: Map<string, unknown>,
    tool?: string,
  ): boolean {
    return (
      name === "claude_code.tool" &&
      (tool === "Agent" ||
        tool === "Task" ||
        Boolean(attr(attrs, "subagent_type", "claude_code.subagent_type")))
    );
  }

  private schedule(state: CapabilityState, delay: number): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void this.flush(state, false, "quiet_window").catch((error) =>
        this.logger.error(
          JSON.stringify({
            event: "otel_relay_flush_failed",
            reason: safeError(error),
          }),
        ),
      );
    }, delay);
    state.timer.unref();
  }

  private async flush(
    state: CapabilityState,
    force: boolean,
    reason: string,
  ): Promise<void> {
    state.flushing = state.flushing
      .catch((error) =>
        this.logger.error(
          JSON.stringify({
            event: "otel_relay_previous_flush_failed",
            reason: safeError(error),
          }),
        ),
      )
      .then(() => this.doFlush(state, force, reason));
    await state.flushing;
  }

  private async doFlush(
    state: CapabilityState,
    force: boolean,
    reason: string,
  ): Promise<void> {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    const now = Date.now();
    const settled = now >= state.lastActivityAt + this.policy.quietMs * 2;
    const keep = new Set<BufferedBatch>();

    for (const batch of state.pending) {
      if (batch.forwarded) continue;
      const agents = [...state.graph.values()].filter(
        (record) => record.batch === batch && record.agent,
      );
      if (!batch.decoded || agents.length === 0) {
        if (batch.agentToolUseIds.length > 0) {
          for (const toolUseId of batch.agentToolUseIds) {
            const metadata = state.metadata.get(toolUseId);
            if (metadata) {
              await this.options.callbacks?.markNativeSeen?.(
                metadata,
                batch.receivedAt,
              );
              await this.options.callbacks?.markForwardedUnenriched?.(
                metadata,
                batch.unsafeReason ?? "unsafe_payload",
              );
              this.options.callbacks?.onTerminal?.(metadata.linearSessionId);
              state.terminalTools.add(toolUseId);
            } else {
              state.evictedTools.set(toolUseId, {
                at: batch.receivedAt,
                reason: batch.unsafeReason ?? "unsafe_payload",
              });
            }
          }
        }
        await this.forwardBatch(batch);
        continue;
      }
      for (const agent of agents) {
        if (state.terminalTools.has(agent.toolUseId ?? "")) continue;
        const resolution = await this.resolveAgent(
          state,
          agent,
          now,
          force,
          settled,
          reason,
        );
        if (resolution === "retain") keep.add(batch);
      }
      if (!keep.has(batch)) await this.forwardBatch(batch);
    }

    state.pending = state.pending.filter((batch) => !batch.forwarded);
    const pendingBytes = state.pending.reduce(
      (sum, batch) => sum + batch.original.length,
      0,
    );
    const released = state.pendingBytes - pendingBytes;
    state.pendingBytes = pendingBytes;
    this.globalBuffered = Math.max(0, this.globalBuffered - released);
    if (state.pending.length && !force)
      this.schedule(state, Math.min(this.policy.quietMs, 1_000));
  }

  private async resolveAgent(
    state: CapabilityState,
    agent: SpanRecord,
    now: number,
    force: boolean,
    settled: boolean,
    forcedReason: string,
  ): Promise<"terminal" | "retain"> {
    const toolUseId = agent.toolUseId;
    if (!toolUseId) return "terminal";
    const firstSeen = state.nativeFirstSeen.get(toolUseId) ?? now;
    state.nativeFirstSeen.set(toolUseId, firstSeen);
    const metadata = state.metadata.get(toolUseId);
    const deadline =
      (metadata?.streamCompletedAt ?? firstSeen) + this.policy.hardDeadlineMs;
    const expired = now >= deadline;

    if (metadata) {
      const seen = await this.options.callbacks?.markNativeSeen?.(
        metadata,
        firstSeen,
      );
      if (seen === false) {
        state.terminalTools.add(toolUseId);
        this.options.callbacks?.onTerminal?.(metadata.linearSessionId);
        return "terminal";
      }
    }
    if ((!metadata || !metadata.report || !settled) && !force && !expired)
      return "retain";
    if (!metadata) {
      this.logger.error(
        JSON.stringify({
          event: "otel_relay_agent_degraded",
          reason: expired ? "metadata_deadline" : forcedReason,
        }),
      );
      state.terminalTools.add(toolUseId);
      return "terminal";
    }
    if (!metadata.report) {
      const degradation = expired ? "stream_result_deadline" : forcedReason;
      await this.options.callbacks?.markForwardedUnenriched?.(
        metadata,
        degradation,
      );
      state.terminalTools.add(toolUseId);
      this.options.callbacks?.onTerminal?.(metadata.linearSessionId);
      return "terminal";
    }

    const usage = this.usageForAgent(state, agent.spanId);
    const originalAttributes = cloneAttributes(agent.span);
    setStringAttribute(
      agent.span,
      "langfuse.observation.input",
      metadata.prompt,
    );
    setStringAttribute(
      agent.span,
      "langfuse.observation.output",
      metadata.report,
    );
    setStringAttribute(agent.span, "orchestra.agent.role", metadata.role);
    setStringAttribute(agent.span, "langfuse.observation.type", "span");
    setStringAttribute(
      agent.span,
      "orchestra.outcome",
      metadata.outcome ?? "success",
    );
    if (usage.model)
      setStringAttribute(agent.span, "orchestra.model", usage.model);
    setIntAttribute(
      agent.span,
      "orchestra.duration_ms",
      Math.max(
        0,
        timestampMs(agent.span.endTimeUnixNano) -
          timestampMs(agent.span.startTimeUnixNano),
      ),
    );
    setIntAttribute(
      agent.span,
      "orchestra.canonical_tokens.input",
      usage.inputTokens,
    );
    setIntAttribute(
      agent.span,
      "orchestra.canonical_tokens.output",
      usage.outputTokens,
    );
    setIntAttribute(
      agent.span,
      "orchestra.canonical_tokens.cache_creation",
      usage.cacheCreationTokens,
    );
    setIntAttribute(
      agent.span,
      "orchestra.canonical_tokens.cache_read",
      usage.cacheReadTokens,
    );
    setIntAttribute(
      agent.span,
      "orchestra.canonical_tokens.total",
      usage.inputTokens +
        usage.outputTokens +
        usage.cacheCreationTokens +
        usage.cacheReadTokens,
    );
    setBoolAttribute(agent.span, "orchestra.canonical_tokens.complete", true);
    const committed = await this.options.callbacks?.markEnriched?.(metadata, {
      spanId: agent.spanId,
      startedAt: timestampMs(agent.span.startTimeUnixNano),
      endedAt: timestampMs(agent.span.endTimeUnixNano),
      usage,
    });
    if (committed === false) agent.span.attributes = originalAttributes;
    else agent.batch.mutated = true;
    state.terminalTools.add(toolUseId);
    this.options.callbacks?.onTerminal?.(metadata.linearSessionId);
    return "terminal";
  }

  private usageForAgent(
    state: CapabilityState,
    agentSpanId: string,
  ): AgentUsage {
    const usage: AgentUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    for (const record of state.graph.values()) {
      if (record.name !== "claude_code.llm_request") continue;
      let parent = record.parentSpanId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const ancestor = state.graph.get(parent);
        if (!ancestor) break;
        if (ancestor.agent) {
          if (ancestor.spanId === agentSpanId) {
            const attrs = attributeMap(record.span);
            usage.inputTokens += numberAttr(
              attrs,
              "gen_ai.usage.input_tokens",
              "input_tokens",
            );
            usage.outputTokens += numberAttr(
              attrs,
              "gen_ai.usage.output_tokens",
              "output_tokens",
            );
            usage.cacheCreationTokens += numberAttr(
              attrs,
              "gen_ai.usage.cache_creation.input_tokens",
              "cache_creation_input_tokens",
            );
            usage.cacheReadTokens += numberAttr(
              attrs,
              "gen_ai.usage.cache_read.input_tokens",
              "cache_read_input_tokens",
            );
            const model = attr(
              attrs,
              "gen_ai.request.model",
              "gen_ai.response.model",
              "model",
            );
            if (model) usage.model = model;
          }
          break;
        }
        parent = ancestor.parentSpanId;
      }
    }
    return usage;
  }

  private async forwardBatch(batch: BufferedBatch): Promise<void> {
    if (batch.forwarded) return;
    const body =
      batch.mutated && batch.decoded
        ? Buffer.from(encodeOtlpTrace(batch.decoded))
        : batch.original;
    const encoding = batch.mutated ? undefined : batch.contentEncoding;
    batch.forwarded = true;
    await this.forward(body, encoding).catch((error) => {
      this.logger.error(
        JSON.stringify({
          event: "otel_relay_forward_failed",
          error: safeError(error),
        }),
      );
    });
  }

  private async settleEvictedTool(
    state: CapabilityState,
    metadata: AgentMetadata,
  ): Promise<void> {
    const evicted = state.evictedTools.get(metadata.toolUseId);
    if (!evicted || state.terminalTools.has(metadata.toolUseId)) return;
    state.evictedTools.delete(metadata.toolUseId);
    state.terminalTools.add(metadata.toolUseId);
    await this.options.callbacks?.markNativeSeen?.(metadata, evicted.at);
    await this.options.callbacks?.markForwardedUnenriched?.(
      metadata,
      evicted.reason,
    );
    this.options.callbacks?.onTerminal?.(metadata.linearSessionId);
  }

  private async forward(body: Buffer, contentEncoding?: string): Promise<void> {
    const response = await fetch(this.options.endpoint, {
      method: "POST",
      headers: {
        ...this.options.headers,
        "content-type": "application/x-protobuf",
        ...(contentEncoding ? { "content-encoding": contentEncoding } : {}),
      },
      body: new Uint8Array(body),
      redirect: "manual",
      signal: AbortSignal.timeout(this.policy.upstreamTimeoutMs),
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`upstream_${response.status}`);
  }

  private releaseGraph(state: CapabilityState): void {
    this.globalBuffered = Math.max(0, this.globalBuffered - state.pendingBytes);
    this.globalGraphBytes = Math.max(
      0,
      this.globalGraphBytes - state.graphBytes,
    );
    state.pending = [];
    state.pendingBytes = 0;
    state.graph.clear();
    state.graphBytes = 0;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    const states = [...this.states.values()];
    this.states.clear();
    for (const state of states) {
      if (state.timer) clearTimeout(state.timer);
      await this.flush(state, true, "relay_shutdown");
      this.releaseGraph(state);
    }
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    this.server = undefined;
  }
}
