import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/sim-cli.js";
import { loadConfig } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import { WebhookServer } from "../src/server.js";
import { detectSimCapability, SimPool, Simctl, writeSimContext } from "../src/sim.js";

const dirs: string[] = [];
afterEach(() => { delete process.env.FAKE_SIMCTL_STATE; delete process.env.FAKE_SIMCTL_LOG;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const io = () => { let stdout = "", stderr = ""; return { get stdout() { return stdout; }, get stderr() { return stderr; },
  streams: { stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } } } }; };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sim-cli-")); dirs.push(dir); const developerDir = join(dir, "Xcode");
  mkdirSync(join(developerDir, "usr/bin"), { recursive: true }); const xcode = join(developerDir, "usr/bin/xcodebuild"); writeFileSync(xcode, "#!/bin/sh\n"); chmodSync(xcode, 0o755);
  const runtime = { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", name: "iOS 26.5", isAvailable: true };
  const type = { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", name: "iPhone 17" };
  const statePath = join(dir, "state.json"); writeFileSync(statePath, JSON.stringify({ runtimes: [runtime], devicetypes: [type], devices: [
    { udid: "GOLDEN", name: "orchestra-golden-iphone-17-ios-26-5", state: "Shutdown", runtimeId: runtime.identifier, deviceTypeIdentifier: type.identifier }], failures: {} }));
  process.env.FAKE_SIMCTL_STATE = statePath; process.env.FAKE_SIMCTL_LOG = join(dir, "calls");
  const config = loadConfig({ DAEMON_TEST_MODE: "1", SESSIONS_ENABLED: "0", PLANNER_WEBHOOK_SECRET: "p", PLANNER_LINEAR_TOKEN: "p",
    IMPLEMENTER_WEBHOOK_SECRET: "i", IMPLEMENTER_LINEAR_TOKEN: "i", DB_PATH: join(dir, "db"), ARTIFACTS_DIR: join(dir, "artifacts"),
    IOS_SIM_ENABLED: "1", IOS_SIM_RUNTIME: runtime.name, IOS_SIM_DEVICE_TYPE: type.name, IOS_SIM_DEVELOPER_DIR: developerDir,
    XCODEBUILD_MCP_BIN: process.execPath, IOS_SIM_SIMCTL_BIN: `${process.execPath} ${resolve("test/fixtures/fake-simctl.mjs")}` });
  const log = new EventLog(config.dbPath); log.append({ deliveryId: "turn", app: "planner", action: "created", agentSessionId: "session",
    issueId: "issue", issueIdentifier: "SIM-1", receivedAt: 1, rawBody: Buffer.from("{}") }); const turn = log.claimNextTurn()!;
  const simctl = new Simctl(config.simctlArgv, { DEVELOPER_DIR: developerDir }); const pool = new SimPool(log, simctl, config, await detectSimCapability(config, simctl));
  const server = new WebhookServer({ config: { ...config, port: 0 }, log, sim: pool }); const address = await server.listen();
  const context = await writeSimContext(config, pool, turn.id, turn.linearSessionId, `http://127.0.0.1:${address.port}`);
  return { log, pool, server, context, turn };
}

describe.sequential("orchestra-sim CLI", () => {
  it.skipIf(!existsSync(resolve("dist/sim-cli.js")))("runs the built entrypoint through a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-cli-link-")); dirs.push(dir);
    const linkedDaemon = join(dir, "daemon"); symlinkSync(resolve("."), linkedDaemon, "dir");
    const result = spawnSync(process.execPath, [join(linkedDaemon, "dist/sim-cli.js"), "--help"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("usage: orchestra-sim");
  });
  it("acquires, reports status, and releases through a real daemon server", async () => {
    const value = await setup(); const acquireIo = io(); expect(await main(["acquire"], { ORCHESTRA_SIM_CONTEXT: value.context }, acquireIo.streams)).toBe(0);
    const acquired = JSON.parse(acquireIo.stdout) as { udid: string }; const statusIo = io();
    expect(await main(["status"], { ORCHESTRA_SIM_CONTEXT: value.context }, statusIo.streams)).toBe(0);
    expect(JSON.parse(statusIo.stdout).leases).toHaveLength(1); const releaseIo = io();
    expect(await main(["release", acquired.udid], { ORCHESTRA_SIM_CONTEXT: value.context }, releaseIo.streams)).toBe(0);
    expect(JSON.parse(releaseIo.stdout)).toEqual({ released: true, udid: acquired.udid }); await value.server.close(); value.log.close();
  });
  it("returns typed failures for missing context, bad tokens, invalid context, and an unreachable daemon", async () => {
    const missing = io(); expect(await main(["acquire"], {}, missing.streams)).toBe(1); expect(JSON.parse(missing.stderr).error.kind).toBe("disabled");
    const value = await setup(); const parsed = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(value.context, "utf8")));
    parsed.token = "bad"; const badPath = join(dirs.at(-1)!, "bad.json"); writeFileSync(badPath, JSON.stringify(parsed)); const bad = io();
    expect(await main(["status"], { ORCHESTRA_SIM_CONTEXT: badPath }, bad.streams)).toBe(1); expect(JSON.parse(bad.stderr).error.kind).toBe("unauthorized");
    const invalidPath = join(dirs.at(-1)!, "invalid.json"); writeFileSync(invalidPath, "{"); const invalid = io();
    expect(await main(["status"], { ORCHESTRA_SIM_CONTEXT: invalidPath }, invalid.streams)).toBe(2); expect(JSON.parse(invalid.stderr).error.kind).toBe("context_invalid");
    await value.server.close(); const down = io(); expect(await main(["status"], { ORCHESTRA_SIM_CONTEXT: value.context }, down.streams)).toBe(1);
    expect(JSON.parse(down.stderr).error.kind).toBe("daemon_unreachable"); value.log.close();
  });
});
