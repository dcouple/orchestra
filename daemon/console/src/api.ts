export interface Resource { label: "Linear issue" | "Artifact bundle"; url: string }
export interface RunSummary {
  id: string; app: "planner" | "implementer"; mode: string; status: string;
  issueIdentifier: string | null; runtime: "claude" | "claudex";
  startedAt: number; completedAt: number | null; durationMs: number;
  invocationCount: number; totalTokens: number; resources: Resource[];
}
export interface Invocation {
  id: number; role: string; runtime: string; model: string | null;
  startedAt: number | null; endedAt: number | null; durationMs: number | null;
  state: "active" | "terminal"; outcome: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; cacheCreationTokens: number | null; cacheReadTokens: number | null; totalTokens: number | null };
}
export interface RunDetail extends RunSummary { invocations: Invocation[] }
export interface Overview {
  observedAt: number;
  daemon: { status: "online" | "offline"; observedAt: number };
  providers: Array<{ provider: string; status: string; reason: string | null; cooldownUntil: number | null; updatedAt: number }>;
  operations: { pending: null | { id: string; type: string; state: string; stage: string | null; reason: string }; runningTurns: number; lastOutcome: unknown };
  activeRuns: number;
  recentRuns: RunSummary[];
  dependencies: { status: "healthy" | "degraded" | "unknown"; configured: number; total: number };
}
export type DependencyStatus = "healthy" | "unavailable" | "unknown" | "disabled" | "stale" | "future_timestamp";
export interface Dependency {
  kind: "mcp" | "harness"; name: string; configured: boolean | null; status: DependencyStatus;
  lastStatus: "healthy" | "unavailable" | "unknown" | "disabled"; reasonCode: string | null;
  capabilities: Record<string, string | number | boolean | null>; observedAt: number | null; staleAt: number | null;
}
export interface Dependencies {
  observedAt: number; daemon: Overview["daemon"]; status: "healthy" | "degraded" | "unknown"; dependencies: Dependency[];
}
export interface Skill {
  name: string; description: string; version: string | null; availability: "available";
  provenance: Array<"Claude Code" | "Codex">; compatibility: Array<"claude" | "codex">;
}
export type Skills = { availability: "available"; schemaVersion: 1; sourceRevision: string;
  sources: Array<{ id: "claude" | "codex"; label: "Claude Code" | "Codex"; available: boolean; skillCount: number }>;
  skills: Skill[] } | { availability: "unavailable"; reasonCode: string; sourceRevision: null; sources: []; skills: [] };

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(response.status === 404 ? "Not found" : "Console data is unavailable");
  return response.json() as Promise<T>;
}
export const api = {
  overview: (signal?: AbortSignal) => get<Overview>("/api/overview", signal),
  runs: (signal?: AbortSignal) => get<{ runs: RunSummary[] }>("/api/runs", signal),
  run: (id: string, signal?: AbortSignal) => get<RunDetail>(`/api/runs/${encodeURIComponent(id)}`, signal),
  dependencies: (signal?: AbortSignal) => get<Dependencies>("/api/dependencies", signal),
  skills: (signal?: AbortSignal) => get<Skills>("/api/skills", signal),
};
