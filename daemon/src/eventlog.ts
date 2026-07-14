import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { AppName } from "./config.js";

export interface AppendEvent {
  deliveryId?: string | undefined;
  app: AppName;
  action?: string | undefined;
  agentSessionId?: string | undefined;
  issueId?: string | undefined;
  webhookId?: string | undefined;
  receivedAt: number;
  rawBody: Buffer;
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
    `);
    this.migrateAckColumns();
  }

  private migrateAckColumns(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(acks)").all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has("failure_kind")) this.db.prepare("ALTER TABLE acks ADD COLUMN failure_kind TEXT CHECK(failure_kind IS NULL OR failure_kind IN ('retriable','terminal'))").run();
    if (!columns.has("next_attempt_at")) this.db.prepare("ALTER TABLE acks ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0").run();
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
      return true;
    });
    return { inserted: run(), deliveryId };
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
