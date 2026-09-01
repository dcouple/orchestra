import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertBrowserPrerequisites, BrowserPrerequisiteError } from "./browser.js";
import type { Config } from "./config.js";
import type { DependencyObservationInput, EventLog } from "./eventlog.js";
import { detectSimCapability, type Simctl } from "./sim.js";

export interface HarnessResolution {
  available: boolean;
  reasonCode: "available" | "invalid_path" | "missing" | "dangling_symlink" | "not_regular" | "not_executable";
}

export async function resolveHarnessExecutable(argv0: string, pathValue = process.env.PATH ?? ""): Promise<HarnessResolution> {
  const candidates = argv0.includes("/")
    ? (isAbsolute(argv0) ? [argv0] : [])
    : pathValue.split(":").filter(entry => entry.length > 0 && isAbsolute(entry)).slice(0, 32).map(entry => join(entry, argv0));
  if (candidates.length === 0) return { available: false, reasonCode: "invalid_path" };
  const failures = new Set<HarnessResolution["reasonCode"]>();
  for (const candidate of candidates) {
    let link;
    try { link = await lstat(candidate); }
    catch { failures.add("missing"); continue; }
    let canonical: string;
    try { canonical = await realpath(candidate); }
    catch { failures.add(link.isSymbolicLink() ? "dangling_symlink" : "missing"); continue; }
    let candidateStat;
    try { candidateStat = await stat(canonical); }
    catch { failures.add("missing"); continue; }
    if (!candidateStat.isFile()) { failures.add("not_regular"); continue; }
    try { await access(canonical, constants.X_OK); }
    catch { failures.add("not_executable"); continue; }
    return { available: true, reasonCode: "available" };
  }
  for (const reasonCode of ["not_executable", "not_regular", "dangling_symlink", "missing"] as const) {
    if (failures.has(reasonCode)) return { available: false, reasonCode };
  }
  return { available: false, reasonCode: "missing" };
}

interface Scheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}
const scheduler: Scheduler = {
  setInterval(callback, intervalMs) { const timer = setInterval(callback, intervalMs); timer.unref(); return timer; },
  clearInterval(handle) { clearInterval(handle as ReturnType<typeof setInterval>); },
};

type MonitorConfig = Pick<Config, "sessionsEnabled" | "browserEnabled" | "playwrightMcpBin" | "playwrightChromeBin"
  | "iosSimEnabled" | "iosSimDeveloperDir" | "iosSimRuntime" | "iosSimDeviceType" | "xcodebuildMcpBin"
  | "iosSimMaxConcurrent" | "artifactsDir" | "claudeArgv" | "claudexArgv">;

export interface DependencyMonitorOptions {
  config: MonitorConfig;
  log: Pick<EventLog, "upsertDependencyObservation">;
  simctl: Simctl;
  intervalMs: number;
  timeoutMs: number;
  staleAfterMs: number;
  now?: () => number;
  pathValue?: string;
  scheduler?: Scheduler;
  browserProbe?: typeof assertBrowserPrerequisites;
  simProbe?: typeof detectSimCapability;
}

class DependencyProbeAbort extends Error {
  constructor(readonly kind: "timeout" | "stopped") { super(kind); }
}

interface ProbeContext {
  signal: AbortSignal;
  generation?: number;
}

function abortKind(error: unknown): DependencyProbeAbort["kind"] | undefined {
  return error instanceof DependencyProbeAbort ? error.kind : undefined;
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export class DependencyMonitor {
  private timer: unknown;
  private stopped = true;
  private inFlight: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private generation = 0;
  private readonly now: () => number;
  private readonly timerApi: Scheduler;

  constructor(private readonly options: DependencyMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.timerApi = options.scheduler ?? scheduler;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.timer = this.timerApi.setInterval(() => void this.trigger(), this.options.intervalMs);
    void this.trigger();
  }

  trigger(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const generation = this.generation; const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(new DependencyProbeAbort("timeout")), this.options.timeoutMs);
    deadline.unref();
    let work!: Promise<void>;
    work = this.probe({ signal: controller.signal, generation }).finally(() => {
      clearTimeout(deadline);
      if (this.inFlight === work) this.inFlight = undefined;
      if (this.controller === controller) this.controller = undefined;
    });
    this.inFlight = work;
    return this.inFlight;
  }

  async probeOnce(): Promise<void> {
    await this.probe({ signal: new AbortController().signal });
  }

  private async probe(context: ProbeContext): Promise<void> {
    const config = this.options.config;
    await Promise.all([
      this.observeBrowser(config, context),
      this.observeSimulator(config, context),
      this.observeHarness("claude", config.sessionsEnabled, config.claudeArgv[0], context),
      this.observeHarness("claudex", config.sessionsEnabled && Boolean(config.claudexArgv), config.claudexArgv?.[0], context),
    ]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    if (this.timer !== undefined) { this.timerApi.clearInterval(this.timer); this.timer = undefined; }
    const inFlight = this.inFlight;
    this.controller?.abort(new DependencyProbeAbort("stopped"));
    await inFlight;
  }

  private write(input: Omit<DependencyObservationInput, "observedAt" | "staleAfterMs">, generation?: number): void {
    if (generation !== undefined && (this.stopped || generation !== this.generation)) return;
    this.options.log.upsertDependencyObservation({ ...input, observedAt: this.now(), staleAfterMs: this.options.staleAfterMs });
  }

  private async observeBrowser(config: MonitorConfig, context: ProbeContext): Promise<void> {
    const configured = config.sessionsEnabled && config.browserEnabled;
    if (!configured) { this.write({ kind: "mcp", name: "playwright", configured: false, status: "disabled", reasonCode: "disabled" }, context.generation); return; }
    try {
      await raceWithSignal((this.options.browserProbe ?? assertBrowserPrerequisites)(config), context.signal);
      this.write({ kind: "mcp", name: "playwright", configured: true, status: "healthy", reasonCode: null }, context.generation);
    } catch (error) {
      const reasonCode = abortKind(error) === "timeout" ? "probe_timeout"
        : error instanceof BrowserPrerequisiteError ? error.kind : "unknown";
      this.write({ kind: "mcp", name: "playwright", configured: true, status: "unavailable", reasonCode }, context.generation);
    }
  }

  private async observeSimulator(config: MonitorConfig, context: ProbeContext): Promise<void> {
    const configured = config.sessionsEnabled && config.iosSimEnabled;
    if (!configured) { this.write({ kind: "mcp", name: "xcodebuildmcp", configured: false, status: "disabled", reasonCode: "disabled" }, context.generation); return; }
    try {
      const result = await raceWithSignal(
        (this.options.simProbe ?? detectSimCapability)(config, this.options.simctl, context.signal), context.signal);
      this.write({ kind: "mcp", name: "xcodebuildmcp", configured: true,
        status: result.available ? "healthy" : "unavailable", reasonCode: result.available ? null : result.kind }, context.generation);
    } catch (error) {
      const reasonCode = abortKind(error) === "timeout" ? "probe_timeout" : "unknown";
      this.write({ kind: "mcp", name: "xcodebuildmcp", configured: true, status: "unavailable", reasonCode }, context.generation);
    }
  }

  private async observeHarness(name: "claude" | "claudex", configured: boolean, argv0: string | undefined,
    context: ProbeContext): Promise<void> {
    if (!configured || !argv0) { this.write({ kind: "harness", name, configured: false, status: "disabled", reasonCode: "disabled" }, context.generation); return; }
    try {
      const result = await raceWithSignal(resolveHarnessExecutable(argv0, this.options.pathValue), context.signal);
      this.write({ kind: "harness", name, configured: true, status: result.available ? "healthy" : "unavailable",
        reasonCode: result.available ? null : result.reasonCode }, context.generation);
    } catch (error) {
      const reasonCode = abortKind(error) === "timeout" ? "probe_timeout" : "unknown";
      this.write({ kind: "harness", name, configured: true, status: "unavailable", reasonCode }, context.generation);
    }
  }
}
