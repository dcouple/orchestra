import type { ProviderStateRow, SessionRow, AgentInvocationRow, ExternalUrlRow } from "./eventlog.js";
import type { SafeOperationStatus } from "./operations.js";

export interface ConsoleResource { label: "Linear issue" | "Artifact bundle"; url: string }
export interface ConsoleRunSummary {
  id: string; app: "planner" | "implementer"; mode: string; status: string;
  issueIdentifier: string | null; runtime: "claude" | "claudex";
  startedAt: number; completedAt: number | null; durationMs: number;
  invocationCount: number; totalTokens: number; resources: ConsoleResource[];
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
