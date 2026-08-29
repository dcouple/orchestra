import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { TurnUsage } from "./claude.js";
import type { AppName } from "./config.js";
import type { InFlightDispatch } from "./dispatches.js";
import { ACTIVE_OPERATION_STATES, type OperationControlKind, type OperationControlRow, type OperationRow, type OperationStageEvent, type OperationState,
  type SafeOperationStatus, type SafeRunningTurn, type ScheduleOperationInput, validateScheduleOperation } from "./operations.js";
import { SimCapacityError, SimTurnLimitError } from "./sim.js";
import { projectConsoleLoop, projectInvocation, projectResources, type ConsoleLoopDefinition,
  type ConsoleRunDetail, type ConsoleRunSummary } from "./console-projections.js";
import { nextLoopDue, type LoopDeclaration, type LoopOutcome } from "./loops.js";

export interface LoopDefinitionRow extends LoopDeclaration {
  id: string; revision: number; digest: string; nextDueAt: number; blockedReason: string | null;
  createdAt: number; updatedAt: number;
}
export interface LoopAuditRow { loopId: string; sequence: number; kind: string; reason: string; actor: string; details: Record<string, unknown>; createdAt: number }
export interface LoopOccurrenceRow {
  id: string; loopId: string; definitionRevision: number; scheduledFor: number; runId: string; turnId: number;
  status: "pending" | "running" | "retry_wait" | "succeeded" | "blocked" | "cancelled";
  retryCount: number; nextAttemptAt: number; outcome: LoopOutcome | null; error: string | null;
  snapshot: LoopDeclaration; worktreePath: string | null; branch: string | null; createdAt: number; startedAt: number | null; finishedAt: number | null;
  inputTokens:number|null;outputTokens:number|null;cacheCreationTokens:number|null;cacheReadTokens:number|null;costUsd:number|null;model:string|null;
}
export interface LoopCleanupJobRow { id: number; occurrenceId: string; loopId: string; ownerKey: string; worktreePath: string | null;
  status: "pending" | "running" | "done" | "retained" | "failed"; attempts: number; nextAttemptAt: number; error: string | null; createdAt: number }
export type SafeLoopMutationDefinition = ConsoleLoopDefinition;
export interface LoopMutationResult { loop: SafeLoopMutationDefinition; auditSequence: number; deduplicated: boolean }

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
  originKind?: "linear" | "loop"; originId?: string | null; loopOccurrenceId?: string | null;
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
export type DependencyKind = "mcp" | "harness";
export type DependencyHealth = "healthy" | "unavailable" | "unknown" | "disabled";
export interface DependencyObservationInput {
  kind: DependencyKind;
  name: string;
  configured: boolean;
  status: DependencyHealth;
  reasonCode: string | null;
  capabilities?: Record<string, string | number | boolean | null>;
  observedAt: number;
  staleAfterMs: number;
}
export interface DependencyObservationRow extends Omit<DependencyObservationInput, "capabilities"> {
  capabilities: Record<string, string | number | boolean | null>;
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
  originKind?: "linear" | "loop"; originId?: string | null; loopOccurrenceId?: string | null; resourceKey?: string;
  id: number;
  eventId: number | null;
  app: AppName;
  linearSessionId: string;
  issueId: string | null;
  kind: "created" | "prompted" | "loop";
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
export type SimLeaseState = "creating" | "booted" | "orphan" | "released" | "reaped" | "failed";
export interface SimLeaseRow {
  id: number; udid: string | null; name: string; turnId: number | null;
  linearSessionId: string | null; leaseIndex: number | null; state: SimLeaseState;
  evidenceDir: string | null; acquiredAt: number; lastLiveAt: number;
  releasedAt: number | null; releaseReason: string | null; reapAttempts: number;
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
  outcome: "resumed" | "human_required" | "awaiting_dispatch";
  reason:
    | "safe_boundary"
    | "hard_restart"
    | "missing_claude_session"
    | "unresolved_tool_call"
    | "dispatch_in_flight";
  resumeTurnId: number | null;
}
export interface DispatchWaitRow {
  turnId: number;
  linearSessionId: string;
  dispatchBase: string;
  deadlineAt: number;
  createdAt: number;
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

function validateCapabilities(value: unknown): Record<string, string | number | boolean | null> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("dependency capabilities must be an object");
  const entries = Object.entries(value);
  if (entries.length > 16) throw new Error("dependency capabilities are too large");
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, capability] of entries) {
    if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(key))
      throw new Error("dependency capability key is invalid");
    if (capability !== null && typeof capability !== "string" && typeof capability !== "number"
      && typeof capability !== "boolean") throw new Error("dependency capability value is invalid");
    if (typeof capability === "string" && (capability.length > 128 || /[^\x20-\x7e]/.test(capability)))
      throw new Error("dependency capability value is invalid");
    if (typeof capability === "number" && (!Number.isSafeInteger(capability) || capability < 0))
      throw new Error("dependency capability value is invalid");
    result[key] = capability;
  }
  if (JSON.stringify(result).length > 2048) throw new Error("dependency capabilities are too large");
  return result;
}

function validateDependencyObservation(input: DependencyObservationInput): Record<string, string | number | boolean | null> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.name)) throw new Error("dependency name is invalid");
  if (!/^(?:[a-z][a-z0-9_]{0,63})$/.test(input.reasonCode ?? "healthy"))
    throw new Error("dependency reason code is invalid");
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0)
    throw new Error("dependency observed time is invalid");
  if (!Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < 1 || input.staleAfterMs > 86_400_000)
    throw new Error("dependency stale interval is invalid");
  const capabilities = validateCapabilities(input.capabilities ?? {});
  if (input.kind === "mcp" && input.name === "linear") {
    if (Object.keys(capabilities).some(key => key !== "toolCount" && key !== "truncated")
      || (capabilities.toolCount !== undefined && (typeof capabilities.toolCount !== "number" || capabilities.toolCount > 256))
      || (capabilities.truncated !== undefined && typeof capabilities.truncated !== "boolean"))
      throw new Error("linear dependency capabilities are invalid");
  } else if (Object.keys(capabilities).length > 0) throw new Error("dependency does not support capabilities");
  return capabilities;
}

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
        origin_kind TEXT NOT NULL DEFAULT 'linear' CHECK(origin_kind IN ('linear','loop')),
        origin_id TEXT,
        loop_occurrence_id TEXT,
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
        origin_kind TEXT NOT NULL DEFAULT 'linear' CHECK(origin_kind IN ('linear','loop')),
        origin_id TEXT REFERENCES loop_definitions(id),
        loop_occurrence_id TEXT REFERENCES loop_occurrences(id),
        resource_key TEXT NOT NULL,
        event_id INTEGER UNIQUE REFERENCES events(id),
        linear_session_id TEXT NOT NULL,
        issue_id TEXT,
        source_key TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('created','prompted','loop')),
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
        execution_finished_at INTEGER,
        CHECK (
          (origin_kind='linear' AND kind IN ('created','prompted') AND event_id IS NOT NULL AND issue_id IS NOT NULL
            AND origin_id IS NULL AND loop_occurrence_id IS NULL)
          OR
          (origin_kind='loop' AND kind='loop' AND event_id IS NULL AND issue_id IS NULL
            AND origin_id IS NOT NULL AND loop_occurrence_id IS NOT NULL)
        ),
        FOREIGN KEY(loop_occurrence_id,origin_id) REFERENCES loop_occurrences(id,loop_id)
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
      CREATE TABLE IF NOT EXISTS dependency_observations (
        kind TEXT NOT NULL CHECK(kind IN ('mcp','harness')),
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
        configured INTEGER NOT NULL CHECK(configured IN (0,1)),
        status TEXT NOT NULL CHECK(status IN ('healthy','unavailable','unknown','disabled')),
        reason_code TEXT CHECK(reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
        capabilities_json TEXT NOT NULL CHECK(length(capabilities_json) <= 2048),
        observed_at INTEGER NOT NULL,
        stale_after_ms INTEGER NOT NULL CHECK(stale_after_ms BETWEEN 1 AND 86400000),
        PRIMARY KEY(kind,name)
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
        state TEXT NOT NULL CHECK(state IN ('pending','executing','accepting','rolling_back','blocked','succeeded','failed','cancelled')),
        stage TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        mutated INTEGER NOT NULL DEFAULT 0,
        rollback_verified INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        error_stage TEXT,
        updated_at INTEGER NOT NULL,
        actor TEXT NOT NULL DEFAULT 'operator' CHECK(actor IN ('operator','local-console','system')),
        request_kind TEXT,
        request_summary TEXT,
        state_version INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_one_active
        ON operations((1)) WHERE state IN ('pending','executing','accepting','rolling_back','blocked');
      CREATE TABLE IF NOT EXISTS operation_stage_events (
        operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        state TEXT NOT NULL,
        stage TEXT,
        outcome TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(operation_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS operation_controls (
        id TEXT PRIMARY KEY,
        digest TEXT NOT NULL UNIQUE,
        target_operation_id TEXT NOT NULL REFERENCES operations(id),
        target_digest TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('retry','cancel')),
        actor TEXT NOT NULL CHECK(actor='local-console'),
        reason TEXT NOT NULL,
        expected_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','executing','succeeded','rejected')),
        outcome TEXT,
        requested_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(target_operation_id,target_digest,kind,expected_version)
      );
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
      CREATE TABLE IF NOT EXISTS dispatch_waits (
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        linear_session_id TEXT NOT NULL,
        dispatch_base TEXT NOT NULL,
        deadline_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(turn_id,dispatch_base)
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_waits_session
        ON dispatch_waits(linear_session_id,turn_id);
      CREATE TABLE IF NOT EXISTS sim_leases (
        id INTEGER PRIMARY KEY,
        udid TEXT UNIQUE,
        name TEXT NOT NULL,
        turn_id INTEGER REFERENCES turns(id),
        linear_session_id TEXT,
        lease_index INTEGER,
        state TEXT NOT NULL CHECK(state IN ('creating','booted','orphan','released','reaped','failed')),
        evidence_dir TEXT,
        acquired_at INTEGER NOT NULL,
        last_live_at INTEGER NOT NULL,
        released_at INTEGER,
        release_reason TEXT,
        reap_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sim_leases_state ON sim_leases(state);
      CREATE TABLE IF NOT EXISTS loop_definitions (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, digest TEXT NOT NULL, declaration_json TEXT NOT NULL,
        name TEXT NOT NULL, description TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        blocked_reason TEXT, next_due_at INTEGER NOT NULL, max_concurrency INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loop_audit_events (
        loop_id TEXT NOT NULL REFERENCES loop_definitions(id), sequence INTEGER NOT NULL, kind TEXT NOT NULL,
        reason TEXT NOT NULL, actor TEXT NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(loop_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS loop_occurrences (
        id TEXT PRIMARY KEY, loop_id TEXT NOT NULL REFERENCES loop_definitions(id), definition_revision INTEGER NOT NULL,
        scheduled_for INTEGER NOT NULL, run_id TEXT NOT NULL UNIQUE, turn_id INTEGER UNIQUE REFERENCES turns(id), status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, outcome TEXT, error TEXT,
        snapshot_json TEXT NOT NULL, worktree_path TEXT, branch TEXT, created_at INTEGER NOT NULL,
        started_at INTEGER, finished_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_creation_tokens INTEGER,
        cache_read_tokens INTEGER,cost_usd REAL,model TEXT, UNIQUE(loop_id,scheduled_for), UNIQUE(id,loop_id)
      );
      CREATE INDEX IF NOT EXISTS idx_loop_occurrences_claim ON loop_occurrences(status,next_attempt_at);
      CREATE TABLE IF NOT EXISTS loop_cleanup_jobs (
        id INTEGER PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE REFERENCES loop_occurrences(id),
        loop_id TEXT NOT NULL REFERENCES loop_definitions(id), owner_key TEXT NOT NULL UNIQUE, worktree_path TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','running','done','retained','failed')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loop_mutation_receipts (
        draft_id TEXT PRIMARY KEY, digest TEXT NOT NULL, loop_id TEXT NOT NULL REFERENCES loop_definitions(id),
        revision INTEGER NOT NULL, audit_sequence INTEGER NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    this.migrateOperationsTable();
    this.migrateOperationControlGenerations();
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_operation_controls_nonterminal
      ON operation_controls(state,requested_at,id) WHERE state IN ('pending','executing')`);
    this.migrateEventColumns();
    this.migrateSessionColumns();
    this.migrateTurnColumns();
    this.migrateLoopColumns();
    this.migrateTurnOriginShape();
    this.migrateAckColumns();
    this.migrateTurnActivityColumns();
    this.migrateSimLeaseColumns();
    this.recoverAmbiguousOutbox();
  }

  private migrateOperationsTable(): void {
    const legacyState = ["drain", "ing"].join("");
    const schema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='operations'")
      .get() as { sql: string } | undefined;
    if (!schema?.sql) return;
    const columns = new Set((this.db.prepare("PRAGMA table_info(operations)").all() as Array<{ name: string }>).map(row => row.name));
    const normalized = schema.sql.replace(/\s+/g, "");
    const auditColumns = ["actor", "request_kind", "request_summary", "state_version", "cancel_requested"];
    const canonical = auditColumns.every(column => columns.has(column))
      && normalized.includes("CHECK(actorIN('operator','local-console','system'))")
      && normalized.includes("CHECK(cancel_requestedIN(0,1))")
      && !schema.sql.includes(`'${legacyState}'`);
    if (canonical) return;
    if (columns.has("actor") && (this.db.prepare(`SELECT 1 FROM operations
      WHERE actor NOT IN ('operator','local-console','system') LIMIT 1`).get())) throw new Error("invalid legacy operation actor");
    if (columns.has("cancel_requested") && (this.db.prepare(`SELECT 1 FROM operations
      WHERE cancel_requested NOT IN (0,1) LIMIT 1`).get())) throw new Error("invalid legacy operation cancellation state");
    const actor = columns.has("actor") ? "actor" : "'operator'";
    const requestKind = columns.has("request_kind") ? "request_kind" : "NULL";
    const requestSummary = columns.has("request_summary") ? "request_summary" : "NULL";
    const stateVersion = columns.has("state_version") ? "state_version" : "0";
    const cancelRequested = columns.has("cancel_requested") ? "cancel_requested" : "0";
    const state = schema.sql.includes(`'${legacyState}'`) ? `CASE state WHEN '${legacyState}' THEN 'pending' ELSE state END` : "state";
    const stage = schema.sql.includes(`'${legacyState}'`) ? `CASE state WHEN '${legacyState}' THEN NULL ELSE stage END` : "stage";
    const secondarySchema = this.db.prepare(`SELECT type,name,sql FROM sqlite_master
      WHERE tbl_name='operations' AND sql IS NOT NULL AND type IN ('index','trigger')
      AND name<>'idx_operations_one_active' ORDER BY type,name`).all() as Array<{ type: "index" | "trigger"; name: string; sql: string }>;
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.exec(`DROP INDEX IF EXISTS idx_operations_one_active;
        CREATE TABLE operations_new (
          id TEXT PRIMARY KEY,
          request_digest TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('restart','config','update')),
          reason TEXT NOT NULL,
          requested_at INTEGER NOT NULL,
          target_ref TEXT,
          target_commit TEXT,
          previous_commit TEXT,
          state TEXT NOT NULL CHECK(state IN ('pending','executing','accepting','rolling_back','blocked','succeeded','failed','cancelled')),
          stage TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          mutated INTEGER NOT NULL DEFAULT 0,
          rollback_verified INTEGER NOT NULL DEFAULT 0,
          outcome TEXT,
          error_stage TEXT,
          updated_at INTEGER NOT NULL,
          actor TEXT NOT NULL DEFAULT 'operator' CHECK(actor IN ('operator','local-console','system')),
          request_kind TEXT,
          request_summary TEXT,
          state_version INTEGER NOT NULL DEFAULT 0,
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1))
        );
        INSERT INTO operations_new
          (id,request_digest,type,reason,requested_at,target_ref,target_commit,previous_commit,
           state,stage,attempts,mutated,rollback_verified,outcome,error_stage,updated_at,
           actor,request_kind,request_summary,state_version,cancel_requested)
        SELECT id,request_digest,type,reason,requested_at,target_ref,target_commit,previous_commit,
          ${state},${stage},attempts,mutated,rollback_verified,outcome,error_stage,updated_at,
          ${actor},${requestKind},${requestSummary},${stateVersion},${cancelRequested}
        FROM operations;
        DROP TABLE operations;
        ALTER TABLE operations_new RENAME TO operations;
        CREATE UNIQUE INDEX idx_operations_one_active
          ON operations((1)) WHERE state IN ('pending','executing','accepting','rolling_back','blocked');
        `);
        for (const object of secondarySchema) this.db.exec(object.sql);
        const violations = this.db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
        if (violations.length > 0) throw new Error("operation migration foreign-key violation");
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  private migrateOperationControlGenerations(): void {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='operation_controls'")
      .get() as { sql: string } | undefined;
    if (!schema?.sql || /UNIQUE\s*\(\s*target_operation_id\s*,\s*target_digest\s*,\s*kind\s*,\s*expected_version\s*\)/i.test(schema.sql)) return;
    this.db.transaction(() => this.db.exec(`
      CREATE TABLE operation_controls_new (
        id TEXT PRIMARY KEY,digest TEXT NOT NULL UNIQUE,target_operation_id TEXT NOT NULL REFERENCES operations(id),
        target_digest TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('retry','cancel')),
        actor TEXT NOT NULL CHECK(actor='local-console'),reason TEXT NOT NULL,expected_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','executing','succeeded','rejected')),outcome TEXT,
        requested_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        UNIQUE(target_operation_id,target_digest,kind,expected_version));
      INSERT INTO operation_controls_new
        (id,digest,target_operation_id,target_digest,kind,actor,reason,expected_version,state,outcome,requested_at,updated_at)
      SELECT id,digest,target_operation_id,target_digest,kind,actor,reason,expected_version,state,outcome,requested_at,updated_at
      FROM operation_controls;
      DROP TABLE operation_controls;
      ALTER TABLE operation_controls_new RENAME TO operation_controls;
    `))();
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
    if(!columns.has("origin_kind"))this.db.prepare("ALTER TABLE sessions ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'linear'").run();
    if(!columns.has("origin_id"))this.db.prepare("ALTER TABLE sessions ADD COLUMN origin_id TEXT").run();
    if(!columns.has("loop_occurrence_id"))this.db.prepare("ALTER TABLE sessions ADD COLUMN loop_occurrence_id TEXT").run();
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
    if(!columns.has("origin_kind"))this.db.prepare("ALTER TABLE turns ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'linear'").run();
    if(!columns.has("origin_id"))this.db.prepare("ALTER TABLE turns ADD COLUMN origin_id TEXT").run();
    if(!columns.has("loop_occurrence_id"))this.db.prepare("ALTER TABLE turns ADD COLUMN loop_occurrence_id TEXT").run();
    if(!columns.has("resource_key")){this.db.prepare("ALTER TABLE turns ADD COLUMN resource_key TEXT").run();this.db.prepare("UPDATE turns SET resource_key=issue_id WHERE resource_key IS NULL").run();}
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

  private migrateTurnOriginShape(): void {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='turns'").get() as { sql: string } | undefined;
    if (!schema?.sql) return;
    const normalized = schema.sql.replace(/\s+/g, "");
    const canonicalOriginCheck = normalized.includes("(origin_kind='linear'ANDkindIN('created','prompted')ANDevent_idISNOTNULLANDissue_idISNOTNULLANDorigin_idISNULLANDloop_occurrence_idISNULL)")
      && normalized.includes("(origin_kind='loop'ANDkind='loop'ANDevent_idISNULLANDissue_idISNULLANDorigin_idISNOTNULLANDloop_occurrence_idISNOTNULL)")
      && normalized.includes("origin_idTEXTREFERENCESloop_definitions(id)")
      && normalized.includes("loop_occurrence_idTEXTREFERENCESloop_occurrences(id)")
      && normalized.includes("FOREIGNKEY(loop_occurrence_id,origin_id)REFERENCESloop_occurrences(id,loop_id)");
    if (!normalized.includes("event_idINTEGERNOTNULL")
      && !normalized.includes("issue_idTEXTNOTNULL")
      && canonicalOriginCheck) return;
    const secondary = this.db.prepare(`SELECT sql FROM sqlite_master
      WHERE tbl_name='turns' AND sql IS NOT NULL AND type IN ('index','trigger')
      AND name<>'idx_turns_source_key' ORDER BY type,name`).all() as Array<{ sql: string }>;
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.exec(`DROP INDEX IF EXISTS idx_turns_source_key;
          CREATE TABLE turns_new (
            id INTEGER PRIMARY KEY,
            origin_kind TEXT NOT NULL DEFAULT 'linear' CHECK(origin_kind IN ('linear','loop')),
            origin_id TEXT REFERENCES loop_definitions(id),
            loop_occurrence_id TEXT REFERENCES loop_occurrences(id),
            resource_key TEXT NOT NULL,
            event_id INTEGER UNIQUE REFERENCES events(id),
            linear_session_id TEXT NOT NULL,
            issue_id TEXT,
            source_key TEXT,
            kind TEXT NOT NULL CHECK(kind IN ('created','prompted','loop')),
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
            execution_finished_at INTEGER,
            CHECK (
              (origin_kind='linear' AND kind IN ('created','prompted') AND event_id IS NOT NULL AND issue_id IS NOT NULL
                AND origin_id IS NULL AND loop_occurrence_id IS NULL)
              OR
              (origin_kind='loop' AND kind='loop' AND event_id IS NULL AND issue_id IS NULL
                AND origin_id IS NOT NULL AND loop_occurrence_id IS NOT NULL)
            ),
            FOREIGN KEY(loop_occurrence_id,origin_id) REFERENCES loop_occurrences(id,loop_id)
          );
          INSERT INTO turns_new SELECT id,origin_kind,origin_id,loop_occurrence_id,
            COALESCE(resource_key,issue_id,linear_session_id),event_id,linear_session_id,issue_id,source_key,kind,prompt,status,
            attempts,error,started_at,finished_at,usage_input_tokens,usage_output_tokens,usage_cache_creation_tokens,
            usage_cache_read_tokens,cost_usd,model,trace_id,turn_span_id,execution_finished_at FROM turns;
          DROP TABLE turns;
          ALTER TABLE turns_new RENAME TO turns;
          CREATE UNIQUE INDEX idx_turns_source_key ON turns(source_key);`);
        for (const row of secondary) this.db.exec(row.sql);
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
    const violations = this.db.pragma("foreign_key_check") as Array<Record<string,unknown>>;
    if (violations.length) throw new Error("turn origin migration foreign-key check failed");
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

  private migrateSimLeaseColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(sim_leases)").all() as Array<{ name: string }>).map(column => column.name),
    );
    if (!columns.has("reap_attempts"))
      this.db.prepare("ALTER TABLE sim_leases ADD COLUMN reap_attempts INTEGER NOT NULL DEFAULT 0").run();
  }

  private migrateLoopColumns():void{
    const columns=new Set((this.db.prepare("PRAGMA table_info(loop_occurrences)").all() as Array<{name:string}>).map(row=>row.name));
    if(!columns.has("turn_id"))this.db.prepare("ALTER TABLE loop_occurrences ADD COLUMN turn_id INTEGER REFERENCES turns(id)").run();
    for(const [name,type] of [["input_tokens","INTEGER"],["output_tokens","INTEGER"],["cache_creation_tokens","INTEGER"],["cache_read_tokens","INTEGER"],["cost_usd","REAL"],["model","TEXT"]] as const)
      if(!columns.has(name))this.db.prepare(`ALTER TABLE loop_occurrences ADD COLUMN ${name} ${type}`).run();
    this.db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_occurrences_id_loop ON loop_occurrences(id,loop_id)").run();
    const legacy=this.db.prepare(`SELECT id,loop_id loopId,run_id runId,snapshot_json snapshotJson,created_at createdAt
      FROM loop_occurrences WHERE turn_id IS NULL`).all() as Array<{id:string;loopId:string;runId:string;snapshotJson:string;createdAt:number}>;
    this.db.transaction(()=>{for(const row of legacy){const snapshot=JSON.parse(row.snapshotJson) as LoopDeclaration;
      this.insertLoopSessionTurn(row.id,row.loopId,row.runId,snapshot,row.createdAt);
    }})();
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
    const storedBody =
      event.type === "Issue" && event.stateType !== "completed"
        ? Buffer.alloc(0)
        : event.rawBody;
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
          storedBody,
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
                `UPDATE turns SET issue_id=?,resource_key=?
              WHERE linear_session_id=? AND issue_id=? AND status IN ('pending','running','awaiting_activity')`,
              )
              .run(event.issueId,event.issueId, event.agentSessionId, existing.issueId);
          }
        }
        const sourceKey = this.turnSourceKey(event);
        const turnResult = this.db
          .prepare(
            `INSERT OR IGNORE INTO turns
          (event_id, linear_session_id, issue_id, resource_key, source_key, kind, status)
          VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
          )
          .run(eventId, event.agentSessionId, issueId, issueId, sourceKey, event.action);
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
            WHERE o.state IN ('pending','executing','accepting','rolling_back','blocked'))
          AND NOT EXISTS (SELECT 1 FROM turns earlier WHERE earlier.resource_key=t.resource_key
            AND earlier.id<t.id AND (
              earlier.status IN ('pending','running','awaiting_activity')
              OR EXISTS (SELECT 1 FROM turn_activities a WHERE a.turn_id=earlier.id AND a.status='pending')
            ))
          AND NOT EXISTS (SELECT 1 FROM turns active WHERE active.resource_key=t.resource_key AND active.status='running')
          AND (t.origin_kind='linear' OR EXISTS (
            SELECT 1 FROM loop_occurrences o JOIN loop_definitions d ON d.id=o.loop_id
            WHERE o.id=t.loop_occurrence_id AND o.status IN ('pending','retry_wait') AND o.next_attempt_at<=?
              AND d.enabled=1
              AND NOT EXISTS(SELECT 1 FROM loop_cleanup_jobs c WHERE c.loop_id=o.loop_id AND c.status<>'done')
              AND (SELECT COUNT(*) FROM loop_occurrences r WHERE r.loop_id=o.loop_id AND r.status='running')<d.max_concurrency
          ))
          AND (t.origin_kind='loop' OR NOT EXISTS (SELECT 1 FROM cleanup_jobs c WHERE c.issue_id=t.issue_id AND c.status='running'))
        ORDER BY t.id LIMIT 1`,
        )
        .get(now) as { id: number } | undefined;
      if (!candidate) return undefined;
      const changed = this.db
        .prepare(
          `UPDATE turns SET status='running', attempts=attempts+1, started_at=?, error=NULL
        WHERE id=? AND status='pending'`,
        )
        .run(now, candidate.id);
      if (!changed.changes) return undefined;
      this.db.prepare(`UPDATE loop_occurrences SET status='running',started_at=COALESCE(started_at,?),error=NULL
        WHERE turn_id=? AND status IN ('pending','retry_wait')`).run(now,candidate.id);
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
        (id,request_digest,type,reason,requested_at,target_ref,target_commit,previous_commit,state,updated_at,
         actor,request_kind,request_summary)
        VALUES (?,?,?,?,?,?,?,?, 'pending',?,?,?,?)`).run(input.id, input.requestDigest, input.type,
          input.reason, now, input.targetRef ?? null, input.targetCommit ?? null,
          input.previousCommit ?? null, now, input.actor ?? "operator", input.requestKind ?? null, input.requestSummary ?? null);
      this.appendOperationEvent(input.id, "pending", "scheduled", null, now);
      return { operation: this.operationById(input.id)!, deduplicated: false };
    })();
  }

  operationById(id: string): OperationRow | undefined {
    return this.db.prepare(`SELECT id,request_digest requestDigest,type,reason,requested_at requestedAt,
      target_ref targetRef,target_commit targetCommit,previous_commit previousCommit,state,stage,attempts,
      mutated,rollback_verified rollbackVerified,outcome,error_stage errorStage,updated_at updatedAt,
      actor,request_kind requestKind,request_summary requestSummary,state_version stateVersion,cancel_requested cancelRequested
      FROM operations WHERE id=?`).get(id) as OperationRow | undefined;
  }

  activeOperation(): OperationRow | undefined {
    return this.db.prepare(`SELECT id,request_digest requestDigest,type,reason,requested_at requestedAt,
      target_ref targetRef,target_commit targetCommit,previous_commit previousCommit,state,stage,attempts,
      mutated,rollback_verified rollbackVerified,outcome,error_stage errorStage,updated_at updatedAt,
      actor,request_kind requestKind,request_summary requestSummary,state_version stateVersion,cancel_requested cancelRequested
      FROM operations WHERE state IN ('pending','executing','accepting','rolling_back','blocked')
      ORDER BY requested_at LIMIT 1`).get() as OperationRow | undefined;
  }

  claimOperation(id: string, digest: string, now = Date.now()): OperationRow | undefined {
    return this.db.transaction(() => {
      const row = this.operationById(id);
      if (!row || row.requestDigest !== digest || row.state === "blocked"
          || !ACTIVE_OPERATION_STATES.includes(row.state as never)) return undefined;
      if (row.state === "pending") {
        this.db.prepare("UPDATE operations SET state='executing',stage='apply',attempts=attempts+1,state_version=state_version+1,updated_at=? WHERE id=? AND state='pending'")
          .run(now, id);
        this.appendOperationEvent(id, "executing", "apply", null, now);
      } else {
        this.db.prepare("UPDATE operations SET attempts=attempts+1,updated_at=? WHERE id=?").run(now, id);
      }
      return this.operationById(id);
    })();
  }

  transitionOperation(id: string, state: OperationState, stage: string | null, options: {
    outcome?: string | null; errorStage?: string | null; mutated?: boolean; rollbackVerified?: boolean;
  } = {}, now = Date.now()): OperationRow {
    return this.db.transaction(() => {
      const current = this.operationById(id);
      if (!current) throw new Error(`unknown operation: ${id}`);
      if ((state === "failed" || state === "cancelled") && current.mutated === 1
          && !(options.rollbackVerified ?? current.rollbackVerified === 1)) {
        throw new Error("cannot release operation gate after mutation without verified rollback");
      }
      const outcome = options.outcome ?? current.outcome;
      this.db.prepare(`UPDATE operations SET state=?,stage=?,outcome=?,error_stage=?,
        mutated=?,rollback_verified=?,state_version=state_version+1,updated_at=? WHERE id=?`).run(state, stage,
          outcome, options.errorStage ?? current.errorStage,
          options.mutated === undefined ? current.mutated : Number(options.mutated),
          options.rollbackVerified === undefined ? current.rollbackVerified : Number(options.rollbackVerified), now, id);
      this.appendOperationEvent(id, state, stage, outcome, now);
      return this.operationById(id)!;
    })();
  }

  retryOperation(id: string, now = Date.now()): OperationRow {
    const row = this.operationById(id);
    if (!row || (row.state !== "blocked" && row.state !== "failed"))
      throw new Error("only a blocked or failed operation can be retried");
    this.db.prepare(`UPDATE operations SET state='pending',stage=NULL,error_stage=NULL,
      rollback_verified=0,state_version=state_version+1,updated_at=? WHERE id=?`)
      .run(now, id);
    this.appendOperationEvent(id, "pending", "retry", null, now);
    return this.operationById(id)!;
  }

  parkOperationFailure(
    id: string,
    stage: string,
    outcome: string | null,
    errorStage: string | null,
    now = Date.now(),
  ): OperationRow {
    const row = this.operationById(id);
    if (!row || !ACTIVE_OPERATION_STATES.includes(row.state as never))
      throw new Error("operation is not active");
    const coherent = row.mutated === 0 || row.rollbackVerified === 1;
    return this.transitionOperation(
      id,
      coherent ? "failed" : "blocked",
      stage,
      { outcome, errorStage },
      now,
    );
  }

  cancelOperation(id: string, now = Date.now()): OperationRow {
    const row = this.operationById(id);
    if (!row || !ACTIVE_OPERATION_STATES.includes(row.state as never)) throw new Error("operation is not active");
    if (row.mutated === 1 && row.rollbackVerified !== 1) throw new Error("operation may not be cancelled after mutation without verified rollback");
    return this.transitionOperation(id, "cancelled", "cancelled",
      { outcome: row.actor === "local-console" ? "cancelled by local-console" : "cancelled by operator" }, now);
  }

  private appendOperationEvent(id: string, state: OperationState, stage: string | null, outcome: string | null, now: number): void {
    this.db.prepare(`INSERT INTO operation_stage_events(operation_id,sequence,state,stage,outcome,created_at)
      VALUES (?,COALESCE((SELECT MAX(sequence)+1 FROM operation_stage_events WHERE operation_id=?),1),?,?,?,?)`)
      .run(id, id, state, stage, outcome, now);
  }

  operationEvents(id: string): OperationStageEvent[] {
    return this.db.prepare(`SELECT sequence,operation_id operationId,state,stage,outcome,created_at createdAt
      FROM operation_stage_events WHERE operation_id=? ORDER BY sequence LIMIT 128`).all(id) as OperationStageEvent[];
  }

  listOperations(limit = 50): OperationRow[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.db.prepare(`SELECT id,request_digest requestDigest,type,reason,requested_at requestedAt,
      target_ref targetRef,target_commit targetCommit,previous_commit previousCommit,state,stage,attempts,
      mutated,rollback_verified rollbackVerified,outcome,error_stage errorStage,updated_at updatedAt,
      actor,request_kind requestKind,request_summary requestSummary,state_version stateVersion,cancel_requested cancelRequested
      FROM operations ORDER BY requested_at DESC LIMIT ?`).all(bounded) as OperationRow[];
  }

  createOperationControl(input: { id: string; digest: string; targetOperationId: string; targetDigest: string;
    kind: OperationControlKind; reason: string; expectedVersion: number; requestedAt?: number }): { control: OperationControlRow; deduplicated: boolean } {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(input.id) || !/^[0-9a-f]{64}$/.test(input.digest)
      || !/^[0-9a-f]{64}$/.test(input.targetDigest) || !Number.isSafeInteger(input.expectedVersion)
      || !input.reason || input.reason.length > 240 || /[\x00-\x1f\x7f]/.test(input.reason)) throw new Error("invalid operation control");
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT id,digest,target_operation_id targetOperationId,target_digest targetDigest,
        kind,actor,reason,expected_version expectedVersion,state,outcome,requested_at requestedAt,updated_at updatedAt
        FROM operation_controls WHERE target_operation_id=? AND target_digest=? AND kind=? AND expected_version=?`)
        .get(input.targetOperationId, input.targetDigest, input.kind, input.expectedVersion) as OperationControlRow | undefined;
      if (existing) return { control: existing, deduplicated: true };
      const target = this.operationById(input.targetOperationId);
      if (!target || target.requestDigest !== input.targetDigest || target.stateVersion !== input.expectedVersion)
        throw new Error("operation control target changed");
      if (input.kind === "cancel" && (!ACTIVE_OPERATION_STATES.includes(target.state as never)
        || target.mutated === 1 || target.cancelRequested === 1)) throw new Error("operation cannot be cancelled");
      if (input.kind === "retry" && target.state !== "failed" && target.state !== "blocked") throw new Error("operation cannot be retried");
      const now = input.requestedAt ?? Date.now();
      this.db.prepare(`INSERT INTO operation_controls
        (id,digest,target_operation_id,target_digest,kind,actor,reason,expected_version,state,requested_at,updated_at)
        VALUES (?,?,?,?,?,'local-console',?,?, 'pending',?,?)`).run(input.id, input.digest,
          input.targetOperationId, input.targetDigest, input.kind, input.reason, input.expectedVersion, now, now);
      if (input.kind === "cancel") this.db.prepare(`UPDATE operations SET cancel_requested=1,state_version=state_version+1,
        updated_at=? WHERE id=? AND state_version=?`).run(now, target.id, target.stateVersion);
      return { control: this.operationControlById(input.id)!, deduplicated: false };
    })();
  }

  operationControlById(id: string): OperationControlRow | undefined {
    return this.db.prepare(`SELECT id,digest,target_operation_id targetOperationId,target_digest targetDigest,
      kind,actor,reason,expected_version expectedVersion,state,outcome,requested_at requestedAt,updated_at updatedAt
      FROM operation_controls WHERE id=?`).get(id) as OperationControlRow | undefined;
  }

  listOperationControls(): OperationControlRow[] {
    return this.db.prepare(`SELECT id,digest,target_operation_id targetOperationId,target_digest targetDigest,
      kind,actor,reason,expected_version expectedVersion,state,outcome,requested_at requestedAt,updated_at updatedAt
      FROM operation_controls ORDER BY requested_at,id LIMIT 256`).all() as OperationControlRow[];
  }

  nonterminalOperationControls(): OperationControlRow[] {
    return this.db.prepare(`SELECT id,digest,target_operation_id targetOperationId,target_digest targetDigest,
      kind,actor,reason,expected_version expectedVersion,state,outcome,requested_at requestedAt,updated_at updatedAt
      FROM operation_controls WHERE state IN ('pending','executing') ORDER BY requested_at,id`).all() as OperationControlRow[];
  }

  transitionOperationControl(id: string, state: OperationControlRow["state"], outcome: string | null, now = Date.now()): OperationControlRow {
    if (outcome !== null && (outcome.length > 240 || /[\x00-\x1f\x7f]/.test(outcome))) throw new Error("invalid control outcome");
    this.db.prepare("UPDATE operation_controls SET state=?,outcome=?,updated_at=? WHERE id=?").run(state, outcome, now, id);
    const row = this.operationControlById(id); if (!row) throw new Error("unknown operation control"); return row;
  }

  acknowledgeRetryOperationControl(id: string, now = Date.now()): { control: OperationControlRow; operation: OperationRow } {
    return this.db.transaction(() => {
      const control = this.operationControlById(id);
      if (!control || control.kind !== "retry") throw new Error("unknown retry control");
      const current = this.operationById(control.targetOperationId);
      if (!current || current.requestDigest !== control.targetDigest) throw new Error("operation control target changed");
      if (control.state === "succeeded") return { control, operation: current };
      if ((control.state !== "pending" && control.state !== "executing") || current.stateVersion !== control.expectedVersion)
        throw new Error("operation control target changed");
      if (current.state === "failed") {
        this.db.prepare(`UPDATE operations SET state='pending',stage=NULL,error_stage=NULL,
          rollback_verified=0,state_version=state_version+1,updated_at=? WHERE id=? AND state='failed' AND state_version=?`)
          .run(now, current.id, control.expectedVersion);
        this.appendOperationEvent(current.id, "pending", "retry", null, now);
      } else if (current.state === "blocked" && current.mutated === 1) {
        this.db.prepare(`UPDATE operations SET state='rolling_back',stage='rollback_retry',
          state_version=state_version+1,updated_at=? WHERE id=? AND state='blocked' AND state_version=?`).run(now, current.id, control.expectedVersion);
        this.appendOperationEvent(current.id, "rolling_back", "rollback_retry", current.outcome, now);
      } else throw new Error("operation cannot be retried");
      this.db.prepare("UPDATE operation_controls SET state='succeeded',outcome='acknowledged',updated_at=? WHERE id=?")
        .run(now, control.id);
      return { control: this.operationControlById(id)!, operation: this.operationById(current.id)! };
    })();
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
        state: pending.state, stage: pending.stage, attempts: pending.attempts,
        recoveryCommand: pending.state === "blocked" ? `daemonctl operation retry ${pending.id}` : null } : null,
      runningTurns: this.runningTurns(now).length,
      lastOutcome: last
        ? {
            ...last,
            recoveryCommand:
              last.state === "failed"
                ? `daemonctl operation retry ${last.id}`
                : null,
          }
        : null,
    };
  }

  consoleProviders(): ProviderStateRow[] {
    return this.db.prepare(`SELECT provider,status,reason,cooldown_until cooldownUntil,updated_at updatedAt
      FROM provider_state ORDER BY provider`).all() as ProviderStateRow[];
  }

  upsertDependencyObservation(input: DependencyObservationInput): void {
    const capabilities = validateDependencyObservation(input);
    this.db.prepare(`INSERT INTO dependency_observations
      (kind,name,configured,status,reason_code,capabilities_json,observed_at,stale_after_ms)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(kind,name) DO UPDATE SET configured=excluded.configured,status=excluded.status,
        reason_code=excluded.reason_code,capabilities_json=excluded.capabilities_json,
        observed_at=excluded.observed_at,stale_after_ms=excluded.stale_after_ms`)
      .run(input.kind, input.name, input.configured ? 1 : 0, input.status, input.reasonCode,
        JSON.stringify(capabilities), input.observedAt, input.staleAfterMs);
  }

  dependencyObservations(): DependencyObservationRow[] {
    const rows = this.db.prepare(`SELECT kind,name,configured,status,reason_code reasonCode,
      capabilities_json capabilitiesJson,observed_at observedAt,stale_after_ms staleAfterMs
      FROM dependency_observations ORDER BY kind,name`).all() as Array<{
        kind: DependencyKind; name: string; configured: number; status: DependencyHealth;
        reasonCode: string | null; capabilitiesJson: string; observedAt: number; staleAfterMs: number;
      }>;
    return rows.map(({ capabilitiesJson, ...row }) => ({ ...row, configured: row.configured === 1,
      capabilities: validateCapabilities(JSON.parse(capabilitiesJson) as unknown) }));
  }

  consoleRuns(limit = 50, now = Date.now(), linearBase?: string): ConsoleRunSummary[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const sessions = this.db.prepare(`SELECT origin_kind originKind,origin_id originId,loop_occurrence_id loopOccurrenceId,linear_session_id linearSessionId,app,issue_id issueId,
      issue_identifier issueIdentifier,worktree_path worktreePath,branch,claude_session_id claudeSessionId,
      runtime,fallback_cause fallbackCause,profile,profile_fallback profileFallback,
      browser_required browserRequired,browser_run_id browserRunId,mode,status,last_seen_at lastSeenAt,
      last_seen_activity_at lastSeenActivityAt,trace_id traceId,root_span_id rootSpanId,
      started_at startedAt,completed_at completedAt FROM sessions ORDER BY started_at DESC LIMIT ?`)
      .all(bounded) as SessionRow[];
    return sessions.map(session => session.originKind === "loop" && session.loopOccurrenceId
      ? this.loopRunSummary(this.loopOccurrence(session.loopOccurrenceId)!,now)
      : this.consoleRunSummary(session, now, linearBase));
  }

  consoleRun(linearSessionId: string, now = Date.now(), linearBase?: string): ConsoleRunDetail | undefined {
    const session = this.getSession(linearSessionId);
    if (!session) return undefined;
    if(session.originKind === "loop" && session.loopOccurrenceId){const occurrence=this.loopOccurrence(session.loopOccurrenceId);if(!occurrence)return undefined;
      return {...this.loopRunSummary(occurrence,now),invocations:this.invocations(linearSessionId).map(row=>projectInvocation(row,now))};}
    return {
      ...this.consoleRunSummary(session, now, linearBase),
      invocations: this.invocations(linearSessionId).map(row => projectInvocation(row, now)),
    };
  }

  private loopRunSummary(occurrence:LoopOccurrenceRow,now:number):ConsoleRunSummary{
    const loop=this.loopById(occurrence.loopId);
    return {id:occurrence.runId,app:occurrence.snapshot.task.role,mode:occurrence.snapshot.task.role,status:occurrence.status,
      issueIdentifier:null,runtime:occurrence.snapshot.harness.runtime,startedAt:occurrence.startedAt??occurrence.createdAt,
      completedAt:occurrence.finishedAt,durationMs:Math.max(0,(occurrence.finishedAt??now)-(occurrence.startedAt??occurrence.createdAt)),
      invocationCount:this.invocations(occurrence.runId).length,totalTokens:this.aggregateSession(occurrence.runId).canonicalTokens,
      resources:[],origin:"loop",loopName:loop?.name??null,loopId:occurrence.loopId,occurrenceId:occurrence.id};
  }

  private consoleRunSummary(session: SessionRow, now: number, linearBase?: string): ConsoleRunSummary {
    const aggregate = this.aggregateSession(session.linearSessionId);
    const urls = this.db.prepare(`SELECT id,linear_session_id linearSessionId,app,label,url,attempts,
      next_attempt_at nextAttemptAt,created_at createdAt FROM session_external_urls
      WHERE linear_session_id=? ORDER BY id`).all(session.linearSessionId) as ExternalUrlRow[];
    return {
      id: session.linearSessionId,
      app: session.app,
      mode: session.mode,
      status: session.status,
      issueIdentifier: session.issueIdentifier,
      runtime: session.runtime,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      durationMs: Math.max(0, (session.completedAt ?? now) - session.startedAt),
      invocationCount: this.invocations(session.linearSessionId).length,
      totalTokens: aggregate.canonicalTokens,
      resources: projectResources(session, urls, linearBase),
      origin: "linear",
      loopName: null,
      loopId: null,
      occurrenceId: null,
    };
  }

  getTurn(id: number): TurnRow | undefined {
    return this.db
      .prepare(
        `SELECT t.origin_kind originKind,t.origin_id originId,t.loop_occurrence_id loopOccurrenceId,t.resource_key resourceKey,
      t.id, t.event_id eventId, COALESCE(e.app,s.app) app, t.linear_session_id linearSessionId,
      t.issue_id issueId, t.kind, t.prompt, t.status, t.attempts, t.error, t.started_at startedAt,
      t.finished_at finishedAt, t.turn_span_id turnSpanId,t.execution_finished_at executionFinishedAt,
      COALESCE(e.raw_body,X'') rawBody,COALESCE(e.received_at,s.started_at) receivedAt
      FROM turns t LEFT JOIN events e ON e.id=t.event_id LEFT JOIN sessions s ON s.linear_session_id=t.linear_session_id WHERE t.id=?`,
      )
      .get(id) as TurnRow | undefined;
  }
  private turnById(id: number): TurnRow | undefined { return this.getTurn(id); }

  setTurnPrompt(turnId: number, prompt: string): void {
    this.db.prepare("UPDATE turns SET prompt=? WHERE id=?").run(prompt, turnId);
  }
  getSession(linearSessionId: string): SessionRow | undefined {
    return this.db
      .prepare(
        `SELECT origin_kind originKind,origin_id originId,loop_occurrence_id loopOccurrenceId,linear_session_id linearSessionId, app, issue_id issueId,
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
  // activeSince bounds the poll set: the reconcile sweep issues one Linear API call per
  // returned row, so an unbounded set spends the workspace quota on sessions that ended
  // weeks ago. Sessions that receive real traffic keep last_seen_at fresh via append().
  plannerSessionsForReconcile(activeSince = 0): SessionRow[] {
    return this.db
      .prepare(
        `SELECT linear_session_id linearSessionId, app, issue_id issueId,
      issue_identifier issueIdentifier, worktree_path worktreePath, branch, claude_session_id claudeSessionId,
      runtime, fallback_cause fallbackCause, profile, profile_fallback profileFallback,
      browser_required browserRequired, browser_run_id browserRunId,
      mode, status, last_seen_at lastSeenAt, last_seen_activity_at lastSeenActivityAt,
      trace_id traceId,root_span_id rootSpanId,started_at startedAt,completed_at completedAt
      FROM sessions WHERE origin_kind='linear' AND app='planner' AND mode='planner' AND status='active'
      AND last_seen_at>=? ORDER BY last_seen_at`,
      )
      .all(activeSince) as SessionRow[];
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
      FROM sessions WHERE origin_kind='linear' AND worktree_path IS NOT NULL ORDER BY last_seen_at`,
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
  dispatchWaits(linearSessionId: string): DispatchWaitRow[] {
    return this.db
      .prepare(
        `SELECT turn_id turnId,linear_session_id linearSessionId,
        dispatch_base dispatchBase,deadline_at deadlineAt,created_at createdAt
        FROM dispatch_waits WHERE linear_session_id=?
        ORDER BY turn_id,dispatch_base`,
      )
      .all(linearSessionId) as DispatchWaitRow[];
  }
  deleteDispatchWait(linearSessionId: string, dispatchBase: string): number {
    return this.db
      .prepare(
        "DELETE FROM dispatch_waits WHERE linear_session_id=? AND dispatch_base=?",
      )
      .run(linearSessionId, dispatchBase).changes;
  }
  enqueueDispatchDeadlineResume(turnId: number, now = Date.now()): number {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT t.id,t.linear_session_id linearSessionId,t.issue_id issueId,
          e.app,s.issue_identifier issueIdentifier
          FROM turns t JOIN events e ON e.id=t.event_id
          LEFT JOIN sessions s ON s.linear_session_id=t.linear_session_id
          WHERE t.id=? AND t.status='interrupted'`,
        )
        .get(turnId) as
        | {
            id: number;
            linearSessionId: string;
            issueId: string;
            app: AppName;
            issueIdentifier: string | null;
          }
        | undefined;
      if (!row) throw new Error("dispatch wait parent is not interrupted");
      const resumeTurnId = this.insertRecoveryResume(
        row,
        `dispatch-deadline:${turnId}`,
        "Continue from the interrupted daemon turn. A detached Codex dispatch was still in flight when the daemon restarted and its completion marker has not appeared by its deadline. Inspect the dispatch owner directory, verify any external effects, and continue the pipeline.",
        now,
      );
      this.db.prepare("DELETE FROM dispatch_waits WHERE turn_id=?").run(turnId);
      return resumeTurnId;
    })();
  }
  private insertRecoveryResume(
    row: {
      id: number;
      linearSessionId: string;
      issueId: string;
      app: AppName;
      issueIdentifier: string | null;
    },
    sourceKey: string,
    prompt: string,
    now: number,
  ): number {
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
        Buffer.from(JSON.stringify({ agentActivity: { body: prompt } })),
      );
    const event = this.db
      .prepare("SELECT id FROM events WHERE delivery_id=?")
      .get(sourceKey) as { id: number };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO turns
        (event_id,linear_session_id,issue_id,resource_key,source_key,kind,status)
        VALUES (?,?,?,?,?, 'prompted','pending')`,
      )
      .run(event.id, row.linearSessionId, row.issueId,row.issueId, sourceKey);
    return (
      this.db.prepare("SELECT id FROM turns WHERE source_key=?").get(sourceKey) as {
        id: number;
      }
    ).id;
  }
  recoverStaleRunning(
    now = Date.now(),
    inflight: ReadonlyMap<string, readonly InFlightDispatch[]> = new Map(),
  ): RestartDisposition[] {
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
        const dispatches = inflight.get(row.linearSessionId) ?? [];
        const reason: RestartDisposition["reason"] = hardRestart
          ? "hard_restart"
          : !row.claudeSessionId
            ? "missing_claude_session"
            : dispatches.length
              ? "dispatch_in_flight"
              : row.hasOpenTool
                ? "unresolved_tool_call"
                : "safe_boundary";
        if (reason === "dispatch_in_flight") {
          const insert = this.db.prepare(
            `INSERT OR IGNORE INTO dispatch_waits
            (turn_id,linear_session_id,dispatch_base,deadline_at,created_at)
            VALUES (?,?,?,?,?)`,
          );
          for (const dispatch of dispatches)
            insert.run(
              row.id,
              row.linearSessionId,
              dispatch.base,
              dispatch.deadlineAt,
              now,
            );
          dispositions.push({
            turnId: row.id,
            outcome: "awaiting_dispatch",
            reason,
            resumeTurnId: null,
          });
          continue;
        }
        if (reason === "safe_boundary" || reason === "unresolved_tool_call") {
          const sourceKey = `restart-resume:${row.id}`;
          const prompt =
            reason === "unresolved_tool_call"
              ? "Continue from the interrupted daemon turn. An external tool call may have been in flight when the daemon restarted: verify its external effects before re-running it — the push, PR, comment, or write may already have landed. Review the current worktree state before proceeding."
              : "Continue from the interrupted daemon turn. Review the current worktree state before proceeding.";
          const resumeTurnId = this.insertRecoveryResume(
            row,
            sourceKey,
            prompt,
            now,
          );
          dispositions.push({
            turnId: row.id,
            outcome: "resumed",
            reason,
            resumeTurnId,
          });
          continue;
        }
        const body =
          reason === "hard_restart"
            ? "The run was interrupted by an explicit hard restart and was not resumed. Please review the current state before continuing."
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
    dispatchWait?: { linearSessionId: string; dispatchBase: string },
  ): { invocation: AgentInvocationRow; append: AppendResult } {
    return this.db.transaction(() => {
      const result = {
        invocation: this.ingestCodexInvocation(invocation, now),
        append: this.append(event),
      };
      if (dispatchWait)
        this.deleteDispatchWait(
          dispatchWait.linearSessionId,
          dispatchWait.dispatchBase,
        );
      return result;
    })();
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
  reserveSimLease(turnId: number, sessionId: string, maxConcurrent: number, now: number):
    { id: number; leaseIndex: number; name: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const open = (this.db.prepare("SELECT count(*) count FROM sim_leases WHERE state IN ('creating','booted','orphan')")
        .get() as { count: number }).count;
      if (open >= maxConcurrent) throw new SimCapacityError(`simulator capacity reached (${maxConcurrent})`);
      const turnOpen = (this.db.prepare("SELECT count(*) count FROM sim_leases WHERE turn_id=? AND state IN ('creating','booted','orphan')")
        .get(turnId) as { count: number }).count;
      if (turnOpen >= 2) throw new SimTurnLimitError("a turn may hold at most two simulator leases");
      const leaseIndex = 1 + (this.db.prepare("SELECT count(*) count FROM sim_leases WHERE turn_id=?")
        .get(turnId) as { count: number }).count;
      const name = `orchestra-${turnId}-${leaseIndex}`;
      const result = this.db.prepare(`INSERT INTO sim_leases
        (name,turn_id,linear_session_id,lease_index,state,acquired_at,last_live_at)
        VALUES (?,?,?,?,'creating',?,?)`).run(name, turnId, sessionId, leaseIndex, now, now);
      this.db.exec("COMMIT");
      return { id: Number(result.lastInsertRowid), leaseIndex, name };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  attachSimDevice(id: number, udid: string): void {
    this.db.prepare("UPDATE sim_leases SET udid=? WHERE id=? AND state='creating'").run(udid, id);
  }
  markSimLeaseBooted(id: number, evidenceDir: string, now: number): void {
    this.db.prepare("UPDATE sim_leases SET state='booted',evidence_dir=?,last_live_at=? WHERE id=?").run(evidenceDir, now, id);
  }
  closeSimLease(id: number, state: "released" | "reaped", reason: string, now = Date.now()): void {
    this.db.prepare("UPDATE sim_leases SET state=?,released_at=?,release_reason=? WHERE id=?").run(state, now, reason, id);
  }
  failSimLease(id: number, reason: string, now: number): void {
    this.db.prepare("UPDATE sim_leases SET state='failed',released_at=?,release_reason=? WHERE id=?").run(now, reason, id);
  }
  openSimLeases(): SimLeaseRow[] {
    return this.db.prepare(`SELECT id,udid,name,turn_id turnId,linear_session_id linearSessionId,
      lease_index leaseIndex,state,evidence_dir evidenceDir,acquired_at acquiredAt,last_live_at lastLiveAt,
      released_at releasedAt,release_reason releaseReason,reap_attempts reapAttempts FROM sim_leases
      WHERE state IN ('creating','booted','orphan') ORDER BY id`).all() as SimLeaseRow[];
  }
  simLeaseByUdid(udid: string): SimLeaseRow | undefined {
    return this.db.prepare(`SELECT id,udid,name,turn_id turnId,linear_session_id linearSessionId,
      lease_index leaseIndex,state,evidence_dir evidenceDir,acquired_at acquiredAt,last_live_at lastLiveAt,
      released_at releasedAt,release_reason releaseReason,reap_attempts reapAttempts FROM sim_leases WHERE udid=? ORDER BY id DESC LIMIT 1`)
      .get(udid) as SimLeaseRow | undefined;
  }
  simLeaseByName(name: string): SimLeaseRow | undefined {
    return this.db.prepare(`SELECT id,udid,name,turn_id turnId,linear_session_id linearSessionId,
      lease_index leaseIndex,state,evidence_dir evidenceDir,acquired_at acquiredAt,last_live_at lastLiveAt,
      released_at releasedAt,release_reason releaseReason,reap_attempts reapAttempts FROM sim_leases
      WHERE name=? AND state IN ('creating','booted','orphan') ORDER BY id DESC LIMIT 1`).get(name) as SimLeaseRow | undefined;
  }
  adoptSimOrphan(udid: string, name: string, now: number): SimLeaseRow {
    this.db.prepare(`INSERT INTO sim_leases (udid,name,state,acquired_at,last_live_at)
      VALUES (?,?,'orphan',?,?) ON CONFLICT(udid) DO NOTHING`).run(udid, name, now, now);
    return this.simLeaseByUdid(udid)!;
  }
  touchSimLeases(ids: number[], now: number): void {
    const update = this.db.prepare("UPDATE sim_leases SET last_live_at=? WHERE id=? AND state IN ('creating','booted','orphan')");
    this.db.transaction((values: number[]) => { for (const id of values) update.run(now, id); })(ids);
  }
  incrementSimReapAttempt(id: number): number {
    return (this.db.prepare("UPDATE sim_leases SET reap_attempts=reap_attempts+1 WHERE id=? RETURNING reap_attempts reapAttempts")
      .get(id) as { reapAttempts: number }).reapAttempts;
  }
  loopById(id: string): LoopDefinitionRow | undefined {
    const row = this.db.prepare(`SELECT id,revision,digest,declaration_json declarationJson,enabled,next_due_at nextDueAt,
      blocked_reason blockedReason,created_at createdAt,updated_at updatedAt FROM loop_definitions WHERE id=?`).get(id) as
      ({ id: string; revision: number; digest: string; declarationJson: string; enabled:number;nextDueAt: number; blockedReason: string | null; createdAt: number; updatedAt: number } | undefined);
    if (!row) return undefined;
    return { ...JSON.parse(row.declarationJson) as LoopDeclaration,enabled:row.enabled===1, id: row.id, revision: row.revision, digest: row.digest,
      nextDueAt: row.nextDueAt, blockedReason: row.blockedReason, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
  listLoops(limit = 50): LoopDefinitionRow[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const ids = this.db.prepare("SELECT id FROM loop_definitions ORDER BY updated_at DESC,id LIMIT ?").all(bounded) as Array<{ id: string }>;
    return ids.map(row => this.loopById(row.id)!);
  }
  loopAudit(loopId: string, limit = 50): LoopAuditRow[] {
    const rows = this.db.prepare(`SELECT loop_id loopId,sequence,kind,reason,actor,details_json detailsJson,created_at createdAt
      FROM loop_audit_events WHERE loop_id=? ORDER BY sequence DESC LIMIT ?`).all(loopId, Math.max(1, Math.min(100, Math.trunc(limit)))) as Array<Omit<LoopAuditRow,"details"> & { detailsJson: string }>;
    return rows.map(({ detailsJson, ...row }) => ({ ...row, details: JSON.parse(detailsJson) as Record<string, unknown> }));
  }
  loopOccurrences(loopId: string, limit = 50): LoopOccurrenceRow[] {
    return (this.db.prepare(`SELECT id FROM loop_occurrences WHERE loop_id=? ORDER BY scheduled_for DESC LIMIT ?`)
      .all(loopId, Math.max(1, Math.min(100, Math.trunc(limit)))) as Array<{ id: string }>).map(row => this.loopOccurrence(row.id)!);
  }
  loopOccurrence(id: string): LoopOccurrenceRow | undefined {
    const row = this.db.prepare(`SELECT id,loop_id loopId,definition_revision definitionRevision,scheduled_for scheduledFor,
      run_id runId,turn_id turnId,status,retry_count retryCount,next_attempt_at nextAttemptAt,outcome,error,snapshot_json snapshotJson,
      worktree_path worktreePath,branch,created_at createdAt,started_at startedAt,finished_at finishedAt,
      input_tokens inputTokens,output_tokens outputTokens,cache_creation_tokens cacheCreationTokens,cache_read_tokens cacheReadTokens,cost_usd costUsd,model
      FROM loop_occurrences WHERE id=?`).get(id) as (Omit<LoopOccurrenceRow,"snapshot"> & { snapshotJson: string }) | undefined;
    if (!row) return undefined; const { snapshotJson, ...safe } = row;
    return { ...safe, snapshot: JSON.parse(snapshotJson) as LoopDeclaration };
  }
  loopReceipt(draftId: string): { digest: string; result: LoopMutationResult } | undefined {
    const row = this.db.prepare("SELECT digest,response_json responseJson FROM loop_mutation_receipts WHERE draft_id=?").get(draftId) as { digest: string; responseJson: string } | undefined;
    return row ? { digest: row.digest, result: JSON.parse(row.responseJson) as LoopMutationResult } : undefined;
  }
  mutateLoop(input: { draftId: string; digest: string; id: string; declaration: LoopDeclaration; expectedRevision: number | null;
    reason: string; kind: string; now?: number }): LoopMutationResult {
    return this.db.transaction(() => {
      const receipt = this.loopReceipt(input.draftId); if (receipt) {
        if (receipt.digest !== input.digest) throw new Error("confirmation_mismatch"); return { ...receipt.result, deduplicated: true };
      }
      const now = input.now ?? Date.now(); const current = this.loopById(input.id);
      if ((current?.revision ?? null) !== input.expectedRevision) throw new Error("loop_revision_changed");
      if (input.declaration.enabled && this.hasBlockingLoopCleanup(input.id)) throw new Error("cleanup_unresolved");
      const revision = (current?.revision ?? 0) + 1; const nextDueAt = current
        ? (current.trigger.everyMinutes === input.declaration.trigger.everyMinutes && current.trigger.startsAt === input.declaration.trigger.startsAt
          ? current.nextDueAt : nextLoopDue(input.declaration.trigger.startsAt, input.declaration.trigger.everyMinutes, now - 1))
        : nextLoopDue(input.declaration.trigger.startsAt, input.declaration.trigger.everyMinutes, now - 1);
      this.db.prepare(`INSERT INTO loop_definitions(id,revision,digest,declaration_json,name,description,enabled,blocked_reason,next_due_at,max_concurrency,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,
        declaration_json=excluded.declaration_json,name=excluded.name,description=excluded.description,enabled=excluded.enabled,
        blocked_reason=NULL,next_due_at=excluded.next_due_at,max_concurrency=excluded.max_concurrency,updated_at=excluded.updated_at`)
        .run(input.id, revision, input.digest, JSON.stringify(input.declaration), input.declaration.name, input.declaration.description,
          Number(input.declaration.enabled), null, nextDueAt, input.declaration.maxConcurrency, current?.createdAt ?? now, now);
      if (!input.declaration.enabled) {
        const cancelled=this.db.prepare("SELECT id FROM loop_occurrences WHERE loop_id=? AND status IN ('pending','retry_wait')").all(input.id) as Array<{id:string}>;
        this.db.prepare(`UPDATE loop_occurrences SET status='cancelled',outcome=NULL,error='disabled',finished_at=?
          WHERE loop_id=? AND status IN ('pending','retry_wait')`).run(now, input.id);
        this.db.prepare(`UPDATE turns SET status='interrupted',error='disabled',finished_at=? WHERE loop_occurrence_id IN
          (SELECT id FROM loop_occurrences WHERE loop_id=? AND status='cancelled') AND status='pending'`).run(now,input.id);
        for(const row of cancelled)this.appendLoopAudit(input.id,"occurrence.cancelled","disabled","local-console",{occurrenceId:row.id},now);
      }
      const sequence = ((this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 sequence FROM loop_audit_events WHERE loop_id=?").get(input.id) as { sequence: number }).sequence);
      this.db.prepare("INSERT INTO loop_audit_events(loop_id,sequence,kind,reason,actor,details_json,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(input.id, sequence, input.kind, input.reason, "local-console", JSON.stringify({ revision, enabled: input.declaration.enabled }), now);
      const result: LoopMutationResult = { loop: projectConsoleLoop(this.loopById(input.id)!), auditSequence: sequence, deduplicated: false };
      this.db.prepare("INSERT INTO loop_mutation_receipts(draft_id,digest,loop_id,revision,audit_sequence,response_json,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(input.draftId, input.digest, input.id, revision, sequence, JSON.stringify(result), now);
      return result;
    })();
  }
  admitDueLoops(now = Date.now()): LoopOccurrenceRow[] {
    return this.db.transaction(() => {
      const due = this.db.prepare(`SELECT id FROM loop_definitions d WHERE enabled=1 AND next_due_at<=?
        AND NOT EXISTS(SELECT 1 FROM loop_cleanup_jobs c WHERE c.loop_id=d.id AND c.status<>'done') ORDER BY next_due_at,id`).all(now) as Array<{ id: string }>;
      const admitted: LoopOccurrenceRow[] = [];
      for (const { id } of due) {
        const loop = this.loopById(id)!;
        const active = (this.db.prepare("SELECT COUNT(*) count FROM loop_occurrences WHERE loop_id=? AND status IN ('pending','running','retry_wait')").get(id) as { count: number }).count;
        const scheduled = loop.nextDueAt; const interval = loop.trigger.everyMinutes * 60_000;
        const missedIntervals = Math.max(0, Math.floor((now - scheduled) / interval));
        this.db.prepare("UPDATE loop_definitions SET next_due_at=?,updated_at=? WHERE id=? AND next_due_at=?")
          .run(nextLoopDue(loop.trigger.startsAt, loop.trigger.everyMinutes, now), now, id, scheduled);
        if (active >= loop.maxConcurrency) continue;
        const occurrenceId = randomUUID(); const runId = `loop:${occurrenceId}`;
        const snapshot=loopDeclaration(loop);
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO loop_occurrences(id,loop_id,definition_revision,scheduled_for,run_id,turn_id,status,next_attempt_at,snapshot_json,created_at)
          VALUES (?,?,?,?,?,NULL,'pending',?,?,?)`).run(occurrenceId,id,loop.revision,scheduled,runId,now,JSON.stringify(snapshot),now);
        if (!inserted.changes) continue;
        this.insertLoopSessionTurn(occurrenceId,id,runId,snapshot,now);
        const sequence = (this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 sequence FROM loop_audit_events WHERE loop_id=?").get(id) as { sequence: number }).sequence;
        this.db.prepare("INSERT INTO loop_audit_events VALUES (?,?,?,?,?,?,?)").run(id,sequence,"occurrence.admitted","scheduled","system",JSON.stringify({ occurrenceId, scheduledFor: scheduled, missedIntervals }),now);
        admitted.push(this.loopOccurrence(occurrenceId)!);
      }
      return admitted;
    })();
  }
  private insertLoopSessionTurn(occurrenceId:string,loopId:string,runId:string,snapshot:LoopDeclaration,now:number):number{
    this.db.prepare(`INSERT OR IGNORE INTO sessions
      (linear_session_id,origin_kind,origin_id,loop_occurrence_id,app,issue_id,issue_identifier,runtime,profile,mode,status,
       last_seen_at,trace_id,root_span_id,started_at)
      VALUES (?,'loop',?,?,?,NULL,NULL,?,?,?,'active',?,?,?,?)`)
      .run(runId,loopId,occurrenceId,snapshot.task.role,snapshot.harness.runtime,snapshot.harness.profile,
        snapshot.task.role,now,randomHex(16),randomHex(8),now);
    this.db.prepare(`INSERT OR IGNORE INTO turns
      (origin_kind,origin_id,loop_occurrence_id,resource_key,event_id,linear_session_id,issue_id,source_key,kind,status)
      VALUES ('loop',?,?,?,NULL,?,NULL,?,'loop','pending')`)
      .run(loopId,occurrenceId,loopId,runId,`loop:${occurrenceId}`);
    const turn=(this.db.prepare("SELECT id FROM turns WHERE source_key=?").get(`loop:${occurrenceId}`) as {id:number}).id;
    this.db.prepare("UPDATE loop_occurrences SET turn_id=? WHERE id=? AND turn_id IS NULL").run(turn,occurrenceId);
    return turn;
  }
  recoverStaleLoopOccurrences(now=Date.now()):number{
    return this.db.transaction(()=>{const rows=this.db.prepare("SELECT id FROM loop_occurrences WHERE status='running'").all() as Array<{id:string}>;
      for(const row of rows)this.finishLoopOccurrence(row.id,"service_restart","service_restart",now);
      return rows.length;})();
  }
  finishLoopOccurrence(id: string, outcome: LoopOutcome, error: string | null, now = Date.now()): LoopOccurrenceRow {
    return this.db.transaction(() => {
      const safeError=safeLoopReason(error);
      const occurrence = this.loopOccurrence(id); if (!occurrence) throw new Error("unknown loop occurrence");
      if (["succeeded","blocked","cancelled"].includes(occurrence.status)) return occurrence;
      if (outcome === "service_restart") {
        this.db.prepare("UPDATE loop_occurrences SET status='pending',next_attempt_at=?,error=?,started_at=NULL WHERE id=?").run(now,safeError,id);
        this.db.prepare("UPDATE turns SET status='pending',started_at=NULL,error=? WHERE id=?").run(safeError,occurrence.turnId);
        this.db.prepare("UPDATE sessions SET status='active',completed_at=NULL,claude_session_id=NULL,last_seen_at=? WHERE linear_session_id=?").run(now,occurrence.runId);
        this.appendLoopAudit(occurrence.loopId,"occurrence.service_restart","service_restart","system",{occurrenceId:id,retryCount:occurrence.retryCount},now);
      }
      else if (outcome === "retriable_failure" && occurrence.retryCount < occurrence.snapshot.maxRetries) {
        const nextAttemptAt=now + Math.min(60_000, 1000 * 2 ** occurrence.retryCount);
        this.db.prepare("UPDATE loop_occurrences SET status='retry_wait',retry_count=retry_count+1,next_attempt_at=?,error=?,started_at=NULL WHERE id=?")
          .run(nextAttemptAt,safeError,id);
        this.db.prepare("UPDATE turns SET status='pending',started_at=NULL,error=? WHERE id=?").run(safeError,occurrence.turnId);
        this.db.prepare("UPDATE sessions SET claude_session_id=NULL,last_seen_at=? WHERE linear_session_id=?").run(now,occurrence.runId);
        this.appendLoopAudit(occurrence.loopId,"occurrence.retry_scheduled","retriable_failure","system",
          {occurrenceId:id,retryCount:occurrence.retryCount+1,nextAttemptAt},now);
      }
      else {
        const status = outcome === "succeeded" ? "succeeded" : "blocked";
        this.db.prepare("UPDATE loop_occurrences SET status=?,outcome=?,error=?,finished_at=? WHERE id=?").run(status,outcome,safeError,now,id);
        this.db.prepare("UPDATE turns SET status=?,error=?,finished_at=?,execution_finished_at=? WHERE id=?")
          .run(status === "succeeded" ? "done" : "failed",safeError,now,now,occurrence.turnId);
        this.db.prepare("UPDATE sessions SET status=?,completed_at=?,last_seen_at=? WHERE linear_session_id=?")
          .run(status === "succeeded" ? "completed" : "failed",now,now,occurrence.runId);
        this.db.prepare(`INSERT OR IGNORE INTO loop_cleanup_jobs(occurrence_id,loop_id,owner_key,worktree_path,status,created_at)
          VALUES (?,?,?,?,'pending',?)`).run(id,occurrence.loopId,`loop-${occurrence.loopId}-${id}`,occurrence.worktreePath,now);
        const terminalReason=outcome === "retriable_failure" ? "retries_exhausted" : outcome;
        this.appendLoopAudit(occurrence.loopId,status === "succeeded" ? "occurrence.succeeded" : "occurrence.blocked",
          terminalReason,"system",{occurrenceId:id,retryCount:occurrence.retryCount},now);
        if (status === "blocked" || (outcome === "retriable_failure" && occurrence.retryCount >= occurrence.snapshot.maxRetries)) {
          const reason = terminalReason;
          const definitionTransition=this.blockLoopDefinition(occurrence.loopId,reason,now);
          this.db.prepare("UPDATE loop_occurrences SET status='cancelled',error=?,finished_at=? WHERE loop_id=? AND status IN ('pending','retry_wait')").run(reason,now,occurrence.loopId);
          this.db.prepare(`UPDATE turns SET status='interrupted',error=?,finished_at=? WHERE loop_occurrence_id IN
            (SELECT id FROM loop_occurrences WHERE loop_id=? AND status='cancelled') AND status='pending'`).run(reason,now,occurrence.loopId);
          if(definitionTransition.changed)this.appendLoopAudit(occurrence.loopId,"policy.blocked",reason,"system",
            {occurrenceId:id,revision:definitionTransition.revision},now);
        }
      }
      return this.loopOccurrence(id)!;
    })();
  }
  updateLoopOccurrenceWorktree(id: string, path: string, branch: string): void {
    this.db.prepare("UPDATE loop_occurrences SET worktree_path=?,branch=? WHERE id=?").run(path,branch,id);
  }
  recordLoopUsage(id:string,usage:{inputTokens?:number|undefined;outputTokens?:number|undefined;cacheCreationTokens?:number|undefined;cacheReadTokens?:number|undefined;costUsd?:number|undefined;model?:string|undefined}):void{
    this.db.transaction(()=>{const occurrence=this.loopOccurrence(id);if(!occurrence)throw new Error("unknown loop occurrence");
      this.db.prepare(`UPDATE loop_occurrences SET input_tokens=?,output_tokens=?,cache_creation_tokens=?,cache_read_tokens=?,cost_usd=?,model=? WHERE id=?`)
        .run(usage.inputTokens??null,usage.outputTokens??null,usage.cacheCreationTokens??null,usage.cacheReadTokens??null,usage.costUsd??null,usage.model??null,id);
      this.db.prepare(`UPDATE turns SET usage_input_tokens=?,usage_output_tokens=?,usage_cache_creation_tokens=?,usage_cache_read_tokens=?,cost_usd=?,model=? WHERE id=?`)
        .run(usage.inputTokens??null,usage.outputTokens??null,usage.cacheCreationTokens??null,usage.cacheReadTokens??null,usage.costUsd??null,usage.model??null,occurrence.turnId);
    })();
  }
  recordLoopInvocation(id:string,input:{startedAt:number;endedAt:number;outcome:LoopOutcome;usage?:TurnUsage}):AgentInvocationRow{
    return this.db.transaction(()=>{const occurrence=this.loopOccurrence(id);if(!occurrence)throw new Error("unknown loop occurrence");
      const session=this.getSession(occurrence.runId);if(!session)throw new Error("missing loop session");
      const usage=input.usage;const total=(usage?.inputTokens??0)+(usage?.outputTokens??0)+(usage?.cacheCreationTokens??0)+(usage?.cacheReadTokens??0);
      const source=occurrence.snapshot.harness.runtime === "claudex" ? "codex" : "claude";
      const sourceKey=`loop:${id}:attempt:${this.getTurn(occurrence.turnId)?.attempts??occurrence.retryCount+1}`;
      this.db.prepare(`INSERT OR IGNORE INTO agent_invocations
        (linear_session_id,turn_id,source,source_key,role,runtime,model,started_at,ended_at,outcome,input_tokens,output_tokens,
         cache_creation_tokens,cache_read_tokens,raw_total_tokens,prior_total_tokens,delta_total_tokens,usage_epoch,usage_classification,
         trace_id,span_id,enrichment_state,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'accepted',?,?, 'enriched',?)`)
        .run(occurrence.runId,occurrence.turnId,source,sourceKey,occurrence.snapshot.task.role,occurrence.snapshot.harness.runtime,
          usage?.model??null,input.startedAt,input.endedAt,input.outcome,usage?.inputTokens??null,usage?.outputTokens??null,
          usage?.cacheCreationTokens??null,usage?.cacheReadTokens??null,total,0,total,session.traceId,randomHex(8),input.endedAt);
      return this.invocationBySourceKey(sourceKey)!;
    })();
  }
  hasBlockingLoopCleanup(loopId: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM loop_cleanup_jobs WHERE loop_id=? AND status<>'done' LIMIT 1").get(loopId)); }
  claimNextLoopCleanup(now = Date.now()): LoopCleanupJobRow | undefined {
    return this.db.transaction(() => { const row = this.db.prepare(`SELECT id FROM loop_cleanup_jobs WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 1`).get(now) as { id: number } | undefined;
      if (!row) return undefined; this.db.prepare("UPDATE loop_cleanup_jobs SET status='running',attempts=attempts+1 WHERE id=?").run(row.id); return this.loopCleanup(row.id); })();
  }
  reclaimRunningLoopCleanups():number{return this.db.prepare("UPDATE loop_cleanup_jobs SET status='pending' WHERE status='running'").run().changes;}
  loopCleanup(id: number): LoopCleanupJobRow | undefined { const row=this.db.prepare(`SELECT id,occurrence_id occurrenceId,loop_id loopId,owner_key ownerKey,
    worktree_path worktreePath,status,attempts,next_attempt_at nextAttemptAt,error,created_at createdAt FROM loop_cleanup_jobs WHERE id=?`).get(id) as LoopCleanupJobRow | undefined;
    return row?{...row,error:safeLoopCleanupError(row.error)}:undefined; }
  loopCleanups(loopId:string,limit=20):LoopCleanupJobRow[]{const rows=this.db.prepare(`SELECT id,occurrence_id occurrenceId,loop_id loopId,owner_key ownerKey,
    worktree_path worktreePath,status,attempts,next_attempt_at nextAttemptAt,error,created_at createdAt FROM loop_cleanup_jobs WHERE loop_id=? ORDER BY id DESC LIMIT ?`)
    .all(loopId,Math.max(1,Math.min(50,Math.trunc(limit)))) as LoopCleanupJobRow[];return rows.map(row=>({...row,error:safeLoopCleanupError(row.error)}));}
  completeLoopCleanup(id: number, now = Date.now()): void { this.db.transaction(() => { const job=this.loopCleanup(id);if(!job||job.status==="done")return;
    this.db.prepare("UPDATE loop_cleanup_jobs SET status='done',error=NULL WHERE id=?").run(id);
    this.appendLoopAudit(job.loopId,"cleanup.completed","cleanup_completed","system",{jobId:job.id,occurrenceId:job.occurrenceId},now); })(); }
  retainLoopCleanup(id: number, reason: string, now = Date.now()): void { this.db.transaction(() => { const job=this.loopCleanup(id); if(!job||job.status==="retained")return;
    const safeReason=safeLoopCleanupError(reason)??"cleanup retained";
    this.db.prepare("UPDATE loop_cleanup_jobs SET status='retained',error=? WHERE id=?").run(safeReason,id);
    const definitionTransition=this.blockLoopDefinition(job.loopId,"cleanup_retained",now);
    const cancelled=this.db.prepare("SELECT id FROM loop_occurrences WHERE loop_id=? AND status IN ('pending','retry_wait')").all(job.loopId) as Array<{id:string}>;
    this.db.prepare("UPDATE loop_occurrences SET status='cancelled',error='cleanup_retained',finished_at=? WHERE loop_id=? AND status IN ('pending','retry_wait')").run(now,job.loopId);
    this.db.prepare(`UPDATE turns SET status='interrupted',error='cleanup_retained',finished_at=? WHERE loop_occurrence_id IN
      (SELECT id FROM loop_occurrences WHERE loop_id=? AND status='cancelled') AND status='pending'`).run(now,job.loopId);
    for(const row of cancelled)this.appendLoopAudit(job.loopId,"occurrence.cancelled","cleanup_retained","system",{occurrenceId:row.id},now);
    this.appendLoopAudit(job.loopId,"cleanup.retained",safeReason,"system",
      {jobId:job.id,occurrenceId:job.occurrenceId,revision:definitionTransition.revision},now); })(); }
  retryLoopCleanup(id: number, error: string, nextAttemptAt: number, now = Date.now()): void { this.db.transaction(() => { const job=this.loopCleanup(id);if(!job)return;
    const safeError=safeLoopCleanupError(error)??"cleanup operation failed";
    this.db.prepare("UPDATE loop_cleanup_jobs SET status='pending',error=?,next_attempt_at=? WHERE id=?").run(safeError,nextAttemptAt,id);
    this.appendLoopAudit(job.loopId,"cleanup.retry_scheduled",safeError,"system",{jobId:job.id,occurrenceId:job.occurrenceId,nextAttemptAt},now); })(); }
  failLoopCleanup(id: number, error: string, now = Date.now()): void { this.db.transaction(() => { const job=this.loopCleanup(id); if(!job||job.status==="failed")return;
    const safeError=safeLoopCleanupError(error)??"cleanup operation failed";
    this.db.prepare("UPDATE loop_cleanup_jobs SET status='failed',error=? WHERE id=?").run(safeError,id);
    const definitionTransition=this.blockLoopDefinition(job.loopId,"cleanup_failed",now);
    const cancelled=this.db.prepare("SELECT id FROM loop_occurrences WHERE loop_id=? AND status IN ('pending','retry_wait')").all(job.loopId) as Array<{id:string}>;
    this.db.prepare("UPDATE loop_occurrences SET status='cancelled',error='cleanup_failed',finished_at=? WHERE loop_id=? AND status IN ('pending','retry_wait')").run(now,job.loopId);
    this.db.prepare(`UPDATE turns SET status='interrupted',error='cleanup_failed',finished_at=? WHERE loop_occurrence_id IN
      (SELECT id FROM loop_occurrences WHERE loop_id=? AND status='cancelled') AND status='pending'`).run(now,job.loopId);
    for(const row of cancelled)this.appendLoopAudit(job.loopId,"occurrence.cancelled","cleanup_failed","system",{occurrenceId:row.id},now);
    this.appendLoopAudit(job.loopId,"cleanup.failed",safeError,"system",
      {jobId:job.id,occurrenceId:job.occurrenceId,revision:definitionTransition.revision},now); })(); }
  retryRetainedLoopCleanup(loopId: string, reason: string, now = Date.now()): {revision:number;sequence:number} { return this.db.transaction(() => {
    const loop=this.loopById(loopId);if(!loop)throw new Error("loop_not_found");
    const changed=this.db.prepare("UPDATE loop_cleanup_jobs SET status='pending',error=NULL,next_attempt_at=? WHERE loop_id=? AND status IN ('retained','failed')").run(now,loopId);
    if(!changed.changes) throw new Error("cleanup_not_retryable");const revision=loop.revision+1;
    this.db.prepare("UPDATE loop_definitions SET revision=?,updated_at=? WHERE id=?").run(revision,now,loopId);
    const sequence=this.appendLoopAudit(loopId,"cleanup.retry",reason,"local-console",{revision,jobs:changed.changes},now);
    return {revision,sequence}; })(); }
  confirmLoopCleanupRetry(input:{draftId:string;digest:string;loopId:string;expectedRevision:number;reason:string;now?:number}):LoopMutationResult{
    return this.db.transaction(()=>{const receipt=this.loopReceipt(input.draftId);if(receipt){if(receipt.digest!==input.digest)throw new Error("confirmation_mismatch");return {...receipt.result,deduplicated:true};}
      const loop=this.loopById(input.loopId);if(!loop||loop.revision!==input.expectedRevision)throw new Error("loop_revision_changed");const now=input.now??Date.now();
      const {revision,sequence}=this.retryRetainedLoopCleanup(input.loopId,input.reason,now);const result:LoopMutationResult={loop:projectConsoleLoop(this.loopById(input.loopId)!),auditSequence:sequence,deduplicated:false};
      this.db.prepare("INSERT INTO loop_mutation_receipts(draft_id,digest,loop_id,revision,audit_sequence,response_json,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(input.draftId,input.digest,input.loopId,revision,sequence,JSON.stringify(result),now);return result;})();
  }
  private appendLoopAudit(loopId:string,kind:string,reason:string,actor:string,details:Record<string,unknown>,now:number):number{
    const sequence=(this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 sequence FROM loop_audit_events WHERE loop_id=?").get(loopId) as {sequence:number}).sequence;
    this.db.prepare("INSERT INTO loop_audit_events VALUES (?,?,?,?,?,?,?)").run(loopId,sequence,kind,safeLoopReason(reason)??"unspecified",actor,JSON.stringify(details),now);return sequence;
  }
  private blockLoopDefinition(loopId:string,reason:string,now:number):{revision:number;changed:boolean}{
    const loop=this.loopById(loopId);if(!loop)throw new Error("loop_not_found");
    if(!loop.enabled&&loop.blockedReason===reason)return {revision:loop.revision,changed:false};
    const revision=loop.revision+1;
    const changed=this.db.prepare(`UPDATE loop_definitions SET revision=?,enabled=0,blocked_reason=?,updated_at=?
      WHERE id=? AND revision=?`).run(revision,reason,now,loopId,loop.revision);
    if(changed.changes!==1)throw new Error("loop_revision_changed");
    return {revision,changed:true};
  }
  turnIsRunning(turnId: number): boolean {
    return (this.db.prepare("SELECT status FROM turns WHERE id=?").get(turnId) as { status?: string } | undefined)?.status === "running";
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

function loopDeclaration(row: LoopDefinitionRow): LoopDeclaration {
  return { version: 1, name: row.name, description: row.description, trigger: row.trigger, task: row.task,
    harness: row.harness, maxConcurrency: row.maxConcurrency, budgetUsd: row.budgetUsd,
    timeoutMinutes: row.timeoutMinutes, maxRetries: row.maxRetries, enabled: row.enabled };
}

function safeLoopReason(value:string|null):string|null{return value===null?null:value.replace(/[\x00-\x1f\x7f]/g," ").slice(0,500);}
function safeLoopCleanupError(value:string|null):string|null{
  if(value===null)return null;
  const safe=value.replace(/[\x00-\x1f\x7f]/g," ")
    .replace(/\b(?:https?|ssh):\/\/\S+/gi,"[redacted-url]")
    .replace(/(?<!\])(?:\/[^/\s'\"]+){2,}/g,"[redacted-path]")
    .replace(/\b(?:token|secret|password|credential|authorization|api[_ -]?key)\s*[:=]\s*\S+/gi,"$1=[redacted]")
    .replace(/\b(?:ghp_|github_pat_|lin_api_|sk-)[A-Za-z0-9_-]+\b/g,"[redacted-token]")
    .replace(/\s+/g," ").trim().slice(0,240);
  return safe||"cleanup operation failed";
}
