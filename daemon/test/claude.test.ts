import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildToolHookSettings,
  buildTurnSettings,
  runTurn,
} from "../src/claude.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const fixture = resolve("test/fixtures/fake-claude.mjs");
function cwd(): string {
  const value = mkdtempSync(join(tmpdir(), "claude-runner-"));
  dirs.push(value);
  return value;
}
function options(overrides: Record<string, unknown> = {}) {
  return {
    cwd: cwd(),
    prompt: "hello",
    argv: [process.execPath, fixture],
    permissionMode: "plan",
    maxTurns: 5,
    mcpConfigJson: "{}",
    ...overrides,
  };
}
async function waitFor(
  predicate: () => boolean,
  timeout = 4000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("runTurn", () => {
  it("generates daemon-owned command hooks with argv-safe durable recorder arguments", () => {
    expect(
      buildToolHookSettings(
        "/var/lib/linear agent/events.db",
        42,
        "/opt/linear agent/dist/operations-cli.js",
      ),
    ).toEqual({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: [
                  "/opt/linear agent/dist/operations-cli.js",
                  "tool-hook-open",
                  "/var/lib/linear agent/events.db",
                  "42",
                ],
                timeout: 10,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: [
                  "/opt/linear agent/dist/operations-cli.js",
                  "tool-hook-complete",
                  "/var/lib/linear agent/events.db",
                  "42",
                ],
                timeout: 10,
              },
            ],
          },
        ],
        PostToolUseFailure: [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: [
                  "/opt/linear agent/dist/operations-cli.js",
                  "tool-hook-complete",
                  "/var/lib/linear agent/events.db",
                  "42",
                ],
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
  });

  it("passes the per-turn hook settings file to Claude", async () => {
    const dir = cwd();
    const argsFile = join(dir, "args.jsonl");
    const result = await runTurn(
      options({
        cwd: dir,
        env: { CLAUDE_FAKE_ARGS_FILE: argsFile },
        toolHook: {
          dbPath: join(dir, "events with spaces.db"),
          turnId: 7,
          operationsCliPath: join(dir, "operations cli.js"),
        },
      }),
    );
    expect(result.ok).toBe(true);
    const row = JSON.parse(
      readFileSync(argsFile, "utf8").trim().split("\n")[0]!,
    ) as {
      args: string[];
      settings: Record<string, unknown>;
    };
    const args = row.args;
    const settingsAt = args.indexOf("--settings");
    expect(settingsAt).toBeGreaterThan(-1);
    expect(args[settingsAt + 1]).toMatch(/settings\.json$/);
    expect(row.settings.enableAllProjectMcpServers).toBe(true);
    expect(row.settings).toMatchObject({
      hooks: { PreToolUse: expect.any(Array) },
    });
  });

  it("pre-approves project MCP servers without a tool hook", async () => {
    const dir = cwd();
    const argsFile = join(dir, "args.jsonl");
    const result = await runTurn(
      options({ cwd: dir, env: { CLAUDE_FAKE_ARGS_FILE: argsFile } }),
    );
    expect(result.ok).toBe(true);
    const row = JSON.parse(
      readFileSync(argsFile, "utf8").trim().split("\n")[0]!,
    ) as {
      args: string[];
      settings: Record<string, unknown>;
    };
    expect(row.args).toContain("--settings");
    expect(row.settings).toEqual({ enableAllProjectMcpServers: true });
  });

  it("builds project MCP settings with and without tool hooks", () => {
    expect(buildTurnSettings()).toEqual({
      enableAllProjectMcpServers: true,
    });
    const dbPath = "/tmp/events.db";
    const turnId = 9;
    const operationsCliPath = "/tmp/operations-cli.js";
    expect(
      buildTurnSettings({
        dbPath,
        turnId,
        operationsCliPath,
      }),
    ).toEqual({
      enableAllProjectMcpServers: true,
      ...buildToolHookSettings(dbPath, turnId, operationsCliPath),
    });
  });

  it("isolates loop environment and disables every ambient MCP discovery source", async () => {
    const dir = cwd();
    const capture = join(dir, "loop-child.json");
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {
      linear: { command: "linear-secret" }, playwright: { command: "browser-secret" },
      xcodebuildmcp: { command: "sim-secret" }, attachments: { command: "attachment-secret" },
    } }));
    const prohibited = {
      LINEAR_API_KEY: "linear", GH_TOKEN: "gh", GITHUB_TOKEN: "github",
      ORCHESTRA_BROWSER_REQUEST_FILE: "/secret/browser", ORCHESTRA_BROWSER_STATE_DIR: "/secret/state",
      ORCHESTRA_SIM_CONTEXT: "sim", ORCHESTRA_DISPATCH_OWNER: "dispatch",
      ARTIFACT_HOST_TOKEN: "artifact", ARTIFACT_TOKEN: "artifact-raw", NTFY_URL: "notification",
      MCP_ENV_PASSTHROUGH: "mcp", ATTACHMENT_DOWNLOAD_TOKEN: "attachment",
    };
    const previous = Object.fromEntries(Object.keys(prohibited).map(key => [key, process.env[key]]));
    Object.assign(process.env, prohibited);
    const script = `const fs=require("node:fs");const a=process.argv.slice(1);const s=a.indexOf("--settings");const m=a.indexOf("--mcp-config");fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({env:process.env,args:a,settings:JSON.parse(fs.readFileSync(a[s+1])),mcp:JSON.parse(fs.readFileSync(a[m+1]))}));console.log(JSON.stringify({type:"system",subtype:"init",session_id:"loop-session"}));console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"ok",session_id:"loop-session",permission_denials:[]}));`;
    try {
      const result = await runTurn(options({ cwd: dir, argv: [process.execPath, "-e", script, "--"], isolation: "loop",
        mcpConfigJson: JSON.stringify({ mcpServers: {} }),
        env: { CLIPROXY_API_KEY: "runtime", BASH_DEFAULT_TIMEOUT_MS: "1000", LINEAR_API_KEY: "extra-linear" },
        trustedEnv: { ANTHROPIC_BASE_URL: "http://proxy", ENABLE_TOOL_SEARCH: "true", LINEAR_API_KEY: "trusted-linear",
          ORCHESTRA_BROWSER_ENABLED: "trusted-browser", GITHUB_TOKEN: "trusted-github" } }));
      expect(result.ok).toBe(true);
      const row = JSON.parse(readFileSync(capture, "utf8")) as { env: Record<string,string>; args:string[];
        settings:Record<string,unknown>;mcp:Record<string,unknown> };
      for (const key of Object.keys(prohibited)) expect(row.env[key], key).toBeUndefined();
      expect(row.env.LINEAR_API_KEY).toBeUndefined();
      expect(row.env.CLIPROXY_API_KEY).toBe("runtime");
      expect(row.env.ANTHROPIC_BASE_URL).toBe("http://proxy");
      expect(row.settings).toEqual({ enableAllProjectMcpServers: false, enabledMcpjsonServers: [], disabledMcpjsonServers: ["*"] });
      expect(row.args).toContain("--strict-mcp-config");
      expect(row.mcp).toEqual({ mcpServers: {} });
      expect(JSON.stringify(row)).not.toMatch(/linear-secret|browser-secret|sim-secret|attachment-secret/);
    } finally {
      for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    }
  });

  it("parses every mixed assistant block and captures the first session id", async () => {
    const events: unknown[] = [];
    const ids: string[] = [];
    const result = await runTurn(
      options({
        onEvent: (event: unknown) => events.push(event),
        onSessionId: (id: string) => ids.push(id),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      sessionId: "claude-session-1",
      resultText: "planner answer",
      sawResult: true,
    });
    expect(result.capacityEvidence).toEqual([]);
    expect(result.usage).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationTokens: 5780,
      cacheReadTokens: 15105,
      costUsd: 0.130925,
      model: "claude-fable-5",
    });
    expect(events).toEqual([
      { type: "text", text: "thinking" },
      {
        type: "toolUse",
        toolUseId: "toolu_read_1",
        name: "Read",
        input: { description: "ticket" },
      },
      {
        type: "toolResult",
        toolUseId: "toolu_read_1",
        outcome: "success",
      },
    ]);
    expect(ids).toEqual(["claude-session-1"]);
  });
  it("correlates an Agent tool use with its top-level tool result and preserves modelUsage", async () => {
    const events: unknown[] = [];
    const result = await runTurn(
      options({
        env: { CLAUDE_FAKE_MODE: "agent" },
        onEvent: (event: unknown) => events.push(event),
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: "agentStart",
          toolUseId: "toolu_agent_1",
          role: "code-researcher",
          prompt: "inspect the daemon",
        },
        {
          type: "agentResult",
          toolUseId: "toolu_agent_1",
          report: "research complete",
          outcome: "success",
        },
      ]),
    );
    expect(result.modelUsage).toEqual({
      "claude-fable-5": { inputTokens: 2, outputTokens: 4 },
    });
  });
  it("emits bounded Linear MCP lifecycle and tool outcomes without result payloads", async () => {
    const events: unknown[] = [];
    const result = await runTurn(
      options({
        env: { CLAUDE_FAKE_MODE: "mcp-telemetry" },
        onEvent: (event: unknown) => events.push(event),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.linearMcpInitialized).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "linearMcpInit", status: "connected" },
        {
          type: "linearMcpToolResult",
          toolUseId: "toolu_linear_1",
          toolName: "mcp__linear__get_issue",
          outcome: "error",
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "linearMcpClose" }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("private Linear result");
  });
  it("recovers reply text when the result event carries usage but no result string", async () => {
    const result = await runTurn(
      options({ env: { CLAUDE_FAKE_MODE: "empty-result" } }),
    );
    expect(result).toMatchObject({
      ok: true,
      // the last assistant text, not the tool_use message that followed it
      resultText: "the real reply",
      resultTextRecovered: true,
      resultSubtype: "success",
      sawResult: true,
    });
    expect(result.usage?.outputTokens).toBe(4797);
  });
  it("omits usage for a usage-free result", async () => {
    const result = await runTurn(
      options({ env: { CLAUDE_FAKE_MODE: "no-usage" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.usage).toBeUndefined();
  });
  it("drops malformed negative usage values", async () => {
    const result = await runTurn(
      options({ env: { CLAUDE_FAKE_MODE: "malformed-usage" } }),
    );
    expect(result.usage).toEqual({
      inputTokens: undefined,
      outputTokens: 4,
      cacheCreationTokens: 5780,
      cacheReadTokens: 15105,
      costUsd: 0.130925,
      model: "claude-fable-5",
    });
  });
  it("omits usage when every usage value is malformed", async () => {
    const result = await runTurn(
      options({ env: { CLAUDE_FAKE_MODE: "all-malformed-usage" } }),
    );
    expect(result.usage).toBeUndefined();
  });
  it("passes resume and captures a mid-stream session id change", async () => {
    const ids: string[] = [];
    const result = await runTurn(
      options({
        resumeSessionId: "prior-id",
        env: { CLAUDE_FAKE_MODE: "new-id" },
        onSessionId: (id: string) => ids.push(id),
      }),
    );
    expect(ids).toEqual(["prior-id", "claude-session-2"]);
    expect(result.sessionId).toBe("claude-session-2");
    expect(result.resultText).toBe("resumed prior-id");
  });
  it.each([
    ["crash", false],
    ["no-result", false],
    ["denied", false],
  ])("classifies %s as failure", async (mode, ok) => {
    const result = await runTurn(options({ env: { CLAUDE_FAKE_MODE: mode } }));
    expect(result.ok).toBe(ok);
    expect(result.capacityEvidence).toEqual([]);
  });
  it.each([
    ["rate-limit-rejected", "rate_limit_event:rejected"],
    ["out-of-credits", "rate_limit_event:out_of_credits"],
    ["api-retry-exhausted", "api_retry:rate_limit"],
    ["result-429", "result:429"],
    ["assistant-rate-limit", "assistant:rate_limit"],
  ])(
    "collects structured capacity evidence from %s",
    async (mode, evidence) => {
      const result = await runTurn(
        options({ env: { CLAUDE_FAKE_MODE: mode } }),
      );
      expect(result.ok).toBe(false);
      expect(result.capacityEvidence).toContain(evidence);
    },
  );
  it("does not turn recovered retry evidence into a runner failure", async () => {
    const result = await runTurn(
      options({ env: { CLAUDE_FAKE_MODE: "api-retry-recovered" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.capacityEvidence).toContain("api_retry:overloaded");
  });
  it("does not classify generic API result errors as capacity", async () => {
    const result = await runTurn(
      options({ env: { CLAUDE_FAKE_MODE: "non-capacity-api-error" } }),
    );
    expect(result).toMatchObject({ ok: false, sawResult: true, exitCode: 1 });
    expect(result.capacityEvidence).toEqual([]);
  });
  it("classifies ENOENT and abort signal death", async () => {
    expect(await runTurn(options({ argv: ["/missing/claude"] }))).toMatchObject(
      { ok: false, sawResult: false },
    );
    const controller = new AbortController();
    const promise = runTurn(
      options({ env: { CLAUDE_FAKE_MODE: "hang" }, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 30);
    expect((await promise).ok).toBe(false);
  });
  it("passes only the child allowlist and keeps bearer tokens out of argv", async () => {
    const dir = cwd();
    const envFile = join(dir, "env.jsonl");
    const ambientEnvFile = join(dir, "ambient-env.jsonl");
    const oldHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
    const oldControl = process.env.OTEL_X;
    const oldToolContent = process.env.OTEL_LOG_TOOL_CONTENT;
    const oldManagementKey = process.env.CLIPROXY_MANAGEMENT_KEY;
    const oldArtifactToken = process.env.ARTIFACT_TOKEN;
    const oldArtifactHostToken = process.env.ARTIFACT_HOST_TOKEN;
    const oldFableModelsEnvFile = process.env.FABLE_MODELS_ENV_FILE;
    process.env.FABLE_MODELS_ENV_FILE = "/ambient/fable-models.env";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "process-header";
    process.env.OTEL_X = "process-control";
    process.env.OTEL_LOG_TOOL_CONTENT = "process-tool-content";
    process.env.CLIPROXY_MANAGEMENT_KEY = "ambient-management";
    process.env.ARTIFACT_TOKEN = "ambient-artifact";
    process.env.ARTIFACT_HOST_TOKEN = "ambient-artifact-host";
    try {
      const result = await runTurn(
        options({
          cwd: dir,
          mcpConfigJson: JSON.stringify({ token: "secret-token" }),
          maxBudgetUsd: 12.5,
          env: {
            CLAUDE_FAKE_ENV_FILE: envFile,
            CLIPROXY_API_KEY: "api-key",
            BASH_DEFAULT_TIMEOUT_MS: "900000",
            BASH_MAX_TIMEOUT_MS: "1200000",
            LINEAR_API_KEY: "linear-key",
            GH_TOKEN: "github-key",
            ARTIFACT_HOST_TOKEN: "daemon-artifact-host",
            OTEL_RESOURCE_ATTRIBUTES: "service.namespace=daemon",
            OTEL_LOG_TOOL_DETAILS: "1",
            OTEL_LOG_TOOL_CONTENT: "extra-tool-content",
            OTEL_X: "extra-control",
            PLANNER_WEBHOOK_SECRET: "webhook-secret",
            PLANNER_LINEAR_CLIENT_SECRET: "client-secret",
            IMPLEMENTER_LINEAR_CLIENT_SECRET: "other-secret",
          },
        }),
      );
      expect(result.ok).toBe(true);
      const row = JSON.parse(readFileSync(envFile, "utf8").trim()) as {
        args: string[];
        env: Record<string, string>;
      };
      expect(row.env.LINEAR_API_KEY).toBe("linear-key");
      expect(row.env.CLIPROXY_API_KEY).toBe("api-key");
      expect(row.env.BASH_DEFAULT_TIMEOUT_MS).toBe("900000");
      expect(row.env.BASH_MAX_TIMEOUT_MS).toBe("1200000");
      expect(row.env.GH_TOKEN).toBe("github-key");
      expect(row.env.ARTIFACT_HOST_TOKEN).toBe("daemon-artifact-host");
      expect(row.env.FABLE_MODELS_ENV_FILE).toBe("/ambient/fable-models.env");
      expect(row.env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
      expect(row.env.OTEL_RESOURCE_ATTRIBUTES).toBe("service.namespace=daemon");
      expect(row.env.OTEL_LOG_TOOL_DETAILS).toBeUndefined();
      expect(row.env.OTEL_LOG_TOOL_CONTENT).toBeUndefined();
      expect(row.env.OTEL_X).toBeUndefined();
      expect(row.env.PLANNER_WEBHOOK_SECRET).toBeUndefined();
      expect(row.env.PLANNER_LINEAR_CLIENT_SECRET).toBeUndefined();
      expect(row.env.IMPLEMENTER_LINEAR_CLIENT_SECRET).toBeUndefined();
      expect(row.env.CLIPROXY_MANAGEMENT_KEY).toBeUndefined();
      expect(row.env.ARTIFACT_TOKEN).toBeUndefined();
      expect(row.args).toContain("--mcp-config");
      expect(row.args).toEqual(
        expect.arrayContaining(["--max-budget-usd", "12.5"]),
      );
      expect(JSON.stringify(row.args)).not.toContain("secret-token");
      expect(JSON.stringify(row.args)).not.toContain("process-header");
      const ambientResult = await runTurn(
        options({
          cwd: dir,
          env: { CLAUDE_FAKE_ENV_FILE: ambientEnvFile },
        }),
      );
      expect(ambientResult.ok).toBe(true);
      const ambientRow = JSON.parse(
        readFileSync(ambientEnvFile, "utf8").trim(),
      ) as { env: Record<string, string> };
      expect(ambientRow.env.ARTIFACT_HOST_TOKEN).toBeUndefined();
    } finally {
      if (oldHeaders === undefined)
        delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
      else process.env.OTEL_EXPORTER_OTLP_HEADERS = oldHeaders;
      if (oldControl === undefined) delete process.env.OTEL_X;
      else process.env.OTEL_X = oldControl;
      if (oldToolContent === undefined)
        delete process.env.OTEL_LOG_TOOL_CONTENT;
      else process.env.OTEL_LOG_TOOL_CONTENT = oldToolContent;
      if (oldManagementKey === undefined)
        delete process.env.CLIPROXY_MANAGEMENT_KEY;
      else process.env.CLIPROXY_MANAGEMENT_KEY = oldManagementKey;
      if (oldArtifactToken === undefined) delete process.env.ARTIFACT_TOKEN;
      else process.env.ARTIFACT_TOKEN = oldArtifactToken;
      if (oldArtifactHostToken === undefined)
        delete process.env.ARTIFACT_HOST_TOKEN;
      else process.env.ARTIFACT_HOST_TOKEN = oldArtifactHostToken;
      if (oldFableModelsEnvFile === undefined)
        delete process.env.FABLE_MODELS_ENV_FILE;
      else process.env.FABLE_MODELS_ENV_FILE = oldFableModelsEnvFile;
    }
  });
  it("keeps the child environment unchanged when passthrough is not configured", async () => {
    const dir = cwd();
    const envFile = join(dir, "golden-env.jsonl");
    const passthroughEnvFile = join(dir, "golden-passthrough-env.jsonl");
    const ambient = {
      CLAUDE_GOLD: "x",
      ANTHROPIC_GOLD: "y",
      GH_TOKEN: "z",
      MCP_GOLD_DROPPED: "q",
      PLANNER_WEBHOOK_SECRET: "w",
      OTEL_RESOURCE_ATTRIBUTES: "o",
      TRACEPARENT: "t",
    };
    const previous = Object.fromEntries(
      Object.keys(ambient).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, ambient);
    try {
      const result = await runTurn(
        options({
          cwd: dir,
          env: {
            CLAUDE_FAKE_ENV_FILE: envFile,
            CLIPROXY_API_KEY: "cliproxy-extra",
            LINEAR_API_KEY: "linear-extra",
            ARTIFACT_HOST_TOKEN: "artifact-extra",
            OTEL_RESOURCE_ATTRIBUTES: "e",
            TRACEPARENT: "te",
            PLANNER_LINEAR_CLIENT_SECRET: "client-extra",
            MCP_GOLD_EXTRA_DROPPED: "extra-dropped",
          },
          trustedEnv: {
            TRUSTED_GOLD: "1",
            LINEAR_API_KEY: "override-attempt",
          },
        }),
      );
      expect(result.ok).toBe(true);
      const row = JSON.parse(readFileSync(envFile, "utf8").trim()) as {
        env: Record<string, string>;
      };
      const keys = [
        "CLAUDE_GOLD",
        "ANTHROPIC_GOLD",
        "GH_TOKEN",
        "MCP_GOLD_DROPPED",
        "PLANNER_WEBHOOK_SECRET",
        "OTEL_RESOURCE_ATTRIBUTES",
        "TRACEPARENT",
        "CLIPROXY_API_KEY",
        "LINEAR_API_KEY",
        "ARTIFACT_HOST_TOKEN",
        "PLANNER_LINEAR_CLIENT_SECRET",
        "MCP_GOLD_EXTRA_DROPPED",
        "TRUSTED_GOLD",
      ];
      const project = (env: Record<string, string>) =>
        Object.fromEntries(
          keys
            .filter((key) => env[key] !== undefined)
            .map((key) => [key, env[key]]),
        );
      const expected = {
        CLAUDE_GOLD: "x",
        ANTHROPIC_GOLD: "y",
        GH_TOKEN: "z",
        OTEL_RESOURCE_ATTRIBUTES: "e",
        TRACEPARENT: "te",
        CLIPROXY_API_KEY: "cliproxy-extra",
        LINEAR_API_KEY: "linear-extra",
        ARTIFACT_HOST_TOKEN: "artifact-extra",
        TRUSTED_GOLD: "1",
      };
      expect(project(row.env)).toEqual(expected);

      const passthroughResult = await runTurn(
        options({
          cwd: dir,
          mcpEnvPassthrough: ["MCP_GOLD_DROPPED"],
          env: {
            CLAUDE_FAKE_ENV_FILE: passthroughEnvFile,
            CLIPROXY_API_KEY: "cliproxy-extra",
            LINEAR_API_KEY: "linear-extra",
            ARTIFACT_HOST_TOKEN: "artifact-extra",
            OTEL_RESOURCE_ATTRIBUTES: "e",
            TRACEPARENT: "te",
            PLANNER_LINEAR_CLIENT_SECRET: "client-extra",
            MCP_GOLD_EXTRA_DROPPED: "extra-dropped",
          },
          trustedEnv: {
            TRUSTED_GOLD: "1",
            LINEAR_API_KEY: "override-attempt",
          },
        }),
      );
      expect(passthroughResult.ok).toBe(true);
      const passthroughRow = JSON.parse(
        readFileSync(passthroughEnvFile, "utf8").trim(),
      ) as { env: Record<string, string> };
      expect(project(passthroughRow.env)).toEqual({
        ...expected,
        MCP_GOLD_DROPPED: "q",
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  it("passes configured ambient and per-turn MCP environment values", async () => {
    const dir = cwd();
    const envFile = join(dir, "passthrough-env.jsonl");
    const previousA = process.env.MCP_PASS_A;
    const previousB = process.env.MCP_PASS_B;
    process.env.MCP_PASS_A = "ambient-a";
    process.env.MCP_PASS_B = "ambient-b";
    try {
      const result = await runTurn(
        options({
          cwd: dir,
          mcpEnvPassthrough: ["MCP_PASS_A", "MCP_PASS_B"],
          env: {
            CLAUDE_FAKE_ENV_FILE: envFile,
            MCP_PASS_A: "extra-a",
          },
        }),
      );
      expect(result.ok).toBe(true);
      const row = JSON.parse(readFileSync(envFile, "utf8").trim()) as {
        env: Record<string, string>;
      };
      expect(row.env).toMatchObject({
        MCP_PASS_A: "extra-a",
        MCP_PASS_B: "ambient-b",
      });
    } finally {
      if (previousA === undefined) delete process.env.MCP_PASS_A;
      else process.env.MCP_PASS_A = previousA;
      if (previousB === undefined) delete process.env.MCP_PASS_B;
      else process.env.MCP_PASS_B = previousB;
    }
  });
  it.each([
    "CLIPROXY_MANAGEMENT_KEY",
    "ARTIFACT_TOKEN",
    "X_WEBHOOK_SECRET",
    "X_LINEAR_CLIENT_SECRET",
    "X_LINEAR_TOKEN",
    "OAUTH_X",
    "X_OAUTH_TOKEN",
  ])("drops denied passthrough key %s from the child environment", async (key) => {
    const dir = cwd();
    const envFile = join(dir, "denied-env.jsonl");
    const previous = process.env[key];
    process.env[key] = "denied-value";
    try {
      const result = await runTurn(
        options({
          cwd: dir,
          mcpEnvPassthrough: [key],
          env: { CLAUDE_FAKE_ENV_FILE: envFile },
        }),
      );
      expect(result.ok).toBe(true);
      const row = JSON.parse(readFileSync(envFile, "utf8").trim()) as {
        env: Record<string, string>;
      };
      expect(row.env[key]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
  it.each([
    ["CLIPROXY_API_KEY", "ambient-value"],
    ["BASH_DEFAULT_TIMEOUT_MS", "ambient-value"],
    ["BASH_MAX_TIMEOUT_MS", "ambient-value"],
    ["LINEAR_API_KEY", "ambient-value"],
    ["ARTIFACT_HOST_TOKEN", undefined],
  ])(
    "does not widen the ambient source for daemon-owned passthrough key %s",
    async (key, expected) => {
      const dir = cwd();
      const envFile = join(dir, "daemon-owned-env.jsonl");
      const previous = process.env[key];
      process.env[key] = "ambient-value";
      try {
        const result = await runTurn(
          options({
            cwd: dir,
            mcpEnvPassthrough: [key],
            env: { CLAUDE_FAKE_ENV_FILE: envFile },
          }),
        );
        expect(result.ok).toBe(true);
        const row = JSON.parse(readFileSync(envFile, "utf8").trim()) as {
          env: Record<string, string>;
        };
        expect(row.env[key]).toBe(expected);
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    },
  );
  it("passes only the named browser handshake and attempt context", async () => {
    const dir = cwd(); const envFile = join(dir, "env.jsonl");
    await runTurn(options({ cwd: dir, env: { CLAUDE_FAKE_ENV_FILE: envFile,
      ORCHESTRA_BROWSER_REQUEST_FILE: "/request", ORCHESTRA_BROWSER_RUN_ID: "run",
      ORCHESTRA_BROWSER_ATTEMPT_ID: "attempt", ORCHESTRA_BROWSER_EVIDENCE_DIR: "/evidence",
      UNTRUSTED_BROWSER_SECRET: "drop" } }));
    const row = JSON.parse(readFileSync(envFile, "utf8").trim()) as { env: Record<string, string> };
    expect(row.env).toMatchObject({ ORCHESTRA_BROWSER_REQUEST_FILE: "/request", ORCHESTRA_BROWSER_RUN_ID: "run",
      ORCHESTRA_BROWSER_ATTEMPT_ID: "attempt", ORCHESTRA_BROWSER_EVIDENCE_DIR: "/evidence" });
    expect(row.env.UNTRUSTED_BROWSER_SECRET).toBeUndefined();
  });
  it("passes only the named simulator environment", async () => {
    const dir = cwd(); const envFile = join(dir, "env.jsonl");
    await runTurn(options({ cwd: dir, env: { CLAUDE_FAKE_ENV_FILE: envFile,
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      ORCHESTRA_SIM_CONTEXT: "/context.json", ORCHESTRA_SIM_TOKEN: "token",
      ORCHESTRA_SIM_DB_PATH: "/events.db",
      ORCHESTRA_SIMX: "drop" } }));
    const row = JSON.parse(readFileSync(envFile, "utf8").trim()) as { env: Record<string, string> };
    expect(row.env).toMatchObject({ DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      ORCHESTRA_SIM_CONTEXT: "/context.json" });
    expect(row.env.ORCHESTRA_SIM_TOKEN).toBeUndefined(); expect(row.env.ORCHESTRA_SIM_DB_PATH).toBeUndefined();
    expect(row.env.ORCHESTRA_SIMX).toBeUndefined();
  });
  it("merges trusted runtime environment after the allowlist", async () => {
    const dir = cwd();
    const envFile = join(dir, "env.jsonl");
    const unconfiguredEnvFile = join(dir, "unconfigured-env.jsonl");
    const result = await runTurn(
      options({
        cwd: dir,
        env: {
          CLAUDE_FAKE_ENV_FILE: envFile,
          CLIPROXY_API_KEY: "daemon-api",
          BASH_DEFAULT_TIMEOUT_MS: "900000",
          BASH_MAX_TIMEOUT_MS: "900000",
          ARTIFACT_HOST_TOKEN: "daemon-artifact-host",
        },
        trustedEnv: {
          ENABLE_TOOL_SEARCH: "true",
          CLAUDE_FAKE_MODE: "happy",
          CLIPROXY_API_KEY: "trusted-api",
          BASH_DEFAULT_TIMEOUT_MS: "1",
          CLIPROXY_MANAGEMENT_KEY: "management-secret",
          PLANNER_WEBHOOK_SECRET: "webhook-secret",
          ARTIFACT_TOKEN: "artifact-secret",
          ARTIFACT_HOST_TOKEN: "trusted-artifact-host",
          OAUTH_ACCESS_TOKEN: "oauth-secret",
        },
      }),
    );
    expect(result.ok).toBe(true);
    const row = JSON.parse(readFileSync(envFile, "utf8").trim()) as {
      env: Record<string, string>;
    };
    expect(row.env.ENABLE_TOOL_SEARCH).toBe("true");
    expect(row.env.CLIPROXY_API_KEY).toBe("daemon-api");
    expect(row.env.BASH_DEFAULT_TIMEOUT_MS).toBe("900000");
    expect(row.env.ARTIFACT_HOST_TOKEN).toBe("daemon-artifact-host");
    expect(row.env.CLIPROXY_MANAGEMENT_KEY).toBeUndefined();
    expect(row.env.PLANNER_WEBHOOK_SECRET).toBeUndefined();
    expect(row.env.ARTIFACT_TOKEN).toBeUndefined();
    expect(row.env.OAUTH_ACCESS_TOKEN).toBeUndefined();
    const unconfiguredResult = await runTurn(
      options({
        cwd: dir,
        env: { CLAUDE_FAKE_ENV_FILE: unconfiguredEnvFile },
        trustedEnv: {
          CLAUDE_FAKE_MODE: "happy",
          ARTIFACT_HOST_TOKEN: "trusted-artifact-host",
        },
      }),
    );
    expect(unconfiguredResult.ok).toBe(true);
    const unconfiguredRow = JSON.parse(
      readFileSync(unconfiguredEnvFile, "utf8").trim(),
    ) as { env: Record<string, string> };
    expect(unconfiguredRow.env.ARTIFACT_HOST_TOKEN).toBeUndefined();
  });
  it("admits TRACEPARENT only from the per-call environment", async () => {
    const dir = cwd();
    const extraFile = join(dir, "extra-env.jsonl");
    const processFile = join(dir, "process-env.jsonl");
    const oldTraceparent = process.env.TRACEPARENT;
    process.env.TRACEPARENT = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
    try {
      await runTurn(
        options({
          cwd: dir,
          env: {
            CLAUDE_FAKE_ENV_FILE: extraFile,
            TRACEPARENT: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
          },
        }),
      );
      const extra = JSON.parse(readFileSync(extraFile, "utf8").trim()) as {
        env: Record<string, string>;
      };
      expect(extra.env.TRACEPARENT).toBe(
        `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      );
      await runTurn(
        options({ cwd: dir, env: { CLAUDE_FAKE_ENV_FILE: processFile } }),
      );
      const inherited = JSON.parse(
        readFileSync(processFile, "utf8").trim(),
      ) as { env: Record<string, string> };
      expect(inherited.env.TRACEPARENT).toBeUndefined();
    } finally {
      if (oldTraceparent === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = oldTraceparent;
    }
  });
  it("drains noisy stderr and returns a bounded tail on failure", async () => {
    const result = await runTurn(
      options({ env: { CLAUDE_FAKE_MODE: "stderr-fail" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.stderrTail).toContain("stderr-line-255");
    expect(result.stderrTail!.length).toBeLessThanOrEqual(8192);
  });
  it("kills the spawned process group on abort", async () => {
    const dir = cwd();
    const heartbeat = join(dir, "heartbeat.txt");
    const controller = new AbortController();
    const promise = runTurn(
      options({
        cwd: dir,
        env: {
          CLAUDE_FAKE_MODE: "grandchild-hang",
          CLAUDE_FAKE_HEARTBEAT_FILE: heartbeat,
        },
        signal: controller.signal,
      }),
    );
    await waitFor(() => existsSync(heartbeat));
    controller.abort();
    expect((await promise).ok).toBe(false);
    const before = readFileSync(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readFileSync(heartbeat, "utf8")).toBe(before);
  });
});
