#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: codex-live-setup.sh [--help]

Install the isolated Codex harness used by the live (voice) session and report
whether it is ready to serve. Idempotent: safe to re-run on every provision.

The live session is a separate Codex installation, not a second profile on the
existing one. Nothing below is shared with the Codex that /do dispatches as a
subagent:

                    Subagent Codex              Live Codex
  binary            /usr/local/bin/codex        /opt/codex-live/bin/codex
                    (otel wrapper -> pnpm)      (pinned release tarball)
  version           0.144.6                     0.145.0
  Codex home        ~/.codex                    ~/.codex-live
  config owner      codex-provider-gate.sh      this script
  auth              CLIProxyAPI OAuth pool      direct ChatGPT (auth.json)
  instructions      per-repo AGENTS.md          ~/.codex-live/AGENTS.md
  workspace         session worktrees           ~/live
  lifecycle         linear-agent-daemon         codex-live

Two reasons they must stay apart. Realtime audio needs direct ChatGPT
credentials, which CLIProxyAPI does not front. And the roles differ: subagent
Codex implements and reviews inside a work item, while live Codex is spoken to
about operating the host. Upgrading or breaking one must not touch the other.

Environment variables:
  LIVE_CODEX_HOME    Live Codex state directory
                     (default: /var/lib/linear-agent-daemon/.codex-live)
  LIVE_WORKSPACE     Live session working directory
                     (default: /var/lib/linear-agent-daemon/live)
  CODEX_BIN          Live Codex executable (default: /opt/codex-live/bin/codex)
  AGENTS_SOURCE      Role instructions to install as the live global AGENTS.md
                     (default: alongside this script)
  DAEMON_ENV_FILE    Daemon env file read for LINEAR_API_KEY presence
                     (default: /etc/linear-agent-daemon/env)
  LINEAR_MCP_URL     Linear MCP endpoint (default: https://mcp.linear.app/mcp)
  LIVE_MODEL         Model for live turns (default: gpt-5.6-sol)
  LIVE_VOICE         Realtime voice (default: cove)

Exit status:
  0  harness installed and the live home holds usable ChatGPT credentials
  3  harness installed but the live home is not logged in yet (operator action)
EOF
}

if [[ $# -gt 0 ]]; then
  case "$1" in
    --help|-h) [[ $# -eq 1 ]] || { usage >&2; exit 2; }; usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LIVE_CODEX_HOME="${LIVE_CODEX_HOME:-/var/lib/linear-agent-daemon/.codex-live}"
LIVE_WORKSPACE="${LIVE_WORKSPACE:-/var/lib/linear-agent-daemon/live}"
CODEX_BIN="${CODEX_BIN:-/opt/codex-live/bin/codex}"
AGENTS_SOURCE="${AGENTS_SOURCE:-${SCRIPT_DIR}/codex-live-AGENTS.md}"
DAEMON_ENV_FILE="${DAEMON_ENV_FILE:-/etc/linear-agent-daemon/env}"
LINEAR_MCP_URL="${LINEAR_MCP_URL:-https://mcp.linear.app/mcp}"
LIVE_MODEL="${LIVE_MODEL:-gpt-5.6-sol}"
LIVE_VOICE="${LIVE_VOICE:-cove}"
MARKER='# managed by codex-live-setup.sh — rewritten on every provision'

[[ -x "${CODEX_BIN}" ]] || { echo "codex-live-setup: ${CODEX_BIN} is not installed" >&2; exit 1; }
install -d -m 0700 "${LIVE_CODEX_HOME}"
install -d -m 0750 "${LIVE_WORKSPACE}"

# config.toml is owned here and rewritten wholesale, so hand edits do not
# survive. auth.json sits alongside it and is never touched — the operator's
# one-time `codex login --device-auth` is what puts it there.
config_tmp="${LIVE_CODEX_HOME}/config.toml.tmp.$$"
# Unquoted heredoc: ${...} interpolation is wanted, but that also makes
# backticks command substitution, so no prose below may use them.
cat > "${config_tmp}" <<EOF
${MARKER}
# Every bare key must stay above the first table header — TOML assigns them to
# the preceding table otherwise, and the features table only accepts booleans.
model = "${LIVE_MODEL}"

# A live session is spoken to, not watched. Approvals surface in whichever
# client is attached — phone or laptop — so keep them on-request rather than
# bypassing the sandbox for a session nobody is staring at.
approval_policy = "on-request"
sandbox_mode = "workspace-write"
suppress_unstable_features_warning = true

# Realtime is still an under-development feature flag upstream; the whole
# transport (WebRTC offer relay, audio chunk append, transcript deltas) is
# present in the shipped binary behind it.
[features]
realtime_conversation = true

# webrtc, not websocket: the client negotiates media straight to OpenAI and
# this host only relays the SDP offer, so voice latency does not depend on the
# VM's region and audio never traverses it.
[realtime]
transport = "webrtc"
voice = "${LIVE_VOICE}"

# Streamable HTTP with a bearer token: no OAuth callback, which a headless VM
# cannot service. LINEAR_API_KEY is supplied by the unit's EnvironmentFile.
[mcp_servers.linear]
url = "${LINEAR_MCP_URL}"
bearer_token_env_var = "LINEAR_API_KEY"
startup_timeout_sec = 60
EOF
chmod 0600 "${config_tmp}"
mv "${config_tmp}" "${LIVE_CODEX_HOME}/config.toml"

# Global instructions for this Codex home only. The subagent Codex reads a
# different home and never sees this file, which is what lets the live agent
# carry an operator role without touching the implementer prompt.
if [[ -r "${AGENTS_SOURCE}" ]]; then
  install -m 0600 "${AGENTS_SOURCE}" "${LIVE_CODEX_HOME}/AGENTS.md"
else
  echo "codex-live-setup: role instructions missing at ${AGENTS_SOURCE}" >&2
  exit 1
fi

if ! grep -Eq "^[[:space:]]*LINEAR_API_KEY=[^[:space:]]+" "${DAEMON_ENV_FILE}" 2>/dev/null; then
  echo "codex-live-setup: ${DAEMON_ENV_FILE} has no LINEAR_API_KEY; the Linear MCP will fail to start" >&2
fi

# `login status` is the only read-only probe that distinguishes "has usable
# ChatGPT credentials" from "has an API key" or "never logged in".
login_status="$(CODEX_HOME="${LIVE_CODEX_HOME}" "${CODEX_BIN}" login status 2>&1 || true)"
if grep -Fqi 'chatgpt' <<<"${login_status}"; then
  echo "codex-live-setup: live Codex harness ready at ${LIVE_CODEX_HOME}"
  exit 0
fi
cat >&2 <<EOF
codex-live-setup: live Codex harness configured but not authenticated.
Realtime requires direct ChatGPT credentials — an API key will not do. Run:

  sudo runuser -u linear-daemon -- env HOME=/var/lib/linear-agent-daemon \\
    CODEX_HOME=${LIVE_CODEX_HOME} ${CODEX_BIN} login --device-auth

then: sudo systemctl restart codex-live
EOF
exit 3
