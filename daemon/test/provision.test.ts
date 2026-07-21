import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const provision = readFileSync(resolve("ops/provision.sh"), "utf8");
const claudex = readFileSync(resolve("ops/claudex"), "utf8");
const proxyUnit = readFileSync(resolve("ops/cliproxyapi.service"), "utf8");
const daemonUnit = readFileSync(resolve("ops/linear-agent-daemon.service"), "utf8");

describe("daemon provisioning", () => {
  it("pins and checksum-verifies CLIProxyAPI for supported architectures", () => {
    expect(provision).toContain('CLIPROXY_VERSION="7.2.93"');
    expect(provision).toContain('CLIPROXY_ARCH="amd64"');
    expect(provision).toContain('CLIPROXY_ARCH="aarch64"');
    expect(provision).toContain("sha256sum -c -");
  });

  it("installs a claudex executable with the GPT-5.6 Sol defaults", () => {
    expect(provision).toContain('"${SOURCE_DIR}/ops/claudex"');
    expect(claudex).toContain(". /etc/linear-agent-daemon/cliproxyapi.env");
    expect(claudex).toContain("export ANTHROPIC_BASE_URL=http://127.0.0.1:8317");
    expect(claudex).toContain('export ANTHROPIC_AUTH_TOKEN="${CLIPROXY_API_KEY}"');
    expect(claudex).toContain("export ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-5.6-sol-low");
    expect(claudex).toContain("export ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-5.6-sol-low");
    expect(claudex).toContain("export ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-5.6-sol-medium");
    expect(claudex).toContain("export ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-5.6-sol-xhigh");
    expect(claudex).toContain("export CLAUDE_CODE_MAX_CONTEXT_TOKENS=250000");
    expect(claudex).not.toContain("CLAUDE_CODE_SUBAGENT_MODEL");
    expect(claudex).toContain("export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1");
    expect(claudex).toContain("export CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=3");
    expect(claudex).toContain("export ENABLE_TOOL_SEARCH=true");
    expect(claudex).toContain("claude --model gpt-5.6-sol");
  });

  it("configures model effort tiers and starts the loopback proxy before the daemon", () => {
    expect(provision).toContain('alias: "gpt-5.6-sol-low"');
    expect(provision).toContain('alias: "gpt-5.6-sol-medium"');
    expect(provision).toContain('alias: "gpt-5.6-sol-xhigh"');
    expect(provision).toContain('"reasoning.effort": "xhigh"');
    expect(proxyUnit).toContain("ExecStart=/usr/local/bin/cliproxyapi -config /etc/linear-agent-daemon/cliproxyapi.yaml");
    expect(proxyUnit).toContain("User=linear-daemon");
    expect(daemonUnit).toContain("After=network-online.target cliproxyapi.service");
    expect(daemonUnit).toContain("Wants=network-online.target cliproxyapi.service");
    expect(daemonUnit).not.toContain("Requires=cliproxyapi.service");
    expect(provision).toContain("systemctl enable caddy cliproxyapi linear-agent-daemon");
    expect(provision).toContain("cliproxy_has_default_model");
    expect(provision).toContain('model.get("id") == "gpt-5.6-sol"');
  });
});
