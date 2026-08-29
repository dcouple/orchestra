import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EDITABLE_SETTING_KEYS, SECRET_NAMES, type ConsoleSecretName, type EditableSettings,
  ConsoleValidationError, validateEditableChanges } from "./console-operation-schema.js";
import { parseManagedEnv } from "./managed-env.js";

export interface SnapshotSourceEvidence { digest: string; size: number; mtimeMs: number }
export interface ConsoleConfigSnapshot {
  version: 1; revision: string; generatedAt: number; settings: EditableSettings;
  secrets: Record<ConsoleSecretName, { configured: boolean }>;
  source: SnapshotSourceEvidence;
}
export type SafeConsoleConfigSnapshot = Omit<ConsoleConfigSnapshot, "source"> & { staleAt: number };

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value !== "0" && value !== "1") throw new ConsoleValidationError("invalid_runtime_config");
  return value === "1";
}
function int(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ConsoleValidationError("invalid_runtime_config");
  return parsed;
}
function settingsFromEnv(env: Record<string, string>): EditableSettings {
  const candidate: EditableSettings = {
    plannerHarness: (env.PLANNER_HARNESS ?? "claude") as EditableSettings["plannerHarness"],
    implementerHarness: (env.IMPLEMENTER_HARNESS ?? "claude") as EditableSettings["implementerHarness"],
    sessionConcurrency: int(env.SESSION_CONCURRENCY, 2), iosSimMaxConcurrent: int(env.IOS_SIM_MAX_CONCURRENT, 2),
    claudeMaxTurns: int(env.CLAUDE_MAX_TURNS, 30), doMaxTurns: int(env.DO_MAX_TURNS, 60),
    doMaxBudgetUsd: env.DO_MAX_BUDGET_USD ? Number(env.DO_MAX_BUDGET_USD) : null,
    mcpEnvPassthrough: env.MCP_ENV_PASSTHROUGH ? env.MCP_ENV_PASSTHROUGH.split(",").filter(Boolean) : [],
    browserEnabled: bool(env.BROWSER_ENABLED, true), iosSimEnabled: bool(env.IOS_SIM_ENABLED, false),
    attachmentsEnabled: bool(env.ATTACHMENTS_ENABLED, true), ntfyUrl: env.NTFY_URL || null,
  };
  const validated = validateEditableChanges(candidate);
  if (Object.keys(validated).length !== EDITABLE_SETTING_KEYS.length) throw new ConsoleValidationError("invalid_runtime_config");
  return validated as EditableSettings;
}
export async function sourceEvidence(path: string): Promise<SnapshotSourceEvidence> {
  return (await readSource(path)).source;
}
async function readSource(path: string): Promise<{ text: string; source: SnapshotSourceEvidence }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new ConsoleValidationError("invalid_env_file");
    const bytes = await handle.readFile();
    return { text: bytes.toString("utf8"), source: { digest: createHash("sha256").update(bytes).digest("hex"),
      size: info.size, mtimeMs: Math.trunc(info.mtimeMs) } };
  } finally { await handle.close(); }
}
export async function createConsoleConfigSnapshot(envPath: string, now = Date.now()): Promise<ConsoleConfigSnapshot> {
  const { text, source } = await readSource(envPath);
  const document = parseManagedEnv(text);
  const secrets = Object.fromEntries(SECRET_NAMES.map(name => [name, { configured: Boolean(document.values[name]) }])) as
    Record<ConsoleSecretName, { configured: boolean }>;
  return { version: 1, revision: randomBytes(24).toString("base64url"), generatedAt: now,
    settings: settingsFromEnv(document.values), secrets, source };
}
export async function writeConsoleConfigSnapshot(envPath: string, outputPath: string, now = Date.now()): Promise<ConsoleConfigSnapshot> {
  const snapshot = await createConsoleConfigSnapshot(envPath, now);
  const target = resolve(outputPath); const parent = dirname(target);
  const temp = resolve(parent, `.console-config-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, target); return snapshot;
}
function isSnapshot(value: unknown): value is ConsoleConfigSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  try {
    if (row.version !== 1 || typeof row.revision !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(row.revision)
      || !Number.isSafeInteger(row.generatedAt) || row.source === null || typeof row.source !== "object"
      || row.secrets === null || typeof row.secrets !== "object") return false;
    const settings = validateEditableChanges(row.settings);
    if (Object.keys(settings).length !== EDITABLE_SETTING_KEYS.length) return false;
    const source = row.source as Record<string, unknown>;
    if (typeof source.digest !== "string" || !/^[0-9a-f]{64}$/.test(source.digest)
      || !Number.isSafeInteger(source.size) || !Number.isSafeInteger(source.mtimeMs)) return false;
    const secretRows = row.secrets as Record<string, unknown>;
    return Object.keys(secretRows).length === SECRET_NAMES.length && SECRET_NAMES.every(name => {
      const state = secretRows[name]; return state !== null && typeof state === "object"
        && Object.keys(state).length === 1 && typeof (state as { configured?: unknown }).configured === "boolean";
    });
  } catch { return false; }
}
export async function readConsoleConfigSnapshot(path: string, maxAgeMs: number, now = Date.now()): Promise<ConsoleConfigSnapshot> {
  let text: string;
  try { const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await handle.stat(); if (!info.isFile() || info.size > 128 * 1024) throw new ConsoleValidationError("snapshot_unavailable");
      text = await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch (error) { if (error instanceof ConsoleValidationError) throw error; throw new ConsoleValidationError("snapshot_unavailable"); }
  let value: unknown; try { value = JSON.parse(text); } catch { throw new ConsoleValidationError("snapshot_invalid"); }
  if (!isSnapshot(value)) throw new ConsoleValidationError("snapshot_invalid");
  if (value.generatedAt > now + 60_000 || now - value.generatedAt > maxAgeMs) throw new ConsoleValidationError("snapshot_stale");
  return value;
}
export function projectConsoleConfigSnapshot(snapshot: ConsoleConfigSnapshot, maxAgeMs: number): SafeConsoleConfigSnapshot {
  const { source: _source, ...safe } = snapshot; return { ...safe, staleAt: snapshot.generatedAt + maxAgeMs };
}
export async function snapshotMatchesSource(snapshot: ConsoleConfigSnapshot, envPath: string): Promise<boolean> {
  const current = await sourceEvidence(envPath); return current.digest === snapshot.source.digest
    && current.size === snapshot.source.size && current.mtimeMs === snapshot.source.mtimeMs;
}
