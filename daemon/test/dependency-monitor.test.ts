import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPrerequisiteError } from "../src/browser.js";
import { DependencyMonitor, resolveHarnessExecutable } from "../src/dependency-monitor.js";
import { EventLog } from "../src/eventlog.js";
import { Simctl, type SimCapabilityResult } from "../src/sim.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "dependency-monitor-")); dirs.push(dir); return dir; }

describe("harness executable resolution", () => {
  it("bounds PATH scanning and normalizes missing, dangling, non-file, and non-executable outcomes", async () => {
    const dir = temp(); const bin = join(dir, "bin"); mkdirSync(bin);
    const executable = join(bin, "claude"); writeFileSync(executable, "#!/bin/sh\n"); chmodSync(executable, 0o755);
    expect(await resolveHarnessExecutable("claude", `relative::${bin}`)).toEqual({ available: true, reasonCode: "available" });
    expect(await resolveHarnessExecutable("relative/claude", bin)).toEqual({ available: false, reasonCode: "invalid_path" });
    expect(await resolveHarnessExecutable("missing", bin)).toEqual({ available: false, reasonCode: "missing" });
    symlinkSync(join(dir, "gone"), join(bin, "dangling"));
    expect(await resolveHarnessExecutable("dangling", bin)).toEqual({ available: false, reasonCode: "dangling_symlink" });
    mkdirSync(join(bin, "directory"));
    expect(await resolveHarnessExecutable("directory", bin)).toEqual({ available: false, reasonCode: "not_regular" });
    writeFileSync(join(bin, "not-executable"), "no");
    expect(await resolveHarnessExecutable("not-executable", bin)).toEqual({ available: false, reasonCode: "not_executable" });
    expect(await resolveHarnessExecutable("claude", Array.from({ length: 33 }, (_, i) => join(dir, `p${i}`)).concat(bin).join(":")))
      .toEqual({ available: false, reasonCode: "missing" });
  });

  it("continues past unusable PATH candidates and applies stable mixed-failure precedence", async () => {
    const dir = temp(); const first = join(dir, "first"); const second = join(dir, "second");
    const third = join(dir, "third"); mkdirSync(first); mkdirSync(second); mkdirSync(third);
    mkdirSync(join(first, "claude"));
    writeFileSync(join(second, "claude"), "#!/bin/sh\n"); chmodSync(join(second, "claude"), 0o755);
    expect(await resolveHarnessExecutable("claude", `${first}:${second}`))
      .toEqual({ available: true, reasonCode: "available" });

    symlinkSync(join(dir, "gone"), join(first, "mixed"));
    mkdirSync(join(second, "mixed"));
    writeFileSync(join(third, "mixed"), "not executable");
    expect(await resolveHarnessExecutable("mixed", `${first}:${second}:${third}`))
      .toEqual({ available: false, reasonCode: "not_executable" });
    expect(await resolveHarnessExecutable("mixed", `${third}:${first}:${second}`))
      .toEqual({ available: false, reasonCode: "not_executable" });
  });
});

describe("DependencyMonitor", () => {
  it("records all supported local dependencies, disabled options, and normalized capability failures", async () => {
    const dir = temp(); const bin = join(dir, "bin"); mkdirSync(bin);
    const claude = join(bin, "claude"); writeFileSync(claude, "#!/bin/sh\n"); chmodSync(claude, 0o755);
    const log = new EventLog(join(dir, "events.db"));
    const config = { sessionsEnabled: true, browserEnabled: true, playwrightMcpBin: "/safe/playwright",
      playwrightChromeBin: "/safe/chrome", iosSimEnabled: true, iosSimDeveloperDir: "/safe/xcode",
      iosSimRuntime: "iOS", iosSimDeviceType: "Phone", xcodebuildMcpBin: "/safe/xcodebuildmcp",
      iosSimMaxConcurrent: 2, artifactsDir: join(dir, "artifacts"), claudeArgv: [claude] };
    let recovered = false; let now = 1_000;
    const monitor = new DependencyMonitor({ config, log, simctl: {} as Simctl, intervalMs: 10_000, timeoutMs: 1_000,
      staleAfterMs: 50_000, now: () => now, pathValue: bin,
      browserProbe: vi.fn(async () => { if (!recovered) throw new BrowserPrerequisiteError("chrome_unavailable", "SECRET /path"); }),
      simProbe: vi.fn(async () => recovered
        ? ({ available: true as const, goldenUdid: "SECRET", goldenName: "SECRET", runtimeId: "SECRET", deviceTypeId: "SECRET" })
        : ({ available: false as const, kind: "runtime_unavailable" as const, message: "SECRET" })) });
    await monitor.probeOnce();
    expect(log.dependencyObservations()).toEqual([
      { kind: "harness", name: "claude", configured: true, status: "healthy", reasonCode: null, capabilities: {}, observedAt: 1_000, staleAfterMs: 50_000 },
      { kind: "harness", name: "claudex", configured: false, status: "disabled", reasonCode: "disabled", capabilities: {}, observedAt: 1_000, staleAfterMs: 50_000 },
      { kind: "mcp", name: "playwright", configured: true, status: "unavailable", reasonCode: "chrome_unavailable", capabilities: {}, observedAt: 1_000, staleAfterMs: 50_000 },
      { kind: "mcp", name: "xcodebuildmcp", configured: true, status: "unavailable", reasonCode: "runtime_unavailable", capabilities: {}, observedAt: 1_000, staleAfterMs: 50_000 },
    ]);
    expect(JSON.stringify(log.dependencyObservations())).not.toMatch(/SECRET|\/safe|\/path/);
    recovered = true; now = 2_000; await monitor.probeOnce();
    expect(log.dependencyObservations().filter(row => row.kind === "mcp")).toMatchObject([
      { name: "playwright", status: "healthy", reasonCode: null, observedAt: 2_000 },
      { name: "xcodebuildmcp", status: "healthy", reasonCode: null, observedAt: 2_000 },
    ]);
    expect(JSON.stringify(log.dependencyObservations())).not.toContain("SECRET");
    log.close();
  });

  it("times out a generation safely, ignores its late result, and recovers on the next probe", async () => {
    vi.useFakeTimers(); const dir = temp(); let finish!: (value: SimCapabilityResult) => void;
    const deferred = new Promise<SimCapabilityResult>(resolve => { finish = resolve; });
    let calls = 0; let signal: AbortSignal | undefined;
    const simProbe = vi.fn(async (_config, _simctl, nextSignal?: AbortSignal) => {
      signal = nextSignal;
      if (calls++ === 0) return deferred;
      return { available: true as const, goldenUdid: "SECRET", goldenName: "SECRET", runtimeId: "SECRET", deviceTypeId: "SECRET" };
    });
    const write = vi.fn();
    const config = { sessionsEnabled: true, browserEnabled: false, playwrightMcpBin: "/unused", playwrightChromeBin: "/unused",
      iosSimEnabled: true, iosSimDeveloperDir: "/unused", iosSimRuntime: "iOS", iosSimDeviceType: "Phone",
      xcodebuildMcpBin: "/unused", iosSimMaxConcurrent: 1, artifactsDir: dir, claudeArgv: ["missing"] };
    const monitor = new DependencyMonitor({ config, log: { upsertDependencyObservation: write }, simctl: {} as Simctl,
      intervalMs: 10_000, timeoutMs: 100, staleAfterMs: 1_000, simProbe, pathValue: dir });
    monitor.start(); const first = monitor.trigger();
    await vi.advanceTimersByTimeAsync(100); await first;
    expect(signal?.aborted).toBe(true);
    expect(write.mock.calls.map(([row]) => row).filter(row => row.name === "xcodebuildmcp")).toEqual([
      expect.objectContaining({ status: "unavailable", reasonCode: "probe_timeout" }),
    ]);
    await monitor.trigger();
    expect(write.mock.calls.map(([row]) => row).filter(row => row.name === "xcodebuildmcp")).toEqual([
      expect.objectContaining({ reasonCode: "probe_timeout" }), expect.objectContaining({ status: "healthy", reasonCode: null }),
    ]);
    finish({ available: true, goldenUdid: "LATE_SECRET", goldenName: "LATE_SECRET", runtimeId: "LATE_SECRET", deviceTypeId: "LATE_SECRET" });
    await Promise.resolve(); await Promise.resolve();
    expect(write.mock.calls.map(([row]) => row).filter(row => row.name === "xcodebuildmcp")).toHaveLength(2);
    await monitor.stop();
  });

  it("aborts stop promptly, suppresses late writes, and isolates a subsequent start generation", async () => {
    vi.useFakeTimers(); const dir = temp(); let finish!: (value: SimCapabilityResult) => void;
    const deferred = new Promise<SimCapabilityResult>(resolve => { finish = resolve; });
    let recovered = false; let signal: AbortSignal | undefined;
    const simProbe = vi.fn(async (_config, _simctl, nextSignal?: AbortSignal) => {
      signal = nextSignal;
      return recovered ? { available: true as const, goldenUdid: "SAFE", goldenName: "SAFE", runtimeId: "SAFE", deviceTypeId: "SAFE" } : deferred;
    });
    const write = vi.fn();
    const config = { sessionsEnabled: true, browserEnabled: false, playwrightMcpBin: "/unused", playwrightChromeBin: "/unused",
      iosSimEnabled: true, iosSimDeveloperDir: "/unused", iosSimRuntime: "iOS", iosSimDeviceType: "Phone",
      xcodebuildMcpBin: "/unused", iosSimMaxConcurrent: 1, artifactsDir: dir, claudeArgv: ["missing"] };
    const monitor = new DependencyMonitor({ config, log: { upsertDependencyObservation: write }, simctl: {} as Simctl,
      intervalMs: 10_000, timeoutMs: 5_000, staleAfterMs: 10_000, simProbe, pathValue: dir });
    monitor.start(); const first = monitor.trigger();
    await monitor.stop(); await first;
    expect(signal?.aborted).toBe(true);
    expect(write.mock.calls.map(([row]) => row).filter(row => row.name === "xcodebuildmcp")).toHaveLength(0);
    recovered = true; monitor.start(); await monitor.trigger();
    expect(write.mock.calls.map(([row]) => row).filter(row => row.name === "xcodebuildmcp")).toEqual([
      expect.objectContaining({ status: "healthy", reasonCode: null }),
    ]);
    finish({ available: true, goldenUdid: "LATE_SECRET", goldenName: "LATE_SECRET", runtimeId: "LATE_SECRET", deviceTypeId: "LATE_SECRET" });
    await Promise.resolve(); await Promise.resolve();
    expect(write.mock.calls.map(([row]) => row).filter(row => row.name === "xcodebuildmcp")).toHaveLength(1);
    await monitor.stop();
  });

  it("passes cancellation into a real read-only Simctl child", async () => {
    const dir = temp(); const script = join(dir, "blocking-simctl.mjs");
    writeFileSync(script, "setInterval(() => {}, 1000);\n");
    const simctl = new Simctl([process.execPath, script], { DEVELOPER_DIR: dir });
    const controller = new AbortController(); const pending = simctl.listRuntimes(controller.signal);
    controller.abort(new Error("probe cancelled"));
    await expect(pending).rejects.toThrow("probe cancelled");
  });
});
