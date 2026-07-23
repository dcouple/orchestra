import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const configAt = process.argv.indexOf("--mcp-config");
if (configAt < 0 || !process.argv[configAt + 1]) throw new Error("missing --mcp-config");
const evidenceDir = process.env.ORCHESTRA_BROWSER_EVIDENCE_DIR;
if (!evidenceDir) throw new Error("missing ORCHESTRA_BROWSER_EVIDENCE_DIR");
const readyFile = `${evidenceDir}/lifecycle-ready.json`;
const driver = new URL("./browser-mcp-driver.mjs", import.meta.url);

process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "browser-lifecycle-session" })}\n`);
spawn(process.execPath, [driver.pathname, process.argv[configAt + 1]], { env: process.env, stdio: "ignore" });

const deadline = Date.now() + 15_000;
while (!existsSync(readyFile)) {
  if (Date.now() > deadline) throw new Error("real browser lifecycle driver did not become ready");
  await delay(25);
}

if (process.env.ORCHESTRA_BROWSER_LIFECYCLE_MODE === "failure") {
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true,
    result: "injected ordinary failure after real browser startup", session_id: "browser-lifecycle-session" })}\n`);
  process.exit(17);
}
await new Promise(() => {});
