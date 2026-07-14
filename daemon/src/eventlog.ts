import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { AppName } from "./config.js";

export interface AppendEvent {
  deliveryId?: string | undefined;
  app: AppName;
  action?: string | undefined;
  agentSessionId?: string | undefined;
  issueId?: string | undefined;
  issueIdentifier?: string | undefined;
  webhookId?: string | undefined;
  receivedAt: number;
  rawBody: Buffer;
}

export interface SessionRow {
  linearSessionId: string; app: AppName; issueId: string | null; issueIdentifier: string | null;
  worktreePath: string | null; branch: string | null; claudeSessionId: string | null;
  mode: string; status: string; lastSeenAt: number;
}
export interface TurnRow {
  id: number; eventId: number; app: AppName; linearSessionId: string; issueId: string; kind: "created" | "prompted";
  prompt: string | null; status: "pending" | "running" | "awaiting_activity" | "done" | "failed" | "interrupted";
  attempts: number; error: string | null; startedAt: number | null; finishedAt: number | null;
  rawBody: Buffer; receivedAt: number;
}
export interface TurnActivityRow {
  turnId: number; app: AppName; linearSessionId: string; kind: "response" | "error"; activityId: string;
  body: string; status: "pending" | "posted" | "failed"; attempts: number; nextAttemptAt: number;
  createdAt: number; progressBarrier: number; receivedAt: number;
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

export interface StoredToken { accessToken: string; expiresAt: number; }
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

  constructor(path: string) {
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
        mode TEXT NOT NULL DEFAULT 'planner',
        status TEXT NOT NULL DEFAULT 'active',
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY,
        event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
        linear_session_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('created','prompted')),
        prompt TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','running','awaiting_activity','done','failed','interrupted')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at INTEGER,
        finished_at INTEGER
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
    `);
    this.migrateAckColumns();
    this.migrateTurnActivityColumns();
  }

  private migrateAckColumns(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(acks)").all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has("failure_kind")) this.db.prepare("ALTER TABLE acks ADD COLUMN failure_kind TEXT CHECK(failure_kind IS NULL OR failure_kind IN ('retriable','terminal'))").run();
    if (!columns.has("next_attempt_at")) this.db.prepare("ALTER TABLE acks ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0").run();
  }

  private migrateTurnActivityColumns(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(turn_activities)").all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has("created_at")) {
      this.db.prepare("ALTER TABLE turn_activities ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0").run();
      this.db.prepare("UPDATE turn_activities SET created_at=next_attempt_at WHERE created_at=0").run();
    }
    if (!columns.has("progress_barrier")) this.db.prepare("ALTER TABLE turn_activities ADD COLUMN progress_barrier INTEGER NOT NULL DEFAULT 0").run();
  }

  append(event: AppendEvent): { inserted: boolean; deliveryId: string } {
    const deliveryId = event.deliveryId?.trim() || `sha256:${createHash("sha256").update(event.rawBody).digest("hex")}`;
    const run = this.db.transaction(() => {
      const result = this.db.prepare(`INSERT OR IGNORE INTO events
        (delivery_id, webhook_id, app, action, agent_session_id, issue_id, received_at, raw_body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(deliveryId, event.webhookId ?? null, event.app, event.action ?? null,
          event.agentSessionId ?? null, event.issueId ?? null, event.receivedAt, event.rawBody);
      if (result.changes === 0) return false;
      if (event.action === "created" && event.agentSessionId) {
        this.db.prepare(`INSERT INTO acks (event_id, activity_id, status, next_attempt_at, deadline_at)
          VALUES (?, ?, 'pending', ?, ?)`)
          .run(Number(result.lastInsertRowid), randomUUID(), event.receivedAt, event.receivedAt + 10_000);
      }
      if (event.app === "planner" && (event.action === "created" || event.action === "prompted") && event.agentSessionId) {
        const existing = this.db.prepare("SELECT issue_id issueId, issue_identifier issueIdentifier FROM sessions WHERE linear_session_id=?")
          .get(event.agentSessionId) as { issueId: string | null; issueIdentifier: string | null } | undefined;
        const issueId = event.issueId ?? existing?.issueId ?? event.agentSessionId;
        const issueIdentifier = event.issueIdentifier ?? existing?.issueIdentifier ?? event.issueId ?? event.agentSessionId;
        this.db.prepare(`INSERT INTO sessions
          (linear_session_id, app, issue_id, issue_identifier, mode, status, last_seen_at)
          VALUES (?, ?, ?, ?, 'planner', 'active', ?)
          ON CONFLICT(linear_session_id) DO UPDATE SET
            issue_id=COALESCE(excluded.issue_id, sessions.issue_id),
            issue_identifier=COALESCE(excluded.issue_identifier, sessions.issue_identifier),
            last_seen_at=excluded.last_seen_at`)
          .run(event.agentSessionId, event.app, issueId, issueIdentifier, event.receivedAt);
        if (event.action === "created" && event.issueId) {
          this.db.prepare(`UPDATE sessions SET issue_id=?, issue_identifier=?, last_seen_at=?
            WHERE linear_session_id=?`)
            .run(event.issueId, issueIdentifier, event.receivedAt, event.agentSessionId);
          if (existing?.issueId && existing.issueId !== event.issueId) {
            this.db.prepare(`UPDATE turns SET issue_id=?
              WHERE linear_session_id=? AND issue_id=? AND status IN ('pending','running','awaiting_activity')`)
              .run(event.issueId, event.agentSessionId, existing.issueId);
          }
        }
        this.db.prepare(`INSERT INTO turns (event_id, linear_session_id, issue_id, kind, status)
          VALUES (?, ?, ?, ?, 'pending')`).run(Number(result.lastInsertRowid), event.agentSessionId, issueId, event.action);
      }
      return true;
    });
    return { inserted: run(), deliveryId };
  }

  claimNextTurn(now = Date.now()): TurnRow | undefined {
    return this.db.transaction(() => {
      const candidate = this.db.prepare(`SELECT t.id FROM turns t
        WHERE t.status='pending'
          AND NOT EXISTS (SELECT 1 FROM turns earlier WHERE earlier.issue_id=t.issue_id
            AND earlier.id<t.id AND (
              earlier.status IN ('pending','running','awaiting_activity')
              OR EXISTS (SELECT 1 FROM turn_activities a WHERE a.turn_id=earlier.id AND a.status='pending')
            ))
          AND NOT EXISTS (SELECT 1 FROM turns active WHERE active.issue_id=t.issue_id AND active.status='running')
        ORDER BY t.id LIMIT 1`).get() as { id: number } | undefined;
      if (!candidate) return undefined;
      const changed = this.db.prepare(`UPDATE turns SET status='running', attempts=attempts+1, started_at=?, error=NULL
        WHERE id=? AND status='pending'`).run(now, candidate.id);
      if (!changed.changes) return undefined;
      return this.turnById(candidate.id);
    })();
  }

  private turnById(id: number): TurnRow | undefined {
    return this.db.prepare(`SELECT t.id, t.event_id eventId, e.app, t.linear_session_id linearSessionId,
      t.issue_id issueId, t.kind, t.prompt, t.status, t.attempts, t.error, t.started_at startedAt,
      t.finished_at finishedAt, e.raw_body rawBody, e.received_at receivedAt
      FROM turns t JOIN events e ON e.id=t.event_id WHERE t.id=?`).get(id) as TurnRow | undefined;
  }

  setTurnPrompt(turnId: number, prompt: string): void { this.db.prepare("UPDATE turns SET prompt=? WHERE id=?").run(prompt, turnId); }
  getSession(linearSessionId: string): SessionRow | undefined {
    return this.db.prepare(`SELECT linear_session_id linearSessionId, app, issue_id issueId,
      issue_identifier issueIdentifier, worktree_path worktreePath, branch, claude_session_id claudeSessionId,
      mode, status, last_seen_at lastSeenAt FROM sessions WHERE linear_session_id=?`).get(linearSessionId) as SessionRow | undefined;
  }
  updateSessionWorktree(linearSessionId: string, path: string, branch: string, now = Date.now()): void {
    this.db.prepare(`UPDATE sessions SET worktree_path=?, branch=?, last_seen_at=? WHERE linear_session_id=?`)
      .run(path, branch, now, linearSessionId);
  }
  updateClaudeSessionId(linearSessionId: string, id: string, now = Date.now()): void {
    this.db.prepare(`UPDATE sessions SET claude_session_id=?, last_seen_at=? WHERE linear_session_id=?`).run(id, now, linearSessionId);
  }
  touchSession(linearSessionId: string, now = Date.now()): void {
    this.db.prepare("UPDATE sessions SET last_seen_at=? WHERE linear_session_id=?").run(now, linearSessionId);
  }
  finishTurn(turnId: number, kind: "response" | "error", body: string, now = Date.now(), activityId = randomUUID(), progressBarrier = false): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO turn_activities
        (turn_id, kind, activity_id, body, status, next_attempt_at, created_at, progress_barrier)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(turnId, kind, activityId, body, now, now, progressBarrier ? 1 : 0);
      this.db.prepare("UPDATE turns SET status='awaiting_activity', error=?, finished_at=? WHERE id=?")
        .run(kind === "error" ? body : null, now, turnId);
    })();
  }
  clearTurnProgressBarrier(turnId: number): void {
    this.db.prepare("UPDATE turn_activities SET progress_barrier=0 WHERE turn_id=?").run(turnId);
  }
  interruptStaleRunning(now = Date.now()): number[] {
    return this.db.transaction(() => {
      this.db.prepare("UPDATE turn_activities SET progress_barrier=0 WHERE progress_barrier=1").run();
      const rows = this.db.prepare("SELECT id FROM turns WHERE status='running'").all() as Array<{ id: number }>;
      for (const row of rows) {
        this.db.prepare("UPDATE turns SET status='interrupted', error='daemon restarted during turn', finished_at=? WHERE id=?").run(now, row.id);
        this.db.prepare(`INSERT OR IGNORE INTO turn_activities
          (turn_id, kind, activity_id, body, status, next_attempt_at, created_at, progress_barrier)
          VALUES (?, 'error', ?, ?, 'pending', ?, ?, 0)`)
          .run(row.id, randomUUID(), "The planner session was interrupted by a daemon restart. Please prompt again to continue.", now, now);
      }
      return rows.map(row => row.id);
    })();
  }
  pendingTurnActivities(now = Date.now(), _retryWindowMs = 30 * 60_000): TurnActivityRow[] {
    return this.db.prepare(`SELECT a.turn_id turnId, e.app, t.linear_session_id linearSessionId, a.kind,
      a.activity_id activityId, a.body, a.status, a.attempts, a.next_attempt_at nextAttemptAt, e.received_at receivedAt
      , a.created_at createdAt, a.progress_barrier progressBarrier
      FROM turn_activities a JOIN turns t ON t.id=a.turn_id JOIN events e ON e.id=t.event_id
      WHERE a.status='pending' AND a.progress_barrier=0 AND a.next_attempt_at<=?
      ORDER BY a.next_attempt_at, a.turn_id`).all(now) as TurnActivityRow[];
  }
  markTurnActivityPosted(turnId: number, now = Date.now()): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT kind FROM turn_activities WHERE turn_id=?").get(turnId) as { kind: "response" | "error" };
      this.db.prepare("UPDATE turn_activities SET status='posted', attempts=attempts+1 WHERE turn_id=?").run(turnId);
      this.db.prepare(`UPDATE turns SET status=CASE
          WHEN status='interrupted' THEN 'interrupted'
          ELSE ?
        END, finished_at=? WHERE id=?`)
        .run(row.kind === "response" ? "done" : "failed", now, turnId);
    })();
  }
  markTurnActivityRetry(turnId: number, nextAttemptAt: number): void {
    this.db.prepare("UPDATE turn_activities SET attempts=attempts+1, next_attempt_at=? WHERE turn_id=?").run(nextAttemptAt, turnId);
  }
  markTurnActivityFailed(turnId: number, error: string, now = Date.now()): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE turn_activities SET status='failed', attempts=attempts+1 WHERE turn_id=?").run(turnId);
      this.db.prepare(`UPDATE turns SET status=CASE
          WHEN status='interrupted' THEN 'interrupted'
          ELSE 'failed'
        END, error=?, finished_at=? WHERE id=?`).run(error, now, turnId);
    })();
  }
  turnStates(): Array<{ id: number; status: string; issueId: string; prompt: string | null }> {
    return this.db.prepare("SELECT id, status, issue_id issueId, prompt FROM turns ORDER BY id").all() as Array<{ id: number; status: string; issueId: string; prompt: string | null }>;
  }

  pendingAcks(now = Date.now(), retryWindowMs = 30 * 60_000): AckRow[] {
    return this.db.prepare(`SELECT a.event_id eventId, e.app, e.agent_session_id agentSessionId,
      a.activity_id activityId, a.status, a.attempts, a.last_error lastError,
      a.failure_kind failureKind, a.next_attempt_at nextAttemptAt,
      a.deadline_at deadlineAt, e.received_at receivedAt
      FROM acks a JOIN events e ON e.id = a.event_id
      WHERE (a.status = 'pending' AND a.next_attempt_at <= ?)
        OR (a.status = 'failed' AND a.failure_kind = 'retriable' AND a.next_attempt_at <= ? AND e.received_at + ? > ?)
      ORDER BY a.next_attempt_at, e.received_at`).all(now, now, retryWindowMs, now) as AckRow[];
  }

  markAcked(eventId: number): void {
    this.db.prepare(`UPDATE acks
      SET status='acked', attempts=attempts+1, last_error=NULL, failure_kind=NULL, next_attempt_at=0
      WHERE event_id=?`).run(eventId);
  }

  markRetriableFailure(eventId: number, error: string, nextAttemptAt: number, status: "pending" | "failed"): void {
    this.db.prepare(`UPDATE acks
      SET status=?, attempts=attempts+1, last_error=?, failure_kind='retriable', next_attempt_at=?
      WHERE event_id=?`).run(status, error, nextAttemptAt, eventId);
  }

  markTerminalFailure(eventId: number, error: string): void {
    this.db.prepare(`UPDATE acks
      SET status='failed', attempts=attempts+1, last_error=?, failure_kind='terminal', next_attempt_at=0
      WHERE event_id=?`).run(error, eventId);
  }

  getToken(app: AppName): StoredToken | undefined {
    return this.db.prepare("SELECT access_token accessToken, expires_at expiresAt FROM tokens WHERE app=?")
      .get(app) as StoredToken | undefined;
  }

  putToken(app: AppName, token: StoredToken): void {
    this.db.prepare(`INSERT INTO tokens (app, access_token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(app) DO UPDATE SET access_token=excluded.access_token, expires_at=excluded.expires_at`)
      .run(app, token.accessToken, token.expiresAt);
  }

  invalidateToken(app: AppName): void { this.db.prepare("DELETE FROM tokens WHERE app=?").run(app); }
  count(): number { return (this.db.prepare("SELECT count(*) count FROM events").get() as { count: number }).count; }
  ackCount(): number { return (this.db.prepare("SELECT count(*) count FROM acks").get() as { count: number }).count; }
  ackStates(): AckState[] {
    return this.db.prepare(`SELECT event_id eventId, activity_id activityId, status, attempts,
      last_error lastError, failure_kind failureKind, next_attempt_at nextAttemptAt
      FROM acks ORDER BY event_id`).all() as AckState[];
  }
  close(): void { this.db.close(); }
}
