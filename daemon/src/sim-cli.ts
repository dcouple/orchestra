import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface Io { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }
interface Context { version: 1; baseUrl: string; turnId: number; linearSessionId: string; token: string }
const usage = "usage: orchestra-sim acquire | release <udid> | status\n";
function write(io: Io["stdout"], value: unknown): void { io.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`); }

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = process): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") { io.stdout.write(usage); return 0; }
  if (!["acquire", "release", "status"].includes(argv[0] ?? "") || (argv[0] === "release" && !argv[1])) {
    io.stderr.write(usage); return 2;
  }
  const path = env.ORCHESTRA_SIM_CONTEXT;
  if (!path) { write(io.stderr, { error: { kind: "disabled", message: "no simulator context: capability disabled or not attached to this turn" } }); return 1; }
  let context: Context;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<Context>;
    if (value.version !== 1 || typeof value.baseUrl !== "string" || typeof value.turnId !== "number" ||
      typeof value.linearSessionId !== "string" || typeof value.token !== "string") throw new Error("invalid fields");
    context = value as Context;
  } catch (error) { write(io.stderr, { error: { kind: "context_invalid", message: error instanceof Error ? error.message : String(error) } }); return 2; }
  const command = argv[0]!;
  const query = `?turnId=${encodeURIComponent(context.turnId)}`;
  const url = command === "release"
    ? `${context.baseUrl}/sim/leases/${encodeURIComponent(argv[1]!)}${query}`
    : `${context.baseUrl}/sim/leases${command === "status" ? query : ""}`;
  try {
    const response = await fetch(url, {
      method: command === "acquire" ? "POST" : command === "release" ? "DELETE" : "GET",
      headers: { Authorization: `Bearer ${context.token}`, ...(command === "acquire" ? { "Content-Type": "application/json" } : {}) },
      ...(command === "acquire" ? { body: JSON.stringify({ turnId: context.turnId }) } : {}),
    });
    const body = await response.json().catch(() => ({ error: { kind: "sim_failed", message: `daemon returned HTTP ${response.status}` } }));
    write(response.ok ? io.stdout : io.stderr, body); return response.ok ? 0 : 1;
  } catch (error) {
    write(io.stderr, { error: { kind: "daemon_unreachable", message: error instanceof Error ? error.message : String(error) } }); return 1;
  }
}

if (process.argv[1]) {
  try { if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2)); }
  catch {}
}
