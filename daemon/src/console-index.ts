import { loadConsoleConfig } from "./config.js";
import { ConsoleServer } from "./console-server.js";
import { EventLog } from "./eventlog.js";
import { readSkillInventory } from "./skill-inventory.js";
import { ConsoleOperationBroker } from "./console-operation-broker.js";
import { ConsoleLoopBroker } from "./console-loop-broker.js";

const config = loadConsoleConfig();
const log = new EventLog(config.dbPath);
const broker = config.operationSpoolDir && config.configSnapshotPath ? new ConsoleOperationBroker({ log,
  spoolDir: config.operationSpoolDir, snapshotPath: config.configSnapshotPath,
  draftTtlMs: config.draftTtlMs ?? 300_000, snapshotMaxAgeMs: config.snapshotMaxAgeMs ?? 86_400_000 }) : undefined;
await broker?.reconcile();
let globalCapacity=1;
try{globalCapacity=Number((await broker?.configuration())?.settings.sessionConcurrency??1);}catch{/* Writes remain safely capped if the snapshot is unavailable. */}
const loopBroker = new ConsoleLoopBroker({ log, globalCapacity, draftTtlMs: config.draftTtlMs ?? 300_000 });
const server = new ConsoleServer({ config, log,
  ...(broker ? { broker } : {}), loopBroker, readSkills: () => readSkillInventory(config.skillInventoryPath) });
const address = await server.listen();
console.log(JSON.stringify({ event: "console_listening", address: address.address, port: address.port }));

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  log.close();
};
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
