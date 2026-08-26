import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventLog } from "../dist/eventlog.js";
import { detectSimCapability, SimCapacityError, SimPool, SimReaper, Simctl } from "../dist/sim.js";

function option(name, fallback) {
  const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : fallback;
}
const runtime = option("--runtime"); const deviceType = option("--device-type");
if (!runtime || !deviceType) { console.error("usage: node ops/sim-host-check.mjs --runtime <runtime> --device-type <type> [--max 2] [--artifacts dir]"); process.exit(2); }
const max = Number(option("--max", "2"));
const artifactsDir = resolve(option("--artifacts", await mkdtemp(join(tmpdir(), "orchestra-sim-host-check-"))));
await mkdir(artifactsDir, { recursive: true });
const config = {
  iosSimEnabled: true, iosSimRuntime: runtime, iosSimDeviceType: deviceType,
  iosSimDeveloperDir: process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer",
  xcodebuildMcpBin: process.env.XCODEBUILD_MCP_BIN || "/usr/local/bin/xcodebuildmcp",
  iosSimMaxConcurrent: max, artifactsDir,
};
const simctl = new Simctl(["xcrun", "simctl"], { DEVELOPER_DIR: config.iosSimDeveloperDir });
const dbPath = join(artifactsDir, `sim-host-check-${process.pid}.db`); const log = new EventLog(dbPath);
log.append({ deliveryId: `host-check-${process.pid}`, app: "planner", action: "created", agentSessionId: "sim-host-check",
  issueId: "sim-host-check", issueIdentifier: "SIM-HOST", receivedAt: Date.now(), rawBody: Buffer.from("{}") });
const turn = log.claimNextTurn(); const acquired = [];
try {
  if (!turn) throw new Error("failed to create synthetic running turn");
  const capability = await detectSimCapability(config, simctl); console.log(`CAPABILITY ${JSON.stringify(capability)}`);
  if (!capability.available) throw new Error(`capability unavailable: ${capability.kind}`);
  const pool = new SimPool(log, simctl, config, capability, { reconciled: false });
  const reaper = new SimReaper(log, simctl, { intervalMs: 60_000, idleTimeoutMs: 900_000, pool });
  if (!await reaper.reconcileOnce()) throw new Error("initial device pool reconciliation failed");
  acquired.push(await pool.acquire(turn.id, turn.linearSessionId)); console.log(`ACQUIRE 1 ${JSON.stringify(acquired[0])}`);
  acquired.push(await pool.acquire(turn.id, turn.linearSessionId)); console.log(`ACQUIRE 2 ${JSON.stringify(acquired[1])}`);
  const started = Date.now(); let capacityKind;
  try { await pool.acquire(turn.id, turn.linearSessionId); }
  catch (error) { if (error instanceof SimCapacityError) capacityKind = error.kind; else throw error; }
  const elapsed = Date.now() - started; console.log(`ACQUIRE 3 ${JSON.stringify({ kind: capacityKind, elapsedMs: elapsed })}`);
  if (capacityKind !== "sim_capacity" || elapsed >= 2000) throw new Error(`third acquire did not fail fast with sim_capacity (${capacityKind}, ${elapsed}ms)`);
  const booted = (await simctl.listDevices()).filter(device => acquired.some(lease => lease.udid === device.udid));
  console.log(`BOOTED ${JSON.stringify(booted.map(device => ({ udid: device.udid, name: device.name, state: device.state })))}`);
  if (booted.length !== 2 || booted.some(device => device.state !== "Booted")) throw new Error("expected two booted clones");
  for (const lease of acquired) { await pool.release(turn.id, lease.udid); console.log(`RELEASE ${JSON.stringify({ udid: lease.udid, evidenceDir: lease.evidenceDir })}`); }
  const remaining = (await simctl.listDevices()).filter(device => acquired.some(lease => lease.udid === device.udid));
  const evidence = await Promise.all(acquired.map(async lease => ({ path: lease.evidenceDir,
    exists: await import("node:fs/promises").then(fs => fs.stat(lease.evidenceDir).then(() => true, () => false)) })));
  console.log(`PROOF ${JSON.stringify({ remaining, evidence })}`);
  if (remaining.length || evidence.some(value => !value.exists)) throw new Error("cleanup/evidence expectation failed");
  console.log("RESULT ok");
} catch (error) {
  console.error(`RESULT failed ${error instanceof Error ? error.stack ?? error.message : String(error)}`); process.exitCode = 1;
} finally {
  if (turn) {
    const pool = new SimPool(log, simctl, config, { available: false, kind: "disabled" });
    for (const lease of acquired) await pool.release(turn.id, lease.udid).catch(async () => {
      await simctl.shutdown(lease.udid).catch(() => {}); await simctl.delete(lease.udid).catch(() => {});
    });
  }
  log.close();
}
