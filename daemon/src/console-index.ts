import { loadConsoleConfig } from "./config.js";
import { ConsoleServer } from "./console-server.js";
import { EventLog } from "./eventlog.js";
import { readSkillInventory } from "./skill-inventory.js";
import { ConsoleOperationBroker } from "./console-operation-broker.js";

const config = loadConsoleConfig();
const log = new EventLog(config.dbPath);
const broker = config.operationSpoolDir && config.configSnapshotPath ? new ConsoleOperationBroker({ log,
  spoolDir: config.operationSpoolDir, snapshotPath: config.configSnapshotPath,
  draftTtlMs: config.draftTtlMs ?? 300_000, snapshotMaxAgeMs: config.snapshotMaxAgeMs ?? 86_400_000 }) : undefined;
await broker?.reconcile();
const server = new ConsoleServer({ config, log,
  ...(broker ? { broker } : {}), readSkills: () => readSkillInventory(config.skillInventoryPath) });
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
