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
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(response.status === 404 ? "Not found" : "Console data is unavailable");
  return response.json() as Promise<T>;
}
export const api = {
  overview: (signal?: AbortSignal) => get<Overview>("/api/overview", signal),
  runs: (signal?: AbortSignal) => get<{ runs: RunSummary[] }>("/api/runs", signal),
  run: (id: string, signal?: AbortSignal) => get<RunDetail>(`/api/runs/${encodeURIComponent(id)}`, signal),
};
