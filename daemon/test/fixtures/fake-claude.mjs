import { appendFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";

const args = process.argv.slice(2);
const resumeAt = args.indexOf("--resume");
const resumed = resumeAt >= 0 ? args[resumeAt + 1] : undefined;
const mode = process.env.CLAUDE_FAKE_MODE || process.env.FAKE_MODE || "happy";
const argsFile = process.env.CLAUDE_FAKE_ARGS_FILE || process.env.FAKE_ARGS_FILE;
if (argsFile) await appendFile(argsFile,
  `${JSON.stringify({ args, cwd: process.cwd(), at: Date.now(), phase: "start" })}\n`);
if (process.env.CLAUDE_FAKE_ENV_FILE) await appendFile(process.env.CLAUDE_FAKE_ENV_FILE,
  `${JSON.stringify({ args, env: process.env, at: Date.now(), phase: "env" })}\n`);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const session = resumed || "claude-session-1";
emit({ type: "system", subtype: "init", session_id: session, uuid: "init" });
if (mode === "crash") process.exit(7);
if (mode === "no-result") process.exit(0);
if (mode === "hang") await new Promise(() => {});
if (mode === "grandchild-hang") {
  const file = process.env.CLAUDE_FAKE_HEARTBEAT_FILE;
  spawn(process.execPath, ["-e", `const fs=require("fs"); setInterval(() => fs.appendFileSync(${JSON.stringify(file)}, Date.now()+"\\n"), 25);`],
    { stdio: "ignore" });
  await new Promise(() => {});
}
if (mode === "stderr-fail") {
  for (let i = 0; i < 256; i++) {
    if (!process.stderr.write(`stderr-line-${i.toString().padStart(3, "0")}-${"x".repeat(512)}\n`)) await once(process.stderr, "drain");
  }
  process.exit(9);
}
emit({ type: "assistant", session_id: session, message: { content: [
  { type: "text", text: "thinking" }, { type: "tool_use", name: "Read", input: { description: "ticket" } },
] } });
if (mode === "new-id") emit({ type: "assistant", session_id: "claude-session-2", message: { content: [{ type: "text", text: "compacted" }] } });
if (mode === "slow") await new Promise(resolve => setTimeout(resolve, Number(process.env.CLAUDE_FAKE_DELAY_MS || process.env.FAKE_DELAY_MS || 100)));
const finalSession = mode === "new-id" ? "claude-session-2" : session;
emit({ type: "result", subtype: mode === "denied" ? "error" : "success", is_error: mode === "denied",
  result: resumed ? `resumed ${resumed}` : "planner answer", session_id: finalSession,
  permission_denials: mode === "denied" ? [{ tool: "Bash" }] : [] });
if (mode === "touch-file" && process.env.CLAUDE_FAKE_TOUCH_FILE) await writeFile(process.env.CLAUDE_FAKE_TOUCH_FILE, "done");
if (argsFile) await appendFile(argsFile,
  `${JSON.stringify({ args, cwd: process.cwd(), at: Date.now(), phase: "end" })}\n`);
