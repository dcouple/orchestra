import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { EventLog } from "../dist/eventlog.js";
import { detectSimCapability, SimCapacityError, SimPool, SimReaper, Simctl, writeSimContext } from "../dist/sim.js";
import { WebhookServer } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";

function option(name, fallback) {
  const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : fallback;
}
const runtime = option("--runtime"); const deviceType = option("--device-type");
if (!runtime || !deviceType) { console.error("usage: node ops/sim-host-check.mjs --runtime <runtime> --device-type <type> [--max 2] [--artifacts dir] [--serve]"); process.exit(2); }
const serve = process.argv.includes("--serve");
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
  if (serve) {
    const serverConfig = loadConfig({ DAEMON_TEST_MODE: "1", SESSIONS_ENABLED: "0", PLANNER_WEBHOOK_SECRET: "p", PLANNER_LINEAR_TOKEN: "p",
      IMPLEMENTER_WEBHOOK_SECRET: "i", IMPLEMENTER_LINEAR_TOKEN: "i", DB_PATH: dbPath, ARTIFACTS_DIR: artifactsDir });
    const server = new WebhookServer({ config: { ...serverConfig, bindAddr: "127.0.0.1", port: 0 }, log, sim: pool });
    const address = await server.listen();
    const adapter = createServer(async (request, response) => {
      const upstream = await fetch(`http://127.0.0.1:${address.port}${request.url}`, {
        method: request.method, headers: request.headers,
        ...(request.method === "POST" ? { body: await new Promise(resolveBody => { const chunks = []; request.on("data", chunk => chunks.push(chunk)); request.on("end", () => resolveBody(Buffer.concat(chunks))); }) } : {}),
      });
      const body = await upstream.json(); response.statusCode = upstream.status; response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.method === "GET" && Array.isArray(body.leases) ? body.leases : body));
    });
    await new Promise((resolveListen, rejectListen) => { adapter.once("error", rejectListen); adapter.listen(0, "127.0.0.1", resolveListen); });
    const adapterAddress = adapter.address(); if (!adapterAddress || typeof adapterAddress === "string") throw new Error("adapter address unavailable");
    const context = await writeSimContext(config, pool, turn.id, turn.linearSessionId, `http://127.0.0.1:${adapterAddress.port}`);
    console.log(`ORCHESTRA_SIM_CONTEXT=${context}`);
    await new Promise(resolveStop => { process.once("SIGINT", resolveStop); process.once("SIGTERM", resolveStop); });
    await new Promise((resolveClose, rejectClose) => adapter.close(error => error ? rejectClose(error) : resolveClose())); await server.close();
    console.log("RESULT ok");
    process.exitCode = 0;
  } else {
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
  }
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
