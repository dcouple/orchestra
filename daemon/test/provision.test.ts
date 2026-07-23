import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const provision = readFileSync(resolve("ops/provision.sh"), "utf8");
const claudex = readFileSync(resolve("ops/claudex"), "utf8");
const claudexFable = readFileSync(resolve("ops/claudex-fable"), "utf8");
const proxyAccounts = readFileSync(resolve("ops/proxy-accounts.sh"), "utf8");
const providerGate = readFileSync(
  resolve("ops/codex-provider-gate.sh"),
  "utf8",
);
const proxyUnit = readFileSync(resolve("ops/cliproxyapi.service"), "utf8");
const daemonUnit = readFileSync(
  resolve("ops/linear-agent-daemon.service"),
  "utf8",
);
const operationUnit = readFileSync(
  resolve("ops/linear-agent-operation.service"),
  "utf8",
);
const operationPath = readFileSync(
  resolve("ops/linear-agent-operation.path"),
  "utf8",
);
const daemonctl = readFileSync(resolve("ops/daemonctl"), "utf8");
const healthWaiterPath = resolve("ops/wait-for-daemon-health.sh");
const healthWaiter = readFileSync(healthWaiterPath, "utf8");
const sessions = readFileSync(resolve("src/sessions.ts"), "utf8");

describe("daemon provisioning", () => {
  it("derives the pinned Playwright MCP wrapper from package.json", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(packageJson.dependencies["@playwright/mcp"]).toBe("0.0.78");
    expect(packageJson.dependencies["@modelcontextprotocol/sdk"]).toBe("1.29.0");
    expect(provision).toContain('p.dependencies?.["@playwright/mcp"]');
    expect(provision).toContain('pnpm add --global "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"');
    expect(provision).toContain("/usr/local/bin/playwright-mcp");
    expect(provision).toContain("google-chrome");
  });
  it("installs a root-only operation boundary without weakening the daemon sandbox", () => {
    expect(provision).toContain("/usr/local/sbin/daemonctl");
    expect(provision).toContain("/usr/local/sbin/wait-for-daemon-health.sh");
    expect(provision).toContain("linear-agent-operation.path");
    expect(provision).toContain("https://github.com/dcouple/orchestra.git");
    expect(operationUnit).toContain("User=root");
    expect(operationUnit).toContain(
      "EnvironmentFile=/etc/linear-agent-daemon/operation.env",
    );
    expect(operationUnit).toContain("ExecStart=/usr/local/sbin/daemonctl internal-execute");
    expect(provision).toContain(
      'OPERATION_ENV_FILE="${OPERATION_ENV_FILE:-/etc/linear-agent-daemon/operation.env}"',
    );
    expect(provision).toContain("printf 'DAEMON_HOST=%s\\n'");
    expect(operationPath).toContain("*.ready");
    expect(daemonUnit).toContain("NoNewPrivileges=true");
    expect(daemonUnit).toContain("CapabilityBoundingSet=");
    expect(daemonctl).toContain('SHA256SUM_BIN="${SHA256SUM_BIN:-sha256sum}"');
    expect(daemonctl).toContain('"${STAT_BIN}" -c %u');
    expect(provision).not.toContain("linear-validator");
    expect(daemonctl).not.toContain("VALIDATOR_USER");
    expect(daemonctl).not.toContain("run_candidate_command");
    expect(provision).toContain('DEPLOYED_COMMIT_FILE="${DEPLOYED_COMMIT_FILE:-${OPERATIONS_STATE_DIR}/deployed-commit}"');
    expect(daemonctl).toContain('DEPLOYED_COMMIT_FILE="${DAEMONCTL_DEPLOYED_COMMIT_FILE:-${STATE_DIR}/deployed-commit}"');
  });
  it("retries daemon health until startup is accepted", () => {
    expect(provision).toContain('bash "${SOURCE_DIR}/ops/wait-for-daemon-health.sh"');
    expect(daemonctl).toContain('bash "${HEALTH_WAITER}" "${HEALTH_URL}"');
    expect(healthWaiter).toContain("DAEMON_HEALTH_MAX_ATTEMPTS");
    expect(healthWaiter).toContain("DAEMON_HEALTH_RETRY_DELAY_SECONDS");
    expect(healthWaiter).toContain('SLEEP_BIN="${SLEEP_BIN:-sleep}"');

    const dir = mkdtempSync(join(tmpdir(), "daemon-health-"));
    const attemptsFile = join(dir, "attempts");
    const fakeCurl = join(dir, "curl");
    writeFileSync(
      fakeCurl,
      `#!/usr/bin/env bash
set -euo pipefail
attempts=0
if [[ -f "$FAKE_HEALTH_ATTEMPTS_FILE" ]]; then attempts="$(<"$FAKE_HEALTH_ATTEMPTS_FILE")"; fi
attempts=$((attempts + 1))
printf '%s\n' "$attempts" > "$FAKE_HEALTH_ATTEMPTS_FILE"
if [[ "\${FAKE_HEALTH_MODE:-eventual}" == "eventual" && "$attempts" -ge 3 ]]; then
  printf '{"ok":true}\n'
else
  printf '{"ok":false}\n'
fi
`,
    );
    chmodSync(fakeCurl, 0o755);

    const run = (mode: "eventual" | "unhealthy", maxAttempts: string) =>
      spawnSync("bash", [healthWaiterPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          CURL_BIN: fakeCurl,
          FAKE_HEALTH_ATTEMPTS_FILE: attemptsFile,
          FAKE_HEALTH_MODE: mode,
          DAEMON_HEALTH_MAX_ATTEMPTS: maxAttempts,
          DAEMON_HEALTH_RETRY_DELAY_SECONDS: "0",
        },
      });

    const eventual = run("eventual", "3");
    expect(eventual.status).toBe(0);
    expect(readFileSync(attemptsFile, "utf8").trim()).toBe("3");

    rmSync(attemptsFile);
    const unhealthy = run("unhealthy", "2");
    expect(unhealthy.status).toBe(1);
    expect(readFileSync(attemptsFile, "utf8").trim()).toBe("2");
    expect(unhealthy.stderr).toContain(
      "daemon health did not report ok=true after 2 attempts",
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it("pins and checksum-verifies CLIProxyAPI for supported architectures", () => {
    expect(provision).toContain('CLIPROXY_VERSION="7.2.93"');
    expect(provision).toContain('CLIPROXY_ARCH="amd64"');
    expect(provision).toContain('CLIPROXY_ARCH="aarch64"');
    expect(provision).toContain("sha256sum -c -");
  });

  it("installs a claudex executable with the GPT-5.6 Sol defaults", () => {
    expect(provision).toContain('"${SOURCE_DIR}/ops/claudex"');
    expect(claudex).toContain(". /etc/linear-agent-daemon/cliproxyapi.env");
    expect(claudex).toContain(
      "export ANTHROPIC_BASE_URL=http://127.0.0.1:8317",
    );
    expect(claudex).toContain("export CLIPROXY_API_KEY");
    expect(claudex).toContain(
      'export ANTHROPIC_AUTH_TOKEN="${CLIPROXY_API_KEY}"',
    );
    expect(claudex).toContain(
      "export ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-5.6-sol-low",
    );
    expect(claudex).toContain(
      "export ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-5.6-sol-low",
    );
    expect(claudex).toContain(
      "export ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-5.6-sol-medium",
    );
    expect(claudex).toContain(
      "export ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-5.6-sol-xhigh",
    );
    expect(claudex).toContain("export CLAUDE_CODE_MAX_CONTEXT_TOKENS=250000");
    expect(claudex).not.toContain("CLAUDE_CODE_SUBAGENT_MODEL");
    expect(claudex).toContain("export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1");
    expect(claudex).toContain("export CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=3");
    expect(claudex).toContain("export ENABLE_TOOL_SEARCH=true");
    expect(claudex).toContain("claude --model gpt-5.6-sol");
    expect(sessions).toMatch(
      /runtime === "claudex"\s*\? this\.config\.claudexArgv/,
    );
    expect(sessions).toMatch(
      /return \{\s*profile: "sol",\s*runtime: "claudex",\s*reason: "claudex_preferred",?\s*\}/,
    );
  });
  it("installs a fail-closed Fable launcher and validates model identity before exec", async () => {
    expect(provision).toContain('"${SOURCE_DIR}/ops/claudex-fable"');
    expect(provision).not.toContain(
      "cat > /etc/linear-agent-daemon/fable-models.env",
    );
    expect(claudexFable).toContain("claude-*");
    expect(claudexFable).toContain("/v1/models");
    const dir = mkdtempSync(join(tmpdir(), "claudex-fable-"));
    const proxyEnv = join(dir, "proxy.env"),
      modelsEnv = join(dir, "models.env"),
      argsFile = join(dir, "args");
    const fakeClaude = join(dir, "claude");
    writeFileSync(proxyEnv, "CLIPROXY_API_KEY=test-key\n");
    writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "$*" > ${argsFile}\n`);
    chmodSync(fakeClaude, 0o755);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "claude-real" }] }));
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    const port = (server.address() as { port: number }).port;
    const run = (models: string) =>
      new Promise<{ code: number | null; stderr: string }>((resolveRun) => {
        writeFileSync(modelsEnv, models);
        const child = spawn("sh", [resolve("ops/claudex-fable"), "--flag"], {
          env: {
            ...process.env,
            CLIPROXY_ENV_FILE: proxyEnv,
            FABLE_MODELS_ENV_FILE: modelsEnv,
            PROXY_URL: `http://127.0.0.1:${port}`,
            FABLE_CLAUDE_BIN: fakeClaude,
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("close", (code) => resolveRun({ code, stderr }));
      });
    const valid =
      "FABLE_MAIN_MODEL=claude-real\nFABLE_HAIKU_MODEL=claude-real\nFABLE_SONNET_MODEL=claude-real\nFABLE_OPUS_MODEL=claude-real\nFABLE_FABLE_MODEL=claude-real\n";
    expect((await run(valid)).code).toBe(0);
    expect(readFileSync(argsFile, "utf8")).toContain(
      "--model claude-real --flag",
    );
    const wrong = await run(
      valid.replace(
        "FABLE_MAIN_MODEL=claude-real",
        "FABLE_MAIN_MODEL=gpt-wrong",
      ),
    );
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain("FABLE_MAIN_MODEL must name a claude-*");
    const missing = await run(
      valid.replace(
        "FABLE_MAIN_MODEL=claude-real",
        "FABLE_MAIN_MODEL=claude-missing",
      ),
    );
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("FABLE_MAIN_MODEL model absent");
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("configures model effort tiers and starts the loopback proxy before the daemon", () => {
    expect(provision).toContain('alias: "gpt-5.6-sol-low"');
    expect(provision).toContain('alias: "gpt-5.6-sol-medium"');
    expect(provision).toContain('alias: "gpt-5.6-sol-xhigh"');
    expect(provision).toContain('"reasoning.effort": "xhigh"');
    expect(provision).toContain('session-affinity-ttl: "168h"');
    expect(provision).toContain("save-cooldown-status: true");
    expect(provision).toContain("remote-management:");
    expect(provision).toContain("allow-remote: false");
    expect(provision).toMatch(
      /payload:\n  default:[\s\S]*name: "gpt-5\.6-sol"[\s\S]*"reasoning\.effort": "high"[\s\S]*  override:/,
    );
    expect(proxyUnit).toContain(
      "ExecStart=/usr/local/bin/cliproxyapi -config /etc/linear-agent-daemon/cliproxyapi.yaml",
    );
    expect(proxyUnit).toContain("User=linear-daemon");
    expect(daemonUnit).toContain(
      "After=network-online.target cliproxyapi.service",
    );
    expect(daemonUnit).toContain(
      "Wants=network-online.target cliproxyapi.service",
    );
    expect(daemonUnit).not.toContain("Requires=cliproxyapi.service");
    expect(provision).toContain(
      "systemctl enable caddy cliproxyapi linear-agent-daemon",
    );
    expect(provision).toContain("cliproxy_has_default_model");
    expect(provision).toContain('model.get("id") == "gpt-5.6-sol"');
  });

  it("manages separate API and management keys and deploys fail-closed account tooling", () => {
    expect(provision).toContain(
      "CLIPROXY_MANAGEMENT_KEY=<48 lowercase hex characters>",
    );
    expect(provision).toContain('CLIPROXY_MANAGEMENT_KEY="$(grep -E');
    expect(provision).toContain("ops/proxy-accounts.sh");
    expect(provision).toContain("ops/codex-provider-gate.sh");
    expect(provision).toContain('EXPECTED_PROXY_VERSION="${CLIPROXY_VERSION}"');
    expect(provision).toContain("standalone Codex provider gate skipped");
    expect(provision).toContain("/v0/management/auth-files");
    expect(provision).toContain('item.get("provider") == "codex"');
    expect(provision).not.toContain("-name 'codex-*.json'");
    expect(proxyAccounts).toContain("/v0/management/auth-files");
    expect(providerGate).toContain("codex exec resume --last");
    expect(providerGate).toContain("rollback");
    expect(providerGate).toContain('echo "FAIL: unexpected-error"');
    expect(providerGate).toContain(
      'GATE_COUNTER_WINDOW_SECONDS="${GATE_COUNTER_WINDOW_SECONDS:-15}"',
    );
  });

  it("exposes help before secret validation and returns nonzero for gate environment failures", () => {
    const gatePath = resolve("ops/codex-provider-gate.sh");
    const accountsPath = resolve("ops/proxy-accounts.sh");
    const missingSecrets = { ...process.env, CLIPROXY_ENV_FILE: "/dev/null" };

    const gateHelp = spawnSync("bash", [gatePath, "--help"], {
      encoding: "utf8",
      env: missingSecrets,
    });
    expect(gateHelp.status).toBe(0);
    expect(gateHelp.stdout).toContain("usage: codex-provider-gate.sh [--help]");
    expect(gateHelp.stdout).toContain("Environment variables:");

    const accountsHelp = spawnSync("bash", [accountsPath, "--help"], {
      encoding: "utf8",
      env: missingSecrets,
    });
    expect(accountsHelp.status).toBe(0);
    expect(accountsHelp.stdout).toContain("usage: proxy-accounts.sh");

    const gateFailure = spawnSync("bash", [gatePath], {
      encoding: "utf8",
      env: missingSecrets,
    });
    expect(gateFailure.status).not.toBe(0);
    expect(gateFailure.stderr).toContain("missing CLIPROXY_API_KEY");

    const unknownArgument = spawnSync("bash", [gatePath, "--unknown"], {
      encoding: "utf8",
      env: missingSecrets,
    });
    expect(unknownArgument.status).not.toBe(0);
    expect(unknownArgument.stderr).toContain("usage: codex-provider-gate.sh");
  });

  it("removes only gate-managed provider configs when environment validation fails", () => {
    const gatePath = resolve("ops/codex-provider-gate.sh");
    const dir = mkdtempSync(join(tmpdir(), "provider-gate-rollback-"));
    try {
      const managed = join(dir, "managed.toml");
      writeFileSync(
        managed,
        '# managed by codex-provider-gate.sh — removed on gate failure\nmodel = "old"\n',
      );
      const managedFailure = spawnSync("bash", [gatePath], {
        encoding: "utf8",
        env: {
          ...process.env,
          CLIPROXY_ENV_FILE: "/dev/null",
          TARGET_CONFIG: managed,
        },
      });
      expect(managedFailure.status).not.toBe(0);
      expect(existsSync(managed)).toBe(false);

      const unmarked = join(dir, "unmarked.toml");
      const unmarkedContent = 'model = "direct"\n# preserve byte-identically\n';
      writeFileSync(unmarked, unmarkedContent);
      const unmarkedFailure = spawnSync("bash", [gatePath], {
        encoding: "utf8",
        env: {
          ...process.env,
          CLIPROXY_ENV_FILE: "/dev/null",
          TARGET_CONFIG: unmarked,
        },
      });
      expect(unmarkedFailure.status).not.toBe(0);
      expect(readFileSync(unmarked, "utf8")).toBe(unmarkedContent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
