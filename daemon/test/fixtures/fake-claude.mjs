import { appendFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";

const args = process.argv.slice(2);
const resumeAt = args.indexOf("--resume");
const resumed = resumeAt >= 0 ? args[resumeAt + 1] : undefined;
const mode = process.env.CLAUDE_FAKE_MODE || process.env.FAKE_MODE || "happy";
const mcpTelemetry = ["mcp-telemetry", "mcp-runner-failed", "mcp-shutdown"].includes(mode);
const argsFile = process.env.CLAUDE_FAKE_ARGS_FILE || process.env.FAKE_ARGS_FILE;
if (argsFile) await appendFile(argsFile,
  `${JSON.stringify({ args, cwd: process.cwd(), at: Date.now(), phase: "start" })}\n`);
if (process.env.CLAUDE_FAKE_ENV_FILE) await appendFile(process.env.CLAUDE_FAKE_ENV_FILE,
  `${JSON.stringify({ args, env: process.env, at: Date.now(), phase: "env" })}\n`);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === "provider-fail-pre-id") {
  process.stderr.write("connection refused by provider base URL\n");
  process.exit(7);
}
const session = resumed || (mode === "do-pr" || mode === "do-pr-error" ? "claude-do-session" : "claude-session-1");
emit({ type: "system", subtype: "init", session_id: session, uuid: "init",
  ...(mcpTelemetry ? { mcp_servers: [{ name: "linear", status: "connected" }] } : {}) });
if (mode === "browser-relaunch" && process.env.ORCHESTRA_BROWSER_REQUEST_FILE && !resumed) {
  await writeFile(process.env.ORCHESTRA_BROWSER_REQUEST_FILE, JSON.stringify({ requested: true }));
  emit({ type: "result", subtype: "success", is_error: false,
    result: "ORCHESTRA_BROWSER_RELAUNCH_REQUIRED", session_id: session, permission_denials: [] });
  process.exit(0);
}
if (mode === "rate-limit-rejected" || mode === "capacity-after-session") {
  emit({ type: "rate_limit_event", session_id: session, rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } });
  process.exit(1);
}
if (mode === "out-of-credits") {
  emit({ type: "rate_limit_event", session_id: session, apiErrorStatus: 429,
    rate_limit_info: { status: "allowed", overageDisabledReason: "out_of_credits" } });
  process.exit(1);
}
if (mode === "api-retry-exhausted") {
  emit({ type: "system", subtype: "api_retry", session_id: session, attempt: 1, max_retries: 2, error: "rate_limit", error_status: 429 });
  emit({ type: "system", subtype: "api_retry", session_id: session, attempt: 2, max_retries: 2, error: "rate_limit", error_status: 429 });
  emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "request failed", session_id: session });
  process.exit(1);
}
if (mode === "result-429") {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, error_status: 429,
    errors: [{ type: "rate_limit_error" }], result: "request failed", session_id: session });
  process.exit(1);
}
if (mode === "assistant-rate-limit") {
  emit({ type: "assistant", session_id: session, error: "rate_limit", message: { content: [] } });
  process.exit(1);
}
if (mode === "api-retry-recovered")
  emit({ type: "system", subtype: "api_retry", session_id: session, attempt: 1, max_retries: 2, error: "overloaded", error_status: 529 });
if (mode === "non-capacity-api-error") {
  emit({ type: "result", subtype: "error_during_execution", terminal_reason: "api_error", is_error: true,
    errors: [{ type: "authentication_error" }, { type: "api_error" }], result: "request failed", session_id: session });
  process.exit(1);
}
if (mode === "provider-fail-post-id") {
  process.stderr.write("HTTP 503 from provider base URL\n");
  process.exit(7);
}
if (mode === "crash") process.exit(7);
if (mode === "no-result") process.exit(0);
if (mode === "hang") {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
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
  { type: "text", text: "thinking" }, { type: "tool_use", id: "toolu_read_1", name: "Read", input: { description: "ticket" } },
] } });
if (mode === "tool-hang") {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
emit({ type: "user", session_id: session, message: { content: [
  { type: "tool_result", tool_use_id: "toolu_read_1", content: "read complete", is_error: false },
] } });
if(mode==="agent"){
  emit({type:"assistant",session_id:session,message:{content:[{type:"tool_use",id:"toolu_agent_1",name:"Agent",input:{subagent_type:"code-researcher",prompt:"inspect the daemon"}}]}});
  emit({type:"user",session_id:session,message:{content:[{type:"tool_result",tool_use_id:"toolu_agent_1",content:"research complete",is_error:false}]}});
}
if (mcpTelemetry) {
  emit({ type: "assistant", session_id: session, message: { content: [
    { type: "tool_use", id: "toolu_linear_1", name: "mcp__linear__get_issue",
      input: { issueId: "private-payload" } },
  ] } });
  emit({ type: "user", session_id: session, message: { content: [
    { type: "tool_result", tool_use_id: "toolu_linear_1",
      content: "private Linear result", is_error: true },
  ] } });
}
if (mode === "mcp-shutdown") {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
if (mode === "new-id") emit({ type: "assistant", session_id: "claude-session-2", message: { content: [{ type: "text", text: "compacted" }] } });
if (mode === "slow") await new Promise(resolve => setTimeout(resolve, Number(process.env.CLAUDE_FAKE_DELAY_MS || process.env.FAKE_DELAY_MS || 100)));
const finalSession = mode === "new-id" ? "claude-session-2" : session;
const errorResult = mode === "denied" || mode === "do-pr-error" ||
  mode === "error-result-exit" || mode === "mcp-runner-failed";
emit({ type: "result", subtype: errorResult ? "error" : "success", is_error: errorResult,
  result: mode === "do-pr" || mode === "do-pr-error" ? "Opened https://github.com/dcouple/example/pull/42" : resumed ? `resumed ${resumed}` : "planner answer", session_id: finalSession,
  ...(mode !== "no-usage" ? {
    total_cost_usd: mode === "all-malformed-usage" ? -1 : 0.130925,
    usage: { input_tokens: mode === "malformed-usage" || mode === "all-malformed-usage" ? -1 : 2,
      output_tokens: mode === "all-malformed-usage" ? -1 : 4,
      cache_creation_input_tokens: mode === "all-malformed-usage" ? -1 : 5780,
      cache_read_input_tokens: mode === "all-malformed-usage" ? -1 : 15105 },
    modelUsage: mode === "all-malformed-usage" ? {} : { "claude-fable-5": { inputTokens: 2, outputTokens: 4 } },
  } : {}),
  permission_denials: mode === "denied" ? [{ tool: "Bash" }] : [] });
if (mode === "error-result-exit") process.exit(11);
if (mode === "touch-file" && process.env.CLAUDE_FAKE_TOUCH_FILE) await writeFile(process.env.CLAUDE_FAKE_TOUCH_FILE, "done");
if (argsFile) await appendFile(argsFile,
  `${JSON.stringify({ args, cwd: process.cwd(), at: Date.now(), phase: "end" })}\n`);
