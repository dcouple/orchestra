import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import { WebhookServer } from "../src/server.js";
import { detectSimCapability, SimCapacityError, SimPool, SimReaper, Simctl, SimTurnLimitError } from "../src/sim.js";

const dirs: string[] = [];
const baseEnv = { DAEMON_TEST_MODE: "1", SESSIONS_ENABLED: "0", PLANNER_WEBHOOK_SECRET: "p",
  PLANNER_LINEAR_TOKEN: "pt", IMPLEMENTER_WEBHOOK_SECRET: "i", IMPLEMENTER_LINEAR_TOKEN: "it" };
afterEach(() => { delete process.env.PLANNER_WEBHOOK_SECRET;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(max = 5) {
  const dir = mkdtempSync(join(tmpdir(), "sim-test-")); dirs.push(dir);
  const developerDir = join(dir, "Xcode"); mkdirSync(join(developerDir, "usr/bin"), { recursive: true });
  const xcodebuild = join(developerDir, "usr/bin/xcodebuild"); writeFileSync(xcodebuild, "#!/bin/sh\n"); chmodSync(xcodebuild, 0o755);
  const runtime = { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", name: "iOS 26.5", isAvailable: true };
  const deviceType = { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", name: "iPhone 17" };
  const golden = { udid: "GOLDEN", name: "orchestra-golden-iphone-17-ios-26-5", state: "Shutdown",
    runtimeId: runtime.identifier, deviceTypeIdentifier: deviceType.identifier };
  const statePath = join(dir, "state.json"), callLog = join(dir, "calls.jsonl"), envLog = join(dir, "env.jsonl");
  writeFileSync(statePath, JSON.stringify({ runtimes: [runtime], devicetypes: [deviceType], devices: [golden], failures: {} }));
  const config = loadConfig({ ...baseEnv, DB_PATH: join(dir, "events.db"), ARTIFACTS_DIR: join(dir, "artifacts"),
    IOS_SIM_ENABLED: "1", IOS_SIM_RUNTIME: runtime.name, IOS_SIM_DEVICE_TYPE: deviceType.name,
    IOS_SIM_DEVELOPER_DIR: developerDir, XCODEBUILD_MCP_BIN: process.execPath,
    IOS_SIM_MAX_CONCURRENT: String(max), IOS_SIM_SIMCTL_BIN: `${process.execPath} ${resolve("test/fixtures/fake-simctl.mjs")}` });
  const simctlEnv = { DEVELOPER_DIR: developerDir, FAKE_SIMCTL_STATE: statePath, FAKE_SIMCTL_LOG: callLog, FAKE_SIMCTL_ENV_LOG: envLog };
  const log = new EventLog(config.dbPath); const simctl = new Simctl(config.simctlArgv, simctlEnv);
  return { dir, config, log, simctl, simctlEnv, statePath, callLog, envLog, runtime, deviceType, golden };
}
function turn(log: EventLog, session = `session-${Math.random()}`) {
  log.append({ deliveryId: session, app: "planner", action: "created", agentSessionId: session,
    issueId: `issue-${session}`, issueIdentifier: "SIM-1", receivedAt: Date.now(), rawBody: Buffer.from("{}") });
  return log.claimNextTurn()!;
}
const calls = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) : [];

describe.sequential("simulator capability and pool", () => {
  it("scrubs daemon secrets from simctl children and failure logs", async () => {
    process.env.PLANNER_WEBHOOK_SECRET = "x";
    const value = setup(); const current = turn(value.log, "secret-test");
    const capability = await detectSimCapability(value.config, value.simctl);
    const state = JSON.parse(readFileSync(value.statePath, "utf8")); state.failures.boot = "boot failed";
    writeFileSync(value.statePath, JSON.stringify(state));
    const logger = { log: vi.fn(), error: vi.fn() };
    const pool = new SimPool(value.log, value.simctl, value.config, capability, { logger });
    await expect(pool.acquire(current.id, current.linearSessionId)).rejects.toMatchObject({ kind: "sim_failed" });
    const childEnvs = readFileSync(value.envLog, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, string>);
    expect(childEnvs.length).toBeGreaterThan(0);
    expect(childEnvs.every(env => env.PLANNER_WEBHOOK_SECRET === undefined)).toBe(true);
    expect(logger.error.mock.calls.map(call => String(call[0])).join("\n")).not.toContain("x");
    value.log.close();
  });

  it("AC2 returns every typed prerequisite failure and the HTTP route preserves its kind", async () => {
    for (const kind of ["xcode_unavailable", "runtime_unavailable", "mcp_unavailable", "golden_unavailable"] as const) {
      const value = setup(); const t = turn(value.log);
      const config: Config = { ...value.config,
        ...(kind === "xcode_unavailable" ? { iosSimDeveloperDir: join(value.dir, "missing") } : {}),
        ...(kind === "runtime_unavailable" ? { iosSimRuntime: "missing" } : {}),
        ...(kind === "mcp_unavailable" ? { xcodebuildMcpBin: join(value.dir, "missing-mcp") } : {}) };
      if (kind === "golden_unavailable") { const state = JSON.parse(readFileSync(value.statePath, "utf8")); state.devices = []; writeFileSync(value.statePath, JSON.stringify(state)); }
      const simctl = new Simctl(config.simctlArgv, { ...value.simctlEnv, DEVELOPER_DIR: config.iosSimDeveloperDir });
      const capability = await detectSimCapability(config, simctl); expect(capability).toMatchObject({ available: false, kind });
      const pool = new SimPool(value.log, simctl, config, capability); const token = pool.issueTurnToken(t.id);
      const server = new WebhookServer({ config: { ...config, port: 0 }, log: value.log, sim: pool }); const address = await server.listen();
      expect(await (await fetch(`http://127.0.0.1:${address.port}/healthz`)).json()).toMatchObject({
        ok: true, sim: { enabled: true, available: false, kind },
      });
      const response = await fetch(`http://127.0.0.1:${address.port}/sim/leases`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ turnId: t.id }) });
      expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { kind } });
      const status = await fetch(`http://127.0.0.1:${address.port}/sim/leases?turnId=${t.id}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(status.status).toBe(503); expect(await status.json()).toMatchObject({ error: { kind } });
      if (kind === "golden_unavailable") {
        const restored = JSON.parse(readFileSync(value.statePath, "utf8")); restored.devices = [value.golden];
        writeFileSync(value.statePath, JSON.stringify(restored));
        await expect(pool.acquire(t.id, t.linearSessionId)).rejects.toMatchObject({ kind: "golden_unavailable" });
      }
      await server.close(); value.log.close();
    }
  });

  it("AC3/AC4/AC5 clones and boots two leases, enforces the turn limit, and releases without deleting evidence", async () => {
    const value = setup(5), t = turn(value.log); const capability = await detectSimCapability(value.config, value.simctl);
    const pool = new SimPool(value.log, value.simctl, value.config, capability);
    const first = await pool.acquire(t.id, t.linearSessionId); const second = await pool.acquire(t.id, t.linearSessionId);
    expect(first).toMatchObject({ name: `orchestra-${t.id}-1`, lease: 1 }); expect(existsSync(first.evidenceDir)).toBe(true);
    expect(first.evidenceDir).toBe(join(resolve(value.config.artifactsDir), "sim", t.linearSessionId, String(t.id), "lease-1"));
    expect(value.log.simLeaseByUdid(first.udid)?.state).toBe("booted");
    await expect(pool.acquire(t.id, t.linearSessionId)).rejects.toBeInstanceOf(SimTurnLimitError);
    expect(calls(value.callLog).filter(call => call[0] === "clone")).toHaveLength(2);
    expect(calls(value.callLog).filter(call => ["clone", "boot", "bootstatus"].includes(call[0]!)).slice(0, 3).map(call => call[0]))
      .toEqual(["clone", "boot", "bootstatus"]);
    await pool.release(t.id, first.udid); expect(value.log.simLeaseByUdid(first.udid)?.state).toBe("released");
    expect(calls(value.callLog).filter(call => ["shutdown", "delete"].includes(call[0]!)).slice(-2).map(call => call[0]))
      .toEqual(["shutdown", "delete"]);
    expect(existsSync(first.evidenceDir)).toBe(true);
    await expect(pool.release(t.id + 1, second.udid)).rejects.toMatchObject({ kind: "lease_not_owned" });
    await pool.release(t.id, second.udid); value.log.close();
  });

  it("AC4 enforces global capacity before invoking clone", async () => {
    const value = setup(2), one = turn(value.log, "one"), two = turn(value.log, "two"), three = turn(value.log, "three");
    const capability = await detectSimCapability(value.config, value.simctl); const pool = new SimPool(value.log, value.simctl, value.config, capability);
    const leases = [await pool.acquire(one.id, one.linearSessionId), await pool.acquire(two.id, two.linearSessionId)];
    const started = Date.now(); await expect(pool.acquire(three.id, three.linearSessionId)).rejects.toBeInstanceOf(SimCapacityError);
    expect(Date.now() - started).toBeLessThan(2000); expect(calls(value.callLog).filter(call => call[0] === "clone")).toHaveLength(2);
    await pool.release(one.id, leases[0]!.udid); await pool.release(two.id, leases[1]!.udid); value.log.close();
  });

  it("fails acquire closed until startup reconciliation completes", async () => {
    const value = setup(2), current = turn(value.log, "reconciliation-pending");
    const capability = await detectSimCapability(value.config, value.simctl);
    const pool = new SimPool(value.log, value.simctl, value.config, capability, { reconciled: false });
    const token = pool.issueTurnToken(current.id);
    const server = new WebhookServer({ config: { ...value.config, port: 0 }, log: value.log, sim: pool }); const address = await server.listen();
    const response = await fetch(`http://127.0.0.1:${address.port}/sim/leases`, { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ turnId: current.id }) });
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({
      error: { kind: "sim_not_ready", message: "device pool reconciliation pending" },
    });
    const status = await fetch(`http://127.0.0.1:${address.port}/sim/leases?turnId=${current.id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(status.status).toBe(503); expect(await status.json()).toMatchObject({ error: { kind: "sim_not_ready" } });
    expect(calls(value.callLog).filter(call => call[0] === "clone")).toHaveLength(0);
    await server.close(); value.log.close();
  });

  it("adopts startup orphans before allowing capacity-checked acquisition", async () => {
    const value = setup(2), current = turn(value.log, "startup-orphans");
    const state = JSON.parse(readFileSync(value.statePath, "utf8"));
    state.devices.push({ ...value.golden, udid: "ORPHAN-1", name: "orchestra-91-1", state: "Booted" });
    state.devices.push({ ...value.golden, udid: "ORPHAN-2", name: "orchestra-92-1", state: "Booted" });
    writeFileSync(value.statePath, JSON.stringify(state));
    const capability = await detectSimCapability(value.config, value.simctl);
    const pool = new SimPool(value.log, value.simctl, value.config, capability, { reconciled: false });
    const reaper = new SimReaper(value.log, value.simctl,
      { intervalMs: 10, idleTimeoutMs: 900_000, now: () => 1000, pool });
    await expect(reaper.reconcileOnce()).resolves.toBe(true);
    expect(value.log.openSimLeases()).toEqual(expect.arrayContaining([
      expect.objectContaining({ udid: "ORPHAN-1", state: "orphan" }),
      expect.objectContaining({ udid: "ORPHAN-2", state: "orphan" }),
    ]));
    await expect(pool.acquire(current.id, current.linearSessionId)).rejects.toBeInstanceOf(SimCapacityError);
    expect(calls(value.callLog).filter(call => call[0] === "clone")).toHaveLength(0); value.log.close();
  });

  it("serializes concurrent HTTP acquisitions at the global capacity boundary", async () => {
    const value = setup(2); const turns = Array.from({ length: 6 }, (_, index) => turn(value.log, `concurrent-${index}`));
    const capability = await detectSimCapability(value.config, value.simctl); const pool = new SimPool(value.log, value.simctl, value.config, capability);
    const server = new WebhookServer({ config: { ...value.config, port: 0 }, log: value.log, sim: pool }); const address = await server.listen();
    const responses = await Promise.all(turns.map(async current => fetch(`http://127.0.0.1:${address.port}/sim/leases`, { method: "POST",
      headers: { Authorization: `Bearer ${pool.issueTurnToken(current.id)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ turnId: current.id }) })));
    expect(responses.filter(response => response.status === 200)).toHaveLength(2);
    expect(responses.filter(response => response.status === 409)).toHaveLength(4);
    expect(calls(value.callLog).filter(call => call[0] === "clone")).toHaveLength(2);
    const leases = value.log.openSimLeases();
    for (const lease of leases) await pool.release(lease.turnId!, lease.udid!);
    await server.close(); value.log.close();
  });

  it("leaves a cloned device open when boot and cleanup fail so the reaper retries it", async () => {
    const value = setup(), current = turn(value.log, "cleanup-retry"); let now = 1000;
    const capability = await detectSimCapability(value.config, value.simctl); const pool = new SimPool(value.log, value.simctl, value.config, capability, { now: () => now });
    const state = JSON.parse(readFileSync(value.statePath, "utf8")); state.failures = { boot: "boot failed", delete: "delete failed" };
    writeFileSync(value.statePath, JSON.stringify(state));
    await expect(pool.acquire(current.id, current.linearSessionId)).rejects.toMatchObject({ kind: "sim_failed" });
    const row = value.log.openSimLeases()[0]!; expect(row.state).toBe("creating"); expect(row.udid).toBeTruthy();
    const retry = JSON.parse(readFileSync(value.statePath, "utf8")); retry.failures = {}; writeFileSync(value.statePath, JSON.stringify(retry));
    value.log.finishTurn(current.id, "response", "done", now); now = 1200;
    const reaper = new SimReaper(value.log, value.simctl, { intervalMs: 10, idleTimeoutMs: 100, now: () => now });
    await reaper.sweep(); expect(value.log.simLeaseByUdid(row.udid!)?.state).toBe("reaped");
    expect((JSON.parse(readFileSync(value.statePath, "utf8")) as { devices: Array<{ udid: string }> }).devices.some(device => device.udid === row.udid)).toBe(false);
    value.log.close();
  });

  it("AC6/AC7 reaps idle and orphan devices, retries delete failures, and protects live turns and non-lease devices", async () => {
    const value = setup(5), live = turn(value.log, "live"), creatingTurn = turn(value.log, "creating"); let now = 1000;
    const capability = await detectSimCapability(value.config, value.simctl); const pool = new SimPool(value.log, value.simctl, value.config, capability, { now: () => now });
    const lease = await pool.acquire(live.id, live.linearSessionId);
    const creating = value.log.reserveSimLease(creatingTurn.id, creatingTurn.linearSessionId, 5, now);
    value.log.finishTurn(creatingTurn.id, "response", "done", now);
    const state = JSON.parse(readFileSync(value.statePath, "utf8")); state.devices.push({ ...value.golden, udid: "ORPHAN", name: "orchestra-7-1", state: "Booted" });
    state.devices.push({ ...value.golden, udid: "CREATING", name: creating.name, state: "Booted" });
    state.devices.push({ ...value.golden, udid: "STOCK", name: "iPhone 17", state: "Booted" }); writeFileSync(value.statePath, JSON.stringify(state));
    const logger = { log: vi.fn(), error: vi.fn() }; const reaper = new SimReaper(value.log, value.simctl,
      { intervalMs: 10, idleTimeoutMs: 100, now: () => now, logger });
    await reaper.sweep(); expect(value.log.simLeaseByName(creating.name)?.udid).toBe("CREATING"); now = 1200; await reaper.sweep();
    expect(value.log.simLeaseByUdid(lease.udid)?.state).toBe("booted"); expect(value.log.simLeaseByUdid(lease.udid)?.lastLiveAt).toBe(1200);
    expect(value.log.simLeaseByUdid("ORPHAN")?.state).toBe("reaped");
    expect(calls(value.callLog).filter(call => call[0] === "delete").flat()).not.toContain("GOLDEN");
    expect(calls(value.callLog).filter(call => call[0] === "delete").flat()).not.toContain("STOCK");
    value.log.finishTurn(live.id, "response", "done", now); now = 1400;
    const failed = JSON.parse(readFileSync(value.statePath, "utf8")); failed.failures.delete = "injected delete failure"; writeFileSync(value.statePath, JSON.stringify(failed));
    await reaper.sweep(); expect(value.log.simLeaseByUdid(lease.udid)).toMatchObject({ state: "booted", reapAttempts: 1 });
    expect(logger.error.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "sim_reaper_error", sweepId: expect.any(String), attempt: 1, udid: lease.udid }),
    ]));
    const retry = JSON.parse(readFileSync(value.statePath, "utf8")); delete retry.failures.delete; writeFileSync(value.statePath, JSON.stringify(retry));
    await reaper.sweep(); expect(value.log.simLeaseByUdid(lease.udid)).toMatchObject({ state: "reaped", reapAttempts: 2 });
    expect(logger.log.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "sim_lease_reaped", sweepId: expect.any(String), attempt: 2, udid: lease.udid }),
    ])); value.log.close();
  });

  it("refuses release and reap when a corrupt lease row points at the golden device", async () => {
    const value = setup(), current = turn(value.log, "corrupt-golden"); let now = 1000;
    const capability = await detectSimCapability(value.config, value.simctl); const logger = { log: vi.fn(), error: vi.fn() };
    const pool = new SimPool(value.log, value.simctl, value.config, capability, { now: () => now, logger });
    const row = value.log.reserveSimLease(current.id, current.linearSessionId, 5, now); value.log.attachSimDevice(row.id, "GOLDEN");
    await expect(pool.release(current.id, "GOLDEN")).rejects.toMatchObject({ kind: "sim_failed" });
    value.log.finishTurn(current.id, "response", "done", now); now = 1200;
    const reaper = new SimReaper(value.log, value.simctl, { intervalMs: 10, idleTimeoutMs: 100, now: () => now, logger });
    await expect(reaper.sweep()).resolves.toBeUndefined();
    expect(value.log.simLeaseByUdid("GOLDEN")?.state).toBe("creating");
    expect((JSON.parse(readFileSync(value.statePath, "utf8")) as { devices: Array<{ udid: string }> }).devices.some(device => device.udid === "GOLDEN")).toBe(true);
    expect(calls(value.callLog).filter(call => call[0] === "delete").flat()).not.toContain("GOLDEN");
    expect(logger.error.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([
      expect.stringContaining("sim_release_failed"), expect.stringContaining("sim_reaper_error"),
    ]));
    value.log.close();
  });

  it("makes repeated identical sweeps idempotent and logs sweep and attempt identities", async () => {
    const value = setup(), current = turn(value.log, "idempotent"); let now = 1000;
    const capability = await detectSimCapability(value.config, value.simctl); const pool = new SimPool(value.log, value.simctl, value.config, capability, { now: () => now });
    const lease = await pool.acquire(current.id, current.linearSessionId); value.log.finishTurn(current.id, "response", "done", now); now = 1200;
    const logger = { log: vi.fn(), error: vi.fn() }; const reaper = new SimReaper(value.log, value.simctl,
      { intervalMs: 10, idleTimeoutMs: 100, now: () => now, logger });
    await reaper.sweep(); await reaper.sweep();
    expect(calls(value.callLog).filter(call => call[0] === "delete" && call[1] === lease.udid)).toHaveLength(1);
    const reaped = logger.log.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter(entry => entry.event === "sim_lease_reaped");
    expect(reaped).toHaveLength(1); expect(reaped[0]).toMatchObject({ sweepId: "1", attempt: 1, udid: lease.udid });
    expect(value.log.simLeaseByUdid(lease.udid)?.reapAttempts).toBe(1);
    expect([...logger.log.mock.calls, ...logger.error.mock.calls].map(call => JSON.parse(String(call[0]))))
      .toEqual(expect.arrayContaining([expect.objectContaining({ sweepId: expect.any(String) })]));
    value.log.close();
  });

  it("always resolves a failed sweep and recovers on the next sweep", async () => {
    const value = setup(); const logger = { log: vi.fn(), error: vi.fn() }; const reaper = new SimReaper(value.log, value.simctl,
      { intervalMs: 10, idleTimeoutMs: 100, logger });
    vi.spyOn(value.log, "openSimLeases").mockImplementationOnce(() => { throw new Error("lease listing failed"); });
    await expect(reaper.sweep()).resolves.toBeUndefined(); await expect(reaper.sweep()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("sim_reaper_error"));
    expect(JSON.parse(String(logger.error.mock.calls[0]![0]))).toMatchObject({ sweepId: "1", step: "sweep", error: "lease listing failed" });
    value.log.close();
  });

  it("routes require tokens, scope status by turn, recheck readiness, and expose release errors", async () => {
    const value = setup(2), first = turn(value.log, "route-one"), second = turn(value.log, "route-two");
    const capability = await detectSimCapability(value.config, value.simctl); const pool = new SimPool(value.log, value.simctl, value.config, capability);
    const token1 = pool.issueTurnToken(first.id), token2 = pool.issueTurnToken(second.id);
    const server = new WebhookServer({ config: { ...value.config, port: 0 }, log: value.log, sim: pool }); const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}/sim/leases`;
    expect(await (await fetch(`http://127.0.0.1:${address.port}/healthz`)).json()).toMatchObject({ ok: true, sim: { enabled: true, available: true } });
    expect((await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnId: first.id }) })).status).toBe(401);
    const acquiredResponse = await fetch(base, { method: "POST", headers: { Authorization: `Bearer ${token1}`, "Content-Type": "application/json" }, body: JSON.stringify({ turnId: first.id }) });
    expect(acquiredResponse.status).toBe(200); const acquired = await acquiredResponse.json() as { udid: string };
    const secondResponse = await fetch(base, { method: "POST", headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" }, body: JSON.stringify({ turnId: second.id }) });
    expect(secondResponse.status).toBe(200); const secondLease = await secondResponse.json() as { udid: string };
    const firstStatus = await fetch(`${base}?turnId=${first.id}`, { headers: { Authorization: `Bearer ${token1}` } });
    const secondStatus = await fetch(`${base}?turnId=${second.id}`, { headers: { Authorization: `Bearer ${token2}` } });
    expect((await firstStatus.json() as { leases: Array<{ udid: string }> }).leases.map(row => row.udid)).toEqual([acquired.udid]);
    expect((await secondStatus.json() as { leases: Array<{ udid: string }> }).leases.map(row => row.udid)).toEqual([secondLease.udid]);
    const state = JSON.parse(readFileSync(value.statePath, "utf8")); state.devices = state.devices.filter((device: { udid: string }) => device.udid !== "GOLDEN");
    writeFileSync(value.statePath, JSON.stringify(state));
    const notReady = await fetch(`${base}?turnId=${first.id}`, { headers: { Authorization: `Bearer ${token1}` } });
    expect(notReady.status).toBe(503); expect(await notReady.json()).toMatchObject({ error: { kind: "golden_unavailable" } });
    expect((await fetch(`${base}/${acquired.udid}?turnId=${second.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token2}` } })).status).toBe(403);
    expect((await fetch(`${base}/${acquired.udid}?turnId=${first.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token1}` } })).status).toBe(200);
    expect((await fetch(`${base}/${secondLease.udid}?turnId=${second.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token2}` } })).status).toBe(200);
    await server.close(); value.log.close();
  });
});
