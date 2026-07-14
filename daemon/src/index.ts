import { AckWorker } from "./ack.js";
import { loadConfig } from "./config.js";
import { EventLog } from "./eventlog.js";
import { LinearGateway } from "./linear.js";
import { WebhookServer } from "./server.js";
import { SessionWorker } from "./sessions.js";

const config = loadConfig();
const log = new EventLog(config.dbPath);
const gateway = new LinearGateway(log, config.apps, config.linearGraphqlUrl, config.linearTokenUrl);
const worker = new AckWorker(log, gateway);
const sessionWorker = config.sessionsEnabled ? new SessionWorker(log, gateway, config) : undefined;
const server = new WebhookServer({ config, log, onInserted: () => { worker.trigger(); sessionWorker?.trigger(); } });

worker.start();
sessionWorker?.start();
const address = await server.listen();
console.log(JSON.stringify({ event: "listening", address: address.address, port: address.port }));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "shutdown", signal }));
  await server.close();
  await worker.stop();
  await sessionWorker?.stop();
  log.close();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal).then(() => process.exit(0)).catch(error => {
    console.error(error); process.exit(1);
  }));
}
