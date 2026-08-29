import { AckWorker } from "./ack.js";
import { loadConfig } from "./config.js";
import { EventLog } from "./eventlog.js";
import { LinearGateway } from "./linear.js";
import { WebhookServer } from "./server.js";
import {
  ProviderReadinessPoller,
  SessionWorker,
  selectSessionProfile,
  type ShutdownPolicy,
} from "./sessions.js";
import { CleanupWorker } from "./cleanup.js";
import { ReconcileWorker } from "./reconcile.js";
import { ArtifactStore } from "./artifacts.js";
import { OtlpRelay } from "./otel-relay.js";
import { resolveOtlpTraces } from "./otel.js";
import { LinearMcpMonitor } from "./linear-mcp-monitor.js";
import { detectSimCapability, SimPool, SimReaper, Simctl } from "./sim.js";
import { DependencyMonitor } from "./dependency-monitor.js";

const config = loadConfig();
let log: EventLog;
log = new EventLog(config.dbPath, (app) =>
  selectSessionProfile(log, config, app),
);
const gateway = new LinearGateway(
  log,
  config.apps,
  config.linearGraphqlUrl,
  config.linearTokenUrl,
);
const worker = new AckWorker(log, gateway);
const simctl = new Simctl(config.simctlArgv, { DEVELOPER_DIR: config.iosSimDeveloperDir });
const simCapability = config.sessionsEnabled && config.iosSimEnabled
  ? await detectSimCapability(config, simctl)
  : { available: false as const, kind: "disabled" as const, message: "simulator capability is disabled" };
console.log(JSON.stringify({ event: "sim_capability", state: simCapability.available ? "available" : "unavailable",
  ...(simCapability.available ? { goldenUdid: simCapability.goldenUdid } : { kind: simCapability.kind }) }));
const simPool = config.iosSimEnabled ? new SimPool(log, simctl, config, simCapability, { reconciled: false }) : undefined;
const simReaper = simPool && simCapability.available ? new SimReaper(log, simctl, { intervalMs: config.iosSimReaperIntervalMs,
  idleTimeoutMs: config.iosSimIdleTimeoutMs, pool: simPool }) : undefined;
let cleanupWorker: CleanupWorker | undefined;
let sessionWorker: SessionWorker | undefined;
const linearMcpMonitor = config.sessionsEnabled
  ? new LinearMcpMonitor({
      url: config.linearMcpUrl,
      token: config.linearApiKey!,
      intervalMs: config.linearMcpMonitorIntervalMs,
      timeoutMs: config.linearMcpMonitorTimeoutMs,
      staleAfterMs: config.dependencyStateStaleMs,
      log,
    })
  : undefined;
if (!linearMcpMonitor) log.upsertDependencyObservation({ kind: "mcp", name: "linear", configured: false,
  status: "disabled", reasonCode: "disabled", observedAt: Date.now(), staleAfterMs: config.dependencyStateStaleMs });
const dependencyMonitor = new DependencyMonitor({ config, log, simctl,
  intervalMs: config.dependencyMonitorIntervalMs, timeoutMs: config.dependencyMonitorTimeoutMs,
  staleAfterMs: config.dependencyStateStaleMs });
const upstream = resolveOtlpTraces(process.env);
const relay = upstream
  ? new OtlpRelay({
      endpoint: upstream.endpoint,
      headers: upstream.headers,
      callbacks: {
        markNativeSeen: (metadata, at) =>
          log.markClaudeNativeSeen(
            metadata.linearSessionId,
            metadata.toolUseId,
            at,
          ),
        markEnriched: (metadata, input) =>
          log.enrichClaudeInvocation({
            linearSessionId: metadata.linearSessionId,
            toolUseId: metadata.toolUseId,
            spanId: input.spanId,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            ...input.usage,
          }),
        markForwardedUnenriched: (metadata, reason) =>
          log.degradeClaudeInvocation(
            metadata.linearSessionId,
            metadata.toolUseId,
            "forwarded_unenriched",
            reason,
          ),
        onTerminal: () => void cleanupWorker?.trigger(),
      },
    })
  : undefined;
await relay?.start();
const triggerWorkers = () => {
  worker.trigger();
  sessionWorker?.trigger();
  void cleanupWorker?.trigger();
};
const onStop = (id: string) => sessionWorker?.stopSession(id);
const artifactStore = config.artifactToken
  ? new ArtifactStore(config.artifactsDir)
  : undefined;
const server = new WebhookServer({
  config,
  log,
  onInserted: triggerWorkers,
  onStop,
  ...(artifactStore ? { artifactStore } : {}),
  ...(simPool ? { sim: simPool } : {}),
});
const address = await server.listen();
const addressHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
sessionWorker = config.sessionsEnabled
  ? new SessionWorker(log, gateway, config, {
      ...(relay ? { relay } : {}),
      ...(simPool ? { sim: { pool: simPool, capability: simCapability,
        baseUrl: `http://${addressHost}:${address.port}` } } : {}),
      onTurnComplete: () => void cleanupWorker?.trigger(),
    })
  : undefined;
cleanupWorker = config.sessionsEnabled
  ? new CleanupWorker(
      log,
      gateway,
      config.worktreesRoot,
      config.targetRepoPath!,
      {
        ...(relay ? { relay } : {}),
        ingestDispatches: () =>
          sessionWorker?.ingestDispatches() ?? Promise.resolve(),
      },
    )
  : undefined;
const reconcileWorker = hasLinearApiCreds()
  ? new ReconcileWorker(log, gateway, config, {
      onInserted: triggerWorkers,
      onStop,
    })
  : undefined;
const providerPoller = config.sessionsEnabled
  ? new ProviderReadinessPoller(log, config)
  : undefined;

if (providerPoller) {
  let initialTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    providerPoller.probe(),
    new Promise<void>((resolve) => {
      initialTimer = setTimeout(() => {
        log.setProviderState("claude", "not_ready", "initial_probe_timeout");
        resolve();
      }, config.providerInitialProbeTimeoutMs);
    }),
  ]);
  if (initialTimer) clearTimeout(initialTimer);
  providerPoller.start();
}

await simReaper?.reconcileOnce();
worker.start();
linearMcpMonitor?.start();
dependencyMonitor.start();
await sessionWorker?.start();
cleanupWorker?.start();
simReaper?.start();
reconcileWorker?.start();
console.log(
  JSON.stringify({
    event: "listening",
    address: address.address,
    port: address.port,
  }),
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const policy: ShutdownPolicy = log.restartIntent()
    ? "hard_restart"
    : "recover";
  console.log(
    JSON.stringify({
      event: "shutdown",
      signal,
      policy,
      runningTurns: log.runningTurns(),
    }),
  );
  await reconcileWorker?.stop();
  await linearMcpMonitor?.stop();
  await dependencyMonitor.stop();
  await server.close();
  await worker.stop();
  await sessionWorker?.stop(policy);
  await simReaper?.stop();
  await cleanupWorker?.stop();
  await relay?.close();
  providerPoller?.stop();
  log.close();
}

function hasLinearApiCreds(): boolean {
  return (["planner", "implementer"] as const).every((app) => {
    const configApp = config.apps[app];
    return Boolean(
      configApp.staticToken || (configApp.clientId && configApp.clientSecret),
    );
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(
    signal,
    () =>
      void shutdown(signal)
        .then(() => process.exit(0))
        .catch((error) => {
          console.error(error);
          process.exit(1);
        }),
  );
}
