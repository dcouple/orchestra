import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { TurnUsage } from "./claude.js";
import type { AppName } from "./config.js";
import { ACTIVE_OPERATION_STATES, type OperationRow, type OperationState,
  type SafeOperationStatus, type SafeRunningTurn, type ScheduleOperationInput, validateScheduleOperation } from "./operations.js";

export interface AppendEvent {
  deliveryId?: string | undefined;
  app: AppName;
  action?: string | undefined;
  agentSessionId?: string | undefined;
  sourceActivityId?: string | undefined;
  issueId?: string | undefined;
  issueIdentifier?: string | undefined;
  webhookId?: string | undefined;
  receivedAt: number;
  rawBody: Buffer;
  type?: string | undefined;
  stateType?: string | undefined;
  signal?: string | undefined;
}

export interface SessionRow {
  linearSessionId: string;
  app: AppName;
  issueId: string | null;
  issueIdentifier: string | null;
  worktreePath: string | null;
  branch: string | null;
  claudeSessionId: string | null;
  runtime: "claude" | "claudex";
  fallbackCause: string | null;
  profile: "fable" | "sol" | null;
  profileFallback: number | null;
  browserRequired: number;
  browserRunId: string | null;
  mode: string;
  status: string;
  lastSeenAt: number;
  lastSeenActivityAt: number | null;
  traceId: string;
  rootSpanId: string;
  startedAt: number;
  completedAt: number | null;
}
export interface ProviderStateRow {
  provider: string;
  status: string;
  reason: string | null;
  cooldownUntil: number | null;
  updatedAt: number;
}
export interface AppendResult {
  inserted: boolean;
  deliveryId: string;
  assignedProfile?: "fable" | "sol";
  assignedRuntime?: "claude" | "claudex";
  assignmentReason?: string;
  stop?: { agentSessionId: string; app: AppName };
}
export interface TurnRow {
  id: number;
  eventId: number;
  app: AppName;
  linearSessionId: string;
  issueId: string;
  kind: "created" | "prompted";
  prompt: string | null;
  status:
    | "pending"
    | "running"
    | "awaiting_activity"
    | "done"
    | "failed"
    | "interrupted";
  attempts: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  rawBody: Buffer;
  receivedAt: number;
  turnSpanId: string | null;
  executionFinishedAt: number | null;
}
export interface RestartIntentRow {
  policy: "interrupt";
  reason: string;
  createdAt: number;
}
export interface TurnToolCallRow {
  turnId: number;
  toolUseId: string;
  toolName: string;
  state: "open" | "completed";
  openedAt: number;
  completedAt: number | null;
}
export interface RestartDisposition {
  turnId: number;
  outcome: "resumed" | "human_required";
  reason:
    | "safe_boundary"
    | "hard_restart"
    | "missing_claude_session"
    | "unresolved_tool_call";
  resumeTurnId: number | null;
}
export type EnrichmentState =
  | "pending"
  | "enriched"
  | "forwarded_unenriched"
  | "native_missing"
  | "relay_delivery_unknown";
export type UsageClassification =
  | "accepted"
  | "reset"
  | "gap"
  | "out_of_order"
  | "identity_collision"
  | "unknown";
export interface AgentInvocationRow {
  id: number;
  linearSessionId: string;
  turnId: number;
  source: "claude" | "codex";
  sourceKey: string;
  parentInvocationId: number | null;
  role: string;
  runtime: string;
  model: string | null;
  prompt: string | null;
  report: string | null;
  startedAt: number | null;
  endedAt: number | null;
  deadlineAt: number | null;
  outcome: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  rawTotalTokens: number | null;
  priorTotalTokens: number | null;
  deltaTotalTokens: number | null;
  usageEpoch: number | null;
  usageClassification: UsageClassification;
  traceId: string;
  spanId: string | null;
  providerConversationId: string | null;
  providerTurnId: string | null;
  enrichmentState: EnrichmentState;
  streamCompletedAt: number | null;
  nativeSeenAt: number | null;
  enrichmentDeadlineAt: number | null;
  degradationReason: string | null;
}
export interface CodexInvocationInput {
  linearSessionId: string;
  turnId: number;
  sourceKey: string;
  role: string;
  prompt?: string;
  report?: string;
  startedAt?: number;
  endedAt?: number;
  deadlineAt?: number;
  outcome?: string;
  model?: string;
  traceId: string;
  spanId?: string;
  providerConversationId?: string;
  providerTurnId?: string;
  mode?: "fresh" | "resume";
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cumulativeTotalTokens?: number;
}
export type TelemetryOutboxState =
  | "pending"
  | "leased"
  | "sending"
  | "delivered"
  | "failed"
  | "delivery_unknown";
export interface TelemetryOutboxRow {
  sessionId: string;
  state: TelemetryOutboxState;
  payload: string;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  attempts: number;
  sendStartedAt: number | null;
  acknowledgedAt: number | null;
  lastError: string | null;
}
export interface TurnActivityRow {
  turnId: number;
  app: AppName;
  linearSessionId: string;
  kind: "response" | "error";
  activityId: string;
  body: string;
  status: "pending" | "posted" | "failed";
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  progressBarrier: number;
  receivedAt: number;
}
export interface ExternalUrlRow {
  id: number;
  linearSessionId: string;
  app: AppName;
  label: string;
  url: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
}
export interface CleanupJobRow {
  id: number;
  issueId: string;
  issueIdentifier: string;
  linearSessionId: string;
  app: AppName;
  status: string;
  attempts: number;
  createdAt: number;
  claimedAt: number | null;
  notifyActivityId: string;
}
export interface CleanupNotificationRow {
  jobId: number;
  app: AppName;
  linearSessionId: string;
  activityId: string;
  body: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
}
export interface StopAckRow {
  sourceActivityId: string;
  eventId: number;
  app: AppName;
  linearSessionId: string;
  activityId: string;
  body: string;
  status: "pending" | "posted" | "failed";
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
}

const STOP_ACK_BODY =
  "Stopped at your request. Send a follow-up message to continue.";

function randomHex(bytes: number): string {
  let value = randomBytes(bytes).toString("hex");
  while (/^0+$/.test(value)) value = randomBytes(bytes).toString("hex");
  return value;
}

function deterministicUuid(key: string): string {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface AckRow {
  eventId: number;
  app: AppName;
  agentSessionId: string;
  activityId: string;
  status: "pending" | "failed";
  attempts: number;
  lastError: string | null;
  failureKind: "retriable" | "terminal" | null;
  nextAttemptAt: number;
  deadlineAt: number;
  receivedAt: number;
}

export interface StoredToken {
  accessToken: string;
  expiresAt: number;
}
export interface AckState {
  eventId: number;
  activityId: string;
  status: "pending" | "acked" | "failed";
  attempts: number;
  lastError: string | null;
  failureKind: "retriable" | "terminal" | null;
  nextAttemptAt: number;
}

export class EventLog {
  private readonly db: Database.Database;

  constructor(
    path: string,
    private readonly selectProfile: (app: AppName) => {
      profile: "fable" | "sol";
      runtime: "claude" | "claudex";
      reason: string;
    } = () => ({
      profile: "fable",
      runtime: "claude",
      reason: "compatibility_default",
    }),
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        webhook_id TEXT,
        app TEXT NOT NULL CHECK(app IN ('planner','implementer')),
        action TEXT,
        agent_session_id TEXT,
        source_activity_id TEXT,
        issue_id TEXT,
        received_at INTEGER NOT NULL,
        raw_body BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS acks (
        event_id INTEGER PRIMARY KEY REFERENCES events(id),
        activity_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('pending','acked','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        failure_kind TEXT CHECK(failure_kind IS NULL OR failure_kind IN ('retriable','terminal')),
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        deadline_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        app TEXT PRIMARY KEY CHECK(app IN ('planner','implementer')),
        access_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        linear_session_id TEXT PRIMARY KEY,
        app TEXT NOT NULL CHECK(app IN ('planner','implementer')),
        issue_id TEXT,
        issue_identifier TEXT,
        worktree_path TEXT,
        branch TEXT,
        claude_session_id TEXT,
        runtime TEXT NOT NULL DEFAULT 'claude',
        fallback_cause TEXT,
        profile TEXT CHECK(profile IS NULL OR profile IN ('fable','sol')),
        profile_fallback INTEGER,
        browser_required INTEGER NOT NULL DEFAULT 0,
        browser_run_id TEXT,
        mode TEXT NOT NULL DEFAULT 'planner',
        status TEXT NOT NULL DEFAULT 'active',
        last_seen_at INTEGER NOT NULL,
        last_seen_activity_at INTEGER,
        trace_id TEXT,
        root_span_id TEXT,
        started_at INTEGER,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY,
        event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
        linear_session_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        source_key TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('created','prompted')),
        prompt TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','running','awaiting_activity','done','failed','interrupted')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        usage_input_tokens INTEGER,
        usage_output_tokens INTEGER,
        usage_cache_creation_tokens INTEGER,
        usage_cache_read_tokens INTEGER,
        cost_usd REAL,
        model TEXT,
        trace_id TEXT,
        turn_span_id TEXT,
        execution_finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS turn_activities (
        turn_id INTEGER PRIMARY KEY REFERENCES turns(id),
        kind TEXT NOT NULL CHECK(kind IN ('response','error')),
        activity_id TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','posted','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        progress_barrier INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_external_urls (
        id INTEGER PRIMARY KEY, linear_session_id TEXT NOT NULL, app TEXT NOT NULL CHECK(app IN ('planner','implementer')),
        label TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','posted','failed')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        error TEXT, UNIQUE(linear_session_id,url)
      );
      CREATE TABLE IF NOT EXISTS cleanup_jobs (
        id INTEGER PRIMARY KEY, issue_id TEXT NOT NULL UNIQUE, issue_identifier TEXT NOT NULL,
        linear_session_id TEXT NOT NULL, app TEXT NOT NULL CHECK(app IN ('planner','implementer')),
        status TEXT NOT NULL CHECK(status IN ('pending','running','done','retained','failed')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT,
        created_at INTEGER NOT NULL, claimed_at INTEGER, notify_activity_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cleanup_notifications (
        job_id INTEGER PRIMARY KEY REFERENCES cleanup_jobs(id), app TEXT NOT NULL, linear_session_id TEXT NOT NULL,
        activity_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','posted','failed')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS stop_acks (
        source_activity_id TEXT PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id),
        app TEXT NOT NULL CHECK(app IN ('planner','implementer')), linear_session_id TEXT NOT NULL,
        activity_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','posted','failed')), attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_state (
        provider TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reason TEXT,
        cooldown_until INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_invocations (
        id INTEGER PRIMARY KEY,
        linear_session_id TEXT NOT NULL REFERENCES sessions(linear_session_id),
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        source TEXT NOT NULL CHECK(source IN ('claude','codex')),
        source_key TEXT NOT NULL UNIQUE,
        parent_invocation_id INTEGER REFERENCES agent_invocations(id),
        role TEXT NOT NULL,
        runtime TEXT NOT NULL,
        model TEXT,
        prompt TEXT,
        report TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        deadline_at INTEGER,
        outcome TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_creation_tokens INTEGER,
        cache_read_tokens INTEGER,
        raw_total_tokens INTEGER,
        prior_total_tokens INTEGER,
        delta_total_tokens INTEGER,
        usage_epoch INTEGER,
        usage_classification TEXT NOT NULL DEFAULT 'unknown',
        trace_id TEXT NOT NULL,
        span_id TEXT,
        provider_conversation_id TEXT,
        provider_turn_id TEXT,
        enrichment_state TEXT NOT NULL CHECK(enrichment_state IN ('pending','enriched','forwarded_unenriched','native_missing','relay_delivery_unknown')),
        stream_completed_at INTEGER,
        native_seen_at INTEGER,
        enrichment_deadline_at INTEGER,
        degradation_reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_usage_checkpoints (
        provider_conversation_id TEXT PRIMARY KEY,
        last_started_at INTEGER NOT NULL,
        last_ended_at INTEGER NOT NULL,
        cumulative_total_tokens INTEGER NOT NULL,
        reset_epoch INTEGER NOT NULL,
        source_key TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS telemetry_outbox (
        session_id TEXT PRIMARY KEY REFERENCES sessions(linear_session_id),
        payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','leased','sending','delivered','failed','delivery_unknown')),
        lease_owner TEXT,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        send_started_at INTEGER,
        acknowledged_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('restart','config','update')),
        reason TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        target_ref TEXT,
        target_commit TEXT,
        previous_commit TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','draining','executing','accepting','rolling_back','blocked','succeeded','failed','cancelled')),
        stage TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        mutated INTEGER NOT NULL DEFAULT 0,
        rollback_verified INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        error_stage TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_one_active
        ON operations((1)) WHERE state IN ('pending','draining','executing','accepting','rolling_back','blocked');
      CREATE TABLE IF NOT EXISTS restart_intents (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        policy TEXT NOT NULL CHECK(policy='interrupt'),
        reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 240),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turn_tool_calls (
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        tool_use_id TEXT NOT NULL CHECK(length(tool_use_id) BETWEEN 1 AND 240),
        tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 120),
        state TEXT NOT NULL CHECK(state IN ('open','completed')),
        opened_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY(turn_id,tool_use_id)
      );
      CREATE INDEX IF NOT EXISTS idx_turn_tool_calls_open
        ON turn_tool_calls(turn_id) WHERE state='open';
    `);
    this.migrateEventColumns();
    this.migrateSessionColumns();
    this.migrateTurnColumns();
    this.migrateAckColumns();
    this.migrateTurnActivityColumns();
    this.recoverAmbiguousOutbox();
  }

  private migrateEventColumns(): void {
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(events)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has("type"))
      this.db.prepare("ALTER TABLE events ADD COLUMN type TEXT").run();
    if (!columns.has("state_type"))
      this.db.prepare("ALTER TABLE events ADD COLUMN state_type TEXT").run();
    if (!columns.has("issue_identifier"))
      this.db
        .prepare("ALTER TABLE events ADD COLUMN issue_identifier TEXT")
        .run();
    if (!columns.has("source_activity_id"))
      this.db
        .prepare("ALTER TABLE events ADD COLUMN source_activity_id TEXT")
        .run();
    if (!columns.has("signal"))
      this.db.prepare("ALTER TABLE events ADD COLUMN signal TEXT").run();
  }

  private migrateSessionColumns(): void {
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has("last_seen_activity_at"))
      this.db
        .prepare(
          "ALTER TABLE sessions ADD COLUMN last_seen_activity_at INTEGER",
        )
        .run();
    if (!columns.has("runtime"))
      this.db
        .prepare(
          "ALTER TABLE sessions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude'",
        )
        .run();
    if (!columns.has("fallback_cause"))
      this.db
        .prepare("ALTER TABLE sessions ADD COLUMN fallback_cause TEXT")
        .run();
    if (!columns.has("profile"))
      this.db
        .prepare(
          "ALTER TABLE sessions ADD COLUMN profile TEXT CHECK(profile IS NULL OR profile IN ('fable','sol'))",
        )
        .run();
    if (!columns.has("profile_fallback"))
      this.db
        .prepare("ALTER TABLE sessions ADD COLUMN profile_fallback INTEGER")
        .run();
    if (!columns.has("browser_required"))
      this.db
        .prepare(
          "ALTER TABLE sessions ADD COLUMN browser_required INTEGER NOT NULL DEFAULT 0",
        )
        .run();
    if (!columns.has("browser_run_id"))
      this.db
        .prepare("ALTER TABLE sessions ADD COLUMN browser_run_id TEXT")
        .run();
    if (!columns.has("trace_id"))
      this.db.prepare("ALTER TABLE sessions ADD COLUMN trace_id TEXT").run();
    if (!columns.has("root_span_id"))
      this.db
        .prepare("ALTER TABLE sessions ADD COLUMN root_span_id TEXT")
        .run();
    if (!columns.has("started_at"))
      this.db
        .prepare("ALTER TABLE sessions ADD COLUMN started_at INTEGER")
        .run();
    if (!columns.has("completed_at"))
      this.db
        .prepare("ALTER TABLE sessions ADD COLUMN completed_at INTEGER")
        .run();
    for (const row of this.db
      .prepare(
        "SELECT linear_session_id linearSessionId,last_seen_at lastSeenAt FROM sessions WHERE trace_id IS NULL OR root_span_id IS NULL OR started_at IS NULL",
      )
      .all() as Array<{ linearSessionId: string; lastSeenAt: number }>) {
      this.db
        .prepare(
          "UPDATE sessions SET trace_id=COALESCE(trace_id,?),root_span_id=COALESCE(root_span_id,?),started_at=COALESCE(started_at,?) WHERE linear_session_id=?",
        )
        .run(randomHex(16), randomHex(8), row.lastSeenAt, row.linearSessionId);
    }
  }

  private migrateTurnColumns(): void {
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(turns)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    const addedSourceKey = !columns.has("source_key");
    if (addedSourceKey)
      this.db.prepare("ALTER TABLE turns ADD COLUMN source_key TEXT").run();
    if (!columns.has("usage_input_tokens"))
      this.db
        .prepare("ALTER TABLE turns ADD COLUMN usage_input_tokens INTEGER")
        .run();
    if (!columns.has("usage_output_tokens"))
      this.db
        .prepare("ALTER TABLE turns ADD COLUMN usage_output_tokens INTEGER")
        .run();
    if (!columns.has("usage_cache_creation_tokens"))
      this.db
        .prepare(
          "ALTER TABLE turns ADD COLUMN usage_cache_creation_tokens INTEGER",
        )
        .run();
    if (!columns.has("usage_cache_read_tokens"))
      this.db
        .prepare("ALTER TABLE turns ADD COLUMN usage_cache_read_tokens INTEGER")
        .run();
    if (!columns.has("cost_usd"))
      this.db.prepare("ALTER TABLE turns ADD COLUMN cost_usd REAL").run();
    if (!columns.has("model"))
      this.db.prepare("ALTER TABLE turns ADD COLUMN model TEXT").run();
    if (!columns.has("trace_id"))
      this.db.prepare("ALTER TABLE turns ADD COLUMN trace_id TEXT").run();
    if (!columns.has("turn_span_id"))
      this.db.prepare("ALTER TABLE turns ADD COLUMN turn_span_id TEXT").run();
    if (!columns.has("execution_finished_at"))
      this.db
        .prepare("ALTER TABLE turns ADD COLUMN execution_finished_at INTEGER")
        .run();
    this.backfillCreatedTurnSourceKeys();
    if (addedSourceKey)
      this.seedActivityCursorsForSourceKeyMigration(Date.now());
    this.db
      .prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_source_key ON turns(source_key)",
      )
      .run();
  }

  private backfillCreatedTurnSourceKeys(): void {
    this.db
      .prepare(
        `
      WITH candidates AS (
        SELECT
          t.id,
          'created:' || COALESCE(NULLIF(e.agent_session_id, ''), t.linear_session_id) AS source_key,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(NULLIF(e.agent_session_id, ''), t.linear_session_id)
            ORDER BY t.id
          ) AS rank
        FROM turns t
        LEFT JOIN events e ON e.id=t.event_id
        WHERE t.kind='created' AND t.source_key IS NULL
      )
      UPDATE turns
      SET source_key=(SELECT candidates.source_key FROM candidates WHERE candidates.id=turns.id)
      WHERE id IN (SELECT id FROM candidates WHERE rank=1)
    `,
      )
      .run();
  }

  private seedActivityCursorsForSourceKeyMigration(now: number): void {
    this.db
      .prepare(
        "UPDATE sessions SET last_seen_activity_at=? WHERE last_seen_activity_at IS NULL",
      )
      .run(now);
  }

  private migrateAckColumns(): void {
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(acks)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has("failure_kind"))
      this.db
        .prepare(
          "ALTER TABLE acks ADD COLUMN failure_kind TEXT CHECK(failure_kind IS NULL OR failure_kind IN ('retriable','terminal'))",
        )
        .run();
    if (!columns.has("next_attempt_at"))
      this.db
        .prepare(
          "ALTER TABLE acks ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0",
        )
        .run();
  }

  private migrateTurnActivityColumns(): void {
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(turn_activities)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has("created_at")) {
      this.db
        .prepare(
          "ALTER TABLE turn_activities ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
        )
        .run();
      this.db
        .prepare(
          "UPDATE turn_activities SET created_at=next_attempt_at WHERE created_at=0",
        )
        .run();
    }
    if (!columns.has("progress_barrier"))
      this.db
        .prepare(
          "ALTER TABLE turn_activities ADD COLUMN progress_barrier INTEGER NOT NULL DEFAULT 0",
        )
        .run();
  }

  private recoverAmbiguousOutbox(): void {
    this.db
      .prepare(
        "UPDATE telemetry_outbox SET state='delivery_unknown',lease_owner=NULL,lease_expires_at=NULL,last_error='restart_after_send' WHERE state='sending'",
      )
      .run();
  }

  append(event: AppendEvent): AppendResult {
    const deliveryId =
      event.deliveryId?.trim() ||
      `sha256:${createHash("sha256").update(event.rawBody).digest("hex")}`;
    const run = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO events
        (delivery_id, webhook_id, app, action, agent_session_id, source_activity_id, issue_id, issue_identifier, type, state_type, signal, received_at, raw_body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deliveryId,
          event.webhookId ?? null,
          event.app,
          event.action ?? null,
          event.agentSessionId ?? null,
          event.sourceActivityId ?? null,
          event.issueId ?? null,
          event.issueIdentifier ?? null,
          event.type ?? null,
          event.stateType ?? null,
          event.signal ?? null,
          event.receivedAt,
          event.rawBody,
        );
      if (result.changes === 0) return { inserted: false } as const;
      const eventId = Number(result.lastInsertRowid);
      if (event.action === "prompted" && event.agentSessionId && event.signal) {
        if (event.signal === "stop") {
          const ackResult = this.db
            .prepare(
              `INSERT OR IGNORE INTO stop_acks
            (source_activity_id,event_id,app,linear_session_id,activity_id,body,status,next_attempt_at,created_at)
            VALUES (?,?,?,?,?,?,'pending',?,?)`,
            )
            .run(
              event.sourceActivityId ?? deliveryId,
              eventId,
              event.app,
              event.agentSessionId,
              randomUUID(),
              STOP_ACK_BODY,
              event.receivedAt,
              event.receivedAt,
            );
          if (ackResult.changes === 0) return { inserted: true } as const;
          this.db
            .prepare(
              `UPDATE turns SET status='interrupted', error='stopped by user', finished_at=?
            WHERE linear_session_id=? AND status='pending'`,
            )
            .run(event.receivedAt, event.agentSessionId);
          this.db
            .prepare(
              "UPDATE sessions SET last_seen_at=? WHERE linear_session_id=?",
            )
            .run(event.receivedAt, event.agentSessionId);
          return {
            inserted: true,
            stop: { agentSessionId: event.agentSessionId, app: event.app },
          } as const;
        }
        return { inserted: true } as const;
      }
      let assignment:
        | {
            profile: "fable" | "sol";
            runtime: "claude" | "claudex";
            reason: string;
          }
        | undefined;
      const createsTurn =
        event.agentSessionId &&
        (event.action === "created" || event.action === "prompted");
      if (createsTurn) {
        const existing = this.db
          .prepare(
            "SELECT issue_id issueId, issue_identifier issueIdentifier FROM sessions WHERE linear_session_id=?",
          )
          .get(event.agentSessionId) as
          | { issueId: string | null; issueIdentifier: string | null }
          | undefined;
        const issueId =
          event.issueId ?? existing?.issueId ?? event.agentSessionId;
        const issueIdentifier =
          event.issueIdentifier ??
          existing?.issueIdentifier ??
          event.issueId ??
          event.agentSessionId;
        assignment = existing ? undefined : this.selectProfile(event.app);
        this.db
          .prepare(
            `INSERT INTO sessions
          (linear_session_id, app, issue_id, issue_identifier, profile, runtime, mode, status, last_seen_at,trace_id,root_span_id,started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?,?,?,?)
          ON CONFLICT(linear_session_id) DO UPDATE SET
            issue_id=COALESCE(excluded.issue_id, sessions.issue_id),
            issue_identifier=COALESCE(excluded.issue_identifier, sessions.issue_identifier),
            last_seen_at=excluded.last_seen_at`,
          )
          .run(
            event.agentSessionId,
            event.app,
            issueId,
            issueIdentifier,
            assignment?.profile ?? null,
            assignment?.runtime ?? "claude",
            event.app,
            event.receivedAt,
            randomHex(16),
            randomHex(8),
            event.receivedAt,
          );
        if (event.action === "created" && event.issueId) {
          this.db
            .prepare(
              `UPDATE sessions SET issue_id=?, issue_identifier=?, last_seen_at=?
            WHERE linear_session_id=?`,
            )
            .run(
              event.issueId,
              issueIdentifier,
              event.receivedAt,
              event.agentSessionId,
            );
          if (existing?.issueId && existing.issueId !== event.issueId) {
            this.db
              .prepare(
                `UPDATE turns SET issue_id=?
              WHERE linear_session_id=? AND issue_id=? AND status IN ('pending','running','awaiting_activity')`,
              )
              .run(event.issueId, event.agentSessionId, existing.issueId);
          }
        }
        const sourceKey = this.turnSourceKey(event);
        const turnResult = this.db
          .prepare(
            `INSERT OR IGNORE INTO turns
          (event_id, linear_session_id, issue_id, source_key, kind, status)
          VALUES (?, ?, ?, ?, ?, 'pending')`,
          )
          .run(eventId, event.agentSessionId, issueId, sourceKey, event.action);
        if (event.action === "created" && turnResult.changes > 0) {
          this.db
            .prepare(
              `INSERT INTO acks (event_id, activity_id, status, next_attempt_at, deadline_at)
            VALUES (?, ?, 'pending', ?, ?)`,
            )
            .run(
              eventId,
              randomUUID(),
              event.receivedAt,
              event.receivedAt + 10_000,
            );
        }
      }
      if (
        event.type === "Issue" &&
        event.stateType === "completed" &&
        event.issueId &&
        event.issueIdentifier
      ) {
        this.enqueueCleanup(
          event.issueId,
          event.issueIdentifier,
          event.receivedAt,
        );
      }
      if (assignment)
        return {
          inserted: true,
          assignedProfile: assignment.profile,
          assignedRuntime: assignment.runtime,
          assignmentReason: assignment.reason,
        } as const;
      return { inserted: true } as const;
    });
    const result = run();
    return { ...result, deliveryId };
  }

  private turnSourceKey(event: AppendEvent): string | null {
    if (!event.agentSessionId) return null;
    if (event.action === "created") return `created:${event.agentSessionId}`;
    if (event.action === "prompted" && event.sourceActivityId) {
      return `prompt:${event.agentSessionId}:${event.sourceActivityId}`;
    }
    return null;
  }

  claimNextTurn(now = Date.now()): TurnRow | undefined {
    return this.db.transaction(() => {
      const candidate = this.db
        .prepare(
          `SELECT t.id FROM turns t
        WHERE t.status='pending'
          AND NOT EXISTS (SELECT 1 FROM operations o
            WHERE o.state IN ('pending','draining','executing','accepting','rolling_back','blocked'))
          AND NOT EXISTS (SELECT 1 FROM turns earlier WHERE earlier.issue_id=t.issue_id
            AND earlier.id<t.id AND (
              earlier.status IN ('pending','running','awaiting_activity')
              OR EXISTS (SELECT 1 FROM turn_activities a WHERE a.turn_id=earlier.id AND a.status='pending')
            ))
          AND NOT EXISTS (SELECT 1 FROM turns active WHERE active.issue_id=t.issue_id AND active.status='running')
          AND NOT EXISTS (SELECT 1 FROM cleanup_jobs c WHERE c.issue_id=t.issue_id AND c.status='running')
        ORDER BY t.id LIMIT 1`,
        )
        .get() as { id: number } | undefined;
      if (!candidate) return undefined;
      const changed = this.db
        .prepare(
          `UPDATE turns SET status='running', attempts=attempts+1, started_at=?, error=NULL
        WHERE id=? AND status='pending'`,
        )
        .run(now, candidate.id);
      if (!changed.changes) return undefined;
      return this.turnById(candidate.id);
    })();
  }

  scheduleOperation(input: ScheduleOperationInput): { operation: OperationRow; deduplicated: boolean } {
    validateScheduleOperation(input);
    return this.db.transaction(() => {
      const active = this.activeOperation();
      if (active) {
        const equivalent = active.type === input.type
          && active.requestDigest === input.requestDigest;
        // Restarts intentionally converge even though separately-created request files have
        // different IDs. Other payload-bearing mutations must match exactly.
        if (equivalent || (active.type === "restart" && input.type === "restart")) {
          return { operation: active, deduplicated: true };
        }
        throw new Error(`active operation ${active.id} (${active.type}) already blocks new mutations`);
      }
      const now = input.requestedAt ?? Date.now();
      this.db.prepare(`INSERT INTO operations
        (id,request_digest,type,reason,requested_at,target_ref,target_commit,previous_commit,state,updated_at)
        VALUES (?,?,?,?,?,?,?,?, 'pending',?)`).run(input.id, input.requestDigest, input.type,
          input.reason, now, input.targetRef ?? null, input.targetCommit ?? null,
          input.previousCommit ?? null, now);
      return { operation: this.operationById(input.id)!, deduplicated: false };
    })();
  }

  operationById(id: string): OperationRow | undefined {
    return this.db.prepare(`SELECT id,request_digest requestDigest,type,reason,requested_at requestedAt,
      target_ref targetRef,target_commit targetCommit,previous_commit previousCommit,state,stage,attempts,
      mutated,rollback_verified rollbackVerified,outcome,error_stage errorStage,updated_at updatedAt
      FROM operations WHERE id=?`).get(id) as OperationRow | undefined;
  }

  activeOperation(): OperationRow | undefined {
    return this.db.prepare(`SELECT id,request_digest requestDigest,type,reason,requested_at requestedAt,
      target_ref targetRef,target_commit targetCommit,previous_commit previousCommit,state,stage,attempts,
      mutated,rollback_verified rollbackVerified,outcome,error_stage errorStage,updated_at updatedAt
      FROM operations WHERE state IN ('pending','draining','executing','accepting','rolling_back','blocked')
      ORDER BY requested_at LIMIT 1`).get() as OperationRow | undefined;
  }

  claimOperation(id: string, digest: string, now = Date.now()): OperationRow | undefined {
    return this.db.transaction(() => {
      const row = this.operationById(id);
      if (!row || row.requestDigest !== digest || row.state === "blocked"
          || !ACTIVE_OPERATION_STATES.includes(row.state as never)) return undefined;
      if (row.state === "pending") {
        this.db.prepare("UPDATE operations SET state='draining',stage='wait_idle',attempts=attempts+1,updated_at=? WHERE id=? AND state='pending'")
          .run(now, id);
      } else {
        this.db.prepare("UPDATE operations SET attempts=attempts+1,updated_at=? WHERE id=?").run(now, id);
      }
      return this.operationById(id);
    })();
  }

  transitionOperation(id: string, state: OperationState, stage: string | null, options: {
    outcome?: string | null; errorStage?: string | null; mutated?: boolean; rollbackVerified?: boolean;
  } = {}, now = Date.now()): OperationRow {
    const current = this.operationById(id);
    if (!current) throw new Error(`unknown operation: ${id}`);
    if ((state === "failed" || state === "cancelled") && current.mutated === 1
        && !(options.rollbackVerified ?? current.rollbackVerified === 1)) {
      throw new Error("cannot release drain after mutation without verified rollback");
    }
    this.db.prepare(`UPDATE operations SET state=?,stage=?,outcome=?,error_stage=?,
      mutated=?,rollback_verified=?,updated_at=? WHERE id=?`).run(state, stage,
        options.outcome ?? current.outcome, options.errorStage ?? current.errorStage,
        options.mutated === undefined ? current.mutated : Number(options.mutated),
        options.rollbackVerified === undefined ? current.rollbackVerified : Number(options.rollbackVerified), now, id);
    return this.operationById(id)!;
  }

  retryOperation(id: string, now = Date.now()): OperationRow {
    const row = this.operationById(id);
    if (!row || row.state !== "blocked") throw new Error("only a blocked operation can be retried");
    this.db.prepare("UPDATE operations SET state='draining',stage='wait_idle',error_stage=NULL,updated_at=? WHERE id=?")
      .run(now, id);
    return this.operationById(id)!;
  }

  cancelOperation(id: string, now = Date.now()): OperationRow {
    const row = this.operationById(id);
    if (!row || !ACTIVE_OPERATION_STATES.includes(row.state as never)) throw new Error("operation is not active");
    if (row.mutated === 1 && row.rollbackVerified !== 1) throw new Error("operation may not be cancelled after mutation without verified rollback");
    return this.transitionOperation(id, "cancelled", "cancelled", { outcome: "cancelled by operator" }, now);
  }

  runningTurns(now = Date.now()): SafeRunningTurn[] {
    return this.db.prepare(`SELECT e.app,COALESCE(s.issue_identifier,t.issue_id) issueIdentifier,
      COALESCE(s.runtime,'claude') runtime,'running' state,t.started_at startedAt,
      MAX(0,?-COALESCE(t.started_at,?)) elapsedMs
      FROM turns t JOIN events e ON e.id=t.event_id
      LEFT JOIN sessions s ON s.linear_session_id=t.linear_session_id
      WHERE t.status='running' ORDER BY t.started_at,t.id`).all(now, now) as SafeRunningTurn[];
  }

  operationStatus(now = Date.now()): SafeOperationStatus {
    const pending = this.activeOperation();
    const last = this.db.prepare(`SELECT id,type,state,stage,outcome,error_stage errorStage,updated_at updatedAt
      FROM operations WHERE state IN ('succeeded','failed','cancelled') ORDER BY updated_at DESC LIMIT 1`)
      .get() as SafeOperationStatus["lastOutcome"];
    return {
      pending: pending ? { id: pending.id, type: pending.type, reason: pending.reason,
        requestedAt: pending.requestedAt, targetRef: pending.targetRef, targetCommit: pending.targetCommit,
        drainState: pending.state, stage: pending.stage, attempts: pending.attempts,
        recoveryCommand: pending.state === "blocked" ? `daemonctl operation retry ${pending.id}` : null } : null,
      runningTurns: this.runningTurns(now).length,
      lastOutcome: last ?? null,
    };
  }

  private turnById(id: number): TurnRow | undefined {
    return this.db
      .prepare(
        `SELECT t.id, t.event_id eventId, e.app, t.linear_session_id linearSessionId,
      t.issue_id issueId, t.kind, t.prompt, t.status, t.attempts, t.error, t.started_at startedAt,
      t.finished_at finishedAt, t.turn_span_id turnSpanId,t.execution_finished_at executionFinishedAt,e.raw_body rawBody, e.received_at receivedAt
      FROM turns t JOIN events e ON e.id=t.event_id WHERE t.id=?`,
      )
      .get(id) as TurnRow | undefined;
  }

  setTurnPrompt(turnId: number, prompt: string): void {
    this.db.prepare("UPDATE turns SET prompt=? WHERE id=?").run(prompt, turnId);
  }
  getSession(linearSessionId: string): SessionRow | undefined {
    return this.db
      .prepare(
        `SELECT linear_session_id linearSessionId, app, issue_id issueId,
      issue_identifier issueIdentifier, worktree_path worktreePath, branch, claude_session_id claudeSessionId,
      runtime, fallback_cause fallbackCause, profile, profile_fallback profileFallback,
      browser_required browserRequired, browser_run_id browserRunId,
      mode, status, last_seen_at lastSeenAt, last_seen_activity_at lastSeenActivityAt,
      trace_id traceId,root_span_id rootSpanId,started_at startedAt,completed_at completedAt FROM sessions WHERE linear_session_id=?`,
      )
      .get(linearSessionId) as SessionRow | undefined;
  }
  sessionByIssueIdentifier(identifier: string): SessionRow | undefined {
    const query = (mode: string) =>
      this.db
        .prepare(
          `SELECT linear_session_id linearSessionId, app, issue_id issueId,
      issue_identifier issueIdentifier, worktree_path worktreePath, branch, claude_session_id claudeSessionId,
      runtime, fallback_cause fallbackCause, profile, profile_fallback profileFallback,
      browser_required browserRequired, browser_run_id browserRunId,
      mode, status, last_seen_at lastSeenAt, last_seen_activity_at lastSeenActivityAt,
      trace_id traceId,root_span_id rootSpanId,started_at startedAt,completed_at completedAt FROM sessions WHERE issue_identifier=? AND mode=? ORDER BY last_seen_at DESC LIMIT 1`,
        )
        .get(identifier, mode) as SessionRow | undefined;
    return query("implementer") ?? query("planner");
  }
  plannerSessionsForReconcile(): SessionRow[] {
    return this.db
      .prepare(
        `SELECT linear_session_id linearSessionId, app, issue_id issueId,
      issue_identifier issueIdentifier, worktree_path worktreePath, branch, claude_session_id claudeSessionId,
      runtime, fallback_cause fallbackCause, profile, profile_fallback profileFallback,
      browser_required browserRequired, browser_run_id browserRunId,
      mode, status, last_seen_at lastSeenAt, last_seen_activity_at lastSeenActivityAt,
      trace_id traceId,root_span_id rootSpanId,started_at startedAt,completed_at completedAt
      FROM sessions WHERE app='planner' AND mode='planner' ORDER BY last_seen_at`,
      )
      .all() as SessionRow[];
  }
  sessionsWithWorktrees(): SessionRow[] {
    return this.db
      .prepare(
        `SELECT linear_session_id linearSessionId, app, issue_id issueId,
      issue_identifier issueIdentifier, worktree_path worktreePath, branch, claude_session_id claudeSessionId,
      runtime, fallback_cause fallbackCause, profile, profile_fallback profileFallback,
      browser_required browserRequired, browser_run_id browserRunId,
      mode, status, last_seen_at lastSeenAt, last_seen_activity_at lastSeenActivityAt,
      trace_id traceId,root_span_id rootSpanId,started_at startedAt,completed_at completedAt
      FROM sessions WHERE worktree_path IS NOT NULL ORDER BY last_seen_at`,
      )
      .all() as SessionRow[];
  }
  hasOpenTurn(linearSessionId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM turns WHERE linear_session_id=?
      AND status IN ('pending','running') LIMIT 1`,
        )
        .get(linearSessionId) !== undefined
    );
  }
  turnIdForSpan(linearSessionId: string, spanId: string): number | undefined {
    return (
      this.db
        .prepare(
          "SELECT id FROM turns WHERE linear_session_id=? AND turn_span_id=?",
        )
        .get(linearSessionId, spanId) as { id: number } | undefined
    )?.id;
  }
  turnSpanId(turnId: number): string | undefined {
    return (
      (
        this.db
          .prepare("SELECT turn_span_id turnSpanId FROM turns WHERE id=?")
          .get(turnId) as { turnSpanId: string | null } | undefined
      )?.turnSpanId ?? undefined
    );
  }
  latestTurnId(linearSessionId: string): number | undefined {
    return (
      this.db
        .prepare(
          "SELECT id FROM turns WHERE linear_session_id=? ORDER BY id DESC LIMIT 1",
        )
        .get(linearSessionId) as { id: number } | undefined
    )?.id;
  }
  updateLastSeenActivity(
    linearSessionId: string,
    seenAt: number,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET last_seen_activity_at=MAX(COALESCE(last_seen_activity_at, 0), ?), last_seen_at=?
      WHERE linear_session_id=?`,
      )
      .run(seenAt, now, linearSessionId);
  }
  updateSessionWorktree(
    linearSessionId: string,
    path: string,
    branch: string,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET worktree_path=?, branch=?, last_seen_at=? WHERE linear_session_id=?`,
      )
      .run(path, branch, now, linearSessionId);
  }
  clearSessionWorktrees(issueIdentifier: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET worktree_path=NULL WHERE issue_identifier=?",
      )
      .run(issueIdentifier);
  }
  updateClaudeSessionId(
    linearSessionId: string,
    id: string,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET claude_session_id=?, last_seen_at=? WHERE linear_session_id=?`,
      )
      .run(id, now, linearSessionId);
  }
  clearClaudeSessionId(linearSessionId: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE sessions SET claude_session_id=NULL, last_seen_at=? WHERE linear_session_id=?",
      )
      .run(now, linearSessionId);
  }
  requireBrowser(
    linearSessionId: string,
    runId: string,
    now = Date.now(),
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE sessions SET browser_required=1, browser_run_id=COALESCE(browser_run_id, ?), last_seen_at=?
      WHERE linear_session_id=? AND browser_required=0`,
        )
        .run(runId, now, linearSessionId).changes === 1
    );
  }
  getProviderState(provider: string): ProviderStateRow | undefined {
    return this.db
      .prepare(
        `SELECT provider, status, reason, cooldown_until cooldownUntil, updated_at updatedAt
      FROM provider_state WHERE provider=?`,
      )
      .get(provider) as ProviderStateRow | undefined;
  }
  setProviderState(
    provider: string,
    status: string,
    reason: string | null,
    updatedAt = Date.now(),
    cooldownUntil?: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO provider_state(provider,status,reason,cooldown_until,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(provider) DO UPDATE SET status=excluded.status, reason=excluded.reason,
      cooldown_until=excluded.cooldown_until, updated_at=excluded.updated_at`,
      )
      .run(provider, status, reason, cooldownUntil ?? null, updatedAt);
  }
  setProviderCooldown(
    provider: string,
    cooldownUntil: number,
    reason: string,
    updatedAt = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO provider_state(provider,status,reason,cooldown_until,updated_at) VALUES(?,'cooldown',?,?,?)
      ON CONFLICT(provider) DO UPDATE SET status='cooldown', reason=excluded.reason,
      cooldown_until=excluded.cooldown_until, updated_at=excluded.updated_at`,
      )
      .run(provider, reason, cooldownUntil, updatedAt);
  }
  setTurnTraceId(turnId: number, traceId: string): void {
    this.db
      .prepare("UPDATE turns SET trace_id=? WHERE id=?")
      .run(traceId, turnId);
  }
  setTurnTraceContext(turnId: number, traceId: string, spanId: string): void {
    this.db
      .prepare("UPDATE turns SET trace_id=?,turn_span_id=? WHERE id=?")
      .run(traceId, spanId, turnId);
  }
  touchSession(linearSessionId: string, now = Date.now()): void {
    this.db
      .prepare("UPDATE sessions SET last_seen_at=? WHERE linear_session_id=?")
      .run(now, linearSessionId);
  }
  finishTurn(
    turnId: number,
    kind: "response" | "error",
    body: string,
    now = Date.now(),
    activityId = randomUUID(),
    progressBarrier = false,
    usage?: TurnUsage,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO turn_activities
        (turn_id, kind, activity_id, body, status, next_attempt_at, created_at, progress_barrier)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(turnId, kind, activityId, body, now, now, progressBarrier ? 1 : 0);
      this.db
        .prepare(
          `UPDATE turns SET status='awaiting_activity', error=?, finished_at=?,execution_finished_at=?,
        usage_input_tokens=?, usage_output_tokens=?, usage_cache_creation_tokens=?, usage_cache_read_tokens=?, cost_usd=?, model=? WHERE id=?`,
        )
        .run(
          kind === "error" ? body : null,
          now,
          now,
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.cacheCreationTokens ?? null,
          usage?.cacheReadTokens ?? null,
          usage?.costUsd ?? null,
          usage?.model ?? null,
          turnId,
        );
    })();
  }
  clearTurnProgressBarrier(turnId: number): void {
    this.db
      .prepare("UPDATE turn_activities SET progress_barrier=0 WHERE turn_id=?")
      .run(turnId);
  }
  markTurnStopped(turnId: number, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE turns SET status='interrupted', error='stopped by user', finished_at=? WHERE id=?",
      )
      .run(now, turnId);
  }
  recordRestartIntent(reason: string, now = Date.now()): RestartIntentRow {
    const normalized = reason.trim();
    if (
      normalized.length === 0 ||
      normalized.length > 240 ||
      normalized.includes("\n") ||
      normalized.includes("\r")
    )
      throw new Error("restart intent reason must be one line of at most 240 characters");
    this.db
      .prepare(
        `INSERT INTO restart_intents(singleton,policy,reason,created_at)
      VALUES(1,'interrupt',?,?)
      ON CONFLICT(singleton) DO UPDATE SET policy='interrupt',reason=excluded.reason,created_at=excluded.created_at`,
      )
      .run(normalized, now);
    return this.restartIntent()!;
  }
  restartIntent(): RestartIntentRow | undefined {
    return this.db
      .prepare(
        `SELECT policy,reason,created_at createdAt
      FROM restart_intents WHERE singleton=1`,
      )
      .get() as RestartIntentRow | undefined;
  }
  clearRestartIntent(): boolean {
    return (
      this.db.prepare("DELETE FROM restart_intents WHERE singleton=1").run()
        .changes === 1
    );
  }
  recordTurnToolCallStarted(
    turnId: number,
    toolUseId: string,
    toolName: string,
    now = Date.now(),
  ): void {
    const id = this.boundedToolUseId(toolUseId);
    const name = toolName.trim().slice(0, 120) || "unknown";
    const turn = this.db
      .prepare("SELECT status FROM turns WHERE id=?")
      .get(turnId) as { status: string } | undefined;
    if (turn?.status !== "running")
      throw new Error("tool call turn is not running");
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO turn_tool_calls
      (turn_id,tool_use_id,tool_name,state,opened_at)
      VALUES(?,?,?,'open',?)`,
      )
      .run(turnId, id, name, now);
    if (inserted.changes === 1) return;
    const existing = this.db
      .prepare(
        `SELECT tool_name toolName,state FROM turn_tool_calls
      WHERE turn_id=? AND tool_use_id=?`,
      )
      .get(turnId, id) as
      | { toolName: string; state: "open" | "completed" }
      | undefined;
    if (existing?.state !== "open" || existing.toolName !== name)
      throw new Error("tool use id conflicts with durable tool-call state");
  }
  recordTurnToolCallCompleted(
    turnId: number,
    toolUseId: string,
    now = Date.now(),
  ): boolean {
    const changed = this.db
        .prepare(
          `UPDATE turn_tool_calls SET state='completed',completed_at=?
        WHERE turn_id=? AND tool_use_id=? AND state='open'`,
        )
        .run(now, turnId, this.boundedToolUseId(toolUseId));
    if (changed.changes === 1) return true;
    const existing = this.db
      .prepare(
        `SELECT state FROM turn_tool_calls
      WHERE turn_id=? AND tool_use_id=?`,
      )
      .get(turnId, this.boundedToolUseId(toolUseId)) as
      | { state: "open" | "completed" }
      | undefined;
    if (existing?.state === "completed") return false;
    throw new Error("tool call completion has no durable open record");
  }
  openTurnToolCalls(turnId: number): TurnToolCallRow[] {
    return this.db
      .prepare(
        `SELECT turn_id turnId,tool_use_id toolUseId,tool_name toolName,state,
      opened_at openedAt,completed_at completedAt
      FROM turn_tool_calls WHERE turn_id=? AND state='open' ORDER BY opened_at,tool_use_id`,
      )
      .all(turnId) as TurnToolCallRow[];
  }
  recoverStaleRunning(now = Date.now()): RestartDisposition[] {
    return this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE turn_activities SET progress_barrier=0 WHERE progress_barrier=1",
        )
        .run();
      const hardRestart = this.restartIntent() !== undefined;
      const rows = this.db
        .prepare(
          `SELECT t.id,t.linear_session_id linearSessionId,t.issue_id issueId,
        e.app,s.issue_identifier issueIdentifier,s.claude_session_id claudeSessionId,
        EXISTS(SELECT 1 FROM turn_tool_calls c WHERE c.turn_id=t.id AND c.state='open') hasOpenTool
        FROM turns t
        JOIN events e ON e.id=t.event_id
        LEFT JOIN sessions s ON s.linear_session_id=t.linear_session_id
        WHERE t.status='running'
        ORDER BY t.id`,
        )
        .all() as Array<{
        id: number;
        linearSessionId: string;
        issueId: string;
        app: AppName;
        issueIdentifier: string | null;
        claudeSessionId: string | null;
        hasOpenTool: number;
      }>;
      const dispositions: RestartDisposition[] = [];
      for (const row of rows) {
        this.db
          .prepare(
            "UPDATE turns SET status='interrupted', error='daemon restarted during turn', finished_at=? WHERE id=?",
          )
          .run(now, row.id);
        const reason: RestartDisposition["reason"] = hardRestart
          ? "hard_restart"
          : row.hasOpenTool
            ? "unresolved_tool_call"
            : !row.claudeSessionId
              ? "missing_claude_session"
              : "safe_boundary";
        if (reason === "safe_boundary") {
          const sourceKey = `restart-resume:${row.id}`;
          this.db
            .prepare(
              `INSERT OR IGNORE INTO events
            (delivery_id,app,action,agent_session_id,source_activity_id,issue_id,issue_identifier,received_at,raw_body)
            VALUES (?,?,'prompted',?,?,?,?,?,?)`,
            )
            .run(
              sourceKey,
              row.app,
              row.linearSessionId,
              sourceKey,
              row.issueId,
              row.issueIdentifier,
              now,
              Buffer.from(
                JSON.stringify({
                  agentActivity: {
                    body: "Continue from the interrupted daemon turn. Review the current worktree state before proceeding.",
                  },
                }),
              ),
            );
          const event = this.db
            .prepare("SELECT id FROM events WHERE delivery_id=?")
            .get(sourceKey) as { id: number };
          this.db
            .prepare(
              `INSERT OR IGNORE INTO turns
            (event_id,linear_session_id,issue_id,source_key,kind,status)
            VALUES (?,?,?,?, 'prompted','pending')`,
            )
            .run(
              event.id,
              row.linearSessionId,
              row.issueId,
              sourceKey,
            );
          const resume = this.db
            .prepare("SELECT id FROM turns WHERE source_key=?")
            .get(sourceKey) as { id: number };
          dispositions.push({
            turnId: row.id,
            outcome: "resumed",
            reason,
            resumeTurnId: resume.id,
          });
          continue;
        }
        const body =
          reason === "hard_restart"
            ? "The run was interrupted by an explicit hard restart and was not resumed. Please review the current state before continuing."
            : reason === "unresolved_tool_call"
              ? "The run was interrupted while an external tool call may have been in flight. Please review its effects before continuing."
              : row.app === "implementer"
                ? "The implementation run was interrupted before a resumable Claude session was saved. Assign bloom-implementer again to retry."
                : "The planner session was interrupted before a resumable Claude session was saved. Please prompt again to continue.";
        this.db
          .prepare(
            `INSERT OR IGNORE INTO turn_activities
          (turn_id, kind, activity_id, body, status, next_attempt_at, created_at, progress_barrier)
          VALUES (?, 'error', ?, ?, 'pending', ?, ?, 0)`,
          )
          .run(
            row.id,
            deterministicUuid(`restart-human:${row.id}`),
            body,
            now,
            now,
          );
        dispositions.push({
          turnId: row.id,
          outcome: "human_required",
          reason,
          resumeTurnId: null,
        });
      }
      this.db.prepare("DELETE FROM restart_intents WHERE singleton=1").run();
      return dispositions;
    })();
  }
  interruptStaleRunning(now = Date.now()): number[] {
    return this.recoverStaleRunning(now).map((row) => row.turnId);
  }
  private boundedToolUseId(toolUseId: string): string {
    const normalized = toolUseId.trim();
    if (!normalized) throw new Error("tool use id must not be empty");
    return normalized.length <= 240
      ? normalized
      : `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
  }
  pendingTurnActivities(
    now = Date.now(),
    _retryWindowMs = 30 * 60_000,
  ): TurnActivityRow[] {
    return this.db
      .prepare(
        `SELECT a.turn_id turnId, e.app, t.linear_session_id linearSessionId, a.kind,
      a.activity_id activityId, a.body, a.status, a.attempts, a.next_attempt_at nextAttemptAt, e.received_at receivedAt
      , a.created_at createdAt, a.progress_barrier progressBarrier
      FROM turn_activities a JOIN turns t ON t.id=a.turn_id JOIN events e ON e.id=t.event_id
      WHERE a.status='pending' AND a.progress_barrier=0 AND a.next_attempt_at<=?
      ORDER BY a.next_attempt_at, a.turn_id`,
      )
      .all(now) as TurnActivityRow[];
  }
  markTurnActivityPosted(turnId: number, now = Date.now()): void {
    this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT kind FROM turn_activities WHERE turn_id=?")
        .get(turnId) as { kind: "response" | "error" };
      this.db
        .prepare(
          "UPDATE turn_activities SET status='posted', attempts=attempts+1 WHERE turn_id=?",
        )
        .run(turnId);
      this.db
        .prepare(
          `UPDATE turns SET status=CASE
          WHEN status='interrupted' THEN 'interrupted'
          ELSE ?
        END, finished_at=? WHERE id=?`,
        )
        .run(row.kind === "response" ? "done" : "failed", now, turnId);
    })();
  }
  markTurnActivityRetry(turnId: number, nextAttemptAt: number): void {
    this.db
      .prepare(
        "UPDATE turn_activities SET attempts=attempts+1, next_attempt_at=? WHERE turn_id=?",
      )
      .run(nextAttemptAt, turnId);
  }
  markTurnActivityFailed(
    turnId: number,
    error: string,
    now = Date.now(),
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE turn_activities SET status='failed', attempts=attempts+1 WHERE turn_id=?",
        )
        .run(turnId);
      this.db
        .prepare(
          `UPDATE turns SET status=CASE
          WHEN status='interrupted' THEN 'interrupted'
          ELSE 'failed'
        END, error=?, finished_at=? WHERE id=?`,
        )
        .run(error, now, turnId);
    })();
  }
  turnStates(): Array<{
    id: number;
    linearSessionId: string;
    status: string;
    issueId: string;
    sourceKey: string | null;
    kind: string;
    prompt: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT id, linear_session_id linearSessionId, status, issue_id issueId,
      source_key sourceKey, kind, prompt FROM turns ORDER BY id`,
      )
      .all() as Array<{
      id: number;
      linearSessionId: string;
      status: string;
      issueId: string;
      sourceKey: string | null;
      kind: string;
      prompt: string | null;
    }>;
  }

  pendingStopAcks(now = Date.now()): StopAckRow[] {
    return this.db
      .prepare(
        `SELECT source_activity_id sourceActivityId,event_id eventId,app,
      linear_session_id linearSessionId,activity_id activityId,body,status,attempts,
      next_attempt_at nextAttemptAt,created_at createdAt FROM stop_acks
      WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at`,
      )
      .all(now) as StopAckRow[];
  }
  markStopAckPosted(sourceActivityId: string): void {
    this.db
      .prepare(
        "UPDATE stop_acks SET status='posted',attempts=attempts+1 WHERE source_activity_id=?",
      )
      .run(sourceActivityId);
  }
  markStopAckRetry(sourceActivityId: string, nextAttemptAt: number): void {
    this.db
      .prepare(
        "UPDATE stop_acks SET attempts=attempts+1,next_attempt_at=? WHERE source_activity_id=?",
      )
      .run(nextAttemptAt, sourceActivityId);
  }
  markStopAckFailed(sourceActivityId: string): void {
    this.db
      .prepare(
        "UPDATE stop_acks SET status='failed',attempts=attempts+1 WHERE source_activity_id=?",
      )
      .run(sourceActivityId);
  }
  stopAckStates(): Array<{
    sourceActivityId: string;
    linearSessionId: string;
    status: string;
    body: string;
    attempts: number;
  }> {
    return this.db
      .prepare(
        `SELECT source_activity_id sourceActivityId,linear_session_id linearSessionId,status,body,attempts
      FROM stop_acks ORDER BY created_at`,
      )
      .all() as Array<{
      sourceActivityId: string;
      linearSessionId: string;
      status: string;
      body: string;
      attempts: number;
    }>;
  }

  stageExternalUrl(
    linearSessionId: string,
    app: AppName,
    label: string,
    url: string,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_external_urls
      (linear_session_id,app,label,url,status,next_attempt_at,created_at) VALUES (?,?,?,?, 'pending',?,?)`,
      )
      .run(linearSessionId, app, label, url, now, now);
  }
  pendingExternalUrls(now = Date.now()): ExternalUrlRow[] {
    return this.db
      .prepare(
        `SELECT id, linear_session_id linearSessionId, app, label, url, attempts,
      next_attempt_at nextAttemptAt, created_at createdAt FROM session_external_urls
      WHERE status='pending' AND next_attempt_at<=? ORDER BY id`,
      )
      .all(now) as ExternalUrlRow[];
  }
  hasExternalUrl(linearSessionId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM session_external_urls WHERE linear_session_id=? LIMIT 1",
        )
        .get(linearSessionId) !== undefined
    );
  }
  markExternalUrlPosted(id: number): void {
    this.db
      .prepare(
        "UPDATE session_external_urls SET status='posted',attempts=attempts+1,error=NULL WHERE id=?",
      )
      .run(id);
  }
  markExternalUrlRetry(id: number, error: string, next: number): void {
    this.db
      .prepare(
        "UPDATE session_external_urls SET attempts=attempts+1,error=?,next_attempt_at=? WHERE id=?",
      )
      .run(error, next, id);
  }
  markExternalUrlFailed(id: number, error: string): void {
    this.db
      .prepare(
        "UPDATE session_external_urls SET status='failed',attempts=attempts+1,error=? WHERE id=?",
      )
      .run(error, id);
  }

  enqueueCleanup(issueId: string, identifier: string, now = Date.now()): void {
    const session = this.sessionByIssueIdentifier(identifier);
    if (!session?.worktreePath) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO cleanup_jobs
      (issue_id,issue_identifier,linear_session_id,app,status,next_attempt_at,created_at,notify_activity_id)
      VALUES (?,?,?,?, 'pending',?,?,?)`,
      )
      .run(
        issueId,
        identifier,
        session.linearSessionId,
        session.app,
        now,
        now,
        randomUUID(),
      );
  }
  claimNextCleanup(now = Date.now()): CleanupJobRow | undefined {
    return this.db.transaction(() => {
      const candidate = this.db
        .prepare(
          `SELECT id FROM cleanup_jobs c WHERE status='pending' AND next_attempt_at<=?
        AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.issue_id=c.issue_id AND t.status IN ('pending','running','awaiting_activity'))
        ORDER BY id LIMIT 1`,
        )
        .get(now) as { id: number } | undefined;
      if (!candidate) return undefined;
      this.db
        .prepare(
          "UPDATE cleanup_jobs SET status='running',attempts=attempts+1,claimed_at=?,error=NULL WHERE id=? AND status='pending'",
        )
        .run(now, candidate.id);
      return this.cleanupById(candidate.id);
    })();
  }
  private cleanupById(id: number): CleanupJobRow | undefined {
    return this.db
      .prepare(
        `SELECT id,issue_id issueId,issue_identifier issueIdentifier,linear_session_id linearSessionId,
      app,status,attempts,created_at createdAt,claimed_at claimedAt,notify_activity_id notifyActivityId FROM cleanup_jobs WHERE id=?`,
      )
      .get(id) as CleanupJobRow | undefined;
  }
  reclaimExpiredCleanups(cutoff: number): number {
    return this.db
      .prepare(
        "UPDATE cleanup_jobs SET status='pending',claimed_at=NULL WHERE status='running' AND claimed_at<?",
      )
      .run(cutoff).changes;
  }
  reclaimRunningCleanups(): number {
    return this.db
      .prepare(
        "UPDATE cleanup_jobs SET status='pending',claimed_at=NULL WHERE status='running'",
      )
      .run().changes;
  }
  markCleanupDone(id: number): void {
    this.db
      .prepare(
        "UPDATE cleanup_jobs SET status='done',claimed_at=NULL WHERE id=?",
      )
      .run(id);
  }
  retryCleanup(id: number, error: string, next: number): void {
    this.db
      .prepare(
        "UPDATE cleanup_jobs SET status='pending',claimed_at=NULL,error=?,next_attempt_at=? WHERE id=?",
      )
      .run(error, next, id);
  }
  failCleanup(id: number, error: string): void {
    this.db
      .prepare(
        "UPDATE cleanup_jobs SET status='failed',claimed_at=NULL,error=? WHERE id=?",
      )
      .run(error, id);
  }
  retainCleanup(id: number, body: string, now = Date.now()): void {
    this.db.transaction(() => {
      const job = this.cleanupById(id);
      if (!job) throw new Error(`Missing cleanup ${id}`);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO cleanup_notifications
        (job_id,app,linear_session_id,activity_id,body,status,next_attempt_at,created_at) VALUES (?,?,?,?,?,'pending',?,?)`,
        )
        .run(
          id,
          job.app,
          job.linearSessionId,
          job.notifyActivityId,
          body,
          now,
          now,
        );
      this.db
        .prepare(
          "UPDATE cleanup_jobs SET status='retained',claimed_at=NULL WHERE id=?",
        )
        .run(id);
    })();
  }
  pendingCleanupNotifications(now = Date.now()): CleanupNotificationRow[] {
    return this.db
      .prepare(
        `SELECT job_id jobId,app,linear_session_id linearSessionId,activity_id activityId,body,attempts,
      next_attempt_at nextAttemptAt,created_at createdAt FROM cleanup_notifications WHERE status='pending' AND next_attempt_at<=?`,
      )
      .all(now) as CleanupNotificationRow[];
  }
  markCleanupNotificationPosted(id: number): void {
    this.db
      .prepare(
        "UPDATE cleanup_notifications SET status='posted',attempts=attempts+1 WHERE job_id=?",
      )
      .run(id);
  }
  retryCleanupNotification(id: number, error: string, next: number): void {
    this.db
      .prepare(
        "UPDATE cleanup_notifications SET attempts=attempts+1,error=?,next_attempt_at=? WHERE job_id=?",
      )
      .run(error, next, id);
  }
  failCleanupNotification(id: number, error: string): void {
    this.db
      .prepare(
        "UPDATE cleanup_notifications SET status='failed',attempts=attempts+1,error=? WHERE job_id=?",
      )
      .run(error, id);
  }
  externalUrlStates(): Array<{
    linearSessionId: string;
    url: string;
    status: string;
  }> {
    return this.db
      .prepare(
        "SELECT linear_session_id linearSessionId,url,status FROM session_external_urls ORDER BY id",
      )
      .all() as Array<{ linearSessionId: string; url: string; status: string }>;
  }
  cleanupStates(): Array<{ id: number; status: string; issueId: string }> {
    return this.db
      .prepare(
        "SELECT id,status,issue_id issueId FROM cleanup_jobs ORDER BY id",
      )
      .all() as Array<{ id: number; status: string; issueId: string }>;
  }
  cleanupNotificationStates(): Array<{
    jobId: number;
    status: string;
    body: string;
  }> {
    return this.db
      .prepare(
        "SELECT job_id jobId,status,body FROM cleanup_notifications ORDER BY job_id",
      )
      .all() as Array<{ jobId: number; status: string; body: string }>;
  }

  sessionsForIssue(issueId: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT linear_session_id linearSessionId,app,issue_id issueId,issue_identifier issueIdentifier,
      worktree_path worktreePath,branch,claude_session_id claudeSessionId,runtime,fallback_cause fallbackCause,
      profile,profile_fallback profileFallback,mode,status,last_seen_at lastSeenAt,last_seen_activity_at lastSeenActivityAt,
      trace_id traceId,root_span_id rootSpanId,started_at startedAt,completed_at completedAt
      FROM sessions WHERE issue_id=? AND mode IN ('planner','implementer') ORDER BY started_at,linear_session_id`,
      )
      .all(issueId) as SessionRow[];
  }

  claimClaudeInvocation(input: {
    linearSessionId: string;
    turnId: number;
    toolUseId: string;
    role: string;
    prompt: string;
    traceId: string;
    startedAt: number;
  }): AgentInvocationRow {
    const sourceKey = `claude:${input.linearSessionId}:${input.toolUseId}`;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_invocations
      (linear_session_id,turn_id,source,source_key,role,runtime,prompt,started_at,trace_id,enrichment_state,usage_classification,created_at)
      VALUES (?,?,'claude',?,?,'claude',?,?,?,'pending','unknown',?)`,
      )
      .run(
        input.linearSessionId,
        input.turnId,
        sourceKey,
        input.role,
        input.prompt,
        input.startedAt,
        input.traceId,
        input.startedAt,
      );
    return this.invocationBySourceKey(sourceKey)!;
  }
  completeClaudeStream(
    linearSessionId: string,
    toolUseId: string,
    report: string,
    outcome: string,
    completedAt: number,
    deadlineAt: number,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE agent_invocations SET report=?,outcome=?,stream_completed_at=?,enrichment_deadline_at=?
      WHERE source_key=? AND enrichment_state='pending'`,
        )
        .run(
          report,
          outcome,
          completedAt,
          deadlineAt,
          `claude:${linearSessionId}:${toolUseId}`,
        ).changes === 1
    );
  }
  markClaudeNativeSeen(
    linearSessionId: string,
    toolUseId: string,
    nativeSeenAt: number,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE agent_invocations SET native_seen_at=COALESCE(native_seen_at,?),
      enrichment_deadline_at=COALESCE(enrichment_deadline_at,?) WHERE source_key=? AND enrichment_state='pending'`,
        )
        .run(
          nativeSeenAt,
          nativeSeenAt + 30_000,
          `claude:${linearSessionId}:${toolUseId}`,
        ).changes === 1
    );
  }
  enrichClaudeInvocation(input: {
    linearSessionId: string;
    toolUseId: string;
    spanId: string;
    startedAt: number;
    endedAt: number;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }): boolean {
    return (
      this.db
        .prepare(
          `UPDATE agent_invocations SET enrichment_state='enriched',span_id=?,started_at=?,ended_at=?,model=?,
      input_tokens=?,output_tokens=?,cache_creation_tokens=?,cache_read_tokens=?,usage_classification='accepted'
      WHERE source_key=? AND enrichment_state='pending'`,
        )
        .run(
          input.spanId,
          input.startedAt,
          input.endedAt,
          input.model ?? null,
          input.inputTokens,
          input.outputTokens,
          input.cacheCreationTokens,
          input.cacheReadTokens,
          `claude:${input.linearSessionId}:${input.toolUseId}`,
        ).changes === 1
    );
  }
  degradeClaudeInvocation(
    linearSessionId: string,
    toolUseId: string,
    state: Exclude<EnrichmentState, "pending" | "enriched">,
    reason: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE agent_invocations SET enrichment_state=?,degradation_reason=? WHERE source_key=? AND enrichment_state='pending'`,
        )
        .run(state, reason, `claude:${linearSessionId}:${toolUseId}`)
        .changes === 1
    );
  }
  terminalizeExpiredClaude(now = Date.now(), linearSessionId?: string): number {
    return this.db
      .prepare(
        `UPDATE agent_invocations SET enrichment_state=CASE WHEN native_seen_at IS NULL THEN 'native_missing' ELSE 'relay_delivery_unknown' END,
      degradation_reason=CASE WHEN native_seen_at IS NULL THEN 'native_span_deadline' ELSE 'restart_after_native_seen' END
      WHERE source='claude' AND enrichment_state='pending' AND enrichment_deadline_at IS NOT NULL AND enrichment_deadline_at<=?
        AND (? IS NULL OR linear_session_id=?)`,
      )
      .run(now, linearSessionId ?? null, linearSessionId ?? null).changes;
  }
  nonterminalInvocations(linearSessionId: string): AgentInvocationRow[] {
    return this.invocations(linearSessionId).filter(
      (row) => row.enrichmentState === "pending",
    );
  }
  invocations(linearSessionId: string): AgentInvocationRow[] {
    return this.db
      .prepare(
        `${this.invocationSelect()} WHERE linear_session_id=? ORDER BY started_at,id`,
      )
      .all(linearSessionId) as AgentInvocationRow[];
  }
  hasCodexInvocation(sourceKey: string): boolean {
    return this.invocationBySourceKey(sourceKey) !== undefined;
  }
  private invocationBySourceKey(
    sourceKey: string,
  ): AgentInvocationRow | undefined {
    return this.db
      .prepare(`${this.invocationSelect()} WHERE source_key=?`)
      .get(sourceKey) as AgentInvocationRow | undefined;
  }
  private invocationSelect(): string {
    return `SELECT id,linear_session_id linearSessionId,turn_id turnId,source,source_key sourceKey,
    parent_invocation_id parentInvocationId,role,runtime,model,prompt,report,started_at startedAt,ended_at endedAt,deadline_at deadlineAt,
    outcome,input_tokens inputTokens,output_tokens outputTokens,cache_creation_tokens cacheCreationTokens,cache_read_tokens cacheReadTokens,
    raw_total_tokens rawTotalTokens,prior_total_tokens priorTotalTokens,delta_total_tokens deltaTotalTokens,usage_epoch usageEpoch,
    usage_classification usageClassification,trace_id traceId,span_id spanId,provider_conversation_id providerConversationId,
    provider_turn_id providerTurnId,enrichment_state enrichmentState,stream_completed_at streamCompletedAt,native_seen_at nativeSeenAt,
    enrichment_deadline_at enrichmentDeadlineAt,degradation_reason degradationReason FROM agent_invocations`;
  }

  ingestCodexInvocation(
    input: CodexInvocationInput,
    now = Date.now(),
  ): AgentInvocationRow {
    return this.db.transaction(() => {
      const prior = this.invocationBySourceKey(input.sourceKey);
      if (prior) return prior;
      const provider = input.providerConversationId;
      const checkpoint = provider
        ? (this.db
            .prepare(
              `SELECT last_started_at lastStartedAt,last_ended_at lastEndedAt,
        cumulative_total_tokens cumulativeTotalTokens,reset_epoch resetEpoch FROM codex_usage_checkpoints WHERE provider_conversation_id=?`,
            )
            .get(provider) as
            | {
                lastStartedAt: number;
                lastEndedAt: number;
                cumulativeTotalTokens: number;
                resetEpoch: number;
              }
            | undefined)
        : undefined;
      let classification: UsageClassification = "unknown";
      let delta: number | null = null;
      let epoch: number | null = null;
      let advance = false;
      const cumulative = input.cumulativeTotalTokens;
      if (
        provider &&
        cumulative !== undefined &&
        input.startedAt !== undefined &&
        input.endedAt !== undefined
      ) {
        if (input.mode === "fresh") {
          if (checkpoint) classification = "identity_collision";
          else {
            classification = "accepted";
            delta = cumulative;
            epoch = 0;
            advance = true;
          }
        } else if (input.mode === "resume") {
          if (!checkpoint) classification = "gap";
          else if (input.startedAt < checkpoint.lastEndedAt)
            classification = "out_of_order";
          else if (cumulative >= checkpoint.cumulativeTotalTokens) {
            classification = "accepted";
            delta = cumulative - checkpoint.cumulativeTotalTokens;
            epoch = checkpoint.resetEpoch;
            advance = true;
          } else {
            classification = "reset";
            delta = cumulative;
            epoch = checkpoint.resetEpoch + 1;
            advance = true;
          }
        }
      }
      const result = this.db
        .prepare(
          `INSERT INTO agent_invocations
        (linear_session_id,turn_id,source,source_key,role,runtime,model,prompt,report,started_at,ended_at,deadline_at,outcome,
        input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,raw_total_tokens,prior_total_tokens,delta_total_tokens,
        usage_epoch,usage_classification,trace_id,span_id,provider_conversation_id,provider_turn_id,enrichment_state,created_at)
        VALUES (?,?,'codex',?,?,'codex',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'enriched',?)`,
        )
        .run(
          input.linearSessionId,
          input.turnId,
          input.sourceKey,
          input.role,
          input.model ?? null,
          input.prompt ?? null,
          input.report ?? null,
          input.startedAt ?? null,
          input.endedAt ?? null,
          input.deadlineAt ?? null,
          input.outcome ?? null,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          input.cacheCreationTokens ?? null,
          input.cacheReadTokens ?? null,
          cumulative ?? null,
          checkpoint?.cumulativeTotalTokens ?? null,
          delta,
          epoch,
          classification,
          input.traceId,
          input.spanId ?? null,
          provider ?? null,
          input.providerTurnId ?? null,
          now,
        );
      if (advance && provider)
        this.db
          .prepare(
            `INSERT INTO codex_usage_checkpoints
        (provider_conversation_id,last_started_at,last_ended_at,cumulative_total_tokens,reset_epoch,source_key) VALUES (?,?,?,?,?,?)
        ON CONFLICT(provider_conversation_id) DO UPDATE SET last_started_at=excluded.last_started_at,last_ended_at=excluded.last_ended_at,
        cumulative_total_tokens=excluded.cumulative_total_tokens,reset_epoch=excluded.reset_epoch,source_key=excluded.source_key`,
          )
          .run(
            provider,
            input.startedAt,
            input.endedAt,
            cumulative,
            epoch,
            input.sourceKey,
          );
      return this.invocationBySourceKey(input.sourceKey)!;
    })();
  }
  ingestCodexMarker(
    invocation: CodexInvocationInput,
    event: AppendEvent,
    now = Date.now(),
  ): { invocation: AgentInvocationRow; append: AppendResult } {
    return this.db.transaction(() => ({
      invocation: this.ingestCodexInvocation(invocation, now),
      append: this.append(event),
    }))();
  }

  aggregateSession(linearSessionId: string): {
    canonicalTokens: number;
    invocationCount: number;
    roles: string[];
    complete: boolean;
    degradedCount: number;
  } {
    const turn = this.db
      .prepare(
        `SELECT COUNT(*) count,COALESCE(SUM(COALESCE(usage_input_tokens,0)+COALESCE(usage_output_tokens,0)+
      COALESCE(usage_cache_creation_tokens,0)+COALESCE(usage_cache_read_tokens,0)),0) total FROM turns WHERE linear_session_id=?`,
      )
      .get(linearSessionId) as { count: number; total: number };
    const rows = this.invocations(linearSessionId);
    let delegated = 0;
    let degraded = 0;
    for (const row of rows) {
      const complete =
        row.enrichmentState === "enriched" &&
        (row.source === "claude" ||
          row.usageClassification === "accepted" ||
          row.usageClassification === "reset");
      if (!complete) {
        degraded++;
        continue;
      }
      delegated +=
        row.source === "codex"
          ? (row.deltaTotalTokens ?? 0)
          : (row.inputTokens ?? 0) +
            (row.outputTokens ?? 0) +
            (row.cacheCreationTokens ?? 0) +
            (row.cacheReadTokens ?? 0);
    }
    return {
      canonicalTokens: turn.total + delegated,
      invocationCount: turn.count + rows.length,
      roles: [...new Set(rows.map((row) => row.role))].sort(),
      complete: degraded === 0,
      degradedCount: degraded,
    };
  }

  materializeOutbox(
    sessionId: string,
    payload: string,
    completedAt = Date.now(),
  ): TelemetryOutboxRow {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO telemetry_outbox(session_id,payload,state,created_at) VALUES (?,?,'pending',?)`,
        )
        .run(sessionId, payload, completedAt);
      this.db
        .prepare(
          "UPDATE sessions SET completed_at=COALESCE(completed_at,?),status='completed' WHERE linear_session_id=?",
        )
        .run(completedAt, sessionId);
    })();
    return this.outbox(sessionId)!;
  }
  leaseOutbox(
    sessionId: string,
    owner: string,
    now = Date.now(),
    leaseMs = 30_000,
  ): TelemetryOutboxRow | undefined {
    this.db
      .prepare(
        `UPDATE telemetry_outbox SET state='pending',lease_owner=NULL,lease_expires_at=NULL WHERE session_id=? AND state='leased' AND lease_expires_at<=?`,
      )
      .run(sessionId, now);
    const changed = this.db
      .prepare(
        `UPDATE telemetry_outbox SET state='leased',lease_owner=?,lease_expires_at=?,attempts=attempts+1
      WHERE session_id=? AND state='pending'`,
      )
      .run(owner, now + leaseMs, sessionId);
    return changed.changes ? this.outbox(sessionId) : undefined;
  }
  markOutboxSending(
    sessionId: string,
    owner: string,
    now = Date.now(),
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE telemetry_outbox SET state='sending',send_started_at=?,lease_owner=NULL,lease_expires_at=NULL
    WHERE session_id=? AND state='leased' AND lease_owner=?`,
        )
        .run(now, sessionId, owner).changes === 1
    );
  }
  finishOutbox(
    sessionId: string,
    state: Extract<
      TelemetryOutboxState,
      "delivered" | "failed" | "delivery_unknown"
    >,
    error: string | null,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        "UPDATE telemetry_outbox SET state=?,acknowledged_at=?,last_error=? WHERE session_id=? AND state='sending'",
      )
      .run(state, now, error, sessionId);
  }
  outbox(sessionId: string): TelemetryOutboxRow | undefined {
    return this.db
      .prepare(
        `SELECT session_id sessionId,state,payload,lease_owner leaseOwner,
    lease_expires_at leaseExpiresAt,attempts,send_started_at sendStartedAt,acknowledged_at acknowledgedAt,last_error lastError
    FROM telemetry_outbox WHERE session_id=?`,
      )
      .get(sessionId) as TelemetryOutboxRow | undefined;
  }
  allSessionsFinalized(issueId: string): boolean {
    const rows = this.sessionsForIssue(issueId);
    return (
      rows.length > 0 &&
      rows.every((row) => {
        const state = this.outbox(row.linearSessionId)?.state;
        return (
          state === "delivered" ||
          state === "failed" ||
          state === "delivery_unknown"
        );
      })
    );
  }

  pendingAcks(now = Date.now(), retryWindowMs = 30 * 60_000): AckRow[] {
    return this.db
      .prepare(
        `SELECT a.event_id eventId, e.app, e.agent_session_id agentSessionId,
      a.activity_id activityId, a.status, a.attempts, a.last_error lastError,
      a.failure_kind failureKind, a.next_attempt_at nextAttemptAt,
      a.deadline_at deadlineAt, e.received_at receivedAt
      FROM acks a JOIN events e ON e.id = a.event_id
      WHERE (a.status = 'pending' AND a.next_attempt_at <= ?)
        OR (a.status = 'failed' AND a.failure_kind = 'retriable' AND a.next_attempt_at <= ? AND e.received_at + ? > ?)
      ORDER BY a.next_attempt_at, e.received_at`,
      )
      .all(now, now, retryWindowMs, now) as AckRow[];
  }

  markAcked(eventId: number): void {
    this.db
      .prepare(
        `UPDATE acks
      SET status='acked', attempts=attempts+1, last_error=NULL, failure_kind=NULL, next_attempt_at=0
      WHERE event_id=?`,
      )
      .run(eventId);
  }

  markRetriableFailure(
    eventId: number,
    error: string,
    nextAttemptAt: number,
    status: "pending" | "failed",
  ): void {
    this.db
      .prepare(
        `UPDATE acks
      SET status=?, attempts=attempts+1, last_error=?, failure_kind='retriable', next_attempt_at=?
      WHERE event_id=?`,
      )
      .run(status, error, nextAttemptAt, eventId);
  }

  markTerminalFailure(eventId: number, error: string): void {
    this.db
      .prepare(
        `UPDATE acks
      SET status='failed', attempts=attempts+1, last_error=?, failure_kind='terminal', next_attempt_at=0
      WHERE event_id=?`,
      )
      .run(error, eventId);
  }

  getToken(app: AppName): StoredToken | undefined {
    return this.db
      .prepare(
        "SELECT access_token accessToken, expires_at expiresAt FROM tokens WHERE app=?",
      )
      .get(app) as StoredToken | undefined;
  }

  putToken(app: AppName, token: StoredToken): void {
    this.db
      .prepare(
        `INSERT INTO tokens (app, access_token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(app) DO UPDATE SET access_token=excluded.access_token, expires_at=excluded.expires_at`,
      )
      .run(app, token.accessToken, token.expiresAt);
  }

  invalidateToken(app: AppName): void {
    this.db.prepare("DELETE FROM tokens WHERE app=?").run(app);
  }
  count(): number {
    return (
      this.db.prepare("SELECT count(*) count FROM events").get() as {
        count: number;
      }
    ).count;
  }
  ackCount(): number {
    return (
      this.db.prepare("SELECT count(*) count FROM acks").get() as {
        count: number;
      }
    ).count;
  }
  ackStates(): AckState[] {
    return this.db
      .prepare(
        `SELECT event_id eventId, activity_id activityId, status, attempts,
      last_error lastError, failure_kind failureKind, next_attempt_at nextAttemptAt
      FROM acks ORDER BY event_id`,
      )
      .all() as AckState[];
  }
  close(): void {
    this.db.close();
  }
}
