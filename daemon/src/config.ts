import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isReservedChildEnvKey } from "./claude.js";

export type AppName = "planner" | "implementer";
export type HarnessPreference = "claude" | "claudex";

export interface AppConfig {
  name: AppName;
  harness: HarnessPreference;
  webhookSecret: string;
  appActorId?: string;
  clientId?: string;
  clientSecret?: string;
  staticToken?: string;
}

function harnessPreference(env: NodeJS.ProcessEnv, name: string): HarnessPreference {
  const raw = env[name];
  if (raw === undefined) return "claude";
  const value = raw.trim();
  if (value !== "claude" && value !== "claudex") throw new Error(`${name} must be claude or claudex`);
  return value;
}

export interface Config {
  port: number;
  bindAddr: string;
  dbPath: string;
  replayWindowMs: number;
  linearGraphqlUrl: string;
  linearTokenUrl: string;
  linearMcpUrl: string;
  linearMcpMonitorIntervalMs: number;
  linearMcpMonitorTimeoutMs: number;
  dependencyMonitorIntervalMs: number;
  dependencyMonitorTimeoutMs: number;
  dependencyStateStaleMs: number;
  webhookBaseUrl: string;
  artifactToken?: string;
  mcpEnvPassthrough?: string[];
  artifactsDir: string;
  dispatchQuarantineDir: string;
  dispatchQuarantineAgeMs: number;
  dispatchResumeGraceMs: number;
  browserEnabled: boolean;
  playwrightMcpBin: string;
  playwrightChromeBin: string;
  browserAttemptTimeoutMs: number;
  iosSimEnabled: boolean;
  xcodebuildMcpBin: string;
  iosSimDeveloperDir: string;
  iosSimRuntime?: string;
  iosSimDeviceType?: string;
  iosSimMaxConcurrent: number;
  iosSimIdleTimeoutMs: number;
  iosSimReaperIntervalMs: number;
  simctlArgv: string[];
  artifactMaxBodyBytes: number;
  reconcileIntervalMs: number;
  reconcileRequestTimeoutMs: number;
  reconcileSessionMaxAgeMs: number;
  apps: Record<AppName, AppConfig>;
  sessionsEnabled: boolean;
  worktreesRoot: string;
  targetRepoPath?: string;
  claudeArgv: string[];
  claudexArgv?: string[];
  claudexEnv?: Record<string, string>;
  fableArgv?: string[];
  cliproxyEnvFile: string;
  cliproxyUrl: string;
  providerProbeIntervalMs: number;
  providerStateStaleMs: number;
  providerInitialProbeTimeoutMs: number;
  claudePermissionMode: string;
  claudeMaxTurns: number;
  bashDefaultTimeoutMs: number;
  bashMaxTimeoutMs: number;
  doPermissionMode: string;
  doMaxTurns: number;
  doMaxBudgetUsd?: number;
  sessionConcurrency: number;
  keepaliveMs: number;
  linearApiKey?: string;
  attachmentsEnabled: boolean;
  attachmentHosts: string[];
  ntfyUrl?: string;
}

export interface ConsoleConfig {
  port: number;
  bindAddr: "127.0.0.1";
  dbPath: string;
  assetsDir: string;
  daemonHealthUrl: string;
  linearWorkspaceBaseUrl?: string;
  skillInventoryPath: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function enabled(env: NodeJS.ProcessEnv, name: string, fallback = true): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(`${name} must be 0 or 1`);
}

function loopbackAddress(env: NodeJS.ProcessEnv, name: string): "127.0.0.1" {
  const value = env[name]?.trim() || "127.0.0.1";
  if (value !== "127.0.0.1") throw new Error(`${name} must be 127.0.0.1`);
  return value;
}

function httpUrl(env: NodeJS.ProcessEnv, name: string, fallback: string, loopbackOnly = false): string {
  const raw = env[name]?.trim() || fallback;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} must be a valid HTTP URL`); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error(`${name} must be a valid HTTP URL`);
  if (loopbackOnly && (url.protocol !== "http:" || url.hostname !== "127.0.0.1"))
    throw new Error(`${name} must be an http://127.0.0.1 URL`);
  return url.toString().replace(/\/$/, "");
}

export function loadConsoleConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  const base = env.LINEAR_WORKSPACE_BASE_URL?.trim();
  const port = positiveInteger(env, "CONSOLE_PORT", 8790);
  if (port > 65_535) throw new Error("CONSOLE_PORT must be at most 65535");
  return {
    port,
    bindAddr: loopbackAddress(env, "CONSOLE_BIND_ADDR"),
    dbPath: env.DB_PATH?.trim() || "/var/lib/linear-agent-daemon/events.db",
    assetsDir: env.CONSOLE_ASSETS_DIR?.trim() || resolve(dirname(fileURLToPath(import.meta.url)), "console"),
    daemonHealthUrl: httpUrl(env, "CONSOLE_DAEMON_HEALTH_URL", "http://127.0.0.1:8787/healthz", true),
    skillInventoryPath: env.CONSOLE_SKILL_INVENTORY_PATH?.trim()
      || resolve(dirname(fileURLToPath(import.meta.url)), "console-inventory.json"),
    ...(base ? { linearWorkspaceBaseUrl: httpUrl(env, "LINEAR_WORKSPACE_BASE_URL", base) } : {}),
  };
}

function optionalArgv(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) throw new Error(`${name} must not be empty`);
  return value.split(/\s+/);
}

function stringMap(env: NodeJS.ProcessEnv, name: string): Record<string, string> | undefined {
  if (env[name] === undefined) return undefined;
  const raw = env[name]!.trim();
  if (!raw) throw new Error(`${name} must be valid JSON`);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`${name} must be valid JSON`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.values(value as Record<string, unknown>).some(entry => typeof entry !== "string")) {
    throw new Error(`${name} must be a JSON object with string values`);
  }
  return value as Record<string, string>;
}

function mcpEnvPassthrough(env: NodeJS.ProcessEnv): string[] {
  const names = [
    ...new Set(
      (env.MCP_ENV_PASSTHROUGH ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(
        `MCP_ENV_PASSTHROUGH key ${name} must be an environment variable name`,
      );
    const reserved = isReservedChildEnvKey(name);
    if (reserved === "denied")
      throw new Error(
        `MCP_ENV_PASSTHROUGH must not name ${name} (denied child secret)`,
      );
    if (reserved === "daemon-owned")
      throw new Error(
        `MCP_ENV_PASSTHROUGH must not name ${name} (daemon-owned)`,
      );
  }
  return names;
}

function appConfig(env: NodeJS.ProcessEnv, name: AppName, testMode: boolean): AppConfig {
  const prefix = name.toUpperCase();
  const staticToken = env[`${prefix}_LINEAR_TOKEN`]?.trim();
  const appActorId = env[`${prefix}_APP_ACTOR_ID`]?.trim();
  const base = { name, harness: harnessPreference(env, `${prefix}_HARNESS`),
    webhookSecret: required(env, `${prefix}_WEBHOOK_SECRET`), ...(appActorId ? { appActorId } : {}) };
  if (testMode && staticToken) return { ...base, staticToken };
  return {
    ...base,
    clientId: required(env, `${prefix}_LINEAR_CLIENT_ID`),
    clientSecret: required(env, `${prefix}_LINEAR_CLIENT_SECRET`),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const testMode = env.DAEMON_TEST_MODE === "1";
  const dbPath = env.DB_PATH?.trim() || "/var/lib/linear-agent-daemon/events.db";
  const sessionsEnabled = enabled(env, "SESSIONS_ENABLED");
  const targetRepoPath = env.TARGET_REPO_PATH?.trim();
  const linearApiKey = env.LINEAR_API_KEY?.trim();
  const artifactToken = env.ARTIFACT_TOKEN?.trim();
  const passthrough = mcpEnvPassthrough(env);
  const webhookBaseUrl = env.WEBHOOK_BASE_URL?.trim() || (testMode ? "http://127.0.0.1:8787" : required(env, "WEBHOOK_BASE_URL"));
  if (sessionsEnabled && !targetRepoPath) required(env, "TARGET_REPO_PATH");
  if (sessionsEnabled && !linearApiKey) required(env, "LINEAR_API_KEY");
  const claudeArgv = (env.CLAUDE_BIN?.trim() || "claude").split(/\s+/);
  const claudexArgv = optionalArgv(env, "CLAUDEX_BIN");
  const claudexEnv = stringMap(env, "CLAUDEX_ENV");
  if (claudexEnv && !claudexArgv) throw new Error("CLAUDEX_ENV requires CLAUDEX_BIN");
  const fableBin = env.FABLE_BIN?.trim();
  const iosSimEnabled = enabled(env, "IOS_SIM_ENABLED", false);
  const iosSimRuntime = env.IOS_SIM_RUNTIME?.trim();
  const iosSimDeviceType = env.IOS_SIM_DEVICE_TYPE?.trim();
  if (iosSimEnabled && (!iosSimRuntime || !iosSimDeviceType)) {
    throw new Error("IOS_SIM_RUNTIME and IOS_SIM_DEVICE_TYPE are required when IOS_SIM_ENABLED=1");
  }
  const providerProbeIntervalMs = positiveInteger(env, "PROVIDER_PROBE_INTERVAL_MS", 60_000);
  const dependencyMonitorIntervalMs = positiveInteger(env, "DEPENDENCY_MONITOR_INTERVAL_MS", 60_000);
  const dependencyMonitorTimeoutMs = positiveInteger(env, "DEPENDENCY_MONITOR_TIMEOUT_MS", 10_000);
  if (dependencyMonitorTimeoutMs > 60_000) throw new Error("DEPENDENCY_MONITOR_TIMEOUT_MS must be at most 60000");
  const dependencyStateStaleMs = positiveInteger(env, "DEPENDENCY_STATE_STALE_MS", 5 * dependencyMonitorIntervalMs);
  if (dependencyStateStaleMs > 86_400_000) throw new Error("DEPENDENCY_STATE_STALE_MS must be at most 86400000");
  const bashDefaultTimeoutMs = positiveInteger(env, "BASH_DEFAULT_TIMEOUT_MS", 900_000);
  const bashMaxTimeoutMs = positiveInteger(env, "BASH_MAX_TIMEOUT_MS", 900_000);
  if (bashMaxTimeoutMs < bashDefaultTimeoutMs) {
    throw new Error("BASH_MAX_TIMEOUT_MS must be greater than or equal to BASH_DEFAULT_TIMEOUT_MS");
  }
  const doPermissionMode = env.DO_PERMISSION_MODE?.trim() || "bypassPermissions";
  if (!testMode && doPermissionMode !== "bypassPermissions") {
    throw new Error("DO_PERMISSION_MODE must be bypassPermissions unless DAEMON_TEST_MODE=1");
  }
  const budgetRaw = env.DO_MAX_BUDGET_USD?.trim();
  const doMaxBudgetUsd = budgetRaw === undefined || budgetRaw === "" ? undefined : Number(budgetRaw);
  if (doMaxBudgetUsd !== undefined && (!Number.isFinite(doMaxBudgetUsd) || doMaxBudgetUsd <= 0)) {
    throw new Error("DO_MAX_BUDGET_USD must be a positive number");
  }
  return {
    port: positiveInteger(env, "PORT", 8787),
    bindAddr: env.BIND_ADDR?.trim() || "127.0.0.1",
    dbPath,
    replayWindowMs: positiveInteger(env, "REPLAY_WINDOW_MS", 60_000),
    linearGraphqlUrl: env.LINEAR_GRAPHQL_URL?.trim() || "https://api.linear.app/graphql",
    linearTokenUrl: env.LINEAR_TOKEN_URL?.trim() || "https://api.linear.app/oauth/token",
    linearMcpUrl: (env.LINEAR_MCP_URL?.trim() || "https://mcp.linear.app/mcp").replace(/\/+$/, ""),
    linearMcpMonitorIntervalMs: positiveInteger(env, "LINEAR_MCP_MONITOR_INTERVAL_MS", 60_000),
    linearMcpMonitorTimeoutMs: positiveInteger(env, "LINEAR_MCP_MONITOR_TIMEOUT_MS", 10_000),
    dependencyMonitorIntervalMs,
    dependencyMonitorTimeoutMs,
    dependencyStateStaleMs,
    webhookBaseUrl: webhookBaseUrl.replace(/\/+$/, ""),
    ...(artifactToken ? { artifactToken } : {}),
    ...(passthrough.length > 0 ? { mcpEnvPassthrough: passthrough } : {}),
    artifactsDir: env.ARTIFACTS_DIR?.trim() || `${dirname(dbPath)}/artifacts`,
    dispatchQuarantineDir:
      env.DISPATCH_QUARANTINE_DIR?.trim() ||
      `${dirname(dbPath)}/dispatch-quarantine`,
    dispatchQuarantineAgeMs: positiveInteger(
      env,
      "DISPATCH_QUARANTINE_AGE_MS",
      24 * 60 * 60 * 1000,
    ),
    dispatchResumeGraceMs: positiveInteger(
      env,
      "DISPATCH_RESUME_GRACE_MS",
      10 * 60_000,
    ),
    browserEnabled: enabled(env, "BROWSER_ENABLED", true),
    playwrightMcpBin: env.PLAYWRIGHT_MCP_BIN?.trim() || "/usr/local/bin/playwright-mcp",
    playwrightChromeBin: env.PLAYWRIGHT_CHROME_BIN?.trim() || "/usr/bin/google-chrome",
    browserAttemptTimeoutMs: positiveInteger(env, "BROWSER_ATTEMPT_TIMEOUT_MS", 4 * 60 * 60 * 1000),
    iosSimEnabled,
    xcodebuildMcpBin: env.XCODEBUILD_MCP_BIN?.trim() || "/usr/local/bin/xcodebuildmcp",
    iosSimDeveloperDir: env.IOS_SIM_DEVELOPER_DIR?.trim() || "/Applications/Xcode.app/Contents/Developer",
    ...(iosSimRuntime ? { iosSimRuntime } : {}),
    ...(iosSimDeviceType ? { iosSimDeviceType } : {}),
    iosSimMaxConcurrent: positiveInteger(env, "IOS_SIM_MAX_CONCURRENT", 2),
    iosSimIdleTimeoutMs: positiveInteger(env, "IOS_SIM_IDLE_TIMEOUT_MS", 900_000),
    iosSimReaperIntervalMs: positiveInteger(env, "IOS_SIM_REAPER_INTERVAL_MS", 60_000),
    simctlArgv: (env.IOS_SIM_SIMCTL_BIN?.trim() || "xcrun simctl").split(/\s+/),
    artifactMaxBodyBytes: positiveInteger(env, "ARTIFACT_MAX_BODY_BYTES", 32 * 1024 * 1024),
    reconcileIntervalMs: positiveInteger(env, "RECONCILE_INTERVAL_MS", 60_000),
    reconcileRequestTimeoutMs: positiveInteger(env, "RECONCILE_REQUEST_TIMEOUT_MS", 10_000),
    reconcileSessionMaxAgeMs: positiveInteger(env, "RECONCILE_SESSION_MAX_AGE_MS", 6 * 60 * 60_000),
    apps: { planner: appConfig(env, "planner", testMode), implementer: appConfig(env, "implementer", testMode) },
    sessionsEnabled,
    worktreesRoot: env.WORKTREES_ROOT?.trim() || `${dirname(dbPath)}/worktrees`,
    ...(targetRepoPath ? { targetRepoPath } : {}),
    claudeArgv,
    ...(claudexArgv ? { claudexArgv } : {}),
    ...(claudexEnv ? { claudexEnv } : {}),
    ...(fableBin ? { fableArgv: fableBin.split(/\s+/) } : {}),
    cliproxyEnvFile: env.CLIPROXY_ENV_FILE?.trim() || "/etc/linear-agent-daemon/cliproxyapi.env",
    cliproxyUrl: (env.CLIPROXY_URL?.trim() || "http://127.0.0.1:8317").replace(/\/+$/, ""),
    providerProbeIntervalMs,
    providerStateStaleMs: positiveInteger(env, "PROVIDER_STATE_STALE_MS", 5 * providerProbeIntervalMs),
    providerInitialProbeTimeoutMs: positiveInteger(env, "PROVIDER_INITIAL_PROBE_TIMEOUT_MS", 5_000),
    claudePermissionMode: env.CLAUDE_PERMISSION_MODE?.trim() || "bypassPermissions",
    claudeMaxTurns: positiveInteger(env, "CLAUDE_MAX_TURNS", 100),
    bashDefaultTimeoutMs,
    bashMaxTimeoutMs,
    doPermissionMode,
    doMaxTurns: positiveInteger(env, "DO_MAX_TURNS", 300),
    ...(doMaxBudgetUsd !== undefined ? { doMaxBudgetUsd } : {}),
    sessionConcurrency: positiveInteger(env, "SESSION_CONCURRENCY", 5),
    keepaliveMs: positiveInteger(env, "KEEPALIVE_MS", 900_000),
    ...(linearApiKey ? { linearApiKey } : {}),
    ...(env.NTFY_URL?.trim() ? { ntfyUrl: env.NTFY_URL.trim() } : {}),
    attachmentsEnabled: enabled(env, "ATTACHMENTS_ENABLED"),
    attachmentHosts: (env.ATTACHMENT_HOSTS?.trim() || "uploads.linear.app").split(",").map(host => host.trim()).filter(Boolean),
  };
}
