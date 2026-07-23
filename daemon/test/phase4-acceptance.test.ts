import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, type CodexInvocationInput } from "../src/eventlog.js";
import {
  attributeMap,
  decodeOtlpTrace,
  encodeOtlpTrace,
  otlpSpans,
  type ProtoObject,
} from "../src/otel-proto.js";
import { OtlpRelay } from "../src/otel-relay.js";
import {
  buildInvocationSpan,
  buildSessionRoot,
  buildTurnSpan,
  type OtlpAttribute,
} from "../src/otel.js";

const directories: string[] = [];
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
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "phase4-acceptance-"));
  directories.push(directory);
  return join(directory, "events.db");
}

function append(
  log: EventLog,
  deliveryId: string,
  action: "created" | "prompted",
  receivedAt: number,
): void {
  log.append({
    deliveryId,
    app: "implementer",
    action,
    agentSessionId: "session",
    ...(action === "prompted" ? { sourceActivityId: deliveryId } : {}),
    issueId: "issue",
    issueIdentifier: "ENG-42",
    receivedAt,
    rawBody: Buffer.from("{}"),
  });
}

function finishTurn(
  log: EventLog,
  spanId: string,
  prompt: string,
  response: string,
  startedAt: number,
  endedAt: number,
): number {
  const turn = log.claimNextTurn(startedAt)!;
  const traceId = log.getSession("session")!.traceId;
  log.setTurnTraceContext(turn.id, traceId, spanId);
  log.setTurnPrompt(turn.id, prompt);
  log.finishTurn(turn.id, "response", response, endedAt, undefined, false, {
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    costUsd: 0.1,
    model: "orchestrator-model",
  });
  log.markTurnActivityPosted(turn.id, endedAt + 1);
  return turn.id;
}

function attributes(
  values: OtlpAttribute[],
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    values.map((attribute) => {
      const value = attribute.value;
      if ("stringValue" in value) return [attribute.key, value.stringValue];
      if ("intValue" in value) return [attribute.key, Number(value.intValue)];
      if ("boolValue" in value) return [attribute.key, value.boolValue];
      return [attribute.key, value.doubleValue];
    }),
  );
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

function nativeFixture(): Buffer {
  return Buffer.from(
    encodeOtlpTrace({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: Buffer.from("a".repeat(32), "hex"),
                  spanId: Buffer.from("b".repeat(16), "hex"),
                  parentSpanId: Buffer.from("c".repeat(16), "hex"),
                  name: "claude_code.tool",
                  startTimeUnixNano: "100000000",
                  endTimeUnixNano: "300000000",
                  attributes: [
                    kv("tool.name", "Agent"),
                    kv("tool_use_id", "agent-1"),
                  ],
                },
                {
                  traceId: Buffer.from("a".repeat(32), "hex"),
                  spanId: Buffer.from("d".repeat(16), "hex"),
                  parentSpanId: Buffer.from("b".repeat(16), "hex"),
                  name: "claude_code.llm_request",
                  startTimeUnixNano: "120000000",
                  endTimeUnixNano: "220000000",
                  attributes: [
                    kv("gen_ai.usage.input_tokens", 5),
                    kv("gen_ai.usage.output_tokens", 7),
                    kv("gen_ai.usage.cache_creation.input_tokens", 2),
                    kv("gen_ai.usage.cache_read.input_tokens", 3),
                    kv("gen_ai.request.model", "claude-agent-model"),
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("phase 4 acceptance contract", () => {
  it("AC1 retains one trace/root through multiple user turns, marker resumption, and SQLite reopen", () => {
    const path = databasePath();
    let log = new EventLog(path);
    append(log, "created", "created", 100);
    const firstTurn = finishTurn(
      log,
      "1".repeat(16),
      "first prompt",
      "first response",
      110,
      120,
    );
    append(log, "user-followup", "prompted", 130);
    const secondTurn = finishTurn(
      log,
      "2".repeat(16),
      "second prompt",
      "second response",
      140,
      150,
    );
    const original = log.getSession("session")!;
    log.close();

    log = new EventLog(path);
    expect(log.getSession("session")).toMatchObject({
      traceId: original.traceId,
      rootSpanId: original.rootSpanId,
    });
    log.ingestCodexMarker(
      {
        linearSessionId: "session",
        turnId: secondTurn,
        sourceKey: "dispatch:session:marker.done",
        role: "verifier",
        prompt: "verify",
        report: "verified",
        startedAt: 145,
        endedAt: 149,
        deadlineAt: 1_045,
        outcome: "success",
        model: "codex-model",
        traceId: original.traceId,
        spanId: "4".repeat(16),
        providerConversationId: "thread-1",
        providerTurnId: "provider-turn-1",
        mode: "fresh",
        cumulativeTotalTokens: 20,
      },
      {
        deliveryId: "dispatch:session:marker.done",
        app: "implementer",
        action: "prompted",
        agentSessionId: "session",
        sourceActivityId: "dispatch:marker.done",
        issueId: "issue",
        issueIdentifier: "ENG-42",
        receivedAt: 160,
        rawBody: Buffer.from("{}"),
      },
      160,
    );
    const markerTurn = finishTurn(
      log,
      "3".repeat(16),
      "marker resume",
      "continued",
      170,
      180,
    );
    expect([firstTurn, secondTurn, markerTurn]).toEqual([1, 2, 3]);

    const db = new Database(path, { readonly: true });
    const turns = db
      .prepare(
        "SELECT trace_id traceId,turn_span_id turnSpanId FROM turns ORDER BY id",
      )
      .all() as Array<{ traceId: string; turnSpanId: string }>;
    db.close();
    expect(new Set(turns.map((turn) => turn.traceId))).toEqual(
      new Set([original.traceId]),
    );
    expect(new Set(turns.map((turn) => turn.turnSpanId)).size).toBe(3);
    expect(log.invocations("session")[0]).toMatchObject({
      turnId: secondTurn,
      traceId: original.traceId,
    });

    const root = buildSessionRoot(
      log.getSession("session")!,
      log.aggregateSession("session"),
      200,
    );
    const firstOutbox = log.materializeOutbox(
      "session",
      JSON.stringify([root]),
      200,
    );
    const secondOutbox = log.materializeOutbox(
      "session",
      JSON.stringify([{ name: "replacement" }]),
      300,
    );
    expect(secondOutbox.payload).toBe(firstOutbox.payload);
    const roots = JSON.parse(firstOutbox.payload) as Array<{
      name: string;
      traceId: string;
      spanId: string;
    }>;
    expect(roots).toEqual([
      expect.objectContaining({
        name: "orchestra.session",
        traceId: original.traceId,
        spanId: original.rootSpanId,
      }),
    ]);
    log.close();
  });

  it("AC2 and AC3 expose one completed summary and one rich orchestrator span with four token classes", () => {
    const session = {
      linearSessionId: "session",
      app: "implementer" as const,
      issueId: "issue",
      issueIdentifier: "ENG-42",
      worktreePath: null,
      branch: null,
      claudeSessionId: "claude-session",
      runtime: "claude" as const,
      fallbackCause: null,
      profile: "fable" as const,
      profileFallback: null,
      mode: "implementer",
      status: "active",
      lastSeenAt: 100,
      lastSeenActivityAt: null,
      traceId: "a".repeat(32),
      rootSpanId: "b".repeat(16),
      startedAt: 100,
      completedAt: null,
    };
    const root = buildSessionRoot(
      session,
      {
        canonicalTokens: 123,
        invocationCount: 4,
        roles: ["researcher", "verifier"],
        complete: true,
        degradedCount: 0,
      },
      500,
    );
    const rootAttrs = attributes(root.attributes);
    expect(root).toMatchObject({
      name: "orchestra.session",
      traceId: session.traceId,
      spanId: session.rootSpanId,
      startTimeUnixNano: "100000000",
      endTimeUnixNano: "500000000",
      status: { code: 1 },
    });
    expect(rootAttrs).toMatchObject({
      "orchestra.session.status": "completed",
      "orchestra.duration_ms": 400,
      "orchestra.canonical_tokens.total": 123,
      "orchestra.canonical_tokens.complete": true,
      "orchestra.telemetry_complete": true,
      "orchestra.invocation.count": 4,
      "orchestra.invocation.role_count": 2,
      "orchestra.invocation.roles": "researcher,verifier",
    });

    const turn = buildTurnSpan({
      traceId: session.traceId,
      rootSpanId: session.rootSpanId,
      turnSpanId: "c".repeat(16),
      linearSessionId: "session",
      issue: "ENG-42",
      turnId: 7,
      prompt: "implement it",
      response: "implemented",
      runtime: "claude",
      profile: "fable",
      model: "claude-model",
      status: "response",
      startedAt: 200,
      finishedAt: 350,
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
    });
    const turnAttrs = attributes(turn.attributes);
    expect(turn).toMatchObject({
      name: "orchestra.turn",
      parentSpanId: session.rootSpanId,
      startTimeUnixNano: "200000000",
      endTimeUnixNano: "350000000",
    });
    expect(turnAttrs).toMatchObject({
      "langfuse.observation.input": "implement it",
      "langfuse.observation.output": "implemented",
      "orchestra.runtime": "claude",
      "orchestra.profile": "fable",
      "orchestra.model": "claude-model",
      "turn.status": "response",
      "orchestra.outcome": "response",
      "orchestra.duration_ms": 150,
      "orchestra.canonical_tokens.input": 10,
      "orchestra.canonical_tokens.output": 20,
      "orchestra.canonical_tokens.cache_creation": 30,
      "orchestra.canonical_tokens.cache_read": 40,
      "orchestra.canonical_tokens.total": 100,
    });
  });

  it("AC4 and AC5 produce exactly one rich Claude Agent and Codex row with native nesting and real overlap", async () => {
    const path = databasePath();
    const log = new EventLog(path);
    append(log, "created", "created", 1);
    const turn = log.claimNextTurn(2)!;
    const session = log.getSession("session")!;
    log.setTurnTraceContext(turn.id, session.traceId, "c".repeat(16));
    log.claimClaudeInvocation({
      linearSessionId: "session",
      turnId: turn.id,
      toolUseId: "agent-1",
      role: "researcher",
      prompt: "inspect",
      traceId: session.traceId,
      startedAt: 100,
    });
    log.completeClaudeStream(
      "session",
      "agent-1",
      "inspection complete",
      "success",
      300,
      Date.now() + 1_000,
    );

    let forwarded: Buffer | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        forwarded = Buffer.concat(chunks);
        response.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const relay = new OtlpRelay({
      endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/fixed`,
      headers: {},
      quietMs: 3,
      callbacks: {
        markNativeSeen: (value, at) =>
          log.markClaudeNativeSeen(value.linearSessionId, value.toolUseId, at),
        markEnriched: (value, input) =>
          log.enrichClaudeInvocation({
            linearSessionId: value.linearSessionId,
            toolUseId: value.toolUseId,
            spanId: input.spanId,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            ...input.usage,
          }),
      },
    });
    relays.push(relay);
    await relay.start();
    const capability = relay.createCapability({
      linearSessionId: "session",
      traceId: session.traceId,
      turnSpanId: "c".repeat(16),
    });
    const metadata = {
      linearSessionId: "session",
      toolUseId: "agent-1",
      role: "researcher",
      prompt: "inspect",
      report: "inspection complete",
      outcome: "success",
      streamCompletedAt: Date.now(),
    };
    relay.registerAgent(capability, metadata);
    relay.completeAgent(capability, metadata);
    expect(
      (
        await fetch(capability.endpoint, {
          method: "POST",
          body: nativeFixture(),
        })
      ).status,
    ).toBe(200);
    await delay(15);
    await relay.flushSession("session");
    await delay(10);

    log.ingestCodexInvocation({
      linearSessionId: "session",
      turnId: turn.id,
      sourceKey: "dispatch:codex",
      role: "verifier",
      prompt: "verify",
      report: "verified",
      startedAt: 150,
      endedAt: 250,
      deadlineAt: 1_050,
      outcome: "success",
      model: "codex-model",
      traceId: session.traceId,
      spanId: "e".repeat(16),
      providerConversationId: "codex-thread",
      providerTurnId: "codex-turn",
      mode: "fresh",
      cumulativeTotalTokens: 11,
    });
    const rows = log.invocations("session");
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "claude",
          role: "researcher",
          prompt: "inspect",
          report: "inspection complete",
          model: "claude-agent-model",
          startedAt: 100,
          endedAt: 300,
          inputTokens: 5,
          outputTokens: 7,
          cacheCreationTokens: 2,
          cacheReadTokens: 3,
          enrichmentState: "enriched",
        }),
        expect.objectContaining({
          source: "codex",
          role: "verifier",
          prompt: "verify",
          report: "verified",
          model: "codex-model",
          startedAt: 150,
          endedAt: 250,
          deltaTotalTokens: 11,
        }),
      ]),
    );
    expect(
      rows[0]!.startedAt! < rows[1]!.endedAt! &&
        rows[1]!.startedAt! < rows[0]!.endedAt!,
    ).toBe(true);

    const native = otlpSpans(decodeOtlpTrace(forwarded!));
    expect(
      native.filter((span) => span.name === "claude_code.tool"),
    ).toHaveLength(1);
    expect(
      native.find((span) => span.name === "claude_code.llm_request")
        ?.parentSpanId,
    ).toEqual(Buffer.from("b".repeat(16), "hex"));
    expect(
      attributes(
        native.find((span) => span.name === "claude_code.tool")!.attributes,
      ),
    ).toMatchObject({
      "langfuse.observation.type": "span",
      "orchestra.agent.role": "researcher",
      "orchestra.duration_ms": 200,
      "orchestra.canonical_tokens.total": 17,
    });
    const codex = buildInvocationSpan(
      rows.find((row) => row.source === "codex")!,
      "c".repeat(16),
    );
    expect(codex).toMatchObject({
      parentSpanId: "c".repeat(16),
      startTimeUnixNano: "150000000",
      endTimeUnixNano: "250000000",
    });
    expect(attributes(codex.attributes)).toMatchObject({
      "orchestra.agent.role": "verifier",
      "orchestra.model": "codex-model",
      "langfuse.observation.input": "verify",
      "langfuse.observation.output": "verified",
      "orchestra.canonical_tokens.total": 11,
    });
    log.close();
  });

  it("AC6 reconciles exact SQLite/root totals across every conservative Codex checkpoint classification", () => {
    const log = new EventLog(databasePath());
    append(log, "created", "created", 1);
    const turnId = finishTurn(log, "c".repeat(16), "prompt", "response", 2, 3);
    const traceId = log.getSession("session")!.traceId;
    const base = {
      linearSessionId: "session",
      turnId,
      role: "implementer",
      traceId,
      outcome: "success",
    };
    const ingest = (
      input: Omit<
        CodexInvocationInput,
        "linearSessionId" | "turnId" | "role" | "traceId"
      >,
    ): ReturnType<EventLog["ingestCodexInvocation"]> =>
      log.ingestCodexInvocation({ ...base, ...input });
    expect(
      ingest({
        sourceKey: "fresh",
        providerConversationId: "thread",
        mode: "fresh",
        startedAt: 10,
        endedAt: 20,
        cumulativeTotalTokens: 100,
      }).deltaTotalTokens,
    ).toBe(100);
    expect(
      ingest({
        sourceKey: "resume",
        providerConversationId: "thread",
        mode: "resume",
        startedAt: 21,
        endedAt: 30,
        cumulativeTotalTokens: 140,
      }).deltaTotalTokens,
    ).toBe(40);
    expect(
      ingest({
        sourceKey: "old",
        providerConversationId: "thread",
        mode: "resume",
        startedAt: 15,
        endedAt: 16,
        cumulativeTotalTokens: 120,
      }).usageClassification,
    ).toBe("out_of_order");
    expect(
      ingest({
        sourceKey: "reset",
        providerConversationId: "thread",
        mode: "resume",
        startedAt: 31,
        endedAt: 40,
        cumulativeTotalTokens: 20,
      }),
    ).toMatchObject({
      usageClassification: "reset",
      deltaTotalTokens: 20,
      usageEpoch: 1,
    });
    expect(
      ingest({
        sourceKey: "collision",
        providerConversationId: "thread",
        mode: "fresh",
        startedAt: 41,
        endedAt: 50,
        cumulativeTotalTokens: 30,
      }).usageClassification,
    ).toBe("identity_collision");
    expect(
      ingest({
        sourceKey: "gap",
        providerConversationId: "gap-thread",
        mode: "resume",
        startedAt: 10,
        endedAt: 20,
        cumulativeTotalTokens: 10,
      }).usageClassification,
    ).toBe("gap");
    expect(
      ingest({
        sourceKey: "missing",
        providerConversationId: "missing-thread",
        mode: "fresh",
        startedAt: 10,
        endedAt: 20,
      }).usageClassification,
    ).toBe("unknown");
    expect(
      ingest({
        sourceKey: "failed",
        providerConversationId: "failed-thread",
        mode: "fresh",
        startedAt: 10,
        endedAt: 20,
        cumulativeTotalTokens: 30,
        outcome: "failed",
      }).deltaTotalTokens,
    ).toBe(30);
    expect(
      ingest({
        sourceKey: "watchdog",
        providerConversationId: "failed-thread",
        mode: "resume",
        startedAt: 21,
        endedAt: 30,
        cumulativeTotalTokens: 45,
        outcome: "watchdog",
      }).deltaTotalTokens,
    ).toBe(15);
    expect(
      ingest({
        sourceKey: "resume",
        providerConversationId: "thread",
        mode: "resume",
        startedAt: 21,
        endedAt: 30,
        cumulativeTotalTokens: 999,
      }).deltaTotalTokens,
    ).toBe(40);

    const summary = log.aggregateSession("session");
    expect(summary).toEqual({
      canonicalTokens: 215,
      invocationCount: 10,
      roles: ["implementer"],
      complete: false,
      degradedCount: 4,
    });
    const root = buildSessionRoot(log.getSession("session")!, summary, 100);
    expect(attributes(root.attributes)).toMatchObject({
      "orchestra.canonical_tokens.total": 215,
      "orchestra.canonical_tokens.complete": false,
      "orchestra.telemetry_complete": false,
      "orchestra.telemetry.degraded_count": 4,
    });
    const unknown = buildInvocationSpan(
      log
        .invocations("session")
        .find((row) => row.sourceKey === "gap")!,
      "c".repeat(16),
    );
    expect(attributes(unknown.attributes)).toMatchObject({
      "orchestra.canonical_tokens.complete": false,
    });
    expect(
      root.attributes.some((attribute) =>
        attribute.key.startsWith("gen_ai.usage."),
      ),
    ).toBe(false);
    log.close();
  });

  it("AC7 and AC8 preserve detached ancestry until the fixed 3600-second capability expires", async () => {
    const received: Buffer[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push(Buffer.concat(chunks));
        response.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const relay = new OtlpRelay({
      endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/fixed`,
      headers: { Authorization: "fixed" },
      quietMs: 2,
    });
    relays.push(relay);
    await relay.start();
    const createdAt = Date.now();
    const capability = relay.createCapability(
      {
        linearSessionId: "session",
        traceId: "a".repeat(32),
        turnSpanId: "c".repeat(16),
      },
      createdAt,
    );
    expect(capability.expiresAt - createdAt).toBe(3_600_000);
    expect(capability.endpoint).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/v1\/traces$/,
    );
    const detached = Buffer.from(
      encodeOtlpTrace({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: Buffer.from("a".repeat(32), "hex"),
                    spanId: Buffer.from("d".repeat(16), "hex"),
                    parentSpanId: Buffer.from("e".repeat(16), "hex"),
                    name: "codex.model",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(
      (await fetch(capability.endpoint, { method: "POST", body: detached }))
        .status,
    ).toBe(200);
    await delay(10);
    await relay.flushSession("session");
    expect(received[0]).toEqual(detached);
    const span = otlpSpans(decodeOtlpTrace(received[0]!))[0]!;
    expect(span.traceId).toEqual(Buffer.from("a".repeat(32), "hex"));
    expect(span.parentSpanId).toEqual(Buffer.from("e".repeat(16), "hex"));

    const expired = relay.createCapability(
      {
        linearSessionId: "expired",
        traceId: "a".repeat(32),
        turnSpanId: "c".repeat(16),
      },
      Date.now() - 3_600_001,
    );
    expect(
      (await fetch(expired.endpoint, { method: "POST", body: detached }))
        .status,
    ).toBe(404);
  });

  it("AC12 keeps completed payloads free of credentials, selected identity, foreign context, and alternate origins", () => {
    const forbidden = [
      "langfuse-secret",
      "proxy-password",
      "selected-account",
      "foreign-trace",
      "attacker.invalid",
    ];
    const turn = buildTurnSpan({
      traceId: "a".repeat(32),
      rootSpanId: "b".repeat(16),
      turnSpanId: "c".repeat(16),
      linearSessionId: "session",
      issue: "ENG-42",
      turnId: 1,
      prompt: "safe prompt",
      response: "safe response",
      runtime: "claude",
      profile: "fable",
      model: "safe-model",
      status: "response",
      startedAt: 1,
      finishedAt: 2,
    });
    const payload = JSON.stringify(turn);
    for (const value of forbidden) expect(payload).not.toContain(value);
    expect(payload).not.toContain("traceparent");
    expect(payload).not.toContain("endpoint");
    expect(payload).not.toContain("authorization");
  });
});
