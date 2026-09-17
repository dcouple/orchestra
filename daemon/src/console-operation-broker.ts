import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { EventLog } from "./eventlog.js";
import { projectConsoleConfigSnapshot, readConsoleConfigSnapshot, type SafeConsoleConfigSnapshot } from "./console-config-snapshot.js";
import { canonicalJson, newOpaqueId, redactedSummary, requestDigest, validateDraftInput, validateReason,
  type ConsoleControlRequest, type ConsoleOperationRequest, type ConsoleSecretName } from "./console-operation-schema.js";
import type { OperationControlRow, OperationRow } from "./operations.js";

export interface ConsoleDraftPreview {
  id: string; kind: ConsoleOperationRequest["kind"]; digest: string; reason: string; snapshotRevision: string;
  expiresAt: number; changedFields: string[]; before: Record<string, unknown>; after: Record<string, unknown>;
  secrets: Partial<Record<ConsoleSecretName, "Will add" | "Will rotate">>; restartRequired: boolean;
}
interface StoredDraft { preview: ConsoleDraftPreview; request: ConsoleOperationRequest; consumed?: OperationRow }
class BrokerCrashError extends Error {}

export class ConsoleBrokerError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = "ConsoleBrokerError"; }
}

export interface ConsoleOperationBrokerOptions {
  log: EventLog; spoolDir: string; snapshotPath: string; draftTtlMs: number; snapshotMaxAgeMs: number;
  now?: () => number; notify?: () => void | Promise<void>; fault?: (stage: string) => void | Promise<void>;
}

export class ConsoleOperationBroker {
  private readonly drafts = new Map<string, StoredDraft>();
  private readonly now: () => number;
  constructor(private readonly options: ConsoleOperationBrokerOptions) { this.now = options.now ?? Date.now; }

  async configuration(): Promise<SafeConsoleConfigSnapshot> {
    const snapshot = await readConsoleConfigSnapshot(this.options.snapshotPath, this.options.snapshotMaxAgeMs, this.now());
    return projectConsoleConfigSnapshot(snapshot, this.options.snapshotMaxAgeMs);
  }

  async draft(value: unknown): Promise<ConsoleDraftPreview> {
    const input = validateDraftInput(value); const snapshot = await this.configuration(); const now = this.now();
    const request: ConsoleOperationRequest = input.kind === "config.apply"
      ? { version: 1, kind: input.kind, snapshotRevision: snapshot.revision, changes: input.changes, secrets: input.secrets }
      : { version: 1, kind: input.kind, snapshotRevision: snapshot.revision };
    const changedFields = input.kind === "config.apply" ? Object.keys(input.changes).sort() : [];
    const before = Object.fromEntries(changedFields.map(key => [key, snapshot.settings[key as keyof typeof snapshot.settings]]));
    const after = input.kind === "config.apply" ? { ...input.changes } : {};
    const secrets = input.kind === "config.apply" ? Object.fromEntries(Object.keys(input.secrets).map(name =>
      [name, snapshot.secrets[name as ConsoleSecretName].configured ? "Will rotate" : "Will add"])) as ConsoleDraftPreview["secrets"] : {};
    const preview: ConsoleDraftPreview = { id: newOpaqueId(), kind: request.kind, digest: requestDigest(request),
      reason: input.reason, snapshotRevision: snapshot.revision, expiresAt: now + this.options.draftTtlMs,
      changedFields, before, after, secrets, restartRequired: request.kind !== "daemon.reload" };
    this.drafts.set(preview.id, { preview, request }); this.expire(now); return preview;
  }

  async confirm(value: unknown): Promise<{ operation: OperationRow; deduplicated: boolean }> {
    const row = exact(value, ["draftId", "digest", "reason"]);
    const draftId = string(row.draftId, "invalid_draft"); const digest = string(row.digest, "invalid_digest");
    const reason = validateReason(row.reason); const draft = this.drafts.get(draftId); const now = this.now();
    if (!draft) throw new ConsoleBrokerError("draft_not_found", 404);
    if (draft.consumed) return { operation: draft.consumed, deduplicated: true };
    if (draft.preview.expiresAt < now) { this.drafts.delete(draftId); throw new ConsoleBrokerError("draft_expired", 409); }
    if (digest !== draft.preview.digest || reason !== draft.preview.reason) throw new ConsoleBrokerError("confirmation_mismatch", 409);
    const snapshot = await this.configuration();
    if (snapshot.revision !== draft.preview.snapshotRevision) throw new ConsoleBrokerError("snapshot_changed", 409);
    const id = newOpaqueId(); const staged = await this.writeArtifact("staged", id, draft.request);
    try {
      const scheduled = this.options.log.scheduleOperation({ id, requestDigest: draft.preview.digest,
        type: operationType(draft.request.kind), reason, actor: "local-console", requestKind: draft.request.kind,
        requestSummary: canonicalJson(redactedSummary(draft.request)), requestedAt: now });
      await this.checkpoint("publication.after_row:normal");
      if (scheduled.deduplicated && scheduled.operation.requestDigest !== draft.preview.digest)
        throw new ConsoleBrokerError("operation_active", 409);
      if (scheduled.deduplicated) {
        await this.unlinkArtifact(staged); draft.consumed = scheduled.operation;
        return { operation: scheduled.operation, deduplicated: true };
      }
      await this.promote(staged, "ready", id); draft.consumed = scheduled.operation;
      await this.options.notify?.(); return scheduled;
    } catch (error) { if (!(error instanceof BrokerCrashError)) await this.unlinkArtifact(staged).catch(() => undefined); throw error; }
  }

  async control(value: unknown): Promise<{ control: OperationControlRow; deduplicated: boolean }> {
    const row = exact(value, ["kind", "targetOperationId", "targetDigest", "expectedVersion", "reason"]);
    if (row.kind !== "operation.retry" && row.kind !== "operation.cancel") throw new ConsoleBrokerError("unsupported_kind", 400);
    const request: ConsoleControlRequest = { version: 1, kind: row.kind,
      targetOperationId: string(row.targetOperationId, "invalid_target"), targetDigest: string(row.targetDigest, "invalid_digest"),
      expectedVersion: number(row.expectedVersion, "invalid_version") };
    const reason = validateReason(row.reason); const id = newOpaqueId(); const digest = requestDigest(request);
    const staged = await this.writeArtifact("control-staged", id, request);
    try {
      const created = this.options.log.createOperationControl({ id, digest, targetOperationId: request.targetOperationId,
        targetDigest: request.targetDigest, kind: request.kind === "operation.retry" ? "retry" : "cancel",
        reason, expectedVersion: request.expectedVersion, requestedAt: this.now() });
      await this.checkpoint("publication.after_row:control");
      if (created.deduplicated) { await this.unlinkArtifact(staged); return created; }
      await this.promote(staged, "controls", created.control.id); await this.options.notify?.(); return created;
    } catch (error) { if (!(error instanceof BrokerCrashError)) await this.unlinkArtifact(staged).catch(() => undefined); throw error; }
  }

  async reconcile(): Promise<void> {
    await this.ensureSpool();
    for (const leaf of ["staged", "control-staged"] as const) for (const name of await readdir(join(this.options.spoolDir, leaf))) {
      if (!/^[A-Za-z0-9-]{1,64}\.json$/.test(name)) { await this.unlinkArtifact(join(this.options.spoolDir, leaf, name)).catch(() => undefined); continue; }
      const id = basename(name, ".json"); const operation = leaf === "staged" ? this.options.log.operationById(id) : this.options.log.operationControlById(id);
      if (leaf === "staged" && operation && "stateVersion" in operation && operation.state === "pending")
        await this.promote(join(this.options.spoolDir, leaf, name), "ready", id);
      else if (leaf === "control-staged" && operation && !("stateVersion" in operation)
        && (operation.state === "pending" || operation.state === "executing"))
        await this.promote(join(this.options.spoolDir, leaf, name), "controls", id);
      else if (leaf === "staged" && operation && "stateVersion" in operation && operation.state === "failed"
        && this.options.log.nonterminalOperationControls().some(control => control.targetOperationId === operation.id && control.kind === "retry"
          && control.expectedVersion === operation.stateVersion && (control.state === "pending" || control.state === "executing"))) continue;
      else {
        if (leaf === "control-staged" && operation && !("stateVersion" in operation)) await this.cleanupRejectedControl(operation);
        await this.unlinkArtifact(join(this.options.spoolDir, leaf, name)).catch(() => undefined);
      }
    }
    for (const name of await readdir(join(this.options.spoolDir, "controls"))) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      const control = /^[A-Za-z0-9-]{1,64}$/.test(id) ? this.options.log.operationControlById(id) : undefined;
      if (!control || control.state === "succeeded" || control.state === "rejected") {
        if (control) await this.cleanupRejectedControl(control);
        await this.unlinkArtifact(join(this.options.spoolDir, "controls", name)).catch(() => undefined);
      }
    }
    const normalLeaves = ["staged", "ready", "executing", "rollback"];
    for (const operation of this.options.log.listOperations(100).filter(row => row.actor === "local-console")) {
      const artifacts = await Promise.all(normalLeaves.map(leaf => stat(this.contained(leaf, operation.id)).catch(() => undefined)));
      if (operation.state === "succeeded" || operation.state === "cancelled" || (operation.state === "failed" && operation.mutated === 1)) {
        for (const leaf of normalLeaves) await this.unlinkArtifact(this.contained(leaf, operation.id)).catch(() => undefined);
      } else if (operation.state !== "failed" && artifacts.every(info => !info?.isFile())) {
        if (operation.mutated === 1) this.options.log.transitionOperation(operation.id, "blocked", "recovery_artifact_missing",
          { errorStage: "recovery_artifact_missing" });
        else this.options.log.transitionOperation(operation.id, "failed", "publication_missing",
          { errorStage: "publication_missing", outcome: "request artifact unavailable" });
      }
    }
    for (const control of this.options.log.nonterminalOperationControls()) {
      const staged = this.contained("control-staged", control.id); const ready = this.contained("controls", control.id);
      const present = (await stat(staged).catch(() => undefined))?.isFile() || (await stat(ready).catch(() => undefined))?.isFile();
      if (!present) {
        const request: ConsoleControlRequest = { version: 1, kind: control.kind === "retry" ? "operation.retry" : "operation.cancel",
          targetOperationId: control.targetOperationId, targetDigest: control.targetDigest, expectedVersion: control.expectedVersion };
        if (requestDigest(request) !== control.digest) {
          await this.cleanupRejectedControl(control, true); this.options.log.transitionOperationControl(control.id, "rejected", "control digest mismatch");
        }
        else { await this.writeArtifact("controls", control.id, request); await this.options.notify?.(); }
      }
    }
  }

  private async cleanupRejectedControl(control: OperationControlRow, rejecting = false): Promise<void> {
    if ((!rejecting && control.state !== "rejected") || control.kind !== "retry") return;
    const target = this.options.log.operationById(control.targetOperationId);
    if (target?.state === "blocked") await this.unlinkArtifact(this.contained("rollback", target.id)).catch(() => undefined);
  }

  private expire(now: number): void { for (const [id, draft] of this.drafts) if (!draft.consumed && draft.preview.expiresAt < now) this.drafts.delete(id); }
  private async ensureSpool(): Promise<void> { await mkdir(this.options.spoolDir, { recursive: true, mode: 0o700 });
    const paths = [this.options.spoolDir];
    for (const leaf of ["staged", "ready", "executing", "control-staged", "controls", "rollback", "quarantine"]) {
      const path = join(this.options.spoolDir, leaf); await mkdir(path, { recursive: true, mode: 0o700 }); paths.push(path);
    }
    for (const path of paths) { const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new ConsoleBrokerError("unsafe_spool", 503); }
  }
  private contained(leaf: string, id: string): string { const root = resolve(this.options.spoolDir); const path = resolve(root, leaf, `${id}.json`);
    if (!path.startsWith(`${root}${sep}`)) throw new ConsoleBrokerError("invalid_artifact", 400); return path; }
  private async writeArtifact(leaf: string, id: string, value: unknown): Promise<string> { await this.ensureSpool(); const path = this.contained(leaf, id);
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${canonicalJson(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await this.checkpoint(`artifact.file_synced:${leaf}`); await this.syncDirectory(dirname(path));
    await this.checkpoint(`artifact.parent_synced:${leaf}`);
    if (!(await stat(path)).isFile()) throw new ConsoleBrokerError("invalid_artifact"); return path; }
  private async promote(source: string, leaf: string, id: string): Promise<void> { const destination = this.contained(leaf, id);
    await rename(source, destination); await this.checkpoint(`artifact.renamed:${leaf}`);
    await this.syncDirectory(dirname(source)); if (dirname(destination) !== dirname(source)) await this.syncDirectory(dirname(destination));
    await this.checkpoint(`artifact.directories_synced:${leaf}`); }
  private async unlinkArtifact(path: string): Promise<void> { await unlink(path); await this.syncDirectory(dirname(path)); }
  private async syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); } }
  private async checkpoint(stage: string): Promise<void> { if (!this.options.fault) return;
    try { await this.options.fault(stage); } catch { throw new BrokerCrashError(stage); } }
}

function operationType(kind: ConsoleOperationRequest["kind"]): "config" | "restart" | "update" {
  return kind === "config.apply" ? "config" : kind === "daemon.restart" ? "restart" : "update";
}
function exact(value: unknown, keys: string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConsoleBrokerError("invalid_object", 400);
  const row = value as Record<string, unknown>; if (Object.keys(row).some(key => !keys.includes(key))) throw new ConsoleBrokerError("unknown_field", 400); return row; }
function string(value: unknown, code: string): string { if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new ConsoleBrokerError(code, 400); return value; }
function number(value: unknown, code: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ConsoleBrokerError(code, 400); return value as number; }
