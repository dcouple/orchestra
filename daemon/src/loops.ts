import { createHash, randomUUID } from "node:crypto";

export type LoopRuntime = "claude" | "claudex";
export type LoopProfile = "fable" | "sol";
export type LoopRole = "planner" | "implementer";
export interface LoopDeclaration {
  version: 1; name: string; description: string;
  trigger: { kind: "fixed-interval"; everyMinutes: number; startsAt: number };
  task: { kind: "agent"; role: LoopRole; objective: string };
  harness: { runtime: LoopRuntime; profile: LoopProfile };
  maxConcurrency: number; budgetUsd: number; timeoutMinutes: number; maxRetries: number; enabled: boolean;
}
export type LoopOutcome = "service_restart" | "timeout" | "budget_exhausted" | "policy_denied" | "restart_unsafe" | "retriable_failure" | "succeeded";
export class LoopValidationError extends Error { constructor(readonly code: string) { super(code); this.name = "LoopValidationError"; } }

const exact = (value: unknown, keys: readonly string[], code = "invalid_object"): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LoopValidationError(code);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !(key in row))) throw new LoopValidationError("unknown_or_missing_field");
  return row;
};
const bounded = (value: unknown, min: number, max: number, code: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new LoopValidationError(code); return value as number;
};
const text = (value: unknown, min: number, max: number, code: string): string => {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) throw new LoopValidationError(code);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new LoopValidationError(code);
  return normalized;
};
export function validateLoopDeclaration(value: unknown, globalCapacity: number, now = Date.now()): LoopDeclaration {
  const row = exact(value, ["version","name","description","trigger","task","harness","maxConcurrency","budgetUsd","timeoutMinutes","maxRetries","enabled"]);
  if (row.version !== 1 || typeof row.enabled !== "boolean") throw new LoopValidationError("invalid_version_or_enabled");
  const trigger = exact(row.trigger, ["kind","everyMinutes","startsAt"], "invalid_trigger");
  if (trigger.kind !== "fixed-interval") throw new LoopValidationError("invalid_trigger");
  const startsAt = bounded(trigger.startsAt, now - 365 * 86_400_000, now + 365 * 86_400_000, "invalid_anchor");
  const task = exact(row.task, ["kind","role","objective"], "invalid_task");
  if (task.kind !== "agent" || (task.role !== "planner" && task.role !== "implementer")) throw new LoopValidationError("invalid_task");
  const harness = exact(row.harness, ["runtime","profile"], "invalid_harness");
  const allowed = harness.runtime === "claude" && (harness.profile === "fable" || harness.profile === "sol")
    || harness.runtime === "claudex" && harness.profile === "sol";
  if (!allowed) throw new LoopValidationError("unsupported_harness");
  const budget = row.budgetUsd;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < .01 || budget > 100) throw new LoopValidationError("invalid_budget");
  return { version: 1, name: text(row.name, 1, 80, "invalid_name"), description: text(row.description, 0, 500, "invalid_description"),
    trigger: { kind: "fixed-interval", everyMinutes: bounded(trigger.everyMinutes, 15, 10080, "invalid_interval"), startsAt },
    task: { kind: "agent", role: task.role, objective: text(task.objective, 1, 4000, "invalid_objective") },
    harness: { runtime: harness.runtime as LoopRuntime, profile: harness.profile as LoopProfile },
    maxConcurrency: bounded(row.maxConcurrency, 1, Math.min(4, globalCapacity), "invalid_concurrency"), budgetUsd: budget,
    timeoutMinutes: bounded(row.timeoutMinutes, 1, 120, "invalid_timeout"), maxRetries: bounded(row.maxRetries, 0, 3, "invalid_retries"), enabled: row.enabled };
}
export function canonicalLoopJson(value: LoopDeclaration): string { return JSON.stringify(value); }
export function loopDigest(value: LoopDeclaration): string { return createHash("sha256").update(canonicalLoopJson(value)).digest("hex"); }
export function nextLoopDue(startsAt: number, everyMinutes: number, after: number): number {
  const interval = everyMinutes * 60_000; if (after < startsAt) return startsAt;
  return startsAt + (Math.floor((after - startsAt) / interval) + 1) * interval;
}
export function classifyLoopOutcome(input: { shutdown?: boolean; timedOut?: boolean; budgetStopped?: boolean; costUsd?: number; budgetUsd: number; permissionDenied?: boolean; restartUnsafe?: boolean; failed?: boolean }): LoopOutcome {
  if (input.shutdown) return "service_restart"; if (input.timedOut) return "timeout";
  if (input.budgetStopped || (input.costUsd ?? 0) >= input.budgetUsd) return "budget_exhausted";
  if (input.restartUnsafe) return "restart_unsafe"; if (input.permissionDenied) return "policy_denied";
  return input.failed ? "retriable_failure" : "succeeded";
}
export function newLoopId(): string { return randomUUID(); }
