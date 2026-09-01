import { createHash, randomUUID } from "node:crypto";

export const EDITABLE_SETTING_KEYS = [
  "plannerHarness", "implementerHarness", "sessionConcurrency", "iosSimMaxConcurrent",
  "claudeMaxTurns", "doMaxTurns", "doMaxBudgetUsd", "mcpEnvPassthrough",
  "browserEnabled", "iosSimEnabled", "attachmentsEnabled", "ntfyUrl",
] as const;
export type EditableSettingKey = typeof EDITABLE_SETTING_KEYS[number];
export type EditableSettings = {
  plannerHarness: "claude" | "claudex";
  implementerHarness: "claude" | "claudex";
  sessionConcurrency: number;
  iosSimMaxConcurrent: number;
  claudeMaxTurns: number;
  doMaxTurns: number;
  doMaxBudgetUsd: number | null;
  mcpEnvPassthrough: string[];
  browserEnabled: boolean;
  iosSimEnabled: boolean;
  attachmentsEnabled: boolean;
  ntfyUrl: string | null;
};

export const SECRET_NAMES = [
  "LINEAR_API_KEY", "ARTIFACT_TOKEN", "PLANNER_WEBHOOK_SECRET", "IMPLEMENTER_WEBHOOK_SECRET",
  "PLANNER_LINEAR_CLIENT_SECRET", "IMPLEMENTER_LINEAR_CLIENT_SECRET",
] as const;
export type ConsoleSecretName = typeof SECRET_NAMES[number];

export type ConsoleOperationRequest =
  | { version: 1; kind: "config.apply"; snapshotRevision: string; changes: Partial<EditableSettings>; secrets: Partial<Record<ConsoleSecretName, string>> }
  | { version: 1; kind: "daemon.restart"; snapshotRevision: string }
  | { version: 1; kind: "daemon.reload"; snapshotRevision: string };

export type ConsoleControlRequest = { version: 1; kind: "operation.retry" | "operation.cancel";
  targetOperationId: string; targetDigest: string; expectedVersion: number };

export interface DraftInput {
  kind: "config.apply" | "daemon.restart" | "daemon.reload";
  reason: string;
  changes?: unknown;
  secrets?: unknown;
}

export class ConsoleValidationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ConsoleValidationError"; }
}

function exactObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConsoleValidationError("invalid_object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ConsoleValidationError("unknown_field");
}
function boundedReason(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value))
    throw new ConsoleValidationError("invalid_reason");
  return value;
}
function integer(value: unknown, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new ConsoleValidationError(code);
  return value as number;
}
function flag(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new ConsoleValidationError(code);
  return value;
}
function harness(value: unknown): "claude" | "claudex" {
  if (value !== "claude" && value !== "claudex") throw new ConsoleValidationError("invalid_harness");
  return value;
}
function notificationUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value))
    throw new ConsoleValidationError("invalid_notification_url");
  let url: URL;
  try { url = new URL(value); } catch { throw new ConsoleValidationError("invalid_notification_url"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
    throw new ConsoleValidationError("invalid_notification_url");
  return url.toString();
}
function mcpNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new ConsoleValidationError("invalid_mcp_names");
  const result = value.map(item => {
    if (typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item))
      throw new ConsoleValidationError("invalid_mcp_names");
    if (/TOKEN|SECRET|PASSWORD|PRIVATE|AUTH|COOKIE/i.test(item)) throw new ConsoleValidationError("protected_mcp_name");
    return item;
  });
  if (new Set(result).size !== result.length) throw new ConsoleValidationError("duplicate_mcp_name");
  return [...result].sort();
}

export function validateEditableChanges(value: unknown): Partial<EditableSettings> {
  const row = exactObject(value ?? {}); exactKeys(row, EDITABLE_SETTING_KEYS);
  const result: Partial<EditableSettings> = {};
  for (const [key, raw] of Object.entries(row) as Array<[EditableSettingKey, unknown]>) {
    switch (key) {
      case "plannerHarness": case "implementerHarness": result[key] = harness(raw); break;
      case "sessionConcurrency": result[key] = integer(raw, 1, 32, "invalid_session_concurrency"); break;
      case "iosSimMaxConcurrent": result[key] = integer(raw, 1, 16, "invalid_sim_concurrency"); break;
      case "claudeMaxTurns": case "doMaxTurns": result[key] = integer(raw, 1, 1_000, "invalid_turn_limit"); break;
      case "doMaxBudgetUsd": result[key] = raw === null ? null : (() => {
        if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 100_000) throw new ConsoleValidationError("invalid_budget");
        return raw;
      })(); break;
      case "mcpEnvPassthrough": result[key] = mcpNames(raw); break;
      case "browserEnabled": case "iosSimEnabled": case "attachmentsEnabled": result[key] = flag(raw, "invalid_flag"); break;
      case "ntfyUrl": result[key] = notificationUrl(raw); break;
    }
  }
  return result;
}

export function validateSecrets(value: unknown): Partial<Record<ConsoleSecretName, string>> {
  const row = exactObject(value ?? {}); exactKeys(row, SECRET_NAMES);
  const result: Partial<Record<ConsoleSecretName, string>> = {};
  for (const [name, raw] of Object.entries(row) as Array<[ConsoleSecretName, unknown]>) {
    if (typeof raw !== "string" || raw.length < 1 || raw.length > 8_192 || /[\u0000\r\n]/.test(raw))
      throw new ConsoleValidationError("invalid_secret");
    result[name] = raw;
  }
  return result;
}

export function validateDraftInput(value: unknown): DraftInput & { changes: Partial<EditableSettings>; secrets: Partial<Record<ConsoleSecretName, string>> } {
  const row = exactObject(value); exactKeys(row, ["kind", "reason", "changes", "secrets"]);
  if (row.kind !== "config.apply" && row.kind !== "daemon.restart" && row.kind !== "daemon.reload")
    throw new ConsoleValidationError("unsupported_kind");
  const reason = boundedReason(row.reason);
  if (row.kind !== "config.apply" && (row.changes !== undefined || row.secrets !== undefined))
    throw new ConsoleValidationError("unknown_field");
  const changes = row.kind === "config.apply" ? validateEditableChanges(row.changes) : {};
  const secrets = row.kind === "config.apply" ? validateSecrets(row.secrets) : {};
  if (row.kind === "config.apply" && Object.keys(changes).length === 0 && Object.keys(secrets).length === 0)
    throw new ConsoleValidationError("empty_change");
  return { kind: row.kind, reason, changes, secrets };
}

export function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(normalize)
    : entry !== null && typeof entry === "object"
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)]))
      : entry;
  return JSON.stringify(normalize(value));
}
export function requestDigest(value: ConsoleOperationRequest | ConsoleControlRequest): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function newOpaqueId(): string { return randomUUID(); }

export function parseOperationRequest(value: unknown): ConsoleOperationRequest {
  const row = exactObject(value);
  if (row.version !== 1) throw new ConsoleValidationError("unsupported_version");
  if (row.kind === "config.apply") {
    exactKeys(row, ["version", "kind", "snapshotRevision", "changes", "secrets"]);
    if (typeof row.snapshotRevision !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(row.snapshotRevision))
      throw new ConsoleValidationError("invalid_snapshot_revision");
    return { version: 1, kind: row.kind, snapshotRevision: row.snapshotRevision,
      changes: validateEditableChanges(row.changes), secrets: validateSecrets(row.secrets) };
  }
  if (row.kind === "daemon.restart" || row.kind === "daemon.reload") {
    exactKeys(row, ["version", "kind", "snapshotRevision"]);
    if (typeof row.snapshotRevision !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(row.snapshotRevision))
      throw new ConsoleValidationError("invalid_snapshot_revision");
    return { version: 1, kind: row.kind, snapshotRevision: row.snapshotRevision };
  }
  throw new ConsoleValidationError("unsupported_kind");
}

export function parseControlRequest(value: unknown): ConsoleControlRequest {
  const row = exactObject(value); exactKeys(row, ["version", "kind", "targetOperationId", "targetDigest", "expectedVersion"]);
  if (row.version !== 1) throw new ConsoleValidationError("unsupported_version");
  if (row.kind !== "operation.retry" && row.kind !== "operation.cancel") throw new ConsoleValidationError("unsupported_kind");
  if (typeof row.targetOperationId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(row.targetOperationId))
    throw new ConsoleValidationError("invalid_target");
  if (typeof row.targetDigest !== "string" || !/^[0-9a-f]{64}$/.test(row.targetDigest)) throw new ConsoleValidationError("invalid_digest");
  if (!Number.isSafeInteger(row.expectedVersion) || (row.expectedVersion as number) < 0) throw new ConsoleValidationError("invalid_version");
  return { version: 1, kind: row.kind, targetOperationId: row.targetOperationId,
    targetDigest: row.targetDigest, expectedVersion: row.expectedVersion as number };
}

export function redactedSummary(request: ConsoleOperationRequest): Record<string, unknown> {
  if (request.kind !== "config.apply") return { kind: request.kind };
  return { kind: request.kind, changedFields: Object.keys(request.changes).sort(),
    secretFields: Object.keys(request.secrets).sort() };
}

export function validateReason(value: unknown): string { return boundedReason(value); }
