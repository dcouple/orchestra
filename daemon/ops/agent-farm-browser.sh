#!/bin/bash
set -euo pipefail

# The workspace is static. Browser state and evidence belong to this attempt.
# Keep the static workspace server healthy without starting a browser. Clients
# still need an MCP handshake; exiting before initialize is a connection failure.
if [[ -z "${ORCHESTRA_BROWSER_STATE_DIR:-}" && -z "${ORCHESTRA_BROWSER_EVIDENCE_DIR:-}" && -z "${ORCHESTRA_BROWSER_SOCKET_ALIAS:-}" ]]; then
  exec node --input-type=module -e '
    import { createInterface } from "node:readline";
    const lines = createInterface({ input: process.stdin });
    lines.on("line", line => {
      let request;
      try { request = JSON.parse(line); } catch { return; }
      if (!request || request.id === undefined) return;
      let result;
      if (request.method === "initialize") result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "orchestra-browser-unattached", version: "1.0.0" },
      };
      else if (request.method === "tools/list") result = { tools: [] };
      else if (request.method === "ping") result = {};
      const response = { jsonrpc: "2.0", id: request.id,
        ...(result === undefined
          ? { error: { code: -32601, message: "Method not found" } }
          : { result }) };
      process.stdout.write(JSON.stringify(response) + "\n");
    });
  '
fi

: "${ORCHESTRA_BROWSER_STATE_DIR:?browser attempt has not been attached}"
: "${ORCHESTRA_BROWSER_EVIDENCE_DIR:?browser evidence directory is missing}"
: "${ORCHESTRA_BROWSER_SOCKET_ALIAS:?browser socket alias is missing}"
test -d "$ORCHESTRA_BROWSER_STATE_DIR"
test -d "$ORCHESTRA_BROWSER_EVIDENCE_DIR"
test -L "$ORCHESTRA_BROWSER_SOCKET_ALIAS"
export TMPDIR="$ORCHESTRA_BROWSER_SOCKET_ALIAS"
export TEMP="$ORCHESTRA_BROWSER_SOCKET_ALIAS"
export TMP="$ORCHESTRA_BROWSER_SOCKET_ALIAS"
export PWTEST_SOCKETS_DIR="$ORCHESTRA_BROWSER_SOCKET_ALIAS"
exec "${ORCHESTRA_BROWSER_MCP_BIN:-/usr/local/bin/playwright-mcp}" \
  --browser chrome \
  --executable-path "${ORCHESTRA_BROWSER_CHROME_BIN:-/usr/bin/google-chrome}" \
  --headless --isolated \
  --output-dir "$ORCHESTRA_BROWSER_EVIDENCE_DIR" \
  --output-mode file --caps devtools
