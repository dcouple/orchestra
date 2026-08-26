import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { EventLog } from "../src/eventlog.js";
import { main } from "../src/sim-preflight.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
interface Hooks { renameAfterList?: { list: number; udid: string; name: string }; delayAfterList?: { list: number; ms: number } }
function setup(devices: Array<{ udid: string; name: string; state: string }> = [], hooks: Hooks = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sim-preflight-test-")); dirs.push(dir);
  const runtime = { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", name: "iOS 26.5", isAvailable: true };
  const type = { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", name: "iPhone 17" };
  const state = join(dir, "state.json"), calls = join(dir, "calls");
  writeFileSync(state, JSON.stringify({ runtimes: [runtime], types: [type], devices: devices.map(value => ({ ...value, runtimeId: runtime.identifier })), hooks, deviceLists: 0 }));
  const simctl = join(dir, "simctl.mjs");
  writeFileSync(simctl, `import fs from "node:fs"; const p=${JSON.stringify(state)}, calls=${JSON.stringify(calls)}, a=process.argv.slice(2), s=JSON.parse(fs.readFileSync(p)); fs.appendFileSync(calls,JSON.stringify(a)+"\\n");
if(a[0]==="list"){if(a[1]==="runtimes")console.log(JSON.stringify({runtimes:s.runtimes}));else if(a[1]==="devicetypes")console.log(JSON.stringify({devicetypes:s.types}));else{s.deviceLists++;const r=s.hooks.renameAfterList;if(r&&r.list===s.deviceLists){const v=s.devices.find(v=>v.udid===r.udid);if(v)v.name=r.name;}fs.writeFileSync(p,JSON.stringify(s));const dly=s.hooks.delayAfterList;if(dly&&dly.list===s.deviceLists)await new Promise(r=>setTimeout(r,dly.ms));const d={};for(const v of s.devices)(d[v.runtimeId]??=[]).push(v);console.log(JSON.stringify({devices:d}));}}
else if(a[0]==="create"){s.devices.push({udid:"CREATED",name:a[1],state:"Shutdown",runtimeId:a[3]});fs.writeFileSync(p,JSON.stringify(s));console.log("CREATED");}
else {const i=s.devices.findIndex(v=>v.udid===a[1]);if(i<0)process.exit(1);if(a[0]==="delete")s.devices.splice(i,1);else if(a[0]==="shutdown")s.devices[i].state="Shutdown";fs.writeFileSync(p,JSON.stringify(s));}`);
  const probe = join(dir, "probe.sh"); writeFileSync(probe, "#!/bin/sh\necho 'RESULT install=ok screenshot=ok snapshot_ui=ok'\n"); chmodSync(probe, 0o755);
  const env = { ...process.env, IOS_SIM_RUNTIME: runtime.name, IOS_SIM_DEVICE_TYPE: type.name,
    IOS_SIM_SIMCTL_BIN: `${process.execPath} ${simctl}`, SIM_PREFLIGHT_PROBE: probe, DB_PATH: join(dir, "db"), BIND_ADDR: "127.0.0.1", PORT: "1" };
  let stdout = "", stderr = ""; const io = { stdout: { write: (v: string) => { stdout += v; } }, stderr: { write: (v: string) => { stderr += v; } } };
  return { dir, state, calls, probe, env, io, output: () => ({ stdout, stderr }) };
}

describe("sim preflight", () => {
  it("creates a missing golden and runs the probe", async () => {
    const value = setup(); expect(await main([], value.env, value.io)).toBe(0);
    expect(value.output().stdout).toContain("golden: created CREATED");
    expect(value.output().stdout).toContain("leases: none (no database)");
    expect(JSON.parse(readFileSync(value.state, "utf8")).devices).toHaveLength(1);
  });
  it("aborts on a corrupt lease database before deleting a simulator", async () => {
    const name = "orchestra-golden-iphone-17-ios-26-5";
    const value = setup([{ udid: "G1", name, state: "Shutdown" }, { udid: "G2", name, state: "Shutdown" }]);
    writeFileSync(value.env.DB_PATH!, "not sqlite");
    expect(await main([], value.env, value.io)).toBe(1);
    expect(value.output().stdout).toContain("lease database unreadable");
    expect(readFileSync(value.calls, "utf8")).not.toContain('"delete"');
  });
  it("treats an existing database without the lease table as empty", async () => {
    const value = setup(); new Database(value.env.DB_PATH!).close();
    expect(await main([], value.env, value.io)).toBe(0); expect(value.output().stdout).toContain("leases: none (no table)");
  });
  it("keeps a protected shutdown golden and never deletes its UDID", async () => {
    const name = "orchestra-golden-iphone-17-ios-26-5";
    const value = setup([{ udid: "G1", name, state: "Shutdown" }, { udid: "G2", name, state: "Shutdown" }]);
    const log = new EventLog(value.env.DB_PATH!); log.append({ deliveryId: "g", app: "planner", action: "created", agentSessionId: "s", issueId: "i", issueIdentifier: "I-2", receivedAt: 1, rawBody: Buffer.from("{}") });
    const turn = log.claimNextTurn()!; const lease = log.reserveSimLease(turn.id, turn.linearSessionId, 2, 2); log.attachSimDevice(lease.id, "G1"); log.close();
    expect(await main([], value.env, value.io)).toBe(0);
    const calls = readFileSync(value.calls, "utf8"); expect(calls).not.toContain('["delete","G1"]'); expect(calls).toContain('["delete","G2"]');
  });
  it("aborts when a protected golden is booted", async () => {
    const name = "orchestra-golden-iphone-17-ios-26-5"; const value = setup([{ udid: "G1", name, state: "Booted" }, { udid: "G2", name, state: "Shutdown" }]);
    const log = new EventLog(value.env.DB_PATH!); log.append({ deliveryId: "b", app: "planner", action: "created", agentSessionId: "s", issueId: "i", issueIdentifier: "I-3", receivedAt: 1, rawBody: Buffer.from("{}") });
    const turn = log.claimNextTurn()!; const lease = log.reserveSimLease(turn.id, turn.linearSessionId, 2, 2); log.attachSimDevice(lease.id, "G1"); log.close();
    expect(await main([], value.env, value.io)).toBe(1); expect(value.output().stdout).toContain("protected golden device is not Shutdown");
    expect(readFileSync(value.calls, "utf8")).not.toContain('"delete"');
  });
  it("adopts, shuts down, deduplicates, and sweeps only unleased orphans", async () => {
    const name = "orchestra-golden-iphone-17-ios-26-5";
    const value = setup([{ udid: "G1", name, state: "Booted" }, { udid: "G2", name, state: "Shutdown" },
      { udid: "OPEN", name: "orchestra-1-1", state: "Booted" }, { udid: "ORPHAN", name: "orchestra-2-1", state: "Booted" }]);
    const log = new EventLog(value.env.DB_PATH!); log.append({ deliveryId: "d", app: "planner", action: "created", agentSessionId: "s", issueId: "i", issueIdentifier: "I-1", receivedAt: 1, rawBody: Buffer.from("{}") });
    const turn = log.claimNextTurn()!; const lease = log.reserveSimLease(turn.id, turn.linearSessionId, 2, 2); log.attachSimDevice(lease.id, "OPEN"); log.close();
    expect(await main([], value.env, value.io)).toBe(0);
    const remaining = JSON.parse(readFileSync(value.state, "utf8")).devices as { udid: string; state: string }[];
    expect(remaining.some(v => v.udid === "OPEN")).toBe(true); expect(remaining.some(v => v.udid === "ORPHAN")).toBe(false);
    expect(remaining.filter(v => v.udid === "G1" || v.udid === "G2")).toHaveLength(1); expect(remaining.find(v => v.udid === "G1" || v.udid === "G2")!.state).toBe("Shutdown");
  });
  it("dry-run performs no mutations or probe calls", async () => {
    const value = setup(); expect(await main(["--dry-run"], value.env, value.io)).toBe(0);
    expect(readFileSync(value.calls, "utf8")).not.toMatch(/create|delete|shutdown/); expect(value.output().stdout).toContain("would create");
  });
  it("requires an explicit runtime and device type before invoking simctl", async () => {
    const runtime = setup(); delete runtime.env.IOS_SIM_RUNTIME;
    expect(await main([], runtime.env, runtime.io)).toBe(1);
    expect(runtime.output().stdout).toContain("[preflight] config: FAILED (IOS_SIM_RUNTIME is required)");
    expect(existsSync(runtime.calls)).toBe(false);
    const deviceType = setup(); deviceType.env.IOS_SIM_DEVICE_TYPE = "";
    expect(await main([], deviceType.env, deviceType.io)).toBe(1);
    expect(deviceType.output().stdout).toContain("[preflight] config: FAILED (IOS_SIM_DEVICE_TYPE is required)");
    expect(existsSync(deviceType.calls)).toBe(false);
  });
  it("lists orphan candidates but leaves them to a healthy daemon", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url === "/healthz" ? 200 : 404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: request.url === "/healthz" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test server port");
      const value = setup([{ udid: "G", name: "orchestra-golden-iphone-17-ios-26-5", state: "Shutdown" }, { udid: "O", name: "orchestra-2-1", state: "Shutdown" }]);
      value.env.PORT = String(address.port);
      expect(await main([], value.env, value.io)).toBe(0);
      expect(value.output().stdout).toContain("[preflight] orphans: skipped (daemon running — the reaper owns sweeps)");
      expect(value.output().stdout).toContain("[preflight] orphan-candidate: O orchestra-2-1");
      expect(readFileSync(value.calls, "utf8")).not.toContain('["delete","O"]');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it("skips a duplicate renamed after the discovery snapshot", async () => {
    const name = "orchestra-golden-iphone-17-ios-26-5";
    const value = setup([{ udid: "G1", name, state: "Shutdown" }, { udid: "G2", name, state: "Shutdown" }],
      { renameAfterList: { list: 2, udid: "G2", name: "renamed-by-daemon" } });
    expect(await main([], value.env, value.io)).toBe(0);
    expect(value.output().stdout).toContain("golden-duplicate: skipped G2 (current name is renamed-by-daemon)");
    expect(readFileSync(value.calls, "utf8")).not.toContain('["delete","G2"]');
  });
  it("skips a duplicate whose lease appears after the discovery snapshot", async () => {
    const name = "orchestra-golden-iphone-17-ios-26-5";
    const value = setup([{ udid: "G1", name, state: "Shutdown" }, { udid: "G2", name, state: "Shutdown" }],
      { delayAfterList: { list: 2, ms: 150 } });
    const log = new EventLog(value.env.DB_PATH!); log.append({ deliveryId: "race", app: "planner", action: "created", agentSessionId: "s", issueId: "i", issueIdentifier: "I-4", receivedAt: 1, rawBody: Buffer.from("{}") });
    const turn = log.claimNextTurn()!; const lease = log.reserveSimLease(turn.id, turn.linearSessionId, 2, 2);
    const running = main([], value.env, value.io);
    while ((JSON.parse(readFileSync(value.state, "utf8")) as { deviceLists: number }).deviceLists < 2) await new Promise(resolve => setTimeout(resolve, 5));
    log.attachSimDevice(lease.id, "G2");
    expect(await running).toBe(0); log.close();
    expect(value.output().stdout).toContain("golden-duplicate: skipped G2 (lease is protected)");
    expect(readFileSync(value.calls, "utf8")).not.toContain('["delete","G2"]');
  });
  it("returns one when the probe fails", async () => {
    const value = setup([{ udid: "G", name: "orchestra-golden-iphone-17-ios-26-5", state: "Shutdown" }]);
    writeFileSync(value.env.SIM_PREFLIGHT_PROBE!, "#!/bin/sh\nexit 1\n");
    expect(await main([], value.env, value.io)).toBe(1); expect(value.output().stdout).toContain("probe=FAILED");
  });
  it("scrubs daemon secrets from the probe environment", async () => {
    const value = setup([{ udid: "G", name: "orchestra-golden-iphone-17-ios-26-5", state: "Shutdown" }]);
    const recorded = join(value.dir, "probe-env"); writeFileSync(value.probe, `#!/bin/sh\nenv > ${JSON.stringify(recorded)}\n`);
    expect(await main([], { ...value.env, PLANNER_WEBHOOK_SECRET: "x" }, value.io)).toBe(0);
    const childEnv = readFileSync(recorded, "utf8"); expect(childEnv).not.toContain("PLANNER_WEBHOOK_SECRET"); expect(childEnv).toContain("XCODEBUILD_MCP_BIN=");
  });
  it("returns zero for help and two for unknown arguments", async () => {
    const value = setup(); expect(await main(["--help"], value.env, value.io)).toBe(0); expect(await main(["-h"], value.env, value.io)).toBe(0);
    expect(await main(["--wat"], value.env, value.io)).toBe(2); expect(value.output().stderr).toContain("usage: sim-preflight");
  });
});
