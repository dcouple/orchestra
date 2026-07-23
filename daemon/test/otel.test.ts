import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSessionRoot,
  mintTraceContext,
  postTurnSpans,
  resolveOtlpTraces,
} from "../src/otel.js";

const servers: Array<{ close(callback: () => void): void }> = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(resolve))),
  );
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function closedEndpoint(): Promise<string> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1/traces`;
}

function input(endpoint: string, resultText: string | undefined) {
  return {
    traceContext: {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    },
    linearSessionId: "linear-session",
    issue: "ENG-42",
    turnId: 7,
    status: "response",
    startedAt: 1_700_000_000_123,
    finishedAt: 1_700_000_001_456,
    ...(resultText !== undefined ? { resultText } : {}),
    env: {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Basic abc==",
    },
  };
}

describe("OTLP turn spans", () => {
  it("mints unique valid W3C trace contexts", () => {
    const first = mintTraceContext();
    const second = mintTraceContext();
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(first.traceparent).toBe(`00-${first.traceId}-${first.spanId}-01`);
    expect(second.traceparent).not.toBe(first.traceparent);
  });

  it("resolves endpoint and header precedence with first-equals value splitting", () => {
    expect(resolveOtlpTraces({})).toBeUndefined();
    expect(
      resolveOtlpTraces({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.test/otel/",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic abc==, x-key = value",
      }),
    ).toEqual({
      endpoint: "https://example.test/otel/v1/traces",
      headers: { Authorization: "Basic abc==", "x-key": "value" },
    });
    expect(
      resolveOtlpTraces({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://base.test/otel",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.test/custom",
        OTEL_EXPORTER_OTLP_HEADERS: "base=ignored",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "trace=specific",
      }),
    ).toEqual({
      endpoint: "https://traces.test/custom",
      headers: { trace: "specific" },
    });
  });

  it("posts one linked turn envelope with response and canonical metadata", async () => {
    let received: {
      url?: string;
      authorization?: string;
      body?: Record<string, unknown>;
    } = {};
    const endpoint = await listen((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        received = {
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(raw) as Record<string, unknown>,
        };
        response.writeHead(200).end();
      });
    });
    await expect(
      postTurnSpans(input(`${endpoint}/v1/traces`, "answer")),
    ).resolves.toEqual({ ok: true });
    expect(received.url).toBe("/v1/traces");
    expect(received.authorization).toBe("Basic abc==");
    const resourceSpans = received.body!.resourceSpans as Array<
      Record<string, unknown>
    >;
    const resource = resourceSpans[0]!.resource as { attributes: unknown[] };
    expect(resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "linear-agent-daemon" },
    });
    const scopeSpans = resourceSpans[0]!.scopeSpans as Array<{
      spans: Array<Record<string, unknown>>;
    }>;
    const [turn] = scopeSpans[0]!.spans;
    expect(scopeSpans[0]!.spans).toHaveLength(1);
    expect(turn).toMatchObject({
      traceId: "a".repeat(32),
      parentSpanId: "b".repeat(16),
      name: "orchestra.turn",
      startTimeUnixNano: "1700000000123000000",
      endTimeUnixNano: "1700000001456000000",
    });
    expect(turn!.attributes).toEqual(
      expect.arrayContaining([
        { key: "linear.session_id", value: { stringValue: "linear-session" } },
        { key: "linear.issue", value: { stringValue: "ENG-42" } },
        { key: "turn.id", value: { stringValue: "7" } },
        { key: "turn.status", value: { stringValue: "response" } },
        {
          key: "langfuse.observation.output",
          value: { stringValue: "answer" },
        },
        { key: "orchestra.canonical_tokens.total", value: { intValue: "0" } },
      ]),
    );
  });

  it("builds one late root with exact completed aggregates", () => {
    const root = buildSessionRoot(
      {
        linearSessionId: "s",
        app: "planner",
        issueId: "i",
        issueIdentifier: "ENG-1",
        worktreePath: null,
        branch: null,
        claudeSessionId: null,
        runtime: "claude",
        fallbackCause: null,
        profile: "fable",
        profileFallback: null,
        mode: "planner",
        status: "active",
        lastSeenAt: 1,
        lastSeenActivityAt: null,
        traceId: "a".repeat(32),
        rootSpanId: "b".repeat(16),
        startedAt: 1000,
        completedAt: null,
      },
      {
        canonicalTokens: 42,
        invocationCount: 3,
        roles: ["implementer", "reviewer"],
        complete: false,
        degradedCount: 1,
      },
      5000,
    );
    expect(root).toMatchObject({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "orchestra.session",
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "5000000000",
    });
    expect(root.attributes).toEqual(
      expect.arrayContaining([
        { key: "orchestra.canonical_tokens.total", value: { intValue: "42" } },
        { key: "orchestra.telemetry_complete", value: { boolValue: false } },
        {
          key: "orchestra.invocation.roles",
          value: { stringValue: "implementer,reviewer" },
        },
      ]),
    );
  });

  it("omits the assistant response span when resultText is absent", async () => {
    let spanCount = 0;
    const endpoint = await listen((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw) as {
          resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
        };
        spanCount = body.resourceSpans[0]!.scopeSpans[0]!.spans.length;
        response.end();
      });
    });
    await expect(
      postTurnSpans(input(`${endpoint}/v1/traces`, undefined)),
    ).resolves.toEqual({ ok: true });
    expect(spanCount).toBe(1);
  });

  it.each([401, 500])(
    "returns a body-free HTTP error for status %s",
    async (status) => {
      const endpoint = await listen((_request, response) =>
        response.writeHead(status).end("sensitive response body"),
      );
      await expect(
        postTurnSpans(input(`${endpoint}/v1/traces`, "answer")),
      ).resolves.toEqual({ ok: false, error: `http ${status}` });
    },
  );

  it("never rejects when the collector connection is refused", async () => {
    await expect(
      postTurnSpans(input(await closedEndpoint(), "answer")),
    ).resolves.toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("resolves fail-open when a collector accepts the request but never responds", async () => {
    const endpoint = await listen((_request, _response) => {});
    await expect(
      postTurnSpans({
        ...input(`${endpoint}/v1/traces`, "answer"),
        timeoutMs: 200,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.any(String) });
  });
});
