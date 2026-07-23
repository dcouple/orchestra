import { createHash } from "node:crypto";
import Database from "better-sqlite3";

function boundedToolUseId(toolUseId: string): string {
  const normalized = toolUseId.trim();
  if (!normalized) throw new Error("tool use id must not be empty");
  return normalized.length <= 240
    ? normalized
    : `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

export class ToolBoundaryStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path, { fileMustExist: true });
    this.db.pragma("busy_timeout = 5000");
  }

  recordOpen(
    turnId: number,
    toolUseId: string,
    toolName: string,
    now = Date.now(),
  ): void {
    const id = boundedToolUseId(toolUseId);
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

  recordComplete(
    turnId: number,
    toolUseId: string,
    now = Date.now(),
  ): void {
    const id = boundedToolUseId(toolUseId);
    const changed = this.db
      .prepare(
        `UPDATE turn_tool_calls SET state='completed',completed_at=?
      WHERE turn_id=? AND tool_use_id=? AND state='open'`,
      )
      .run(now, turnId, id);
    if (changed.changes === 1) return;
    const existing = this.db
      .prepare(
        `SELECT state FROM turn_tool_calls
      WHERE turn_id=? AND tool_use_id=?`,
      )
      .get(turnId, id) as { state: "open" | "completed" } | undefined;
    if (existing?.state !== "completed")
      throw new Error("tool call completion has no durable open record");
  }

  close(): void {
    this.db.close();
  }
}
