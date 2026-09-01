import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { EventLog } from "./eventlog.js";
import { canonicalJson, parseControlRequest, parseOperationRequest, requestDigest } from "./console-operation-schema.js";

const execFileAsync = promisify(execFile);
export interface ConsoleOperationExecutorOptions { log: EventLog; spoolDir: string; executable: string;
  argv?: readonly string[]; run?: (executable: string, argv: readonly string[]) => Promise<void>;
  fault?: (stage: string) => void | Promise<void>; environmentFile?: string }

class RejectControlError extends Error {}

export class ConsoleOperationExecutor {
  constructor(private readonly options: ConsoleOperationExecutorOptions) {}
  async run(): Promise<void> {
    await this.reconcilePublications();
    // Controls are acknowledgement boundaries: a queued cancellation must be
    // consumed before an executing request can be resumed, and a retry must
    // deliberately promote its retained request before that request runs.
    for (const name of await readdir(join(this.options.spoolDir, "controls")).catch(() => [])) await this.control(name);
    await this.reconcileRollbackTriggers();
    const executing = await readdir(join(this.options.spoolDir, "executing")).catch(() => []);
    if (executing.length > 0) {
      const resumable: string[] = [];
      for (const name of executing) {
        let operation = this.options.log.operationById(name.replace(/\.json$/, ""));
        if (operation && (operation.state === "succeeded" || operation.state === "cancelled"
          || ((operation.state === "failed" || operation.state === "blocked") && operation.mutated === 1)))
          await this.durableUnlink(join(this.options.spoolDir, "executing", name)).catch(() => undefined);
        else {
          if (operation?.state === "pending") operation = this.options.log.claimOperation(operation.id, operation.requestDigest);
          if (operation?.state === "executing" || operation?.state === "accepting" || operation?.state === "rolling_back") resumable.push(name);
        }
      }
      if (resumable.length > 0) await this.bridge();
      for (const name of resumable) { const operation = this.options.log.operationById(name.replace(/\.json$/, ""));
        if (operation && (operation.state === "succeeded" || operation.state === "cancelled"
          || ((operation.state === "failed" || operation.state === "blocked") && operation.mutated === 1)))
          await this.durableUnlink(join(this.options.spoolDir, "executing", name)).catch(() => undefined); }
    }
    for (const name of await readdir(join(this.options.spoolDir, "ready")).catch(() => [])) await this.execute(name);
    const rollback = await readdir(join(this.options.spoolDir, "rollback")).catch(() => []);
    const eligible = rollback.some(name => { const operation = this.options.log.operationById(name.replace(/\.json$/, ""));
      return operation?.state === "executing" || operation?.state === "rolling_back"; });
    if (eligible) await this.bridge();
  }
  private async bridge(): Promise<void> { const argv = this.options.argv ?? [];
    await (this.options.run ?? (async (executable, fixedArgv) => { await execFileAsync(executable, [...fixedArgv], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 30 * 60_000, maxBuffer: 64 * 1024 }); }))(this.options.executable, argv); }
  private async execute(name: string): Promise<void> {
    const ready = join(this.options.spoolDir, "ready", name); const quarantine = join(this.options.spoolDir, "quarantine", name);
    if (!/^[A-Za-z0-9-]{1,64}\.json$/.test(name)) { await this.durableRename(ready, quarantine).catch(() => this.durableUnlink(ready)); return; }
    try {
      const before = await lstat(ready); if (!before.isFile() || before.isSymbolicLink() || before.size > 128 * 1024 || (before.mode & 0o077) !== 0)
        throw new Error("invalid request artifact");
      const handle = await open(ready, constants.O_RDONLY | constants.O_NOFOLLOW); let text: string;
      try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
      const request = parseOperationRequest(JSON.parse(text) as unknown); const id = name.slice(0, -5);
      const operation = this.options.log.operationById(id);
      if (!operation || operation.requestDigest !== requestDigest(request)) throw new Error("request digest mismatch");
      const executing = join(this.options.spoolDir, "executing", name); await this.durableRename(ready, executing);
      const claimed = this.options.log.claimOperation(id, operation.requestDigest); if (!claimed) { await this.durableUnlink(executing); return; }
      await this.bridge();
      if ((await stat(executing).catch(() => undefined))?.isFile()) await this.durableUnlink(executing);
    } catch {
      await this.durableRename(ready, quarantine).catch(() => undefined);
    }
  }

  private async reconcilePublications(): Promise<void> {
    for (const name of await readdir(join(this.options.spoolDir, "control-staged")).catch(() => [])) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : ""; const source = join(this.options.spoolDir, "control-staged", name);
      const control = /^[A-Za-z0-9-]{1,64}$/.test(id) ? this.options.log.operationControlById(id) : undefined;
      if (control && (control.state === "pending" || control.state === "executing"))
        await this.durableRename(source, join(this.options.spoolDir, "controls", name));
      else await this.durableUnlink(source).catch(() => undefined);
    }
    for (const name of await readdir(join(this.options.spoolDir, "staged")).catch(() => [])) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : ""; const operation = this.options.log.operationById(id);
      const source = join(this.options.spoolDir, "staged", name);
      if (operation?.state === "pending") await this.durableRename(source, join(this.options.spoolDir, "ready", name));
      else if (!(operation?.state === "failed" && this.options.log.nonterminalOperationControls().some(control =>
        control.kind === "retry" && control.targetOperationId === operation.id && control.targetDigest === operation.requestDigest
        && control.expectedVersion === operation.stateVersion))) await this.durableUnlink(source).catch(() => undefined);
    }
    for (const name of await readdir(join(this.options.spoolDir, "controls")).catch(() => [])) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      const control = /^[A-Za-z0-9-]{1,64}$/.test(id) ? this.options.log.operationControlById(id) : undefined;
      if (!control || control.state === "succeeded" || control.state === "rejected") {
        if (control?.state === "rejected" && control.kind === "retry") {
          const target = this.options.log.operationById(control.targetOperationId); if (target) await this.cleanupRejectedRetry(target);
        }
        await this.durableUnlink(join(this.options.spoolDir, "controls", name)).catch(() => undefined);
      }
    }
    for (const control of this.options.log.nonterminalOperationControls()) {
      const staged = join(this.options.spoolDir, "control-staged", `${control.id}.json`);
      const ready = join(this.options.spoolDir, "controls", `${control.id}.json`);
      const present = (await stat(staged).catch(() => undefined))?.isFile() || (await stat(ready).catch(() => undefined))?.isFile();
      if (!present) {
        const request = { version: 1 as const, kind: control.kind === "retry" ? "operation.retry" as const : "operation.cancel" as const,
          targetOperationId: control.targetOperationId, targetDigest: control.targetDigest, expectedVersion: control.expectedVersion };
        if (requestDigest(request) !== control.digest) {
          if (control.kind === "retry") { const target = this.options.log.operationById(control.targetOperationId);
            if (target) await this.cleanupRejectedRetry(target); }
          this.options.log.transitionOperationControl(control.id, "rejected", "control digest mismatch"); continue;
        }
        await this.writeExclusiveArtifact(ready, `${canonicalJson(request)}\n`);
      }
    }
  }

  private async reconcileRollbackTriggers(): Promise<void> {
    const controls = this.options.log.nonterminalOperationControls();
    for (const name of await readdir(join(this.options.spoolDir, "rollback")).catch(() => [])) {
      const path = join(this.options.spoolDir, "rollback", name); const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      let digest: string | undefined;
      try {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error("invalid rollback trigger name");
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 || (info.mode & 0o077) !== 0)
          throw new Error("invalid rollback trigger artifact");
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let text: string;
        try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
        const value = JSON.parse(text) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid rollback trigger payload");
        const row = value as Record<string, unknown>;
        if (Object.keys(row).sort().join(",") !== "digest,operationId" || row.operationId !== id
          || typeof row.digest !== "string" || !/^[0-9a-f]{64}$/.test(row.digest)) throw new Error("invalid rollback trigger payload");
        digest = row.digest;
      } catch {
        await this.durableUnlink(path).catch(() => undefined); continue;
      }
      const operation = this.options.log.operationById(id);
      if (!operation || operation.actor !== "local-console" || operation.requestDigest !== digest) {
        await this.durableUnlink(path).catch(() => undefined); continue;
      }
      const recovering = operation.state === "executing" || operation.state === "rolling_back";
      const awaitingRetryAck = operation.state === "blocked" && operation.mutated === 1 && controls.some(control =>
        control.kind === "retry" && control.targetOperationId === operation.id && control.targetDigest === operation.requestDigest
        && control.expectedVersion === operation.stateVersion);
      if (!recovering && !awaitingRetryAck) {
        if (operation.state === "succeeded" || operation.state === "failed" || operation.state === "cancelled") {
          const stateDir = dirname(this.options.spoolDir);
          for (const leaf of ["staged", "ready", "executing"])
            await this.durableUnlink(join(this.options.spoolDir, leaf, `${operation.id}.json`)).catch(() => undefined);
          await this.durableUnlink(join(stateDir, "backups", `${operation.id}.changes.json`)).catch(() => undefined);
          await this.durableUnlink(join(stateDir, "backups", `${operation.id}.env`)).catch(() => undefined);
          if (this.options.environmentFile)
            await this.durableUnlink(`${this.options.environmentFile}.new.${operation.id}`).catch(() => undefined);
        }
        await this.durableUnlink(path).catch(() => undefined);
      }
    }
  }
  private async control(name: string): Promise<void> {
    const path = join(this.options.spoolDir, "controls", name);
    let request: ReturnType<typeof parseControlRequest>; let row: ReturnType<EventLog["operationControlById"]>;
    try {
      if (!/^[A-Za-z0-9-]{1,64}\.json$/.test(name)) throw new Error("invalid control artifact");
      const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 || (info.mode & 0o077) !== 0) throw new Error("invalid control artifact");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let text: string;
      try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
      request = parseControlRequest(JSON.parse(text) as unknown);
      row = this.options.log.operationControlById(name.slice(0, -5));
      if (!row || row.digest !== requestDigest(request) || row.targetOperationId !== request.targetOperationId
        || row.targetDigest !== request.targetDigest || row.expectedVersion !== request.expectedVersion) throw new Error("control digest mismatch");
    } catch {
      await this.rejectControl(name, path); return;
    }
    const target = this.options.log.operationById(request.targetOperationId);
    if (!target || target.requestDigest !== request.targetDigest) { await this.rejectControl(name, path, row); return; }
    if (row.state === "succeeded") { await this.reconcileAcknowledgedControl(request, target, path); return; }
    try {
      if (row.state === "pending") this.options.log.transitionOperationControl(row.id, "executing", null);
      if (request.kind === "operation.cancel") {
        if (target.state !== "cancelled") this.options.log.cancelOperation(target.id);
        for (const leaf of ["ready", "executing"])
          await this.durableUnlink(join(this.options.spoolDir, leaf, `${target.id}.json`)).catch(() => undefined);
        this.options.log.transitionOperationControl(row.id, "succeeded", "acknowledged");
        await this.durableUnlink(path); return;
      }
      if (target.stateVersion !== request.expectedVersion || (target.state !== "failed" && !(target.state === "blocked" && target.mutated === 1)))
        throw new RejectControlError("retry target changed");
      if (target.state === "failed") await this.prepareFailedRetry(row.id, target, path);
      else await this.prepareRollbackRetry(row.id, target, path);
    } catch (error) {
      if (error instanceof RejectControlError) { await this.cleanupRejectedRetry(target); await this.rejectControl(name, path, row); return; }
      throw error;
    }
  }

  private async prepareFailedRetry(controlId: string, target: NonNullable<ReturnType<EventLog["operationById"]>>, controlPath: string): Promise<void> {
    const held = join(this.options.spoolDir, "executing", `${target.id}.json`);
    const staged = join(this.options.spoolDir, "staged", `${target.id}.json`);
    const ready = join(this.options.spoolDir, "ready", `${target.id}.json`);
    if ((await stat(held).catch(() => undefined))?.isFile()) {
      if ((await stat(staged).catch(() => undefined))?.isFile()) throw new RejectControlError("duplicate retry artifacts");
      await this.durableRename(held, staged);
    }
    await this.validateOperationArtifact(staged, target.requestDigest);
    await this.checkpoint("retry.after_staged");
    this.options.log.acknowledgeRetryOperationControl(controlId);
    await this.checkpoint("retry.after_acknowledged");
    if ((await stat(staged).catch(() => undefined))?.isFile()) await this.durableRename(staged, ready);
    await this.checkpoint("retry.after_promoted");
    await this.durableUnlink(controlPath);
  }

  private async prepareRollbackRetry(controlId: string, target: NonNullable<ReturnType<EventLog["operationById"]>>, controlPath: string): Promise<void> {
    const trigger = join(this.options.spoolDir, "rollback", `${target.id}.json`);
    await this.ensureMatchingTrigger(trigger, target.id, target.requestDigest);
    await this.checkpoint("rollback.after_trigger");
    this.options.log.acknowledgeRetryOperationControl(controlId);
    await this.checkpoint("rollback.after_acknowledged");
    await this.durableUnlink(controlPath);
  }

  private async reconcileAcknowledgedControl(request: ReturnType<typeof parseControlRequest>, target: NonNullable<ReturnType<EventLog["operationById"]>>, controlPath: string): Promise<void> {
    if (request.kind === "operation.retry" && target.stateVersion === request.expectedVersion + 1 && target.state === "pending") {
      const staged = join(this.options.spoolDir, "staged", `${target.id}.json`); const ready = join(this.options.spoolDir, "ready", `${target.id}.json`);
      if ((await stat(staged).catch(() => undefined))?.isFile() && !(await stat(ready).catch(() => undefined))?.isFile())
        await this.durableRename(staged, ready);
    }
    await this.durableUnlink(controlPath);
  }

  private async validateOperationArtifact(path: string, digest: string): Promise<void> {
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 || (info.mode & 0o077) !== 0)
      throw new RejectControlError("retry request unavailable");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let text: string;
    try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
    const value = parseOperationRequest(JSON.parse(text) as unknown);
    if (requestDigest(value) !== digest) throw new RejectControlError("retry request digest mismatch");
  }

  private async ensureMatchingTrigger(path: string, operationId: string, digest: string): Promise<void> {
    const expected = `${canonicalJson({ operationId, digest })}\n`;
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(expected); await handle.sync(); } finally { await handle.close(); }
      await this.syncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new RejectControlError("invalid rollback trigger");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let actual: string;
      try { actual = await handle.readFile("utf8"); } finally { await handle.close(); }
      if (actual !== expected) throw new RejectControlError("rollback trigger mismatch");
    }
  }

  private async cleanupRejectedRetry(target: NonNullable<ReturnType<EventLog["operationById"]>>): Promise<void> {
    const trigger = join(this.options.spoolDir, "rollback", `${target.id}.json`);
    await this.durableUnlink(trigger).catch(() => undefined);
    const staged = join(this.options.spoolDir, "staged", `${target.id}.json`); const held = join(this.options.spoolDir, "executing", `${target.id}.json`);
    if ((await stat(staged).catch(() => undefined))?.isFile() && !(await stat(held).catch(() => undefined))?.isFile())
      await this.durableRename(staged, held).catch(() => undefined);
  }

  private async rejectControl(name: string, path: string, row?: ReturnType<EventLog["operationControlById"]>): Promise<void> {
    const current = row ?? this.options.log.operationControlById(name.endsWith(".json") ? name.slice(0, -5) : "");
    if (current && current.state !== "succeeded") {
      if (current.kind === "retry") { const target = this.options.log.operationById(current.targetOperationId);
        if (target) await this.cleanupRejectedRetry(target); }
      this.options.log.transitionOperationControl(current.id, "rejected", "target changed");
    }
    await this.durableRename(path, join(this.options.spoolDir, "quarantine", name)).catch(() => undefined);
  }

  private async checkpoint(stage: string): Promise<void> { await this.options.fault?.(stage); }
  private async writeExclusiveArtifact(path: string, value: string): Promise<void> {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await this.syncDirectory(dirname(path));
  }
  private async durableRename(source: string, destination: string): Promise<void> { await rename(source, destination);
    await this.syncDirectory(dirname(source)); if (dirname(destination) !== dirname(source)) await this.syncDirectory(dirname(destination)); }
  private async durableUnlink(path: string): Promise<void> { await unlink(path); await this.syncDirectory(dirname(path)); }
  private async syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); } }
}
