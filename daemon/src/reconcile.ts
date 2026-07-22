import type { AppName, Config } from "./config.js";
import type { EventLog, SessionRow } from "./eventlog.js";
import type { AgentPromptActivity, AgentSessionSummary, LinearGateway } from "./linear.js";

interface Logger { log(...args: unknown[]): void; error(...args: unknown[]): void; }
export interface ReconcileWorkerOptions {
  now?: () => number;
  logger?: Logger;
  onInserted?: () => void;
  onStop?: (agentSessionId: string) => void;
}

type ReconcileGateway = Pick<LinearGateway,
  "ensureWebhookEnabled" | "listAgentSessions" | "listDelegatedIssueAgentSessions" | "listSessionActivitiesSince">;

const APPS: AppName[] = ["planner", "implementer"];

export class ReconcileWorker {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private sweeping: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(
    private readonly log: EventLog,
    private readonly gateway: ReconcileGateway,
    private readonly config: Config,
    private readonly options: ReconcileWorkerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.trigger(), this.config.reconcileIntervalMs);
    this.timer.unref();
    void this.trigger();
  }

  trigger(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.sweeping ??= this.sweep().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async sweep(): Promise<void> {
    await this.ensureWebhooks();
    await this.reconcileCreatedSessions();
    await this.reconcilePlannerPrompts();
  }

  private async ensureWebhooks(): Promise<void> {
    await Promise.all(APPS.map(async app => {
      const url = `${this.config.webhookBaseUrl}/webhook/${app}`;
      try {
        const result = await this.gateway.ensureWebhookEnabled(app, url, this.now() + this.config.reconcileRequestTimeoutMs);
        this.logger.log(JSON.stringify({ event: "reconcile_webhook", app, matched: result.matched, updated: result.updated }));
      } catch (error) {
        this.logger.error(JSON.stringify({ level: "error", event: "reconcile_webhook_failed", app, error: messageOf(error) }));
      }
    }));
  }

  private async reconcileCreatedSessions(): Promise<void> {
    for (const app of APPS) {
      const actorId = this.config.apps[app].appActorId;
      if (!actorId) {
        this.logger.error(JSON.stringify({ level: "warn", event: "reconcile_sessions_skipped_missing_app_actor_id", app,
          message: `${app.toUpperCase()}_APP_ACTOR_ID is required for session discovery synthesis` }));
        continue;
      }
      let sessions: AgentSessionSummary[];
      try {
        sessions = await this.gateway.listAgentSessions(app, actorId, this.now() + this.config.reconcileRequestTimeoutMs);
      } catch (error) {
        this.logger.error(JSON.stringify({ level: "error", event: "reconcile_sessions_bulk_failed", app, error: messageOf(error) }));
        try {
          sessions = await this.gateway.listDelegatedIssueAgentSessions(app, actorId, this.now() + this.config.reconcileRequestTimeoutMs);
        } catch (fallbackError) {
          this.logger.error(JSON.stringify({ level: "error", event: "reconcile_sessions_fallback_failed", app, error: messageOf(fallbackError) }));
          continue;
        }
      }

      for (const session of sessions) {
        if (this.log.getSession(session.id)) continue;
        const result = this.appendCreated(session);
        if (result.assignedProfile) this.logger.log(JSON.stringify({ event: "session_profile_assigned",
          linearSessionId: session.id, profile: result.assignedProfile,
          runtime: result.assignedRuntime, reason: result.assignmentReason }));
        if (result.inserted) this.options.onInserted?.();
      }
    }
  }

  private async reconcilePlannerPrompts(): Promise<void> {
    // Prompt reconciliation only visits durable sessions, so it cannot assign a profile.
    for (const session of this.log.plannerSessionsForReconcile()) {
      let activities: AgentPromptActivity[];
      try {
        activities = await this.gateway.listSessionActivitiesSince("planner", session.linearSessionId,
          session.lastSeenActivityAt, this.now() + this.config.reconcileRequestTimeoutMs);
      } catch (error) {
        this.logger.error(JSON.stringify({ level: "error", event: "reconcile_activities_failed",
          app: "planner", sessionId: session.linearSessionId, error: messageOf(error) }));
        continue;
      }
      let maxSeen = session.lastSeenActivityAt ?? 0;
      for (const activity of activities) {
        const result = this.appendPrompted(session, activity);
        if (result.inserted) this.options.onInserted?.();
        if (result.stop) this.options.onStop?.(result.stop.agentSessionId);
        maxSeen = Math.max(maxSeen, activity.createdAt);
      }
      if (maxSeen > (session.lastSeenActivityAt ?? 0)) {
        this.log.updateLastSeenActivity(session.linearSessionId, maxSeen, this.now());
      }
    }
  }

  private appendCreated(session: AgentSessionSummary): ReturnType<EventLog["append"]> {
    const raw = {
      action: "created",
      agentSession: {
        id: session.id,
        issueId: session.issueId,
        issue: session.issueId || session.issueIdentifier ? { id: session.issueId, identifier: session.issueIdentifier } : undefined,
      },
    };
    return this.log.append({
      deliveryId: `reconcile:created:${session.app}:${session.id}`,
      app: session.app,
      action: "created",
      agentSessionId: session.id,
      issueId: session.issueId,
      issueIdentifier: session.issueIdentifier,
      receivedAt: this.now(),
      rawBody: Buffer.from(JSON.stringify(raw)),
    });
  }

  private appendPrompted(session: SessionRow, activity: AgentPromptActivity): ReturnType<EventLog["append"]> {
    const raw = {
      action: "prompted",
      agentSession: {
        id: session.linearSessionId,
        issueId: session.issueId,
        issue: session.issueId || session.issueIdentifier ? { id: session.issueId, identifier: session.issueIdentifier } : undefined,
      },
      agentActivity: {
        id: activity.id,
        signal: activity.signal,
        body: activity.body,
        createdAt: new Date(activity.createdAt).toISOString(),
        content: { type: "prompt", body: activity.body },
      },
    };
    return this.log.append({
      deliveryId: `reconcile:prompt:${session.linearSessionId}:${activity.id}`,
      app: "planner",
      action: "prompted",
      agentSessionId: session.linearSessionId,
      sourceActivityId: activity.id,
      signal: activity.signal,
      issueId: session.issueId ?? undefined,
      issueIdentifier: session.issueIdentifier ?? undefined,
      receivedAt: this.now(),
      rawBody: Buffer.from(JSON.stringify(raw)),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.sweeping;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
