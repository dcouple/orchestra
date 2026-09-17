import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import { projectDependencies } from "../src/console-projections.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "console-projection-")); dirs.push(dir);
  const log = new EventLog(join(dir, "events.db"));
  log.append({ deliveryId: "secret-delivery", app: "planner", action: "created", agentSessionId: "session-1",
    issueId: "issue-id", issueIdentifier: "ENG-42", receivedAt: 1_000,
    rawBody: Buffer.from('{"token":"RAW_WEBHOOK_SECRET"}') });
  const turn = log.claimNextTurn(1_100)!;
  log.ingestCodexInvocation({ linearSessionId: "session-1", turnId: turn.id, sourceKey: "invocation-1",
    role: "code-researcher", prompt: "PROMPT_SECRET", report: "REPORT_SECRET", startedAt: 1_200, endedAt: 1_700,
    outcome: "done", model: "gpt-test", traceId: "trace-secret", providerConversationId: "provider-secret",
    providerTurnId: "provider-turn-secret", inputTokens: 10, outputTokens: 5 });
  log.stageExternalUrl("session-1", "planner", "Artifact bundle", "https://artifacts.example/bundle/one", 1_800);
  log.setProviderState("claude", "ready", null, 1_900);
  return log;
}

describe("console projections", () => {
  it("derives fresh, stale, future-skewed, disabled, missing, and aggregate dependency truth", () => {
    const observations = [
      { kind: "mcp" as const, name: "linear", configured: true, status: "healthy" as const, reasonCode: null,
        capabilities: { toolCount: 4, truncated: false }, observedAt: 900, staleAfterMs: 200 },
      { kind: "mcp" as const, name: "playwright", configured: false, status: "disabled" as const, reasonCode: "disabled", capabilities: {}, observedAt: 900, staleAfterMs: 200 },
      { kind: "mcp" as const, name: "xcodebuildmcp", configured: true, status: "healthy" as const, reasonCode: null, capabilities: {}, observedAt: 700, staleAfterMs: 200 },
      { kind: "harness" as const, name: "claude", configured: true, status: "healthy" as const, reasonCode: null, capabilities: {}, observedAt: 1_100, staleAfterMs: 200 },
    ];
    const projected = projectDependencies(observations, { status: "online", observedAt: 1_000 }, 1_000);
    expect(projected.status).toBe("degraded");
    expect(projected.dependencies).toMatchObject([
      { name: "linear", status: "healthy", lastStatus: "healthy", capabilities: { toolCount: 4 }, staleAt: 1_100 },
      { name: "playwright", status: "disabled" }, { name: "xcodebuildmcp", status: "stale", lastStatus: "healthy", reasonCode: "stale" },
      { name: "claude", status: "future_timestamp", lastStatus: "healthy", reasonCode: "future_timestamp" },
      { name: "claudex", configured: null, status: "unknown", observedAt: null },
    ]);
    expect(projectDependencies([], { status: "online", observedAt: 1_000 }, 1_000).status).toBe("unknown");
    expect(projectDependencies(observations, { status: "offline", observedAt: 1_000 }, 1_000).status).toBe("degraded");
    const allDisabled = observations.map(row => ({ ...row, configured: false, status: "disabled" as const, reasonCode: "disabled" }));
    allDisabled.push({ kind: "harness", name: "claudex", configured: false, status: "disabled", reasonCode: "disabled", capabilities: {}, observedAt: 900, staleAfterMs: 200 });
    expect(projectDependencies(allDisabled, { status: "online", observedAt: 1_000 }, 1_000).status).toBe("unknown");
  });
  it("projects complete run detail from SQLite without secret-bearing fields", () => {
    const log = setup();
    const run = log.consoleRun("session-1", 2_000, "https://linear.example");
    expect(run).toMatchObject({ id: "session-1", issueIdentifier: "ENG-42", invocationCount: 1,
      resources: [{ label: "Linear issue", url: "https://linear.example/issue/ENG-42" },
        { label: "Artifact bundle", url: "https://artifacts.example/bundle/one" }],
      invocations: [{ role: "code-researcher", runtime: "codex", durationMs: 500, state: "terminal",
        usage: { totalTokens: 15 } }] });
    const serialized = JSON.stringify(run);
    for (const secret of ["RAW_WEBHOOK_SECRET", "PROMPT_SECRET", "REPORT_SECRET", "trace-secret", "provider-secret", "provider-turn-secret"])
      expect(serialized).not.toContain(secret);
    for (const forbidden of ["prompt", "report", "rawBody", "worktreePath", "claudeSessionId", "traceId", "providerConversationId"])
      expect(serialized).not.toContain(`\"${forbidden}\"`);
    expect(log.consoleProviders()).toEqual([{ provider: "claude", status: "ready", reason: null, cooldownUntil: null, updatedAt: 1900 }]);
    log.close();
  });

  it("does not fabricate resource links without an exact URL or configured Linear base", () => {
    const log = setup();
    expect(log.consoleRun("session-1", 2_000)?.resources).toEqual([
      { label: "Artifact bundle", url: "https://artifacts.example/bundle/one" },
    ]);
    expect(log.consoleRun("missing")).toBeUndefined(); log.close();
  });
});
