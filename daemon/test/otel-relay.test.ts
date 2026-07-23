import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  attributeMap,
  decodeOtlpTrace,
  encodeOtlpTrace,
  otlpSpans,
  type ProtoObject,
} from "../src/otel-proto.js";
import {
  OtlpRelay,
  type AgentMetadata,
  type AgentUsage,
} from "../src/otel-relay.js";

const relays: OtlpRelay[] = [];
const servers: Array<{
  close(callback: () => void): void;
  closeAllConnections(): void;
}> = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out");
    await delay(5);
  }
}

async function upstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/fixed/v1/traces`;
}

function kv(key: string, value: string | number): ProtoObject {
  return {
    key,
    value:
      typeof value === "number"
        ? { intValue: String(value) }
        : { stringValue: value },
  };
}

function id(hex: string): Buffer {
  return Buffer.from(hex.repeat(hex.length === 1 ? 16 : 1), "hex");
}

function agent(
  spanId: string,
  parentSpanId: string,
  toolUseId: string,
  start = 1,
  end = 9,
): ProtoObject {
  return {
    traceId: id("a".repeat(32)),
    spanId: id(spanId),
    parentSpanId: id(parentSpanId),
    name: "claude_code.tool",
    startTimeUnixNano: String(start * 1_000_000),
    endTimeUnixNano: String(end * 1_000_000),
    attributes: [kv("tool.name", "Agent"), kv("tool_use_id", toolUseId)],
  };
}

function llm(
  spanId: string,
  parentSpanId: string,
  input: number,
  output: number,
  model: string,
): ProtoObject {
  return {
    traceId: id("a".repeat(32)),
    spanId: id(spanId),
    parentSpanId: id(parentSpanId),
    name: "claude_code.llm_request",
    startTimeUnixNano: "2000000",
    endTimeUnixNano: "4000000",
    attributes: [
      kv("gen_ai.usage.input_tokens", input),
      kv("gen_ai.usage.output_tokens", output),
      kv("gen_ai.request.model", model),
    ],
  };
}

function fixture(...spans: ProtoObject[]): Buffer {
  return Buffer.from(
    encodeOtlpTrace({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
  );
}

function metadata(toolUseId: string, role = "researcher"): AgentMetadata {
  return {
    linearSessionId: "session",
    toolUseId,
    role,
    prompt: `prompt:${toolUseId}`,
    report: `report:${toolUseId}`,
    outcome: "success",
    streamCompletedAt: Date.now(),
  };
}

function postHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { "content-type": "application/x-protobuf", ...extra };
}

function holdPost(
  url: string,
  contentLength = 4,
): {
  finish(): void;
  response: Promise<number>;
} {
  let resolveStatus!: (status: number) => void;
  const response = new Promise<number>((resolve) => {
    resolveStatus = resolve;
  });
  const request = httpRequest(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-protobuf",
        "content-length": String(contentLength),
      },
    },
    (result) => {
      resolveStatus(result.statusCode ?? 0);
      result.resume();
    },
  );
  request.flushHeaders();
  return {
    finish: () => request.end(Buffer.alloc(contentLength)),
    response,
  };
}

describe("OTLP capability relay", () => {
  it("ships the exact phase-4 lifetime and finite admission policy", async () => {
    const endpoint = await upstream((_request, response) => response.end());
    const relay = new OtlpRelay({ endpoint, headers: {} });
    relays.push(relay);
    const policy = (relay as unknown as { policy: Record<string, number> })
      .policy;
    expect(policy).toMatchObject({
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
    });
  });

  it("reconciles nested and parallel Agent usage across export requests before forwarding each original Agent", async () => {
    const forwarded: Buffer[] = [];
    const commits = new Map<string, AgentUsage>();
    const endpoint = await upstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        forwarded.push(Buffer.concat(chunks));
        response.end();
      });
    });
    const relay = new OtlpRelay({
      endpoint,
      headers: { Authorization: "fixed-secret" },
      quietMs: 5,
      callbacks: {
        markNativeSeen: () => true,
        markEnriched: (value, input) => {
          commits.set(value.toolUseId, input.usage);
          return true;
        },
      },
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    for (const value of [
      metadata("outer", "researcher"),
      metadata("nested", "reviewer"),
      metadata("parallel", "verifier"),
    ]) {
      relay.registerAgent(capability, value);
      relay.completeAgent(capability, value);
    }

    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          headers: postHeaders(),
          body: fixture(
            llm("d".repeat(16), "b".repeat(16), 7, 3, "outer-model"),
          ),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          headers: postHeaders(),
          body: fixture(
            agent("e".repeat(16), "b".repeat(16), "nested"),
            llm("f".repeat(16), "e".repeat(16), 4, 1, "nested-model"),
          ),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          headers: postHeaders(),
          body: fixture(
            agent("b".repeat(16), "c".repeat(16), "outer"),
            agent("1".repeat(16), "c".repeat(16), "parallel"),
          ),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          headers: postHeaders(),
          body: fixture(
            llm("2".repeat(16), "1".repeat(16), 2, 4, "parallel-model"),
          ),
        })
      ).status,
    ).toBe(200);

    await delay(20);
    await relay.flushSession("session");
    await waitFor(() => commits.size === 3 && forwarded.length === 4);
    expect(commits.get("outer")).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      model: "outer-model",
    });
    expect(commits.get("nested")).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
      model: "nested-model",
    });
    expect(commits.get("parallel")).toMatchObject({
      inputTokens: 2,
      outputTokens: 4,
      model: "parallel-model",
    });
    expect(
      commits.get("outer")!.inputTokens + commits.get("outer")!.outputTokens,
    ).toBe(10);

    const agentSpans = forwarded
      .flatMap((body) => otlpSpans(decodeOtlpTrace(body)))
      .filter((span) => span.name === "claude_code.tool");
    expect(agentSpans).toHaveLength(3);
    const totals = agentSpans
      .map((span) =>
        Number(attributeMap(span).get("orchestra.canonical_tokens.total")),
      )
      .sort((left, right) => left - right);
    expect(totals).toEqual([5, 6, 10]);
  });

  it("retains a native Agent that arrives before stream registration", async () => {
    const order: string[] = [];
    let forwarded = 0;
    const endpoint = await upstream((_request, response) => {
      forwarded += 1;
      order.push("forward");
      response.end();
    });
    const relay = new OtlpRelay({
      endpoint,
      headers: {},
      quietMs: 5,
      hardDeadlineMs: 100,
      callbacks: {
        markNativeSeen: () => {
          order.push("seen");
          return true;
        },
        markEnriched: () => {
          order.push("commit");
          return true;
        },
      },
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    await fetch(capability.endpoint, {
      method: "POST",
      headers: postHeaders(),
      body: fixture(
        agent("b".repeat(16), "c".repeat(16), "late"),
        llm("d".repeat(16), "b".repeat(16), 3, 2, "model"),
      ),
    });
    await delay(20);
    expect(forwarded).toBe(0);

    const value = metadata("late");
    relay.registerAgent(capability, { ...value, report: undefined });
    relay.completeAgent(capability, value);
    await delay(20);
    await relay.flushSession("session");
    await waitFor(() => forwarded === 1);
    expect(order).toEqual(["seen", "commit", "forward"]);
  });

  it("records a bounded degraded terminal state when stream correlation never completes", async () => {
    const degradations: string[] = [];
    let forwards = 0;
    const endpoint = await upstream((_request, response) => {
      forwards += 1;
      response.end();
    });
    const relay = new OtlpRelay({
      endpoint,
      headers: {},
      quietMs: 2,
      hardDeadlineMs: 15,
      callbacks: {
        markNativeSeen: () => true,
        markForwardedUnenriched: (_value, reason) => {
          degradations.push(reason);
          return true;
        },
      },
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    const pending = metadata("deadline");
    delete pending.report;
    relay.registerAgent(capability, pending);
    await fetch(capability.endpoint, {
      method: "POST",
      body: fixture(agent("b".repeat(16), "c".repeat(16), "deadline")),
    });
    await waitFor(() => forwards === 1, 500);
    expect(degradations).toEqual(["stream_result_deadline"]);
  });

  it("forwards unchanged when a durable terminal state wins and never invokes late enrichment", async () => {
    let enriched = 0;
    let received: Buffer | undefined;
    const endpoint = await upstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received = Buffer.concat(chunks);
        response.end();
      });
    });
    const relay = new OtlpRelay({
      endpoint,
      headers: {},
      quietMs: 2,
      callbacks: {
        markNativeSeen: () => false,
        markEnriched: () => {
          enriched += 1;
          return true;
        },
      },
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    const value = metadata("terminal");
    relay.registerAgent(capability, value);
    relay.completeAgent(capability, value);
    const original = fixture(agent("b".repeat(16), "c".repeat(16), "terminal"));
    await fetch(capability.endpoint, { method: "POST", body: original });
    await waitFor(() => received !== undefined);
    expect(received).toEqual(original);
    expect(enriched).toBe(0);
  });

  it("forwards valid gzip as valid protobuf and preserves malformed gzip/protobuf byte-for-byte", async () => {
    const received: Array<{ body: Buffer; encoding?: string }> = [];
    const endpoint = await upstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push({
          body: Buffer.concat(chunks),
          ...(request.headers["content-encoding"]
            ? { encoding: String(request.headers["content-encoding"]) }
            : {}),
        });
        response.end();
      });
    });
    const relay = new OtlpRelay({ endpoint, headers: {}, quietMs: 3 });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    const valid = gzipSync(
      fixture(llm("d".repeat(16), "c".repeat(16), 1, 1, "model")),
    );
    const malformed = Buffer.from("not-gzip");
    const malformedProtobuf = Buffer.from([0xff, 0xff, 0xff]);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          headers: postHeaders({ "content-encoding": "gzip" }),
          body: valid,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          headers: postHeaders({ "content-encoding": "gzip" }),
          body: malformed,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          headers: postHeaders(),
          body: malformedProtobuf,
        })
      ).status,
    ).toBe(200);
    await delay(20);
    await relay.flushSession("session");
    await waitFor(() => received.length === 3);
    expect(received[0]).toEqual({ body: valid, encoding: "gzip" });
    expect(received[1]).toEqual({ body: malformed, encoding: "gzip" });
    expect(received[2]).toEqual({ body: malformedProtobuf });
    expect(
      otlpSpans(decodeOtlpTrace(gunzipSync(received[0]!.body))),
    ).toHaveLength(1);
  });

  it("forwards protobuf with an unsupported future wire field byte-for-byte instead of dropping it", async () => {
    let received: Buffer | undefined;
    const endpoint = await upstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received = Buffer.concat(chunks);
        response.end();
      });
    });
    const relay = new OtlpRelay({ endpoint, headers: {}, quietMs: 3 });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    const future = Buffer.concat([
      fixture(agent("b".repeat(16), "c".repeat(16), "future")),
      Buffer.from([0x9a, 0x06, 0x01, 0x7f]),
    ]);
    const value = metadata("future");
    relay.registerAgent(capability, value);
    relay.completeAgent(capability, value);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          headers: postHeaders(),
          body: future,
        })
      ).status,
    ).toBe(200);
    await delay(20);
    await relay.flushSession("session");
    await waitFor(() => received !== undefined);
    expect(received).toEqual(future);
  });

  it("reserves request count, cumulative bytes, and per-capability concurrency before awaiting bodies", async () => {
    const endpoint = await upstream((_request, response) => response.end());
    const relay = new OtlpRelay({
      endpoint,
      headers: {},
      maxRequests: 2,
      maxBytes: 100,
      maxRequestBytes: 4,
      maxCapabilityConcurrency: 1,
      quietMs: 3,
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    const held = holdPost(capability.endpoint, 4);
    await delay(10);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          body: Buffer.alloc(2),
        })
      ).status,
    ).toBe(429);
    held.finish();
    expect(await held.response).toBe(200);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          body: Buffer.alloc(3),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          body: Buffer.alloc(1),
        })
      ).status,
    ).toBe(429);
  });

  it("enforces per-request and cumulative-byte budgets", async () => {
    const endpoint = await upstream((_request, response) => response.end());
    const relay = new OtlpRelay({
      endpoint,
      headers: {},
      maxRequests: 10,
      maxBytes: 6,
      maxRequestBytes: 4,
      quietMs: 3,
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          body: Buffer.alloc(5),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          body: Buffer.alloc(4),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          body: Buffer.alloc(3),
        })
      ).status,
    ).toBe(413);
  });

  it("reserves cumulative bytes across simultaneous streaming requests", async () => {
    const endpoint = await upstream((_request, response) => response.end());
    const relay = new OtlpRelay({
      endpoint,
      headers: {},
      maxBytes: 6,
      maxRequestBytes: 4,
      maxCapabilityConcurrency: 2,
      quietMs: 3,
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    const held = holdPost(capability.endpoint, 4);
    await delay(10);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          body: Buffer.alloc(4),
        })
      ).status,
    ).toBe(413);
    held.finish();
    expect(await held.response).toBe(200);
  });

  it("enforces the global concurrency limit across capabilities", async () => {
    const endpoint = await upstream((_request, response) => response.end());
    const relay = new OtlpRelay({
      endpoint,
      headers: {},
      maxGlobalConcurrency: 1,
      quietMs: 3,
    });
    relays.push(relay);
    await relay.start();
    const first = relay.createCapability({
      linearSessionId: "one",
      traceId: "a".repeat(32),
      turnSpanId: "b".repeat(16),
    });
    const second = relay.createCapability({
      linearSessionId: "two",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    const held = holdPost(first.endpoint, 4);
    await delay(10);
    expect(
      (await fetch(second.endpoint, { method: "POST", body: Buffer.alloc(1) }))
        .status,
    ).toBe(429);
    held.finish();
    expect(await held.response).toBe(200);
  });

  it("forwards unchanged at per-capability and global decoded-buffer ceilings", async () => {
    const received: Buffer[] = [];
    const endpoint = await upstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push(Buffer.concat(chunks));
        response.end();
      });
    });
    const body = fixture(agent("b".repeat(16), "c".repeat(16), "limited"));
    const relay = new OtlpRelay({
      endpoint,
      headers: {},
      maxCapabilityBufferedBytes: body.length - 1,
      maxGlobalBufferedBytes: body.length - 1,
      quietMs: 3,
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    const value = metadata("limited");
    relay.registerAgent(capability, value);
    relay.completeAgent(capability, value);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          headers: postHeaders(),
          body,
        })
      ).status,
    ).toBe(200);
    await delay(20);
    await relay.flushSession("session");
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual(body);
  });

  it("enforces the global decoded-buffer ceiling across capabilities", async () => {
    const received: Buffer[] = [];
    const endpoint = await upstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push(Buffer.concat(chunks));
        response.end();
      });
    });
    const firstBody = fixture(agent("b".repeat(16), "c".repeat(16), "first"));
    const secondBody = fixture(agent("d".repeat(16), "c".repeat(16), "second"));
    const relay = new OtlpRelay({
      endpoint,
      headers: {},
      maxCapabilityBufferedBytes: 10_000,
      maxGlobalBufferedBytes: firstBody.length * 2 + secondBody.length - 1,
      quietMs: 20,
      hardDeadlineMs: 100,
    });
    relays.push(relay);
    await relay.start();
    const first = relay.createCapability({
      linearSessionId: "first",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    const second = relay.createCapability({
      linearSessionId: "second",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    expect(
      (await fetch(first.endpoint, { method: "POST", body: firstBody })).status,
    ).toBe(200);
    expect(
      (await fetch(second.endpoint, { method: "POST", body: secondBody }))
        .status,
    ).toBe(200);
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual(secondBody);
  });

  it("expires and prunes capabilities at their maximum lifetime without normal-completion revocation", async () => {
    const endpoint = await upstream((_request, response) => response.end());
    const relay = new OtlpRelay({
      endpoint,
      headers: {},
      ttlMs: 25,
      pruneMs: 5,
      quietMs: 2,
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          body: Buffer.alloc(0),
        })
      ).status,
    ).toBe(200);
    await delay(40);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          body: Buffer.alloc(0),
        })
      ).status,
    ).toBe(404);
  });

  it("invalidates capabilities on shutdown", async () => {
    const endpoint = await upstream((_request, response) => response.end());
    const relay = new OtlpRelay({ endpoint, headers: {} });
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    await relay.close();
    await expect(
      fetch(capability.endpoint, { method: "POST", body: Buffer.alloc(0) }),
    ).rejects.toThrow();
  });

  it("confines upstream origin/auth, refuses redirects, times out upstream, and remains fail-open to callers", async () => {
    let fixedRequests = 0;
    let redirectedRequests = 0;
    let auth: string | undefined;
    const redirected = await upstream((_request, response) => {
      redirectedRequests += 1;
      response.end();
    });
    const redirectEndpoint = await upstream((request, response) => {
      fixedRequests += 1;
      auth = request.headers.authorization;
      response.writeHead(307, { location: redirected }).end();
    });
    const relay = new OtlpRelay({
      endpoint: redirectEndpoint,
      headers: { Authorization: "fixed-auth" },
      quietMs: 2,
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: "a".repeat(32),
      turnSpanId: "c".repeat(16),
    });
    expect(
      (
        await fetch(
          `${capability.endpoint}?endpoint=${encodeURIComponent(redirected)}`,
          {
            method: "POST",
            headers: {
              Authorization: "caller-auth",
              "x-forward-to": redirected,
            },
            body: Buffer.alloc(0),
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          headers: { Authorization: "caller-auth" },
          body: Buffer.alloc(0),
        })
      ).status,
    ).toBe(200);
    await delay(20);
    expect(fixedRequests).toBe(1);
    expect(redirectedRequests).toBe(0);
    expect(auth).toBe("fixed-auth");

    const timeoutEndpoint = await upstream((_request, _response) => {});
    const timeoutRelay = new OtlpRelay({
      endpoint: timeoutEndpoint,
      headers: {},
      quietMs: 1,
      upstreamTimeoutMs: 10,
    });
    relays.push(timeoutRelay);
    await timeoutRelay.start();
    const timeoutCapability = timeoutRelay.createCapability({
      linearSessionId: "timeout",
      traceId: "a".repeat(32),
      turnSpanId: "d".repeat(16),
    });
    expect(
      (
        await fetch(timeoutCapability.endpoint, {
          method: "POST",
          body: Buffer.alloc(0),
        })
      ).status,
    ).toBe(200);
    await delay(30);
  });
});
