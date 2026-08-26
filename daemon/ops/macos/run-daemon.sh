#!/bin/bash
set -euo pipefail

# shellcheck source=daemon-site-lib.sh
. "${DAEMON_SITE_LIB:-/usr/local/sbin/daemon-site-lib.sh}"
load_site_env
ENV_FILE=${LINEAR_AGENT_ENV_FILE:-$DAEMON_SERVICE_HOME/.config/linear-agent-daemon/env}
[ -r "$ENV_FILE" ] || { echo "env file missing: $ENV_FILE" >&2; exit 78; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
cd "$DAEMON_SERVICE_HOME/linear-agent-daemon"
exec /opt/homebrew/opt/node@22/bin/node dist/index.js
