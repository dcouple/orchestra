import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  awaitDetachedExit, buildTurnSettings, childEnv, runTurn,
  type PreparedLaunch, type RunTurnOptions, type RunTurnResult,
} from "./claude.js";
import { runCodexTurn } from "./codex.js";

export const AGENT_FARM_WORKSPACE = "bloom-mono";
type NativeHarness = "claude" | "codex";

interface AgentFarmTurnOptions extends RunTurnOptions {
  agentFarmBin: string;
  profile: string;
  workspace?: string;
  onHarness?: (harness: NativeHarness) => void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

// Only preparation output is collected. The native child goes straight to the
// existing streaming runner, with its detached process group and abort handling.
async function printJson(options: AgentFarmTurnOptions, args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  options.signal?.throwIfAborted();
  const child = spawn(options.agentFarmBin, args, {
    cwd: options.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let spawnError = false;
  let tooLarge = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length + chunk.length > 4 * 1024 * 1024) {
      tooLarge = true;
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* Already exited. */ }
    } else stdout += chunk;
  });
  // Drain stderr without exposing potentially sensitive preparation diagnostics.
  child.stderr.resume();
  child.once("error", () => { spawnError = true; });
  const closed = await awaitDetachedExit(child, options.signal);
  options.signal?.throwIfAborted();
  if (spawnError || tooLarge || closed.code !== 0 || closed.signal !== null)
    throw new Error("Agent Farm preparation failed");
  try { return JSON.parse(stdout); } catch { throw new Error("Agent Farm printed invalid JSON"); }
}

function harness(value: unknown): NativeHarness {
  if (value !== "claude" && value !== "codex")
    throw new Error("Agent Farm profile must report a claude or codex harness");
  return value;
}

export async function runAgentFarmTurn(options: AgentFarmTurnOptions): Promise<RunTurnResult> {
  const env = childEnv(options.env, options.trustedEnv, options.mcpEnvPassthrough);
  const workspace = options.workspace ? ["--workspace", options.workspace] : [];
  const info = record(await printJson(options, ["inspect", options.profile, ...workspace], env));
  const main = record(record(info?.agents)?.main);
  const nativeHarness = harness(main?.harness);
  options.onHarness?.(nativeHarness);
  let settingsDir: string | undefined;
  try {
    let flags: string[];
    if (nativeHarness === "claude") {
      settingsDir = await mkdtemp(join(tmpdir(), "linear-agent-farm-settings-"));
      const settings = join(settingsDir, "settings.json");
      const settingsJson = JSON.stringify(buildTurnSettings(options.toolHook));
      await writeFile(settings, settingsJson, { mode: 0o600 });
      if (await readFile(settings, "utf8") !== settingsJson)
        throw new Error("Agent Farm turn settings did not verify");
      flags = ["-p", "--output-format", "stream-json", "--verbose"];
      if (options.resumeSessionId) flags.push("--resume", options.resumeSessionId);
      flags.push("--settings", settings, "--permission-mode", options.permissionMode,
        "--max-turns", String(options.maxTurns));
      if (options.maxBudgetUsd !== undefined)
        flags.push("--max-budget-usd", String(options.maxBudgetUsd));
    } else {
      flags = ["exec"];
      if (options.resumeSessionId) flags.push("resume");
      flags.push("--json");
      if (options.resumeSessionId) flags.push(options.resumeSessionId);
    }
    const printed = record(await printJson(options, ["run", options.profile,
      "--directory", options.cwd, ...workspace, "--print-launch",
      "--message=" + options.prompt, "--", ...flags], env));
    const overrides = record(printed?.env);
    if (!Array.isArray(printed?.argv) || !printed.argv.length
      || printed.argv.some(arg => typeof arg !== "string" || arg.includes("\0"))
      || !printed.argv[0] || typeof printed.cwd !== "string" || !isAbsolute(printed.cwd)
      || typeof printed.bundle !== "string" || !isAbsolute(printed.bundle)
      || !overrides || Object.values(overrides).some(value => typeof value !== "string"))
      throw new Error("Agent Farm printed an invalid launch");
    const manifest = record(JSON.parse(await readFile(join(printed.bundle, "manifest.json"), "utf8")));
    const prepared = record(record(manifest?.nodes)?.main);
    if (harness(prepared?.harness) !== nativeHarness)
      throw new Error("Agent Farm profile harness changed during preparation");
    const launch: PreparedLaunch = {
      argv: printed.argv as string[], cwd: printed.cwd,
      env: { ...env, ...overrides as Record<string, string> },
    };
    options.signal?.throwIfAborted();
    if (nativeHarness === "codex") {
      if (typeof prepared?.model !== "string") throw new Error("Agent Farm profile has no model");
      return await runCodexTurn({ ...options, preparedLaunch: launch, model: prepared.model });
    }
    return await runTurn({ ...options, preparedLaunch: launch });
  } finally {
    if (settingsDir) await rm(settingsDir, { recursive: true, force: true });
  }
}
