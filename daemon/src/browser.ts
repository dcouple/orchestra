import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "./config.js";

export const BROWSER_RELAUNCH_SENTINEL = "ORCHESTRA_BROWSER_RELAUNCH_REQUIRED";

export interface BrowserAttempt {
  runId: string;
  attemptId: string;
  root: string;
  stateDir: string;
  evidenceDir: string;
  socketAlias: string;
  mcpServer: { type: "stdio"; command: string; args: string[]; env: Record<string, string> };
}

export class BrowserPrerequisiteError extends Error {
  constructor(readonly kind: "disabled" | "mcp_unavailable" | "chrome_unavailable", message: string) {
    super(message); this.name = "BrowserPrerequisiteError";
  }
}

export function browserRunRoot(config: Pick<Config, "artifactsDir">, runId: string): string {
  return join(resolve(config.artifactsDir), "browser", runId);
}

export async function createBrowserRequest(config: Pick<Config, "artifactsDir">, linearSessionId: string): Promise<string> {
  const root = join(resolve(config.artifactsDir), "browser-requests");
  await mkdir(root, { recursive: true });
  const path = join(root, `${linearSessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ version: 1, linearSessionId, requested: false }), { mode: 0o600 });
  return path;
}

export async function browserWasRequested(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { requested?: unknown };
    return value.requested === true;
  } catch { return false; }
}

export async function removeBrowserRequest(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function assertBrowserPrerequisites(config: Pick<Config, "browserEnabled" | "playwrightMcpBin" | "playwrightChromeBin">): Promise<void> {
  if (!config.browserEnabled) throw new BrowserPrerequisiteError("disabled", "browser capability is disabled (BROWSER_ENABLED=0)");
  try { await access(config.playwrightMcpBin, constants.X_OK); }
  catch { throw new BrowserPrerequisiteError("mcp_unavailable", `Playwright MCP executable is unavailable: ${config.playwrightMcpBin}`); }
  try { await access(config.playwrightChromeBin, constants.X_OK); }
  catch { throw new BrowserPrerequisiteError("chrome_unavailable", `Chrome executable is unavailable: ${config.playwrightChromeBin}`); }
}

export async function createBrowserAttempt(config: Pick<Config, "artifactsDir" | "browserEnabled" | "playwrightMcpBin" | "playwrightChromeBin">, runId: string): Promise<BrowserAttempt> {
  await assertBrowserPrerequisites(config);
  const attemptId = `attempt-${randomUUID()}`;
  const root = join(browserRunRoot(config, runId), attemptId);
  const stateDir = join(root, "state");
  const evidenceDir = join(root, "evidence");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(evidenceDir, { recursive: true })]);
  const socketAlias = join("/tmp", `orchestra-pw-${randomUUID()}`);
  await symlink(stateDir, socketAlias);
  return {
    runId, attemptId, root, stateDir, evidenceDir, socketAlias,
    mcpServer: {
      type: "stdio", command: config.playwrightMcpBin,
      args: ["--browser", "chrome", "--executable-path", config.playwrightChromeBin, "--headless", "--isolated",
        "--output-dir", evidenceDir, "--output-mode", "file", "--caps", "devtools"],
      env: { TMPDIR: stateDir, TEMP: stateDir, TMP: stateDir, PWTEST_SOCKETS_DIR: socketAlias },
    },
  };
}

export async function cleanupBrowserAttempt(attempt: BrowserAttempt): Promise<void> {
  await unlink(attempt.socketAlias).catch(() => {});
  await rm(attempt.stateDir, { recursive: true, force: true });
}

export function mergeMcpConfig(linearConfigJson: string, attempt: BrowserAttempt): string {
  const parsed = JSON.parse(linearConfigJson) as { mcpServers?: Record<string, unknown> };
  return JSON.stringify({ ...parsed, mcpServers: { ...(parsed.mcpServers ?? {}), playwright: attempt.mcpServer } });
}

export function browserAttemptEnv(attempt: BrowserAttempt): NodeJS.ProcessEnv {
  return {
    ORCHESTRA_BROWSER_RUN_ID: attempt.runId,
    ORCHESTRA_BROWSER_ATTEMPT_ID: attempt.attemptId,
    ORCHESTRA_BROWSER_STATE_DIR: attempt.stateDir,
    ORCHESTRA_BROWSER_EVIDENCE_DIR: attempt.evidenceDir,
  };
}
