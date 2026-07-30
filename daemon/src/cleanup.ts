import type {
  EventLog,
  CleanupJobRow,
  CleanupNotificationRow,
} from "./eventlog.js";
import type { LinearGateway } from "./linear.js";
import { WorktreeManager } from "./worktrees.js";
import {
  buildInvocationSpan,
  buildSessionRoot,
  postSpans,
  type OtlpSpan,
} from "./otel.js";
import type { OtlpRelay } from "./otel-relay.js";
import { inFlightDispatches } from "./dispatches.js";

interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
export interface CleanupWorkerOptions {
  pollMs?: number;
  reconcileMs?: number;
  leaseMs?: number;
  retryWindowMs?: number;
  now?: () => number;
  logger?: Logger;
  relay?: OtlpRelay;
  ingestDispatches?: () => Promise<void>;
  worktrees?: WorktreeManager;
  bundlesDir?: string;
  onIssueFinalized?: () => void;
}

export class CleanupWorker {
  private timer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private stopped = false;
  private draining: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly logger: Logger;
  constructor(
    private readonly log: EventLog,
    private readonly gateway: LinearGateway,
    private readonly worktreesRoot: string,
    targetRepoPath: string,
    private readonly options: CleanupWorkerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.worktrees =
      options.worktrees ?? new WorktreeManager(worktreesRoot, targetRepoPath);
  }
  private readonly worktrees: WorktreeManager;
  start(): void {
    this.stopped = false;
    this.log.reclaimRunningCleanups();
    this.timer = setInterval(
      () => void this.trigger(),
      this.options.pollMs ?? 250,
    );
    this.reconcileTimer = setInterval(
      () => void this.reconcile(),
      this.options.reconcileMs ?? 60_000,
    );
    this.timer.unref();
    this.reconcileTimer.unref();
    void this.reconcile();
  }
  trigger(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    }));
  }
  private async reconcile(): Promise<void> {
    await this.trigger();
  }
  private async drain(): Promise<void> {
    for (;;) {
      const job = this.log.claimNextCleanup(this.now());
      if (!job) break;
      await this.process(job);
    }
    for (const note of this.log.pendingCleanupNotifications(this.now()))
      await this.postNotification(note);
  }
  private async process(job: CleanupJobRow): Promise<void> {
    let preservationAttempt = false;
    try {
      await this.options.ingestDispatches?.();
      if (!(await this.finalizeIssue(job))) {
        this.log.retryCleanup(
          job.id,
          "finalization_pending",
          this.now() + 1000,
        );
        return;
      }
      const session = this.log.sessionByIssueIdentifier(job.issueIdentifier);
      if (
        !session?.worktreePath ||
        !(await this.worktrees.isPresent(session.worktreePath))
      ) {
        preservationAttempt = true;
        const result = await this.worktrees.preserveAndRemove(
          job.issueIdentifier,
          this.options.bundlesDir ?? `${this.worktreesRoot}/../worktree-bundles`,
          { alwaysPreserve: true },
        );
        preservationAttempt = false;
        this.log.clearSessionWorktrees(job.issueIdentifier);
        this.log.noteCleanupOutcome(
          job.id,
          `Worktree cleanup completed; state ${result.detail}.`,
          this.now(),
        );
        this.log.markCleanupDone(job.id);
        this.options.onIssueFinalized?.();
        return;
      }
      if (await this.worktrees.isClean(session.worktreePath)) {
        if (!this.log.hasExternalUrl(job.linearSessionId)) {
          preservationAttempt = true;
          const result = await this.worktrees.preserveAndRemove(
            job.issueIdentifier,
            this.options.bundlesDir ??
              `${this.worktreesRoot}/../worktree-bundles`,
            { alwaysPreserve: true },
          );
          preservationAttempt = false;
          this.log.clearSessionWorktrees(job.issueIdentifier);
          this.log.noteCleanupOutcome(
            job.id,
            `Worktree cleanup completed; state ${result.detail}.`,
            this.now(),
          );
          this.log.markCleanupDone(job.id);
          this.options.onIssueFinalized?.();
          return;
        }
        await this.worktrees.remove(job.issueIdentifier);
        this.log.clearSessionWorktrees(job.issueIdentifier);
        this.log.markCleanupDone(job.id);
        this.options.onIssueFinalized?.();
      } else {
        preservationAttempt = true;
        const result = await this.worktrees.preserveAndRemove(
          job.issueIdentifier,
          this.options.bundlesDir ?? `${this.worktreesRoot}/../worktree-bundles`,
          { alwaysPreserve: true },
        );
        preservationAttempt = false;
        this.log.clearSessionWorktrees(job.issueIdentifier);
        this.log.noteCleanupOutcome(
          job.id,
          `Worktree cleanup completed; state ${result.detail}.`,
          this.now(),
        );
        this.log.markCleanupDone(job.id);
        this.options.onIssueFinalized?.();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        this.now() <
        job.createdAt + (this.options.retryWindowMs ?? 30 * 60_000)
      )
        this.log.retryCleanup(
          job.id,
          message,
          this.now() + Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)),
        );
      else {
        if (preservationAttempt)
          this.log.retainCleanup(
            job.id,
            `Worktree retained because preservation failed: ${message}`,
            this.now(),
          );
        else this.log.failCleanup(job.id, message);
        this.logger.error(
          JSON.stringify({
            event: preservationAttempt
              ? "cleanup_preservation_failed"
              : "cleanup_failed",
            jobId: job.id,
            error: message,
          }),
        );
      }
    }
  }
  private async finalizeIssue(job: CleanupJobRow): Promise<boolean> {
    const sessions = this.log.sessionsForIssue(job.issueId);
    if (!sessions.length) return true;
    if (
      sessions.some((session) => this.log.hasOpenTurn(session.linearSessionId))
    )
      return false;
    for (const session of sessions) {
      const dispatches = await inFlightDispatches(
        session.worktreePath,
        session.linearSessionId,
      );
      const futureDeadlines = dispatches
        .map((dispatch) => dispatch.deadlineAt)
        .filter((deadline) => deadline > this.now());
      const dispatchDeadline = futureDeadlines.length
        ? Math.min(...futureDeadlines)
        : undefined;
      if (dispatchDeadline !== undefined && dispatchDeadline > this.now())
        return false;
    }
    for (const session of sessions) {
      let pending = this.log.nonterminalInvocations(session.linearSessionId);
      if (pending.length) {
        await this.options.relay?.flushSession(session.linearSessionId);
        this.log.terminalizeExpiredClaude(this.now(), session.linearSessionId);
        pending = this.log.nonterminalInvocations(session.linearSessionId);
        if (pending.length) return false;
      }
      let outbox = this.log.outbox(session.linearSessionId);
      if (!outbox) {
        const summary = this.log.aggregateSession(session.linearSessionId);
        const completedAt = this.now();
        const spans: OtlpSpan[] = [
          ...this.log
            .invocations(session.linearSessionId)
            .filter((row) => row.source === "codex")
            .flatMap((row) => {
              const parent = this.log.turnSpanId(row.turnId);
              return parent ? [buildInvocationSpan(row, parent)] : [];
            }),
          buildSessionRoot(session, summary, completedAt),
        ];
        outbox = this.log.materializeOutbox(
          session.linearSessionId,
          JSON.stringify(spans),
          completedAt,
        );
      }
      if (outbox.state === "pending" || outbox.state === "leased") {
        const owner = `cleanup:${job.id}:${session.linearSessionId}`;
        const lease = this.log.leaseOutbox(
          session.linearSessionId,
          owner,
          this.now(),
          this.options.leaseMs ?? 30_000,
        );
        if (!lease) return false;
        if (
          !this.log.markOutboxSending(
            session.linearSessionId,
            owner,
            this.now(),
          )
        )
          return false;
        let spans: OtlpSpan[];
        try {
          spans = JSON.parse(lease.payload) as OtlpSpan[];
        } catch {
          this.log.finishOutbox(
            session.linearSessionId,
            "failed",
            "invalid_payload",
            this.now(),
          );
          continue;
        }
        const result = await postSpans(spans);
        this.log.finishOutbox(
          session.linearSessionId,
          result.delivery,
          result.ok ? null : (result.error ?? "export_error"),
          this.now(),
        );
      }
    }
    return this.log.allSessionsFinalized(job.issueId);
  }
  private async postNotification(note: CleanupNotificationRow): Promise<void> {
    const result = await this.gateway.postActivity(
      note.app,
      note.linearSessionId,
      note.activityId,
      { type: "thought", body: note.body },
      true,
      this.now() + 10_000,
    );
    if (result.ok) {
      this.log.markCleanupNotificationPosted(note.jobId);
      return;
    }
    if (result.retriable && this.now() < note.createdAt + 30 * 60_000) {
      this.log.retryCleanupNotification(
        note.jobId,
        result.error,
        this.now() + Math.max(1000, result.retryAfterMs ?? 0),
      );
      return;
    }
    this.log.failCleanupNotification(note.jobId, result.error);
    this.logger.error(
      JSON.stringify({
        event: "cleanup_notification_failed",
        jobId: note.jobId,
        error: result.error,
      }),
    );
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.draining;
  }
}
