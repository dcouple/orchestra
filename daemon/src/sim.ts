import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import type { EventLog, SimLeaseRow } from "./eventlog.js";

const execFileAsync = promisify(execFile);
const OPEN_STATES = new Set(["creating", "booted", "orphan"]);
export const LEASE_NAME = /^orchestra-(\d+)-(\d+)$/;
export const XCODEBUILDMCP_WORKFLOWS = "session-management,simulator,ui-automation";

export class SimPrerequisiteError extends Error {
  constructor(readonly kind: "disabled" | "xcode_unavailable" | "runtime_unavailable" | "mcp_unavailable" | "golden_unavailable", message: string) {
    super(message); this.name = "SimPrerequisiteError";
  }
}
export class SimCapacityError extends Error {
  readonly kind = "sim_capacity" as const;
  constructor(message: string) { super(message); this.name = "SimCapacityError"; }
}
export class SimTurnLimitError extends Error {
  readonly kind = "sim_turn_limit" as const;
  constructor(message: string) { super(message); this.name = "SimTurnLimitError"; }
}
export class SimLeaseError extends Error {
  constructor(readonly kind: "lease_not_found" | "lease_not_owned" | "sim_not_ready" | "sim_failed", message: string) {
    super(message); this.name = "SimLeaseError";
  }
}

export interface SimDevice {
  udid: string; name: string; state: string; isAvailable?: boolean;
  deviceTypeIdentifier?: string; runtimeId: string;
}
export interface SimRuntime { identifier: string; name: string; isAvailable?: boolean; }
export interface SimDeviceType { identifier: string; name: string; }
export type SimCapabilityResult =
  | { available: true; goldenUdid: string; goldenName: string; runtimeId: string; deviceTypeId: string }
  | { available: false; kind: SimPrerequisiteError["kind"]; message?: string };

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) return error.stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

export class Simctl {
  constructor(private readonly argv: string[], private readonly env: NodeJS.ProcessEnv & { DEVELOPER_DIR: string }) {}
  private async run(args: string[], timeout = 120_000): Promise<string> {
    const [command, ...prefix] = this.argv;
    if (!command) throw new Error("simctl command is empty");
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG"] as const) {
      if (process.env[key] !== undefined) childEnv[key] = process.env[key];
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("LC_") && value !== undefined) childEnv[key] = value;
    }
    for (const [key, value] of Object.entries(this.env)) if (value !== undefined) childEnv[key] = value;
    try {
      const { stdout } = await execFileAsync(command, [...prefix, ...args], {
        env: childEnv, timeout, maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) { throw new Error(messageOf(error)); }
  }
  async listDevices(): Promise<SimDevice[]> {
    const parsed = JSON.parse(await this.run(["list", "devices", "-j"])) as { devices?: Record<string, Omit<SimDevice, "runtimeId">[]> };
    return Object.entries(parsed.devices ?? {}).flatMap(([runtimeId, devices]) => devices.map(device => ({ ...device, runtimeId })));
  }
  async listRuntimes(): Promise<SimRuntime[]> {
    return (JSON.parse(await this.run(["list", "runtimes", "-j"])) as { runtimes?: SimRuntime[] }).runtimes ?? [];
  }
  async listDeviceTypes(): Promise<SimDeviceType[]> {
    return (JSON.parse(await this.run(["list", "devicetypes", "-j"])) as { devicetypes?: SimDeviceType[] }).devicetypes ?? [];
  }
  clone(udid: string, name: string): Promise<string> { return this.run(["clone", udid, name]); }
  async boot(udid: string): Promise<void> { await this.run(["boot", udid]); }
  async bootstatus(udid: string, timeoutMs = 180_000): Promise<void> { await this.run(["bootstatus", udid, "-b"], timeoutMs); }
  async shutdown(udid: string): Promise<void> { await this.goneOkay("shutdown", udid); }
  async delete(udid: string): Promise<void> { await this.goneOkay("delete", udid); }
  private async goneOkay(command: string, udid: string): Promise<void> {
    try { await this.run([command, udid]); }
    catch (error) { const message = messageOf(error); if (!/Invalid device|not found|Unable to find/i.test(message)) throw error; }
  }
}

function slugTail(identifier: string): string {
  return identifier.split(".").at(-1)!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
export function goldenDeviceName(deviceTypeId: string, runtimeId: string): string {
  return `orchestra-golden-${slugTail(deviceTypeId)}-${slugTail(runtimeId)}`;
}

type SimConfig = Pick<Config, "iosSimEnabled" | "iosSimDeveloperDir" | "iosSimRuntime" | "iosSimDeviceType" |
  "xcodebuildMcpBin" | "iosSimMaxConcurrent" | "artifactsDir">;

export async function detectSimCapability(config: SimConfig, simctl: Simctl): Promise<SimCapabilityResult> {
  if (!config.iosSimEnabled) return { available: false, kind: "disabled", message: "simulator capability is disabled" };
  try { await access(join(config.iosSimDeveloperDir, "usr/bin/xcodebuild"), constants.X_OK); }
  catch { return { available: false, kind: "xcode_unavailable", message: `Xcode is unavailable: ${config.iosSimDeveloperDir}` }; }
  let runtimes: SimRuntime[];
  try { runtimes = await simctl.listRuntimes(); }
  catch (error) { return { available: false, kind: "runtime_unavailable", message: messageOf(error) }; }
  const runtime = runtimes.find(value => value.isAvailable !== false && (value.name === config.iosSimRuntime || value.identifier === config.iosSimRuntime));
  if (!runtime) return { available: false, kind: "runtime_unavailable",
    message: `runtime unavailable: ${config.iosSimRuntime}; available: ${runtimes.filter(value => value.isAvailable !== false).map(value => value.name).join(", ")}` };
  try { await access(config.xcodebuildMcpBin, constants.X_OK); }
  catch { return { available: false, kind: "mcp_unavailable", message: `XcodeBuildMCP executable is unavailable: ${config.xcodebuildMcpBin}` }; }
  let types: SimDeviceType[], devices: SimDevice[];
  try { [types, devices] = await Promise.all([simctl.listDeviceTypes(), simctl.listDevices()]); }
  catch (error) { return { available: false, kind: "golden_unavailable", message: messageOf(error) }; }
  const deviceType = types.find(value => value.name === config.iosSimDeviceType || value.identifier === config.iosSimDeviceType);
  if (!deviceType) return { available: false, kind: "golden_unavailable", message: `device type unavailable: ${config.iosSimDeviceType}` };
  const goldenName = goldenDeviceName(deviceType.identifier, runtime.identifier);
  const matches = devices.filter(device => device.runtimeId === runtime.identifier && device.name === goldenName && device.isAvailable !== false);
  if (matches.length !== 1) return { available: false, kind: "golden_unavailable", message: `expected exactly one golden device named ${goldenName}; found ${matches.length}` };
  return { available: true, goldenUdid: matches[0]!.udid, goldenName, runtimeId: runtime.identifier, deviceTypeId: deviceType.identifier };
}

interface Logger { log(...args: unknown[]): void; error(...args: unknown[]): void; }
async function deleteLeaseDevice(simctl: Simctl, udid: string): Promise<void> {
  const device = (await simctl.listDevices()).find(value => value.udid === udid);
  if (!device) return;
  if (!LEASE_NAME.test(device.name))
    throw new SimLeaseError("sim_failed", `refusing to delete simulator ${udid}: current name ${device.name} is not a lease device`);
  await simctl.shutdown(udid).catch(() => {});
  await simctl.delete(udid);
}
export class SimPool {
  private readonly tokens = new Map<number, string>();
  private simctlWork: Promise<void> = Promise.resolve();
  private reconciled: boolean;
  private readonly now: () => number;
  private readonly logger: Logger;
  constructor(readonly log: EventLog, readonly simctl: Simctl, readonly config: SimConfig,
    readonly capability: SimCapabilityResult, options: { now?: () => number; logger?: Logger; reconciled?: boolean } = {}) {
    this.now = options.now ?? Date.now; this.logger = options.logger ?? console;
    this.reconciled = options.reconciled ?? true;
  }
  issueTurnToken(turnId: number): string { const token = randomBytes(32).toString("hex"); this.tokens.set(turnId, token); return token; }
  revokeTurnToken(turnId: number): void { this.tokens.delete(turnId); }
  authorize(turnId: number, token: string): boolean {
    const expected = this.tokens.get(turnId);
    if (!expected) return false;
    const left = Buffer.from(expected); const right = Buffer.from(token);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  health(): { enabled: boolean; available: boolean; kind?: string } {
    return { enabled: this.config.iosSimEnabled, available: this.capability.available,
      ...(!this.capability.available ? { kind: this.capability.kind } : {}) };
  }
  private async requireReady(): Promise<{ capability: Extract<SimCapabilityResult, { available: true }>; golden: SimDevice }> {
    if (!this.capability.available)
      throw new SimPrerequisiteError(this.capability.kind, this.capability.message ?? this.capability.kind);
    if (!this.reconciled) throw new SimLeaseError("sim_not_ready", "device pool reconciliation pending");
    const capability = await detectSimCapability(this.config, this.simctl);
    if (!capability.available) throw new SimPrerequisiteError(capability.kind, capability.message ?? capability.kind);
    const golden = (await this.simctl.listDevices()).find(device => device.udid === capability.goldenUdid);
    if (!golden || golden.state !== "Shutdown") throw new SimPrerequisiteError("golden_unavailable", `golden is ${golden?.state ?? "missing"}`);
    return { capability, golden };
  }
  async acquire(turnId: number, sessionId: string): Promise<{ udid: string; name: string; lease: number; evidenceDir: string }> {
    const { golden } = await this.requireReady();
    const reservation = this.log.reserveSimLease(turnId, sessionId, this.config.iosSimMaxConcurrent, this.now());
    return this.withSimctlWork(async () => {
      let udid: string | undefined;
      try {
        udid = await this.simctl.clone(golden.udid, reservation.name);
        this.log.attachSimDevice(reservation.id, udid);
        await this.simctl.boot(udid); await this.simctl.bootstatus(udid);
        const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
        const evidenceDir = join(resolve(this.config.artifactsDir), "sim", safeSession, String(turnId), `lease-${reservation.leaseIndex}`);
        await mkdir(evidenceDir, { recursive: true });
        this.log.markSimLeaseBooted(reservation.id, evidenceDir, this.now());
        return { udid, name: reservation.name, lease: reservation.leaseIndex, evidenceDir };
      } catch (error) {
        const message = messageOf(error); let cleaned = !udid;
        if (udid) {
          try { await deleteLeaseDevice(this.simctl, udid); cleaned = true; }
          catch (cleanupError) {
            this.logger.error(JSON.stringify({ event: "sim_acquire_cleanup_failed", turnId, udid, error: messageOf(cleanupError) }));
          }
        }
        if (cleaned) this.log.failSimLease(reservation.id, message, this.now());
        this.logger.error(JSON.stringify({ event: "sim_acquire_failed", turnId, error: message }));
        throw new SimLeaseError("sim_failed", message);
      }
    });
  }
  markReconciled(): void { this.reconciled = true; }
  private async withSimctlWork<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.simctlWork; let release!: () => void;
    this.simctlWork = new Promise(resolveWork => { release = resolveWork; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }
  async release(turnId: number, udid: string): Promise<void> {
    const row = this.log.simLeaseByUdid(udid);
    if (!row || !OPEN_STATES.has(row.state)) throw new SimLeaseError("lease_not_found", `open lease not found: ${udid}`);
    if (row.turnId !== turnId) throw new SimLeaseError("lease_not_owned", `lease ${udid} is not owned by turn ${turnId}`);
    try { await deleteLeaseDevice(this.simctl, udid); }
    catch (error) {
      const message = messageOf(error); this.logger.error(JSON.stringify({ event: "sim_release_failed", turnId, udid, error: message }));
      throw error instanceof SimLeaseError ? error : new SimLeaseError("sim_failed", message);
    }
    this.log.closeSimLease(row.id, "released", "released_by_turn", this.now());
  }
  async status(turnId: number): Promise<SimLeaseRow[]> {
    await this.requireReady();
    return this.log.openSimLeases().filter(row => row.turnId === turnId);
  }
}

export class SimReaper {
  private timer?: NodeJS.Timeout; private stopped = false; private sweeping: Promise<void> | undefined;
  private sweepSequence = 0;
  private readonly now: () => number; private readonly logger: Logger;
  constructor(private readonly log: EventLog, private readonly simctl: Simctl,
    private readonly options: { intervalMs: number; idleTimeoutMs: number; now?: () => number; logger?: Logger; pool?: SimPool }) {
    this.now = options.now ?? Date.now; this.logger = options.logger ?? console;
  }
  start(): void { this.stopped = false; this.timer = setInterval(() => void this.trigger(), this.options.intervalMs); this.timer.unref(); void this.trigger(); }
  trigger(): Promise<void> { if (this.stopped) return Promise.resolve(); this.sweeping ??= this.sweep().finally(() => { this.sweeping = undefined; }); return this.sweeping; }
  async sweep(): Promise<void> {
    await this.reconcileOnce();
  }
  async reconcileOnce(): Promise<boolean> {
    const sweepId = String(++this.sweepSequence);
    try {
      const completed = await this.sweepOnce(sweepId);
      if (completed) this.options.pool?.markReconciled();
      return completed;
    } catch (error) { this.error("sweep", undefined, error, sweepId); return false; }
  }
  private async sweepOnce(sweepId: string): Promise<boolean> {
    let completed = true;
    const devices = await this.simctl.listDevices();
    for (const device of devices.filter(value => LEASE_NAME.test(value.name))) {
      try {
        const byName = this.log.simLeaseByName(device.name);
        if (byName?.state === "creating" && !byName.udid) this.log.attachSimDevice(byName.id, device.udid);
        else if (!this.log.simLeaseByUdid(device.udid) || !OPEN_STATES.has(this.log.simLeaseByUdid(device.udid)!.state)) {
          this.log.adoptSimOrphan(device.udid, device.name, this.now());
          this.logger.log(JSON.stringify({ event: "sim_orphan_adopted", sweepId, udid: device.udid, name: device.name }));
        }
      } catch (error) { completed = false; this.error("reconcile", device.udid, error, sweepId); }
    }
    for (const row of this.log.openSimLeases()) {
      try {
        if (row.turnId !== null && this.log.turnIsRunning(row.turnId)) { this.log.touchSimLeases([row.id], this.now()); continue; }
        if (this.now() - row.lastLiveAt < this.options.idleTimeoutMs) continue;
        if (!row.udid) {
          this.log.failSimLease(row.id, "abandoned_creating", this.now());
          this.logger.log(JSON.stringify({ event: "sim_lease_failed", sweepId, attempt: row.reapAttempts, reason: "abandoned_creating" }));
          continue;
        }
        const attempt = this.log.incrementSimReapAttempt(row.id);
        try { await deleteLeaseDevice(this.simctl, row.udid); }
        catch (error) { completed = false; this.error("delete", row.udid, error, sweepId, attempt); continue; }
        const reason = row.state === "orphan" ? "orphan" : row.state === "creating" ? "abandoned_creating" : "idle";
        this.log.closeSimLease(row.id, "reaped", reason, this.now());
        this.logger.log(JSON.stringify({ event: "sim_lease_reaped", sweepId, attempt, udid: row.udid, reason }));
      } catch (error) { completed = false; this.error("lease", row.udid ?? undefined, error, sweepId); }
    }
    return completed;
  }
  private error(step: string, udid: string | undefined, error: unknown, sweepId: string, attempt?: number): void {
    try {
      this.logger.error(JSON.stringify({ event: "sim_reaper_error", sweepId, step, ...(attempt === undefined ? {} : { attempt }),
        ...(udid ? { udid } : {}), error: messageOf(error) }));
    } catch {}
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.sweeping; }
}

export function simMcpServer(config: Pick<Config, "xcodebuildMcpBin" | "iosSimDeveloperDir">) {
  return { type: "stdio" as const, command: config.xcodebuildMcpBin, args: ["mcp"],
    env: { DEVELOPER_DIR: config.iosSimDeveloperDir, XCODEBUILDMCP_ENABLED_WORKFLOWS: XCODEBUILDMCP_WORKFLOWS } };
}
export function mergeSimMcpConfig(baseJson: string, server: ReturnType<typeof simMcpServer>): string {
  const parsed = JSON.parse(baseJson) as { mcpServers?: Record<string, unknown> };
  return JSON.stringify({ ...parsed, mcpServers: { ...(parsed.mcpServers ?? {}), xcodebuildmcp: server } });
}
export async function writeSimContext(config: Pick<Config, "artifactsDir">, pool: SimPool, turnId: number,
  sessionId: string, baseUrl: string): Promise<string> {
  const root = join(resolve(config.artifactsDir), "sim", sessionId.replace(/[^a-zA-Z0-9._-]/g, "_"), String(turnId));
  await mkdir(root, { recursive: true });
  const path = join(root, "context.json");
  await writeFile(path, JSON.stringify({ version: 1, baseUrl, turnId, linearSessionId: sessionId, token: pool.issueTurnToken(turnId) }), { mode: 0o600 });
  return path;
}
export function simTurnEnv(contextPath: string, developerDir?: string): NodeJS.ProcessEnv {
  return { ORCHESTRA_SIM_CONTEXT: contextPath, ...(developerDir ? { DEVELOPER_DIR: developerDir } : {}) };
}
