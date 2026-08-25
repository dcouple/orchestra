import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// references/linear-agent-sessions.md is the consumer-facing contract for what
// daemon sessions look like from inside Linear. The strings and defaults it
// quotes are daemon internals; this test fails when either side moves without
// the other, so the contract cannot silently drift.

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8");

const contract = read("../../references/linear-agent-sessions.md");
const sessions = read("../src/sessions.ts");
const eventlog = read("../src/eventlog.ts");
const linear = read("../src/linear.ts");
const config = read("../src/config.ts");
const reconcile = read("../src/reconcile.ts");

describe("references/linear-agent-sessions.md matches the daemon", () => {
  it("quotes the turn-failure prefixes exactly as sessions.ts builds them", () => {
    expect(sessions).toContain('${implementer ? "Implementer" : "Planner"} turn failed: ${detail}');
    expect(contract).toContain("`Planner turn failed: <detail>`");
    expect(contract).toContain("`Implementer turn failed: <detail>`");
  });

  it("quotes the stop acknowledgement exactly", () => {
    const stopAck = "Stopped at your request. Send a follow-up message to continue.";
    expect(eventlog).toContain(`"${stopAck}"`);
    expect(contract).toContain(`\`${stopAck}\``);
  });

  it("quotes the empty-reply defect prefix exactly", () => {
    const prefix = "Turn completed without reply text — ";
    expect(sessions).toContain(prefix);
    expect(contract).toContain(`\`${prefix}\``);
  });

  it("describes the pickup ack as ephemeral, matching linear.ts", () => {
    expect(linear).toMatch(/picked up — starting work" \}, true, deadlineAt\)/);
    expect(contract).toMatch(/the pickup ack[\s\S]{0,200}posted ephemeral/);
  });

  it("states the keepalive default that config.ts sets", () => {
    expect(config).toMatch(/"KEEPALIVE_MS",\s*900_000\)/);
    expect(contract).toContain("`KEEPALIVE_MS` (default 15 minutes)");
  });

  it("states that only planner prompts are replayed by reconciliation", () => {
    expect(reconcile).toContain('listSessionActivitiesSince("planner"');
    expect(contract).toContain("Implementer replies sent while the daemon is down are lost");
  });

  it("states the per-issue serialization and global cap that eventlog.ts and sessions.ts enforce", () => {
    expect(eventlog).toContain("AND NOT EXISTS (SELECT 1 FROM turns active WHERE active.issue_id=t.issue_id AND active.status='running')");
    expect(sessions).toContain("this.active.size < this.config.sessionConcurrency");
    expect(contract).toContain("two turns on the same issue never overlap");
    expect(contract).toContain("`SESSION_CONCURRENCY` turns at once");
  });

  it("names the restart-recovery notices' shared stem that eventlog.ts posts as durable errors", () => {
    expect(eventlog).toContain("The run was interrupted by an explicit hard restart");
    expect(eventlog).toContain("The implementation run was interrupted before a resumable Claude session was saved");
    expect(eventlog).toContain("The planner session was interrupted before a resumable Claude session was saved");
    expect(contract).toContain("`was interrupted`");
  });

  it("states the reconcile window and the operation types the daemon defines", () => {
    expect(config).toMatch(/"RECONCILE_SESSION_MAX_AGE_MS",\s*6 \* 60 \* 60_000\)/);
    expect(contract).toContain("roughly the last six hours");
    expect(read("../src/operations.ts")).toMatch(/\["restart", "config", "update"\]/);
    expect(contract).toContain("(restart, config, update)");
  });

  it("states that a stop interrupts every pending turn of the session", () => {
    expect(eventlog).toMatch(/UPDATE turns SET status='interrupted', error='stopped by user'[\s\S]{0,80}WHERE linear_session_id=\? AND status='pending'/);
    expect(contract).toContain("marks every pending");
  });
});
