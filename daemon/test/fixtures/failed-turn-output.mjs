export const MODEL_VERSION_ERROR = "API Error: 400 Claude Code 2.1.229 does not support this model; version 2.1.251 or newer is required. ...";

export function failedTurnOutput(mode, harness) {
  if (!mode.startsWith("diagnostic-")) return;
  const emit = event => process.stdout.write(JSON.stringify(event) + "\n");
  if (mode === "diagnostic-stderr") {
    process.stderr.write("\u001b[31mnative launch detail from stderr\u001b[0m\n");
    process.exit(1);
  }
  const message = mode.endsWith("secret")
    ? (mode === "diagnostic-capacity-secret" ? "rate limit private error " : "private error ") + ["CLIPROXY_API_KEY", "LINEAR_API_KEY", "GH_TOKEN", "ARTIFACT_HOST_TOKEN"]
      .map(key => process.env[key]).filter(Boolean).join(" ")
    : MODEL_VERSION_ERROR;
  if (mode.endsWith("secret")) process.stderr.write(`\u001b[31m${message}\u001b[0m\n`);
  if (harness === "codex") emit(mode === "diagnostic-codex-error"
    ? { type: "error", message } : { type: "turn.failed", error: { message } });
  else if (mode.startsWith("diagnostic-assistant")) {
    emit({ type: "assistant", error: { message }, message: { content: [] } });
    if (mode.endsWith("zero")) emit({ type: "result", subtype: "success", result: "success must not erase the error" });
  } else emit({ type: "result", subtype: "success", is_error: true, result: message });
  process.exit(mode.endsWith("zero") ? 0 : 1);
}
