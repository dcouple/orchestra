import { AckWorker } from "./ack.js";
import { loadConfig } from "./config.js";
import { EventLog } from "./eventlog.js";
import { LinearGateway } from "./linear.js";
import { WebhookServer } from "./server.js";
import { SessionWorker } from "./sessions.js";
import { CleanupWorker } from "./cleanup.js";
import { ReconcileWorker } from "./reconcile.js";

const config = loadConfig();
const log = new EventLog(config.dbPath);
const gateway = new LinearGateway(log, config.apps, config.linearGraphqlUrl, config.linearTokenUrl);
const worker = new AckWorker(log, gateway);
const cleanupWorker = config.sessionsEnabled ? new CleanupWorker(log,gateway,config.worktreesRoot,config.targetRepoPath!) : undefined;
const sessionWorker = config.sessionsEnabled ? new SessionWorker(log, gateway, config, {onTurnComplete:()=>void cleanupWorker?.trigger()}) : undefined;
const triggerWorkers = () => { worker.trigger(); sessionWorker?.trigger(); void cleanupWorker?.trigger(); };
const reconcileWorker = hasLinearApiCreds() ? new ReconcileWorker(log, gateway, config, { onInserted: triggerWorkers }) : undefined;
const server = new WebhookServer({ config, log, onInserted: triggerWorkers });

worker.start();
sessionWorker?.start();
cleanupWorker?.start();
reconcileWorker?.start();
const address = await server.listen();
console.log(JSON.stringify({ event: "listening", address: address.address, port: address.port }));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "shutdown", signal }));
  await reconcileWorker?.stop();
  await server.close();
  await worker.stop();
  await sessionWorker?.stop();
  await cleanupWorker?.stop();
  log.close();
}

function hasLinearApiCreds(): boolean {
  return (["planner", "implementer"] as const).every(app => {
    const configApp = config.apps[app];
    return Boolean(configApp.staticToken || (configApp.clientId && configApp.clientSecret));
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal).then(() => process.exit(0)).catch(error => {
    console.error(error); process.exit(1);
  }));
}
