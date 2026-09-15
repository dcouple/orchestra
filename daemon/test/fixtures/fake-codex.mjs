import { appendFile } from "node:fs/promises";

// Stands in for `codex exec --json`: records its argv and env, then replays the
// JSONL event shapes observed from codex-cli 0.154 (`thread.started`, item
// lifecycle, `turn.completed` / `turn.failed`).
const args = process.argv.slice(2);
const mode = process.env.CODEX_FAKE_MODE || "happy";
const resumed = args[0] === "exec" && args[1] === "resume" ? args[args.length - 2] : undefined;
if (process.env.CODEX_FAKE_ARGS_FILE)
  await appendFile(process.env.CODEX_FAKE_ARGS_FILE,
    `${JSON.stringify({ args, cwd: process.cwd(), env: process.env, at: Date.now() })}\n`);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === "spawn-fail") {
  process.stderr.write("codex: HTTP 429 from provider\n");
  process.exit(3);
}
const thread = resumed || "codex-thread-1";
emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Reading the ticket." } });
emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'git status'", aggregated_output: "", exit_code: null, status: "in_progress" } });
emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'git status'", aggregated_output: "clean", exit_code: 0, status: "completed" } });
emit({ type: "item.completed", item: { id: "item_2", type: "mcp_tool_call", server: "linear", tool: "get_issue", arguments: { id: "private" }, status: "failed", error: { message: "private Linear result" } } });
if (mode === "hang") {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
if (mode === "turn-failed") {
  emit({ type: "turn.failed", error: { message: "usage limit reached, rate limit exceeded" } });
  process.exit(1);
}
emit({ type: "item.completed", item: { id: "item_3", type: "agent_message",
  text: resumed ? `resumed ${resumed}` : "Opened https://github.com/dcouple/example/pull/42" } });
emit({ type: "turn.completed", usage: { input_tokens: 40072, cached_input_tokens: 13824, cache_write_input_tokens: 0, output_tokens: 46, reasoning_output_tokens: 0 } });
