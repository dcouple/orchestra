#!/bin/bash
set -euo pipefail

ENV_FILE=${LINEAR_AGENT_ENV_FILE:-/Users/linearagent/.config/linear-agent-daemon/env}
[ -r "$ENV_FILE" ] || { echo "env file missing: $ENV_FILE" >&2; exit 78; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
cd /Users/linearagent/linear-agent-daemon
exec /opt/homebrew/opt/node@22/bin/node dist/index.js
