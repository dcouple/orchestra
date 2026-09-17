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
SNAPSHOT_PATH=$DAEMON_SERVICE_HOME/.local/state/linear-agent-operations/console-config-snapshot.json
/opt/homebrew/opt/node@22/bin/node dist/managed-env-cli.js refresh "$ENV_FILE" "$SNAPSHOT_PATH"
# The daemon refreshes this snapshot periodically while it runs, preserving the
# revision when the env is unchanged, so console writes survive >24h uptimes.
export LINEAR_AGENT_MANAGED_ENV_FILE="$ENV_FILE"
export CONSOLE_CONFIG_SNAPSHOT_PATH="$SNAPSHOT_PATH"
exec /opt/homebrew/opt/node@22/bin/node dist/index.js
