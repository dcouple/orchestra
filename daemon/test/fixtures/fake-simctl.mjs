import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";

const statePath = process.env.FAKE_SIMCTL_STATE;
if (!statePath) throw new Error("FAKE_SIMCTL_STATE is required");
const args = process.argv.slice(2);
if (process.env.FAKE_SIMCTL_LOG) await appendFile(process.env.FAKE_SIMCTL_LOG, `${JSON.stringify(args)}\n`);
const state = JSON.parse(await readFile(statePath, "utf8"));
const save = () => writeFile(statePath, JSON.stringify(state));
const fail = (name, fallback) => {
  const value = state.failures?.[name];
  if (!value) return;
  process.stderr.write(typeof value === "string" ? value : fallback); process.exit(1);
};
const invalid = () => { process.stderr.write("Invalid device\n"); process.exit(149); };

if (args[0] === "list") {
  fail("list", "list failed");
  if (args[1] === "runtimes") process.stdout.write(JSON.stringify({ runtimes: state.runtimes ?? [] }));
  else if (args[1] === "devicetypes") process.stdout.write(JSON.stringify({ devicetypes: state.devicetypes ?? [] }));
  else if (args[1] === "devices") {
    const devices = {};
    for (const device of state.devices ?? []) (devices[device.runtimeId] ??= []).push({
      udid: device.udid, name: device.name, state: device.state, isAvailable: device.isAvailable ?? true,
      deviceTypeIdentifier: device.deviceTypeIdentifier,
    });
    process.stdout.write(JSON.stringify({ devices }));
  } else process.exit(2);
} else if (args[0] === "clone") {
  fail("clone", "clone failed");
  const source = state.devices.find(device => device.udid === args[1]); if (!source) invalid();
  if (source.state !== "Shutdown") {
    process.stderr.write("SimError Code=405 Unable to clone device in current state: Booted\n"); process.exit(149);
  }
  const udid = randomUUID().toUpperCase();
  state.devices.push({ ...source, udid, name: args[2], state: "Shutdown" }); await save(); process.stdout.write(`${udid}\n`);
} else if (args[0] === "boot") {
  fail("boot", "boot failed"); const device = state.devices.find(value => value.udid === args[1]); if (!device) invalid();
  device.state = "Booted"; await save();
} else if (args[0] === "bootstatus") {
  const device = state.devices.find(value => value.udid === args[1]); if (!device) invalid();
  if (device.state !== "Booted") { process.stderr.write("device is not booted\n"); process.exit(1); }
} else if (args[0] === "shutdown") {
  fail("shutdown", "shutdown failed"); const device = state.devices.find(value => value.udid === args[1]); if (!device) invalid();
  device.state = "Shutdown"; await save();
} else if (args[0] === "delete") {
  fail("delete", "delete failed"); const index = state.devices.findIndex(value => value.udid === args[1]); if (index < 0) invalid();
  state.devices.splice(index, 1); await save();
} else process.exit(2);
