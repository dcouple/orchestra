#!/bin/bash
set -euo pipefail

# shellcheck source=daemon-site-lib.sh
. "${DAEMON_SITE_LIB:-/usr/local/sbin/daemon-site-lib.sh}"
load_site_env
ENV_FILE=${LINEAR_AGENT_ENV_FILE:-$DAEMON_SERVICE_HOME/.config/linear-agent-daemon/env}
[ -r "$ENV_FILE" ] || { echo "env file missing: $ENV_FILE" >&2; exit 78; }

# Read the trusted daemon environment, then pass only the console's allow-listed
# settings to its process. Webhook and provider credentials never enter its env.
set +u
# shellcheck disable=SC1090
. "$ENV_FILE"
set -u
DB_PATH=${DB_PATH:-/var/lib/linear-agent-daemon/events.db}
LINEAR_WORKSPACE_BASE_URL=${LINEAR_WORKSPACE_BASE_URL:-}
CODE_DIR=$DAEMON_SERVICE_HOME/linear-agent-daemon
NODE_BIN=${CONSOLE_NODE_BIN:-/opt/homebrew/opt/node@22/bin/node}
args=(env -i HOME="$DAEMON_SERVICE_HOME" USER="$DAEMON_SERVICE_USER" PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin
  DB_PATH="$DB_PATH" CONSOLE_BIND_ADDR="$DAEMON_CONSOLE_BIND_ADDR" CONSOLE_PORT="$DAEMON_CONSOLE_PORT"
  CONSOLE_ASSETS_DIR="$CODE_DIR/dist/console")
[[ -z $LINEAR_WORKSPACE_BASE_URL ]] || args+=(LINEAR_WORKSPACE_BASE_URL="$LINEAR_WORKSPACE_BASE_URL")
cd "$CODE_DIR"
exec "${args[@]}" "$NODE_BIN" dist/console-index.js
