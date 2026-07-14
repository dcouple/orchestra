import type { AppName } from "./config.js";
import type { AckRow, EventLog } from "./eventlog.js";
import type { PostResult } from "./linear.js";

export interface ActivityPoster {
  postAckActivity(app: AppName, sessionId: string, activityId: string, deadlineAt: number): Promise<PostResult>;
}

export interface AckWorkerOptions {
  pollMs?: number;
  reconcileMs?: number;
  attemptTimeoutMs?: number;
  concurrency?: number;
  maxFastAttempts?: number;
  random?: () => number;
  now?: () => number;
  logger?: Pick<Console, "error">;
}

export class AckWorker {
  private timer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private draining = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly logger: Pick<Console, "error">;

  constructor(private readonly log: EventLog, private readonly poster: ActivityPoster, private readonly options: AckWorkerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? console;
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.drain(false), this.options.pollMs ?? 250);
    this.reconcileTimer = setInterval(() => void this.drain(true), this.options.reconcileMs ?? 60_000);
    this.timer.unref();
    this.reconcileTimer.unref();
    void this.drain(true);
  }

  trigger(): void { queueMicrotask(() => void this.drain(false)); }

  async drain(includeFailed: boolean): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      const rows = this.log.pendingAcks(this.now()).filter(row => includeFailed || row.status === "pending");
      await this.processConcurrently(rows);
    } finally { this.draining = false; }
  }

  private async processConcurrently(rows: AckRow[]): Promise<void> {
    const concurrency = Math.max(1, this.options.concurrency ?? 4);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      for (;;) {
        const row = rows[next++];
        if (!row) return;
        await this.process(row);
      }
    });
    await Promise.all(workers);
  }

  private async process(row: AckRow): Promise<void> {
    const lateRetry = row.status === "failed";
    const now = this.now();
    const attemptDeadlineAt = lateRetry
      ? now + (this.options.attemptTimeoutMs ?? 5_000)
      : Math.min(row.deadlineAt, now + (this.options.attemptTimeoutMs ?? 5_000));
    if (attemptDeadlineAt <= this.now()) {
      this.log.markRetriableFailure(row.eventId, "ack deadline exceeded before activity post",
        this.nextSlowAttemptAt(this.now()), "failed");
      this.logger.error(JSON.stringify({ level: "error", event: "ack_failed", eventId: row.eventId, error: "deadline_exceeded" }));
      return;
    }
    const result = await this.poster.postAckActivity(
      row.app, row.agentSessionId, row.activityId, attemptDeadlineAt,
    );
    if (result.ok) { this.log.markAcked(row.eventId); return; }
    if (result.retriable) {
      const now = this.now();
      const nextAttemptAt = now + this.backoffMs(row.attempts, result.retryAfterMs);
      if (!lateRetry && row.attempts + 1 < (this.options.maxFastAttempts ?? 5) && nextAttemptAt < row.deadlineAt) {
        this.log.markRetriableFailure(row.eventId, result.error, nextAttemptAt, "pending");
      } else {
        this.log.markRetriableFailure(row.eventId, result.error,
          this.nextSlowAttemptAt(now, result.retryAfterMs), "failed");
        this.logger.error(JSON.stringify({ level: "error", event: "ack_failed", eventId: row.eventId, error: result.error }));
      }
      return;
    }
    this.log.markTerminalFailure(row.eventId, result.error);
    this.logger.error(JSON.stringify({ level: "error", event: "ack_failed", eventId: row.eventId, error: result.error }));
  }

  private backoffMs(attempts: number, retryAfterMs?: number): number {
    const base = Math.min(500 * 2 ** Math.max(0, attempts), 5_000);
    const jitter = 0.8 + this.random() * 0.4;
    return Math.max(Math.ceil(base * jitter), retryAfterMs ?? 0);
  }

  private nextSlowAttemptAt(now: number, retryAfterMs?: number): number {
    return now + Math.max(this.options.reconcileMs ?? 60_000, retryAfterMs ?? 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }
}
