import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { writeConsoleConfigSnapshot } from "../src/console-config-snapshot.js";
import { ConsoleOperationBroker } from "../src/console-operation-broker.js";
import { ConsoleOperationExecutor } from "../src/console-operation-executor.js";
import { canonicalJson, requestDigest, type ConsoleOperationRequest } from "../src/console-operation-schema.js";
import { EventLog } from "../src/eventlog.js";
import { treeSnapshot } from "./operations-fixtures.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture(fault?: (stage: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "console-broker-")); dirs.push(dir); const env = join(dir, "env");
  writeFileSync(env, "PLANNER_HARNESS=claude\nIMPLEMENTER_HARNESS=claude\nLINEAR_API_KEY='CURRENT_SECRET'\n");
  const snapshot = join(dir, "snapshot.json"); await writeConsoleConfigSnapshot(env, snapshot, 1000);
  const db = join(dir, "events.db"); const log = new EventLog(db); const spool = join(dir, "spool"); mkdirSync(spool, { mode: 0o700 });
  const notification = { count: 0 }; const process = { count: 0 };
  return { dir, env, snapshot, db, log, spool, notification, process,
    broker: new ConsoleOperationBroker({ log, spoolDir: spool, snapshotPath: snapshot,
      draftTtlMs: 5000, snapshotMaxAgeMs: 5000, now: () => 2000, notify: () => { notification.count += 1; }, fault }) };
}
describe("console operation broker", () => {
  it("keeps drafts side-effect free, redacts secrets, and confirms exactly once", async () => {
    const { dir, env, snapshot, db, log, spool, broker, notification, process } = await fixture();
    const before = treeSnapshot([env, snapshot, db, spool]); const envBytes = readFileSync(env); const envMode = statSync(env).mode & 0o777;
    expect((await broker.configuration()).secrets.LINEAR_API_KEY).toEqual({ configured: true });
    const draft = await broker.draft({ kind: "config.apply", reason: "rotate", changes: { plannerHarness: "claudex",
      mcpEnvPassthrough: ["ZED_ENV", "ALPHA_ENV"], ntfyUrl: "https://ntfy.sh/topic" },
      secrets: { LINEAR_API_KEY: "NEW_SECRET_SENTINEL" } });
    expect(draft).toMatchObject({ before: { plannerHarness: "claude", mcpEnvPassthrough: [], ntfyUrl: null },
      after: { plannerHarness: "claudex", mcpEnvPassthrough: ["ALPHA_ENV", "ZED_ENV"], ntfyUrl: "https://ntfy.sh/topic" },
      secrets: { LINEAR_API_KEY: "Will rotate" }, restartRequired: true });
    expect(JSON.stringify(draft)).not.toContain("NEW_SECRET_SENTINEL"); expect(log.activeOperation()).toBeUndefined();
    expect(treeSnapshot([env, snapshot, db, spool])).toBe(before); expect(readFileSync(env)).toEqual(envBytes);
    expect(statSync(env).mode & 0o777).toBe(envMode); expect(notification.count).toBe(0); expect(process.count).toBe(0);
    expect(readdirSync(spool)).toEqual([]); expect(treeSnapshot([dir])).not.toContain("NEW_SECRET_SENTINEL");
    const confirmations = await Promise.all([
      broker.confirm({ draftId: draft.id, digest: draft.digest, reason: draft.reason }),
      broker.confirm({ draftId: draft.id, digest: draft.digest, reason: draft.reason }),
    ]);
    const first = confirmations[0]!;
    expect(confirmations.filter(result => result.deduplicated)).toHaveLength(1);
    expect(confirmations[1]!.operation.id).toBe(first.operation.id);
    expect(readdirSync(join(spool, "ready"))).toEqual([`${first.operation.id}.json`]);
    const artifact = readFileSync(join(spool, "ready", `${first.operation.id}.json`), "utf8");
    expect(artifact).toContain("NEW_SECRET_SENTINEL"); expect(notification.count).toBe(1); expect(process.count).toBe(0);
    expect(JSON.stringify(log.listOperations())).not.toContain("NEW_SECRET_SENTINEL");
    log.close();
  });

  it("acknowledges cancel before an executing artifact can resume", async () => {
    const { log, spool, broker, notification } = await fixture(); await broker.reconcile();
    const request: ConsoleOperationRequest = { version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" };
    const digest = requestDigest(request); const id = "cancel-target";
    log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "run", actor: "local-console", requestKind: request.kind });
    log.claimOperation(id, digest); writeFileSync(join(spool, "executing", `${id}.json`), `${canonicalJson(request)}\n`, { mode: 0o600 });
    const target = log.operationById(id)!; const created = await broker.control({ kind: "operation.cancel", targetOperationId: id,
      targetDigest: digest, expectedVersion: target.stateVersion, reason: "stop safely" });
    let processCalls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
      argv: ["internal-console-execute"], run: async () => { processCalls += 1; } }).run();
    expect(processCalls).toBe(0); expect(notification.count).toBe(1);
    expect(log.operationById(id)).toMatchObject({ state: "cancelled", cancelRequested: 1 });
    expect(log.operationControlById(created.control.id)).toMatchObject({ state: "succeeded", outcome: "acknowledged" });
    expect(readdirSync(join(spool, "controls"))).toEqual([]); expect(readdirSync(join(spool, "executing"))).toEqual([]);
    log.close();
  });

  it("acknowledges a failed retry before promoting and executing its retained digest-bound request once", async () => {
    const { log, spool, broker, notification } = await fixture(); await broker.reconcile();
    const request: ConsoleOperationRequest = { version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" };
    const digest = requestDigest(request); const id = "retry-target";
    log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "run", actor: "local-console", requestKind: request.kind });
    log.claimOperation(id, digest); log.transitionOperation(id, "failed", "health", { errorStage: "health", outcome: "not accepted" });
    writeFileSync(join(spool, "executing", `${id}.json`), `${canonicalJson(request)}\n`, { mode: 0o600 });
    const target = log.operationById(id)!; const created = await broker.control({ kind: "operation.retry", targetOperationId: id,
      targetDigest: digest, expectedVersion: target.stateVersion, reason: "retry safely" });
    let processCalls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
      argv: ["internal-console-execute"], run: async () => { processCalls += 1; } }).run();
    expect(processCalls).toBe(1); expect(notification.count).toBe(1);
    expect(log.operationById(id)).toMatchObject({ state: "executing", attempts: 2 });
    expect(log.operationControlById(created.control.id)).toMatchObject({ state: "succeeded", outcome: "acknowledged" });
    expect(log.listOperations()).toHaveLength(1); expect(readdirSync(join(spool, "controls"))).toEqual([]);
    log.close();
  });

  it("does not resume a retained failed request without an acknowledged retry control", async () => {
    const { log, spool, broker } = await fixture(); await broker.reconcile();
    const request: ConsoleOperationRequest = { version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" };
    const digest = requestDigest(request); const id = "failed-without-retry";
    log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "run", actor: "local-console", requestKind: request.kind });
    log.claimOperation(id, digest); log.transitionOperation(id, "failed", "health", { errorStage: "health" });
    writeFileSync(join(spool, "executing", `${id}.json`), `${canonicalJson(request)}\n`, { mode: 0o600 });
    let processCalls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
      argv: ["internal-console-execute"], run: async () => { processCalls += 1; } }).run();
    expect(processCalls).toBe(0); expect(log.operationById(id)).toMatchObject({ state: "failed", attempts: 1 });
    expect(readdirSync(join(spool, "executing"))).toEqual([`${id}.json`]); expect(log.listOperationControls()).toEqual([]); log.close();
  });

  it("acknowledges a blocked retry by durably publishing only a non-secret rollback trigger", async () => {
    const { log, spool, broker, notification } = await fixture(); await broker.reconcile(); const id = "rollback-target"; const digest = "a".repeat(64);
    log.scheduleOperation({ id, requestDigest: digest, type: "config", reason: "run", actor: "local-console", requestKind: "config.apply" });
    log.claimOperation(id, digest); log.transitionOperation(id, "blocked", "rollback_acceptance", { mutated: true, errorStage: "rollback_acceptance" });
    const target = log.operationById(id)!; const created = await broker.control({ kind: "operation.retry", targetOperationId: id,
      targetDigest: digest, expectedVersion: target.stateVersion, reason: "retry rollback" });
    let processCalls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
      argv: ["internal-console-execute"], run: async () => { processCalls += 1; } }).run();
    expect(processCalls).toBe(1); expect(notification.count).toBe(1); expect(log.listOperations()).toHaveLength(1);
    expect(log.operationById(id)).toMatchObject({ state: "rolling_back", mutated: 1 });
    expect(log.operationControlById(created.control.id)).toMatchObject({ state: "succeeded", outcome: "acknowledged" });
    expect(JSON.parse(readFileSync(join(spool, "rollback", `${id}.json`), "utf8"))).toEqual({ digest, operationId: id });
    log.close();
  });

  it.each(["retry.after_staged", "retry.after_acknowledged", "retry.after_promoted"])(
    "recovers a failed retry crash at %s without execution before durable control acknowledgement", async boundary => {
      const { log, spool, broker } = await fixture(); await broker.reconcile();
      const request: ConsoleOperationRequest = { version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" };
      const digest = requestDigest(request); const id = `retry-crash-${boundary.split(".").at(-1)!.replaceAll("_", "-")}`;
      log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "run", actor: "local-console", requestKind: request.kind });
      log.claimOperation(id, digest); log.transitionOperation(id, "failed", "health", { errorStage: "health" });
      writeFileSync(join(spool, "executing", `${id}.json`), `${canonicalJson(request)}\n`, { mode: 0o600 });
      const target = log.operationById(id)!; const created = await broker.control({ kind: "operation.retry", targetOperationId: id,
        targetDigest: digest, expectedVersion: target.stateVersion, reason: "retry after crash" });
      let processCalls = 0;
      await expect(new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl", argv: ["internal-console-execute"],
        run: async () => { processCalls += 1; }, fault: stage => { if (stage === boundary) throw new Error("fixture crash"); } }).run()).rejects.toThrow("fixture crash");
      expect(processCalls).toBe(0);
      if (boundary === "retry.after_staged") {
        expect(log.operationById(id)).toMatchObject({ state: "failed", stateVersion: target.stateVersion });
        expect(log.operationControlById(created.control.id)).toMatchObject({ state: "executing" });
      } else {
        expect(log.operationById(id)).toMatchObject({ state: "pending", stateVersion: target.stateVersion + 1 });
        expect(log.operationControlById(created.control.id)).toMatchObject({ state: "succeeded", outcome: "acknowledged" });
      }
      await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl", argv: ["internal-console-execute"],
        run: async () => { expect(log.operationControlById(created.control.id)?.state).toBe("succeeded"); processCalls += 1; } }).run();
      expect(processCalls).toBe(1); expect(log.operationControlById(created.control.id)).toMatchObject({ state: "succeeded" });
      expect(log.operationById(id)).toMatchObject({ state: "executing", attempts: 2 });
      expect(readdirSync(join(spool, "controls"))).toEqual([]); log.close();
    });

  it.each(["rollback.after_trigger", "rollback.after_acknowledged"])(
    "replays a matching rollback trigger after a crash at %s without rejecting its control", async boundary => {
      const { log, spool, broker } = await fixture(); await broker.reconcile();
      const id = `rollback-crash-${boundary.split(".").at(-1)!.replaceAll("_", "-")}`; const digest = "c".repeat(64);
      log.scheduleOperation({ id, requestDigest: digest, type: "config", reason: "run", actor: "local-console", requestKind: "config.apply" });
      log.claimOperation(id, digest); log.transitionOperation(id, "blocked", "rollback_acceptance", { mutated: true, errorStage: "rollback_acceptance" });
      const target = log.operationById(id)!; const created = await broker.control({ kind: "operation.retry", targetOperationId: id,
        targetDigest: digest, expectedVersion: target.stateVersion, reason: "retry rollback" }); let processCalls = 0;
      await expect(new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl", argv: ["internal-console-execute"],
        run: async () => { processCalls += 1; }, fault: stage => { if (stage === boundary) throw new Error("fixture crash"); } }).run()).rejects.toThrow("fixture crash");
      expect(processCalls).toBe(0); expect(readdirSync(join(spool, "rollback"))).toEqual([`${id}.json`]);
      expect(log.operationControlById(created.control.id)?.state).not.toBe("rejected");
      await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl", argv: ["internal-console-execute"],
        run: async () => { expect(log.operationControlById(created.control.id)?.state).toBe("succeeded"); processCalls += 1; } }).run();
      expect(processCalls).toBe(1); expect(log.operationById(id)).toMatchObject({ state: "rolling_back" });
      expect(log.operationControlById(created.control.id)).toMatchObject({ state: "succeeded", outcome: "acknowledged" }); log.close();
    });

  it("rejects and removes a mismatched rollback trigger without executing rollback", async () => {
    const { log, spool, broker } = await fixture(); await broker.reconcile(); const id = "rollback-trigger-mismatch"; const digest = "9".repeat(64);
    log.scheduleOperation({ id, requestDigest: digest, type: "config", reason: "run", actor: "local-console", requestKind: "config.apply" });
    log.claimOperation(id, digest); log.transitionOperation(id, "blocked", "rollback_acceptance", { mutated: true, errorStage: "rollback_acceptance" });
    const target = log.operationById(id)!; const created = await broker.control({ kind: "operation.retry", targetOperationId: id,
      targetDigest: digest, expectedVersion: target.stateVersion, reason: "retry rollback" });
    writeFileSync(join(spool, "rollback", `${id}.json`), `${canonicalJson({ operationId: id, digest: "8".repeat(64) })}\n`, { mode: 0o600 });
    let processCalls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
      argv: ["internal-console-execute"], run: async () => { processCalls += 1; } }).run();
    expect(processCalls).toBe(0); expect(log.operationControlById(created.control.id)).toMatchObject({ state: "rejected" });
    expect(log.operationById(id)).toMatchObject({ state: "blocked" }); expect(readdirSync(join(spool, "rollback"))).toEqual([]); log.close();
  });

  it("drains malformed, symlinked, mismatched, orphaned, and noneligible rollback triggers without bridging", async () => {
    const { dir, log, spool, broker } = await fixture(); await broker.reconcile();
    const terminalId = "terminal-trigger"; const terminalDigest = "1".repeat(64);
    log.scheduleOperation({ id: terminalId, requestDigest: terminalDigest, type: "config", reason: "terminal",
      actor: "local-console", requestKind: "config.apply" });
    log.transitionOperation(terminalId, "succeeded", "accepted", { outcome: "accepted" });
    writeFileSync(join(spool, "rollback", `${terminalId}.json`), `${canonicalJson({ operationId: terminalId, digest: terminalDigest })}\n`, { mode: 0o600 });
    writeFileSync(join(spool, "staged", `${terminalId}.json`), `${canonicalJson({ version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" })}\n`, { mode: 0o600 });
    const blockedId = "blocked-trigger"; const blockedDigest = "2".repeat(64);
    log.scheduleOperation({ id: blockedId, requestDigest: blockedDigest, type: "config", reason: "blocked",
      actor: "local-console", requestKind: "config.apply" });
    log.claimOperation(blockedId, blockedDigest); log.transitionOperation(blockedId, "blocked", "rollback_acceptance", { mutated: true });
    writeFileSync(join(spool, "rollback", `${blockedId}.json`), `${canonicalJson({ operationId: blockedId, digest: blockedDigest })}\n`, { mode: 0o600 });
    writeFileSync(join(spool, "executing", `${blockedId}.json`), `${canonicalJson({ version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" })}\n`, { mode: 0o600 });
    writeFileSync(join(spool, "staged", "orphan-request.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(spool, "rollback", "malformed.json"), "not json\n", { mode: 0o600 });
    writeFileSync(join(spool, "rollback", "mismatch.json"), `${canonicalJson({ operationId: "mismatch", digest: "3".repeat(64) })}\n`, { mode: 0o600 });
    writeFileSync(join(spool, "rollback", "orphan.json"), `${canonicalJson({ operationId: "orphan", digest: "4".repeat(64) })}\n`, { mode: 0o600 });
    const symlinkTarget = join(dir, "rollback-symlink-target"); writeFileSync(symlinkTarget, "must remain\n");
    symlinkSync(symlinkTarget, join(spool, "rollback", "symlink.json"));
    let processCalls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
      argv: ["internal-console-execute"], run: async () => { processCalls += 1; } }).run();
    expect(processCalls).toBe(0); expect(readdirSync(join(spool, "rollback"))).toEqual([]);
    expect(readdirSync(join(spool, "staged"))).toEqual([]); expect(readdirSync(join(spool, "executing"))).toEqual([]);
    expect(existsSync(symlinkTarget)).toBe(true); expect(readFileSync(symlinkTarget, "utf8")).toBe("must remain\n");
    expect(log.operationById(blockedId)).toMatchObject({ state: "blocked", mutated: 1 }); log.close();
  });

  it("creates a new retry generation after the retried operation fails again", async () => {
    const { log, spool, broker } = await fixture(); await broker.reconcile();
    const request: ConsoleOperationRequest = { version: 1, kind: "daemon.restart", snapshotRevision: "revision_123456789" };
    const digest = requestDigest(request); const id = "repeated-retry";
    log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "run", actor: "local-console", requestKind: request.kind });
    log.claimOperation(id, digest); log.transitionOperation(id, "failed", "health", { errorStage: "health" });
    writeFileSync(join(spool, "executing", `${id}.json`), `${canonicalJson(request)}\n`, { mode: 0o600 });
    let target = log.operationById(id)!; const first = await broker.control({ kind: "operation.retry", targetOperationId: id,
      targetDigest: digest, expectedVersion: target.stateVersion, reason: "first retry" });
    await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl", argv: ["internal-console-execute"],
      run: async () => { log.transitionOperation(id, "failed", "health", { errorStage: "health" }); throw new Error("failed again"); } }).run();
    target = log.operationById(id)!; expect(target.state).toBe("failed");
    const second = await broker.control({ kind: "operation.retry", targetOperationId: id,
      targetDigest: digest, expectedVersion: target.stateVersion, reason: "second retry" });
    expect(second.deduplicated).toBe(false); expect(second.control.id).not.toBe(first.control.id);
    let processCalls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
      argv: ["internal-console-execute"], run: async () => { processCalls += 1; } }).run();
    expect(processCalls).toBe(1); expect(log.listOperationControls().sort((a, b) => a.expectedVersion - b.expectedVersion)).toMatchObject([
      { id: first.control.id, expectedVersion: first.control.expectedVersion, state: "succeeded" },
      { id: second.control.id, expectedVersion: second.control.expectedVersion, state: "succeeded" },
    ]); log.close();
  });

  it.each(["publication.after_row:normal", "artifact.renamed:ready"])(
    "reconciles normal publication after a crash at %s", async boundary => {
      let armed = true; const { log, spool, broker } = await fixture(stage => { if (armed && stage === boundary) throw new Error("fixture crash"); });
      const draft = await broker.draft({ kind: "daemon.restart", reason: "durable publish" });
      await expect(broker.confirm({ draftId: draft.id, digest: draft.digest, reason: draft.reason })).rejects.toThrow(); armed = false;
      expect(log.listOperations()).toHaveLength(1); let calls = 0;
      await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl", argv: ["internal-console-execute"],
        run: async () => { calls += 1; } }).run();
      expect(calls).toBe(1); expect(log.listOperations()[0]).toMatchObject({ state: "executing", attempts: 1 }); log.close();
    });

  it("removes an orphan whose file was synced before its parent but no normal row was scheduled", async () => {
    let armed = true; const { log, spool, broker } = await fixture(stage => { if (armed && stage === "artifact.file_synced:staged") throw new Error("fixture crash"); });
    const draft = await broker.draft({ kind: "daemon.restart", reason: "orphan fixture" });
    await expect(broker.confirm({ draftId: draft.id, digest: draft.digest, reason: draft.reason })).rejects.toThrow(); armed = false;
    expect(log.listOperations()).toEqual([]); expect(readdirSync(join(spool, "staged"))).toHaveLength(1);
    await broker.reconcile(); expect(readdirSync(join(spool, "staged"))).toEqual([]); log.close();
  });

  it("reconciles control publication after a crash between its durable row and promotion", async () => {
    let armed = true; const { log, spool, broker } = await fixture(stage => { if (armed && stage === "publication.after_row:control") throw new Error("fixture crash"); });
    await broker.reconcile(); const id = "control-publication"; const digest = "e".repeat(64);
    log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "run", actor: "local-console", requestKind: "daemon.restart" });
    const target = log.operationById(id)!;
    await expect(broker.control({ kind: "operation.cancel", targetOperationId: id, targetDigest: digest,
      expectedVersion: target.stateVersion, reason: "cancel durably" })).rejects.toThrow(); armed = false;
    const staged = readdirSync(join(spool, "control-staged")); expect(staged).toHaveLength(1);
    rmSync(join(spool, "control-staged", staged[0]!));
    await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl", argv: ["internal-console-execute"],
      run: async () => { throw new Error("must not execute"); } }).run();
    expect(log.operationById(id)).toMatchObject({ state: "cancelled" }); expect(log.listOperationControls()).toMatchObject([{ state: "succeeded" }]);
    expect(readdirSync(join(spool, "control-staged"))).toEqual([]); expect(readdirSync(join(spool, "controls"))).toEqual([]); log.close();
  });

  it("reconstructs a newer nonterminal control hidden behind more than 256 completed history rows", async () => {
    const { db, log, spool, broker } = await fixture(); await broker.reconcile(); const id = "control-after-history"; const digest = "6".repeat(64);
    log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "run", actor: "local-console", requestKind: "daemon.restart" });
    const target = log.operationById(id)!; const created = await broker.control({ kind: "operation.cancel", targetOperationId: id,
      targetDigest: digest, expectedVersion: target.stateVersion, reason: "cancel after long history" });
    rmSync(join(spool, "controls", `${created.control.id}.json`));
    const raw = new Database(db); const insert = raw.prepare(`INSERT INTO operation_controls
      (id,digest,target_operation_id,target_digest,kind,actor,reason,expected_version,state,outcome,requested_at,updated_at)
      VALUES (?,?,?,?,?,'local-console','historical control',?,'succeeded','acknowledged',?,?)`);
    raw.transaction(() => { for (let index = 0; index < 256; index += 1) insert.run(`history-${index}`,
      (index + 1).toString(16).padStart(64, "0"), id, digest, "retry", 10_000 + index, index, index); })(); raw.close();
    expect(log.listOperationControls()).toHaveLength(256); expect(log.listOperationControls().some(row => row.id === created.control.id)).toBe(false);
    expect(log.nonterminalOperationControls()).toMatchObject([{ id: created.control.id, digest: created.control.digest,
      expectedVersion: target.stateVersion, state: "pending" }]);
    let processCalls = 0; await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
      argv: ["internal-console-execute"], run: async () => { processCalls += 1; } }).run();
    expect(processCalls).toBe(0); expect(log.operationById(id)).toMatchObject({ state: "cancelled", cancelRequested: 1 });
    expect(log.operationControlById(created.control.id)).toMatchObject({ state: "succeeded", outcome: "acknowledged" });
    expect(readdirSync(join(spool, "controls"))).toEqual([]);

    const rejectedTarget = "control-after-history-bad"; const rejectedDigest = "5".repeat(64);
    log.scheduleOperation({ id: rejectedTarget, requestDigest: rejectedDigest, type: "restart", reason: "run",
      actor: "local-console", requestKind: "daemon.restart" });
    const corrupt = new Database(db); corrupt.prepare(`INSERT INTO operation_controls
      (id,digest,target_operation_id,target_digest,kind,actor,reason,expected_version,state,requested_at,updated_at)
      VALUES ('history-corrupt','${"f".repeat(64)}',? ,?,'cancel','local-console','reject bad digest',0,'pending',3000,3000)`)
      .run(rejectedTarget, rejectedDigest); corrupt.close();
    await new ConsoleOperationExecutor({ log, spoolDir: spool, executable: "/fixed/daemonctl",
      argv: ["internal-console-execute"], run: async () => { processCalls += 1; } }).run();
    expect(processCalls).toBe(0); expect(log.operationControlById("history-corrupt")).toMatchObject({ state: "rejected", outcome: "control digest mismatch" });
    expect(log.operationById(rejectedTarget)).toMatchObject({ state: "pending", stateVersion: 0, cancelRequested: 0 });
    expect(readdirSync(join(spool, "controls"))).toEqual([]); log.close();
  });

  it("crosses file, parent, rename, and both-directory durability seams for normal and control publication", async () => {
    const normalStages: string[] = []; const normal = await fixture(stage => { normalStages.push(stage); });
    const draft = await normal.broker.draft({ kind: "daemon.restart", reason: "durability instrumentation" });
    await normal.broker.confirm({ draftId: draft.id, digest: draft.digest, reason: draft.reason });
    expect(normalStages).toEqual(expect.arrayContaining(["artifact.file_synced:staged", "artifact.parent_synced:staged",
      "publication.after_row:normal", "artifact.renamed:ready", "artifact.directories_synced:ready"])); normal.log.close();

    const controlStages: string[] = []; const control = await fixture(stage => { controlStages.push(stage); }); await control.broker.reconcile();
    const id = "control-durability"; const digest = "7".repeat(64);
    control.log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "run", actor: "local-console", requestKind: "daemon.restart" });
    const target = control.log.operationById(id)!; await control.broker.control({ kind: "operation.cancel", targetOperationId: id,
      targetDigest: digest, expectedVersion: target.stateVersion, reason: "durable cancel" });
    expect(controlStages).toEqual(expect.arrayContaining(["artifact.file_synced:control-staged", "artifact.parent_synced:control-staged",
      "publication.after_row:control", "artifact.renamed:controls", "artifact.directories_synced:controls"])); control.log.close();
  });

  it.each([
    ["retry", "pending", false, false], ["retry", "executing", false, false], ["retry", "cancelled", false, false],
    ["retry", "succeeded", false, false], ["cancel", "failed", false, false], ["cancel", "blocked", false, false],
    ["cancel", "cancelled", false, false], ["cancel", "succeeded", false, false], ["cancel", "pending", true, false],
    ["cancel", "pending", false, true],
  ] as const)("rejects %s against %s (staleVersion=%s wrongDigest=%s) without target, database, artifact, or callback mutation",
    async (kind, state, staleVersion, wrongDigest) => {
      const { db, log, spool, broker, notification } = await fixture(); await broker.reconcile();
      const digest = "d".repeat(64); const id = `target-${kind}-${state}-${staleVersion}-${wrongDigest}`;
      log.scheduleOperation({ id, requestDigest: digest, type: "restart", reason: "run", actor: "local-console", requestKind: "daemon.restart" });
      if (state === "executing" || state === "failed" || state === "blocked") log.claimOperation(id, digest);
      if (state === "failed") log.transitionOperation(id, "failed", "health", { errorStage: "health" });
      if (state === "blocked") log.transitionOperation(id, "blocked", "rollback_acceptance", { mutated: true, errorStage: "rollback_acceptance" });
      if (state === "cancelled") log.cancelOperation(id);
      if (state === "succeeded") log.transitionOperation(id, "succeeded", "accepted", { outcome: "accepted" });
      const target = log.operationById(id)!; const beforeTree = treeSnapshot([db, spool]);
      await expect(broker.control({ kind: `operation.${kind}`, targetOperationId: id,
        targetDigest: wrongDigest ? "e".repeat(64) : digest, expectedVersion: staleVersion ? target.stateVersion + 1 : target.stateVersion,
        reason: "rejected race" })).rejects.toThrow();
      expect(log.operationById(id)).toEqual(target); expect(treeSnapshot([db, spool])).toBe(beforeTree);
      expect(log.listOperationControls()).toEqual([]); expect(notification.count).toBe(0); log.close();
    });
});
