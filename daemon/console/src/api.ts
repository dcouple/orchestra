export interface Resource { label: "Linear issue" | "Artifact bundle"; url: string }
export interface RunSummary {
  id: string; app: "planner" | "implementer"; mode: string; status: string;
  issueIdentifier: string | null; runtime: "claude" | "claudex";
  startedAt: number; completedAt: number | null; durationMs: number;
  invocationCount: number; totalTokens: number; resources: Resource[];
  origin: "linear" | "loop"; loopName: string | null; loopId: string | null; occurrenceId: string | null;
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
export interface LoopDeclaration { version:1;name:string;description:string;trigger:{kind:"fixed-interval";everyMinutes:number;startsAt:number};
  task:{kind:"agent";role:"planner"|"implementer";objective:string};harness:{runtime:"claude"|"claudex";profile:"fable"|"sol"};
  maxConcurrency:number;budgetUsd:number;timeoutMinutes:number;maxRetries:number;enabled:boolean }
export interface SafeLoopDeclaration extends Omit<LoopDeclaration,"task"> {task:{kind:"agent";role:"planner"|"implementer"}}
export interface LoopSummary extends SafeLoopDeclaration {id:string;revision:number;digest:string;nextDueAt:number;blockedReason:string|null;createdAt:number;updatedAt:number}
export interface LoopDetail extends LoopSummary {audit:Array<{sequence:number;kind:string;reason:string;actor:string;createdAt:number}>;
  cleanups:Array<{id:number;occurrenceId:string;status:string;attempts:number;error:string|null;createdAt:number}>;
  occurrences:Array<{id:string;runId:string;scheduledFor:number;status:string;retryCount:number;outcome:string|null;error:string|null;policy:{budgetUsd:number;timeoutMinutes:number;maxRetries:number}}>}
export interface LoopDraft {id:string;digest:string;kind:string;loopId:string;expectedRevision:number|null;reason:string;expiresAt:number;changedFields:string[];
  declaration?:SafeLoopDeclaration;policy:{maxConcurrency:number;budgetUsd:number;timeoutMinutes:number;maxRetries:number}|null}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(response.status === 404 ? "Not found" : "Console data is unavailable");
  return response.json() as Promise<T>;
}
let csrfToken: string | undefined;
async function post<T>(path: string, body: unknown): Promise<T> {
  if (!csrfToken) await api.bootstrap();
  const response = await fetch(path, { method: "POST", credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Orchestra-CSRF": csrfToken ?? "" },
    body: JSON.stringify(body) });
  const payload = await response.json() as { error?: { message?: string } };
  if (!response.ok) { if (response.status === 403) csrfToken = undefined; throw new Error(payload.error?.message ?? "Operation failed"); }
  return payload as T;
}
export interface ConfigurationSnapshot { version: 1; revision: string; generatedAt: number; staleAt: number;
  settings: Record<string, string | number | boolean | string[] | null>; secrets: Record<string, { configured: boolean }> }
export interface DraftPreview { id: string; kind: string; digest: string; reason: string; expiresAt: number;
  changedFields: string[]; before: Record<string, unknown>; after: Record<string, unknown>;
  secrets: Record<string, string>; restartRequired: boolean }
export interface Operation { id: string; digest: string; kind: string; actor: string; reason: string; state: string;
  stage: string | null; attempts: number; stateVersion: number; outcome: string | null; recoveryActions: string[];
  events: Array<{ sequence: number; state: string; stage: string | null; createdAt: number }> }
export const api = {
  bootstrap: async (signal?: AbortSignal) => { const value = await get<{ capability: "read-only" | "local-trusted"; csrfToken: string }>("/api/bootstrap", signal); csrfToken = value.csrfToken; return value; },
  overview: (signal?: AbortSignal) => get<Overview>("/api/overview", signal),
  runs: (signal?: AbortSignal) => get<{ runs: RunSummary[] }>("/api/runs", signal),
  run: (id: string, signal?: AbortSignal) => get<RunDetail>(`/api/runs/${encodeURIComponent(id)}`, signal),
  dependencies: (signal?: AbortSignal) => get<Dependencies>("/api/dependencies", signal),
  skills: (signal?: AbortSignal) => get<Skills>("/api/skills", signal),
  configuration: (signal?: AbortSignal) => get<ConfigurationSnapshot>("/api/configuration", signal),
  operations: (signal?: AbortSignal) => get<{ operations: Operation[] }>("/api/operations", signal),
  loops: (signal?:AbortSignal)=>get<{loops:LoopSummary[]}>("/api/loops",signal),
  loop: (id:string,signal?:AbortSignal)=>get<LoopDetail>(`/api/loops/${encodeURIComponent(id)}`,signal),
  loopDraft:(body:unknown)=>post<LoopDraft>("/api/loops/drafts",body),
  loopConfirm:(body:unknown)=>post<{loop:LoopSummary;auditSequence:number;deduplicated:boolean}>("/api/loops/confirm",body),
  draft: (body: unknown) => post<DraftPreview>("/api/drafts", body),
  confirm: (body: unknown) => post<{ operation: Operation; deduplicated: boolean }>("/api/operations/confirm", body),
  control: (operation: Operation, kind: "retry" | "cancel", reason: string) => post(`/api/operations/${encodeURIComponent(operation.id)}/${kind}`,
    { targetDigest: operation.digest, expectedVersion: operation.stateVersion, reason }),
};
