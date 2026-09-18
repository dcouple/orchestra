#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const profile = args[1];
const harness = profile === "planner" ? "claude" : "codex";
const emit = value => {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  const split = bytes.indexOf(Buffer.from("🌱"));
  // Exercise a UTF-8 code point split across preparation stdout chunks.
  if (split >= 0) {
    process.stdout.write(bytes.subarray(0, split + 1));
    setTimeout(() => process.stdout.write(bytes.subarray(split + 1)), 10);
  } else process.stdout.write(bytes);
};
const arg = name => args[args.indexOf(name) + 1];
const report = process.env.ORCHESTRA_BROWSER_FAKE_REPORT;
if (args[0] === "inspect") {
  if (process.env.ORCHESTRA_BROWSER_FAKE_MODE === "prepare-hang") {
    await writeFile(report + ".ready", String(process.pid));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  emit({ agents: { main: { harness } } });
} else if (args[0] === "run") {
  const cwd = arg("--directory");
  const bundle = join(cwd, ".agent-farm", "generated", profile);
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, "manifest.json"), JSON.stringify({ nodes: {
    main: { harness: process.env.ORCHESTRA_BROWSER_FAKE_MODE === "changed-harness" ? "claude" : harness,
      model: "profile-model" },
  } }));
  const flags = args.slice(args.indexOf("--") + 1);
  const settings = flags.includes("--settings")
    ? JSON.parse(await readFile(flags[flags.indexOf("--settings") + 1], "utf8")) : undefined;
  const prompt = args.find(value => value.startsWith("--message=")).slice("--message=".length);
  const launch = {
    argv: [process.execPath, fileURLToPath(import.meta.url), "native", "wrapper-prefix", ...flags, "--", prompt],
    cwd: bundle,
    bundle,
    env: { CODEX_HOME: join(bundle, "runtime"), AGENT_FARM_NATIVE_CODEX_HOME: "/native/home",
      PRINTED_ONLY: "kept", ORCHESTRA_BROWSER_FAKE_COLLISION: "printed" },
  };
  await writeFile(report, JSON.stringify({ preparationArgs: args, launch, settings }));
  if (process.env.ORCHESTRA_BROWSER_FAKE_MODE === "invalid-launch") launch.argv = [];
  emit(launch);
} else if (args[0] === "native") {
  await appendFile(report + ".child", JSON.stringify({ args, env: process.env, cwd: process.cwd() }) + "\n");
  if (process.env.ORCHESTRA_BROWSER_FAKE_MODE === "hang") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (process.env.ORCHESTRA_BROWSER_FAKE_MODE === "capacity") {
    process.stderr.write("HTTP 429 from provider, verbatim stderr\n");
    if (args.includes("exec")) emit({ type: "turn.failed", error: { message: "rate limit exceeded" } });
    else {
      emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day" } });
      emit({ type: "result", subtype: "error", is_error: true });
    }
    process.exit(1);
  }
  if (args.includes("exec")) {
    emit({ type: "thread.started", thread_id: "farm-thread" });
    emit({ type: "item.completed", item: { id: "linear", type: "mcp_tool_call",
      server: "orchestra_linear", tool: "get_issue", status: "completed" } });
    emit({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "farm answer" } });
    emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  } else {
    emit({ type: "system", subtype: "init", session_id: "farm-session",
      mcp_servers: [{ name: "orchestra_linear", status: "connected" }] });
    emit({ type: "assistant", message: { content: [
      { type: "tool_use", id: "linear", name: "mcp__orchestra_linear__get_issue", input: {} },
      { type: "text", text: "farm answer" },
    ] } });
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "linear", content: "ok" }] } });
    emit({ type: "result", subtype: "success", result: "farm answer" });
  }
}
