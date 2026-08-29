import type { ProviderStateRow, SessionRow, AgentInvocationRow, ExternalUrlRow,
  DependencyHealth, DependencyKind, DependencyObservationRow, LoopDefinitionRow } from "./eventlog.js";
import type { SafeOperationStatus } from "./operations.js";
import type { OperationRow, OperationStageEvent } from "./operations.js";

export interface ConsoleResource { label: "Linear issue" | "Artifact bundle"; url: string }
export interface ConsoleRunSummary {
  id: string; app: "planner" | "implementer"; mode: string; status: string;
  issueIdentifier: string | null; runtime: "claude" | "claudex";
  startedAt: number; completedAt: number | null; durationMs: number;
  invocationCount: number; totalTokens: number; resources: ConsoleResource[];
  origin: "linear" | "loop"; loopName: string | null; loopId: string | null; occurrenceId: string | null;
}
export interface ConsoleInvocation {
  id: number; role: string; runtime: string; model: string | null;
  startedAt: number | null; endedAt: number | null; durationMs: number | null;
  state: "active" | "terminal"; outcome: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; cacheCreationTokens: number | null; cacheReadTokens: number | null; totalTokens: number | null };
}
export interface ConsoleRunDetail extends ConsoleRunSummary { invocations: ConsoleInvocation[] }
export interface ConsoleDaemonHealth { status: "online" | "offline"; observedAt: number }
export interface ConsoleOverview {
  observedAt: number; daemon: ConsoleDaemonHealth; providers: ProviderStateRow[];
  operations: SafeOperationStatus; activeRuns: number; recentRuns: ConsoleRunSummary[];
  dependencies: { status: "healthy" | "degraded" | "unknown"; configured: number; total: number };
}
export type ConsoleDependencyStatus = DependencyHealth | "stale" | "future_timestamp";
export interface ConsoleDependency {
  kind: DependencyKind;
  name: string;
  configured: boolean | null;
  status: ConsoleDependencyStatus;
  lastStatus: DependencyHealth;
  reasonCode: string | null;
  capabilities: Record<string, string | number | boolean | null>;
  observedAt: number | null;
  staleAt: number | null;
}
export interface ConsoleDependencies {
  observedAt: number;
  daemon: ConsoleDaemonHealth;
  status: "healthy" | "degraded" | "unknown";
  dependencies: ConsoleDependency[];
}
export interface ConsoleOperationHistory {
  id: string; digest: string; kind: string; actor: OperationRow["actor"]; summary: unknown; reason: string;
  state: OperationRow["state"]; stage: string | null; attempts: number; stateVersion: number;
  requestedAt: number; updatedAt: number; outcome: string | null; events: OperationStageEvent[];
  recoveryActions: Array<"retry" | "cancel">;
}

export type ConsoleLoopDefinition = Omit<LoopDefinitionRow, "task"> & {
  task: { kind: "agent"; role: LoopDefinitionRow["task"]["role"] };
};

/** The only loop definition shape permitted to cross an HTTP or receipt boundary. */
export function projectConsoleLoop(row: LoopDefinitionRow): ConsoleLoopDefinition {
  const { task, ...safe } = row;
  return { ...safe, task: { kind: "agent", role: task.role } };
}

export function projectConsoleOperation(operation: OperationRow, events: OperationStageEvent[]): ConsoleOperationHistory {
  let summary: unknown = null;
  if (operation.requestSummary) { try { summary = JSON.parse(operation.requestSummary) as unknown; } catch { summary = null; } }
  const recoveryActions: ConsoleOperationHistory["recoveryActions"] = operation.state === "blocked" || operation.state === "failed" ? ["retry"]
    : operation.cancelRequested === 0 && operation.mutated === 0 && (operation.state === "pending" || operation.state === "executing") ? ["cancel"] : [];
  return { id: operation.id, digest: operation.requestDigest, kind: operation.requestKind ?? operation.type,
    actor: operation.actor, summary, reason: operation.reason, state: operation.state, stage: operation.stage,
    attempts: operation.attempts, stateVersion: operation.stateVersion, requestedAt: operation.requestedAt,
    updatedAt: operation.updatedAt, outcome: operation.outcome, events, recoveryActions };
}

const SUPPORTED_DEPENDENCIES: Array<{ kind: DependencyKind; name: string }> = [
  { kind: "mcp", name: "linear" }, { kind: "mcp", name: "playwright" },
  { kind: "mcp", name: "xcodebuildmcp" }, { kind: "harness", name: "claude" },
  { kind: "harness", name: "claudex" },
];

export function projectDependencies(observations: DependencyObservationRow[], daemon: ConsoleDaemonHealth,
  now = Date.now()): ConsoleDependencies {
  const byKey = new Map(observations.map(row => [`${row.kind}:${row.name}`, row]));
  const dependencies = SUPPORTED_DEPENDENCIES.map(({ kind, name }): ConsoleDependency => {
    const row = byKey.get(`${kind}:${name}`);
    if (!row) return { kind, name, configured: null, status: "unknown", lastStatus: "unknown",
      reasonCode: "not_observed", capabilities: {}, observedAt: null, staleAt: null };
    const staleAt = Number.isSafeInteger(row.observedAt + row.staleAfterMs)
      ? row.observedAt + row.staleAfterMs : Number.MAX_SAFE_INTEGER;
    const status = row.observedAt > now ? "future_timestamp"
      : now > staleAt ? "stale" : row.status;
    return { kind, name, configured: row.configured, status, lastStatus: row.status,
      reasonCode: status === "future_timestamp" ? "future_timestamp" : status === "stale" ? "stale" : row.reasonCode,
      capabilities: row.capabilities, observedAt: row.observedAt, staleAt };
  });
  let status: ConsoleDependencies["status"];
  if (daemon.status === "offline") status = "degraded";
  else if (observations.length === 0 || dependencies.every(row => row.configured === false)) status = "unknown";
  else if (dependencies.some(row => row.configured === null)
    || dependencies.some(row => row.configured === true && row.status !== "healthy")) status = "degraded";
  else status = "healthy";
  return { observedAt: now, daemon, status, dependencies };
}

function safeExternalUrl(url: string): string | undefined {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password ? parsed.toString() : undefined; }
  catch { return undefined; }
}

export function projectResources(session: SessionRow, urls: ExternalUrlRow[], linearBase?: string): ConsoleResource[] {
  const resources: ConsoleResource[] = [];
  const linear = urls.find(row => /linear|issue/i.test(row.label));
  const artifact = urls.find(row => /artifact|bundle/i.test(row.label));
  const linearUrl = linear ? safeExternalUrl(linear.url) : session.issueIdentifier && linearBase
    ? safeExternalUrl(`${linearBase.replace(/\/$/, "")}/issue/${encodeURIComponent(session.issueIdentifier)}`) : undefined;
  const artifactUrl = artifact ? safeExternalUrl(artifact.url) : undefined;
  if (linearUrl) resources.push({ label: "Linear issue", url: linearUrl });
  if (artifactUrl) resources.push({ label: "Artifact bundle", url: artifactUrl });
  return resources;
}

export function projectInvocation(row: AgentInvocationRow, now = Date.now()): ConsoleInvocation {
  const total = [row.inputTokens, row.outputTokens, row.cacheCreationTokens, row.cacheReadTokens]
    .reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    id: row.id, role: row.role, runtime: row.runtime, model: row.model,
    startedAt: row.startedAt, endedAt: row.endedAt,
    durationMs: row.startedAt === null ? null : Math.max(0, (row.endedAt ?? row.streamCompletedAt ?? now) - row.startedAt),
    state: row.endedAt === null && row.streamCompletedAt === null && row.outcome === null ? "active" : "terminal",
    outcome: row.outcome,
    usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens,
      cacheCreationTokens: row.cacheCreationTokens, cacheReadTokens: row.cacheReadTokens,
      totalTokens: total || null },
  };
}
