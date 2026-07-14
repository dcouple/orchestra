import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";

const dirs: string[] = [];
function path(): string { const dir = mkdtempSync(join(tmpdir(), "linear-eventlog-")); dirs.push(dir); return join(dir, "events.db"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function event(overrides: Record<string, unknown> = {}) {
  return { deliveryId: "delivery-1", app: "planner" as const, action: "created", agentSessionId: "session-1",
    issueId: "issue-1", webhookId: "webhook-1", receivedAt: 1000, rawBody: Buffer.from("{}"), ...overrides };
}

describe("EventLog", () => {
  it("atomically appends an event and pending ack, then deduplicates redelivery", () => {
    const log = new EventLog(path());
    expect(log.append(event()).inserted).toBe(true);
    expect(log.append(event()).inserted).toBe(false);
    expect(log.count()).toBe(1);
    expect(log.ackCount()).toBe(1);
    expect(log.pendingAcks(1000)).toHaveLength(1);
    expect(log.ackStates()[0]).toMatchObject({ nextAttemptAt: 1000, failureKind: null });
    log.close();
  });

  it("does not dedupe separate deliveries sharing a webhook id", () => {
    const log = new EventLog(path());
    log.append(event());
    log.append(event({ deliveryId: "delivery-2" }));
    expect(log.count()).toBe(2);
    expect(log.ackCount()).toBe(2);
    log.close();
  });

  it("creates no ack row for prompted or unrecognized events", () => {
    const log = new EventLog(path());
    log.append(event({ action: "prompted" }));
    expect(log.ackCount()).toBe(0);
    log.close();
  });

  it("survives close/reopen with ack state and tokens", () => {
    const dbPath = path();
    const first = new EventLog(dbPath);
    first.append(event());
    const [ack] = first.pendingAcks(1000);
    first.markRetriableFailure(ack!.eventId, "temporary", 2000, "failed");
    first.putToken("planner", { accessToken: "token", expiresAt: 5000 });
    first.close();
    const reopened = new EventLog(dbPath);
    expect(reopened.count()).toBe(1);
    expect(reopened.pendingAcks(2000)[0]).toMatchObject({ status: "failed", lastError: "temporary", failureKind: "retriable" });
    expect(reopened.getToken("planner")).toEqual({ accessToken: "token", expiresAt: 5000 });
    reopened.close();
  });

  it("uses a stable body hash fallback when Linear-Delivery is absent", () => {
    const log = new EventLog(path());
    expect(log.append(event({ deliveryId: undefined })).deliveryId).toMatch(/^sha256:/);
    expect(log.append(event({ deliveryId: undefined })).inserted).toBe(false);
    log.close();
  });
});
