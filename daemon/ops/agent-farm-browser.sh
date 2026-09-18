#!/bin/bash
set -euo pipefail

# The workspace is static. Browser state and evidence belong to this attempt.
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
