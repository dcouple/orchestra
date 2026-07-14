import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AckWorker, type ActivityPoster } from "../src/ack.js";
import { EventLog } from "../src/eventlog.js";
import { LinearGateway } from "../src/linear.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(receivedAt = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "ack-worker-")); dirs.push(dir);
  const log = new EventLog(join(dir, "db"));
  log.append({ deliveryId: "d", app: "planner", action: "created", agentSessionId: "s", receivedAt, rawBody: Buffer.from("{}") });
  return log;
}

async function stubGraphql(handler: (body: Record<string, unknown>) => unknown) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(handler(body)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return { requests, url: `http://127.0.0.1:${port}/graphql`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe("AckWorker", () => {
  it("marks a successful pending ack complete", async () => {
    const log = setup();
    const postAckActivity = vi.fn(async () => ({ ok: true as const }));
    const worker = new AckWorker(log, { postAckActivity }, { now: () => 2000 });
    await worker.drain(false);
    expect(log.ackStates()[0]).toMatchObject({ status: "acked", attempts: 1 });
    expect(postAckActivity).toHaveBeenCalledWith("planner", "s", expect.any(String), 7000);
    log.close();
  });

  it("exhaustion marks failed, then slow reconciliation reuses the same activity id", async () => {
    const log = setup(); const id = log.ackStates()[0]!.activityId;
    const poster: ActivityPoster = { postAckActivity: vi.fn(async () => ({ ok: false, retriable: true, error: "timeout" })) };
    const first = new AckWorker(log, poster, { now: () => 11_001, logger: { error: vi.fn() } });
    await first.drain(false);
    expect(log.ackStates()[0]).toMatchObject({ status: "failed" });
    poster.postAckActivity = vi.fn(async () => ({ ok: true }));
    const reconciler = new AckWorker(log, poster, { now: () => 72_000 });
    await reconciler.drain(true);
    expect(log.ackStates()[0]).toMatchObject({ status: "acked" });
    expect(poster.postAckActivity).toHaveBeenCalledWith("planner", "s", id, 77_000);
    log.close();
  });

  it("crash-window restart reposts the same pre-generated activity id", async () => {
    const log = setup(); const id = log.ackStates()[0]!.activityId;
    const firstPoster: ActivityPoster = { postAckActivity: vi.fn(async () => ({ ok: false, retriable: true, error: "process died after remote accept" })) };
    await new AckWorker(log, firstPoster, { now: () => 2000 }).drain(false);
    expect(log.ackStates()[0]).toMatchObject({ status: "pending" });
    const restartedPoster: ActivityPoster = { postAckActivity: vi.fn(async () => ({ ok: true })) };
    await new AckWorker(log, restartedPoster, { now: () => 3000 }).drain(true);
    expect(restartedPoster.postAckActivity).toHaveBeenCalledWith("planner", "s", id, 8000);
    expect(log.ackStates()[0]).toMatchObject({ status: "acked" });
    log.close();
  });

  it("crash-window duplicate-id GraphQL error marks the same-id repost acked", async () => {
    const log = setup(); const id = log.ackStates()[0]!.activityId;
    const now = () => 3000;
    const api = await stubGraphql(() => ({
      errors: [{
        message: "Invalid input",
        extensions: { type: "invalid input", userPresentableMessage: `Agent activity id ${id} already exists` },
      }],
    }));
    const gateway = new LinearGateway(log, {
      planner: { name: "planner", webhookSecret: "p", staticToken: "token-p" },
      implementer: { name: "implementer", webhookSecret: "i", staticToken: "token-i" },
    }, api.url, "http://unused", now);
    expect(log.pendingAcks(now())).toHaveLength(1);
    await new AckWorker(log, gateway, { now }).drain(true);
    expect(api.requests).toHaveLength(1);
    expect(JSON.stringify(api.requests[0])).toContain(id);
    expect(log.ackStates()[0]).toMatchObject({ status: "acked", attempts: 1 });
    await api.close(); log.close();
  });

  it("caps a stalled fast attempt, then retries successfully inside the 10s window", async () => {
    let now = 2000;
    const log = setup(1000);
    const postAckActivity = vi.fn(async () => ({ ok: false as const, retriable: true, error: "deadline exceeded" }))
      .mockResolvedValueOnce({ ok: false, retriable: true, error: "deadline exceeded" })
      .mockResolvedValueOnce({ ok: true });
    const worker = new AckWorker(log, { postAckActivity }, {
      now: () => now, attemptTimeoutMs: 500, random: () => 0.5, logger: { error: vi.fn() },
    });
    await worker.drain(false);
    expect(postAckActivity).toHaveBeenCalledWith("planner", "s", expect.any(String), 2500);
    expect(log.ackStates()[0]).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: 2500 });
    now = 2500;
    await worker.drain(false);
    expect(postAckActivity).toHaveBeenLastCalledWith("planner", "s", expect.any(String), 3000);
    expect(log.ackStates()[0]).toMatchObject({ status: "acked", attempts: 2 });
    log.close();
  });

  it("paces sustained retriable failures with durable backoff instead of every poll tick", async () => {
    let now = 1000;
    const log = setup(now);
    const postAckActivity = vi.fn(async () => ({ ok: false as const, retriable: true, error: "upstream 500" }));
    const worker = new AckWorker(log, { postAckActivity }, { now: () => now, random: () => 0.5, logger: { error: vi.fn() } });
    await worker.drain(false);
    expect(log.ackStates()[0]).toMatchObject({ attempts: 1, status: "pending", nextAttemptAt: 1500 });
    now = 1499; await worker.drain(false);
    now = 1500; await worker.drain(false);
    now = 2499; await worker.drain(false);
    now = 2500; await worker.drain(false);
    now = 4499; await worker.drain(false);
    now = 4500; await worker.drain(false);
    expect(postAckActivity).toHaveBeenCalledTimes(4);
    expect(log.ackStates()[0]).toMatchObject({ attempts: 4, status: "pending", nextAttemptAt: 8500 });
    now = 8500; await worker.drain(false);
    expect(postAckActivity).toHaveBeenCalledTimes(5);
    expect(log.ackStates()[0]).toMatchObject({ attempts: 5, status: "failed", failureKind: "retriable", nextAttemptAt: 68_500 });
    log.close();
  });

  it("honors Retry-After and skips terminal failures during slow reconciliation", async () => {
    let now = 1000;
    const log = setup(now);
    const postAckActivity = vi.fn()
      .mockResolvedValueOnce({ ok: false, retriable: true, error: "rate limited", retryAfterMs: 3000 })
      .mockResolvedValue({ ok: false, retriable: false, error: "bad input" });
    const worker = new AckWorker(log, { postAckActivity }, { now: () => now, random: () => 0.5, logger: { error: vi.fn() } });
    await worker.drain(false);
    expect(log.ackStates()[0]).toMatchObject({ attempts: 1, status: "pending", nextAttemptAt: 4000 });
    now = 3999; await worker.drain(false);
    expect(postAckActivity).toHaveBeenCalledTimes(1);
    now = 4000; await worker.drain(false);
    expect(log.ackStates()[0]).toMatchObject({ attempts: 2, status: "failed", failureKind: "terminal" });
    now = 70_000; await worker.drain(true);
    expect(postAckActivity).toHaveBeenCalledTimes(2);
    log.close();
  });

  it("processes pending acks with bounded concurrency", async () => {
    const log = setup();
    log.append({ deliveryId: "d2", app: "planner", action: "created", agentSessionId: "s2", receivedAt: 1000, rawBody: Buffer.from("{}") });
    log.append({ deliveryId: "d3", app: "planner", action: "created", agentSessionId: "s3", receivedAt: 1000, rawBody: Buffer.from("{}") });
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const postAckActivity = vi.fn(async () => {
      started++;
      await gate;
      return { ok: true as const };
    });
    const drain = new AckWorker(log, { postAckActivity }, { now: () => 2000, concurrency: 3 }).drain(false);
    await vi.waitFor(() => expect(started).toBe(3));
    release();
    await drain;
    expect(log.ackStates()).toHaveLength(3);
    expect(log.ackStates().every(state => state.status === "acked")).toBe(true);
    log.close();
  });
});
