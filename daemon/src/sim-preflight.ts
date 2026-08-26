import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { goldenDeviceName, LEASE_NAME, type SimDevice, type SimDeviceType, type SimRuntime } from "./sim.js";

const execFileAsync = promisify(execFile);
interface Io { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }
interface Settings { runtime: string; deviceType: string; developerDir: string; simctl: string[]; mcpBin: string; dbPath: string; probe: string; childEnv: NodeJS.ProcessEnv; bindAddr: string; port: number }
interface Report { golden?: string; disposition?: "created" | "adopted" | "skipped"; orphansSwept: number; probe: "ok" | "FAILED" | "skipped"; dryRun: boolean }
interface DaemonHealth { ok?: unknown; sim?: { enabled?: unknown; available?: unknown; kind?: unknown } }

function settings(env: NodeJS.ProcessEnv): Settings {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "TMPDIR", "LANG"] as const) if (env[key] !== undefined) childEnv[key] = env[key];
  childEnv.DEVELOPER_DIR = env.IOS_SIM_DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer";
  childEnv.XCODEBUILD_MCP_BIN = env.XCODEBUILD_MCP_BIN || "/usr/local/bin/xcodebuildmcp";
  if (env.SIM_PROBE_APP_SRC !== undefined) childEnv.SIM_PROBE_APP_SRC = env.SIM_PROBE_APP_SRC;
  return {
    runtime: env.IOS_SIM_RUNTIME!.trim(), deviceType: env.IOS_SIM_DEVICE_TYPE!.trim(),
    developerDir: env.IOS_SIM_DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer",
    simctl: (env.IOS_SIM_SIMCTL_BIN || "xcrun simctl").split(/\s+/),
    mcpBin: env.XCODEBUILD_MCP_BIN || "/usr/local/bin/xcodebuildmcp", dbPath: env.DB_PATH || resolve("events.db"),
    probe: env.SIM_PREFLIGHT_PROBE || fileURLToPath(new URL("../ops/macos/sim-context-probe.sh", import.meta.url)), childEnv,
    bindAddr: env.BIND_ADDR || "127.0.0.1", port: Number(env.PORT || "8787"),
  };
}
async function command(config: Settings, args: string[]): Promise<string> {
  const [bin, ...prefix] = config.simctl; if (!bin) throw new Error("simctl command is empty");
  return (await execFileAsync(bin, [...prefix, ...args], { env: config.childEnv, maxBuffer: 10 * 1024 * 1024 })).stdout.trim();
}
async function lists(config: Settings): Promise<{ runtimes: SimRuntime[]; types: SimDeviceType[]; devices: SimDevice[] }> {
  const [runtimeJson, typeJson, deviceJson] = await Promise.all([
    command(config, ["list", "runtimes", "-j"]), command(config, ["list", "devicetypes", "-j"]), command(config, ["list", "devices", "-j"]),
  ]);
  const runtimes = (JSON.parse(runtimeJson) as { runtimes?: SimRuntime[] }).runtimes ?? [];
  const types = (JSON.parse(typeJson) as { devicetypes?: SimDeviceType[] }).devicetypes ?? [];
  const devices = Object.entries((JSON.parse(deviceJson) as { devices?: Record<string, Omit<SimDevice, "runtimeId">[]> }).devices ?? {})
    .flatMap(([runtimeId, values]) => values.map(value => ({ ...value, runtimeId })));
  return { runtimes, types, devices };
}
async function protectedUdids(path: string, io: Io, announceMissing = true): Promise<Set<string>> {
  try { await access(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { if (announceMissing) line(io, "leases", "none (no database)"); return new Set(); }
    throw new Error(`lease database inaccessible: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sim_leases'").get();
      if (!table) { if (announceMissing) line(io, "leases", "none (no table)"); return new Set(); }
      return new Set((db.prepare("SELECT udid FROM sim_leases WHERE state IN ('creating','booted','orphan') AND udid IS NOT NULL").all() as { udid: string }[]).map(row => row.udid));
    } finally { db.close(); }
  } catch (error) { throw new Error(`lease database unreadable: ${error instanceof Error ? error.message : String(error)}`); }
}
async function oldest(devices: SimDevice[]): Promise<SimDevice> {
  const dated = await Promise.all(devices.map(async device => {
    try { return { device, time: (await stat((device as SimDevice & { dataPath?: string }).dataPath || "")).mtimeMs }; }
    catch { return { device, time: Number.MAX_SAFE_INTEGER }; }
  }));
  return dated.sort((a, b) => a.time - b.time || a.device.udid.localeCompare(b.device.udid))[0]!.device;
}
function line(io: Io, step: string, result: string): void { io.stdout.write(`[preflight] ${step}: ${result}\n`); }
async function daemonHealth(config: Settings): Promise<DaemonHealth | undefined> {
  const host = config.bindAddr === "0.0.0.0" || config.bindAddr === "::" ? "127.0.0.1" : config.bindAddr;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  try {
    const response = await fetch(`http://${urlHost}:${config.port}/healthz`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return;
    const body = await response.json() as DaemonHealth;
    return body.ok === true ? body : undefined;
  } catch { return; }
}
async function currentDevice(config: Settings, udid: string): Promise<SimDevice | undefined> {
  return (await lists(config)).devices.find(value => value.udid === udid);
}
async function deleteIfSafe(config: Settings, udid: string, expected: (device: SimDevice) => boolean, step: string, io: Io): Promise<boolean> {
  const check = async (): Promise<SimDevice | undefined> => {
    const device = await currentDevice(config, udid);
    if (!device) { line(io, step, `skipped ${udid} (device disappeared)`); return; }
    if (!expected(device)) { line(io, step, `skipped ${udid} (current name is ${device.name})`); return; }
    if ((await protectedUdids(config.dbPath, io, false)).has(udid)) { line(io, step, `skipped ${udid} (lease is protected)`); return; }
    return device;
  };
  if (!await check()) return false;
  await command(config, ["shutdown", udid]).catch(() => "");
  if (!await check()) return false;
  await command(config, ["delete", udid]); return true;
}
function runProbe(config: Settings, udid: string, out: string, io: Io): Promise<void> {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn("bash", [config.probe, udid, out], { env: config.childEnv });
    child.stdout.on("data", chunk => io.stdout.write(String(chunk))); child.stderr.on("data", chunk => io.stderr.write(String(chunk)));
    child.once("error", rejectProbe); child.once("close", (code, signal) => code === 0 ? resolveProbe() : rejectProbe(new Error(`probe exited ${code ?? signal}`)));
  });
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = process): Promise<number> {
  const usage = "usage: sim-preflight [--dry-run] [--json]\n";
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { io.stdout.write(usage); return 0; }
  const dryRun = argv.includes("--dry-run"), json = argv.includes("--json");
  if (argv.some(arg => arg !== "--dry-run" && arg !== "--json")) { io.stderr.write(usage); return 2; }
  if (!env.IOS_SIM_RUNTIME?.trim()) { line(io, "config", "FAILED (IOS_SIM_RUNTIME is required)"); return 1; }
  if (!env.IOS_SIM_DEVICE_TYPE?.trim()) { line(io, "config", "FAILED (IOS_SIM_DEVICE_TYPE is required)"); return 1; }
  const config = settings(env); const report: Report = { orphansSwept: 0, probe: dryRun ? "skipped" : "FAILED", dryRun };
  try {
    const listed = await lists(config);
    const runtime = listed.runtimes.find(value => value.isAvailable !== false && (value.name === config.runtime || value.identifier === config.runtime));
    if (!runtime) throw new Error(`runtime unavailable: ${config.runtime}`);
    const deviceType = listed.types.find(value => value.name === config.deviceType || value.identifier === config.deviceType);
    if (!deviceType) throw new Error(`device type unavailable: ${config.deviceType}`);
    line(io, "resolve", `runtime=${runtime.identifier} device_type=${deviceType.identifier}`);
    const name = goldenDeviceName(deviceType.identifier, runtime.identifier);
    const matches = listed.devices.filter(value => value.runtimeId === runtime.identifier && value.name === name && value.isAvailable !== false);
    const health = await daemonHealth(config);
    const daemonSimAvailable = health?.sim?.available === true;
    if (daemonSimAvailable) {
      if (matches[0]) report.golden = matches[0].udid;
      report.disposition = "skipped"; report.probe = "skipped";
      line(io, "golden", "skipped (daemon running with the simulator capability)");
      line(io, "orphans", "skipped (daemon running — the reaper owns sweeps)");
      for (const candidate of listed.devices.filter(value => LEASE_NAME.test(value.name)))
        line(io, "orphan-candidate", `${candidate.udid} ${candidate.name}`);
      line(io, "probe", "skipped (daemon running with the simulator capability — stop it or run preflight before enabling)");
      if (json) io.stdout.write(`${JSON.stringify(report)}\n`);
      io.stdout.write(`RESULT golden=${report.golden ?? "none"} skipped orphans_swept=0 probe=skipped\n`);
      return 0;
    }
    const protectedSet = await protectedUdids(config.dbPath, io);
    const protectedGolden = matches.filter(value => protectedSet.has(value.udid));
    const orphanCandidates = listed.devices.filter(value => LEASE_NAME.test(value.name) && !protectedSet.has(value.udid));
    if (protectedGolden.some(value => value.state !== "Shutdown"))
      throw new Error(`protected golden device is not Shutdown: ${protectedGolden.find(value => value.state !== "Shutdown")!.udid}`);
    if (protectedGolden.length > 1) throw new Error(`multiple protected golden devices found: ${protectedGolden.map(value => value.udid).join(", ")}`);
    if (dryRun) {
      const keep = protectedGolden[0] ?? matches[0];
      line(io, "golden", keep ? `would adopt ${keep.udid}; would remove ${matches.filter(value => value.udid !== keep.udid && !protectedSet.has(value.udid)).length} duplicates` : `would create ${name}`);
      line(io, "orphans", `would sweep ${orphanCandidates.length}`);
    } else {
      let golden: SimDevice;
      if (!matches.length) {
        const udid = await command(config, ["create", name, deviceType.identifier, runtime.identifier]);
        golden = { udid, name, state: "Shutdown", runtimeId: runtime.identifier }; report.disposition = "created";
      } else {
        golden = protectedGolden[0] ?? await oldest(matches); report.disposition = "adopted";
        for (const duplicate of matches.filter(value => value.udid !== golden.udid && !protectedSet.has(value.udid)))
          await deleteIfSafe(config, duplicate.udid, device => device.name === name, "golden-duplicate", io);
      }
      if (golden.state !== "Shutdown") await command(config, ["shutdown", golden.udid]);
      report.golden = golden.udid; line(io, "golden", `${report.disposition} ${golden.udid}`);
      for (const orphan of orphanCandidates) {
        if (await deleteIfSafe(config, orphan.udid, device => LEASE_NAME.test(device.name), "orphan", io)) report.orphansSwept++;
      }
      line(io, "orphans", `swept ${report.orphansSwept}`);
      const out = await mkdtemp(join(tmpdir(), "sim-preflight-"));
      await runProbe(config, golden.udid, out, io);
      report.probe = "ok"; line(io, "probe", "ok");
    }
    if (json) io.stdout.write(`${JSON.stringify(report)}\n`);
    io.stdout.write(`RESULT golden=${report.golden ?? "planned"} ${report.disposition ?? "dry-run"} orphans_swept=${report.orphansSwept} probe=${report.probe}\n`);
    return 0;
  } catch (error) {
    line(io, "failed", error instanceof Error ? error.message : String(error));
    if (json) io.stdout.write(`${JSON.stringify(report)}\n`);
    io.stdout.write(`RESULT golden=${report.golden ?? "none"} ${report.disposition ?? "failed"} orphans_swept=${report.orphansSwept} probe=FAILED\n`);
    return 1;
  }
}

if (process.argv[1]) {
  try { if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2)); }
  catch {}
}
