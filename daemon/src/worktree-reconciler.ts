import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { EventLog } from "./eventlog.js";
import type { LinearGateway } from "./linear.js";
import type { WorktreeManager } from "./worktrees.js";

interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface WorktreeReconcilerConfig {
  worktreesRoot: string;
  worktreeUnlinkedGraceMs: number;
  worktreeBundlesDir: string;
  ntfyUrl?: string;
}

export interface WorktreeReconcilerOptions {
  now?: () => number;
  logger?: Logger;
  onEnqueued?: () => void;
}

export class WorktreeReconciler {
  private stopped = false;
  private running: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(
    private readonly log: EventLog,
    private readonly gateway: LinearGateway,
    private readonly worktrees: WorktreeManager,
    private readonly config: WorktreeReconcilerConfig,
    private readonly options: WorktreeReconcilerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  start(): void {
    this.stopped = false;
    void this.trigger();
  }

  trigger(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.running ??= this.sweep().finally(() => {
      this.running = undefined;
    }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async sweep(): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = await readdir(this.config.worktreesRoot, {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const identifiers = new Set(
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    );
    for (const job of this.log.retainedCleanups())
      identifiers.add(job.issueIdentifier);

    for (const identifier of identifiers)
      await this.reconcileCandidate(identifier);
  }

  private async reconcileCandidate(identifier: string): Promise<void> {
    const path = resolve(this.config.worktreesRoot, identifier);
    if (!(await this.worktrees.isOwned(path))) {
      this.logger.log(
        JSON.stringify({
          event: "worktree_reconcile_skipped",
          identifier,
          reason: "foreign_or_invalid",
        }),
      );
      return;
    }

    const state = /^[A-Za-z0-9]+-[0-9]+$/.test(identifier)
      ? await this.gateway.issueState(
          "implementer",
          identifier,
          this.now() + 10_000,
        )
      : ({ kind: "not_found" } as const);
    if (state.kind === "error") {
      this.logger.error(
        JSON.stringify({
          event: "worktree_reconcile_lookup_failed",
          identifier,
          error: state.error,
        }),
      );
      return;
    }
    if (state.kind === "not_found") {
      const observation = this.log.observeUnlinkedWorktree(
        identifier,
        path,
        this.now(),
      );
      if (
        this.now() - observation.firstObservedAt <
        this.config.worktreeUnlinkedGraceMs
      )
        return;
      try {
        const result = await this.worktrees.preserveAndRemove(
          identifier,
          this.config.worktreeBundlesDir,
          { alwaysPreserve: true },
        );
        this.log.clearUnlinkedObservation(identifier);
        this.notify(identifier, result.detail, "unlinked_grace_expired");
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: "worktree_reconcile_preservation_failed",
            identifier,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return;
    }

    this.log.clearUnlinkedObservation(identifier);
    if (!["completed", "canceled"].includes(state.stateType)) return;
    const existing = this.log.cleanupJobByIssueIdentifier(identifier);
    if (existing?.status === "retained") {
      if (this.log.repromoteRetainedCleanup(existing.id, this.now()))
        this.options.onEnqueued?.();
      return;
    }
    const session = this.log.sessionByIssueIdentifier(identifier);
    if (session) {
      if (
        this.log.enqueueCleanupFromReconcile(
          state.issueId,
          identifier,
          this.now(),
        )
      )
        this.options.onEnqueued?.();
      return;
    }
    try {
      const result = await this.worktrees.preserveAndRemove(
        identifier,
        this.config.worktreeBundlesDir,
        { alwaysPreserve: true },
      );
      this.notify(identifier, result.detail, "resolved_without_session");
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "worktree_reconcile_preservation_failed",
          identifier,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private notify(identifier: string, detail: string, reason: string): void {
    const body = `Worktree ${identifier} reconciled; state ${detail}.`;
    this.logger.log(
      JSON.stringify({
        event: "worktree_reconciled",
        identifier,
        reason,
        destination: detail,
      }),
    );
    if (!this.config.ntfyUrl) return;
    void fetch(this.config.ntfyUrl, {
      method: "POST",
      headers: {
        Title: "Linear daemon worktree reconciled",
        Priority: "default",
      },
      body,
    }).catch((error) =>
      this.logger.error(
        JSON.stringify({
          event: "worktree_reconcile_notification_failed",
          identifier,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }
}
