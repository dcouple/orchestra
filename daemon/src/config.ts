import { dirname } from "node:path";

export type AppName = "planner" | "implementer";

export interface AppConfig {
  name: AppName;
  webhookSecret: string;
  clientId?: string;
  clientSecret?: string;
  staticToken?: string;
}

export interface Config {
  port: number;
  bindAddr: string;
  dbPath: string;
  replayWindowMs: number;
  linearGraphqlUrl: string;
  linearTokenUrl: string;
  apps: Record<AppName, AppConfig>;
  sessionsEnabled: boolean;
  worktreesRoot: string;
  targetRepoPath?: string;
  claudeArgv: string[];
  claudePermissionMode: string;
  claudeMaxTurns: number;
  sessionConcurrency: number;
  keepaliveMs: number;
  linearApiKey?: string;
  attachmentsEnabled: boolean;
  attachmentHosts: string[];
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

function appConfig(env: NodeJS.ProcessEnv, name: AppName, testMode: boolean): AppConfig {
  const prefix = name.toUpperCase();
  const staticToken = env[`${prefix}_LINEAR_TOKEN`]?.trim();
  const base = { name, webhookSecret: required(env, `${prefix}_WEBHOOK_SECRET`) };
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
  if (sessionsEnabled && !targetRepoPath) required(env, "TARGET_REPO_PATH");
  if (sessionsEnabled && !linearApiKey) required(env, "LINEAR_API_KEY");
  const claudeArgv = (env.CLAUDE_BIN?.trim() || "claude").split(/\s+/);
  return {
    port: positiveInteger(env, "PORT", 8787),
    bindAddr: env.BIND_ADDR?.trim() || "127.0.0.1",
    dbPath,
    replayWindowMs: positiveInteger(env, "REPLAY_WINDOW_MS", 60_000),
    linearGraphqlUrl: env.LINEAR_GRAPHQL_URL?.trim() || "https://api.linear.app/graphql",
    linearTokenUrl: env.LINEAR_TOKEN_URL?.trim() || "https://api.linear.app/oauth/token",
    apps: { planner: appConfig(env, "planner", testMode), implementer: appConfig(env, "implementer", testMode) },
    sessionsEnabled,
    worktreesRoot: env.WORKTREES_ROOT?.trim() || `${dirname(dbPath)}/worktrees`,
    ...(targetRepoPath ? { targetRepoPath } : {}),
    claudeArgv,
    claudePermissionMode: env.CLAUDE_PERMISSION_MODE?.trim() || "bypassPermissions",
    claudeMaxTurns: positiveInteger(env, "CLAUDE_MAX_TURNS", 100),
    sessionConcurrency: positiveInteger(env, "SESSION_CONCURRENCY", 2),
    keepaliveMs: positiveInteger(env, "KEEPALIVE_MS", 900_000),
    ...(linearApiKey ? { linearApiKey } : {}),
    attachmentsEnabled: enabled(env, "ATTACHMENTS_ENABLED"),
    attachmentHosts: (env.ATTACHMENT_HOSTS?.trim() || "uploads.linear.app").split(",").map(host => host.trim()).filter(Boolean),
  };
}
