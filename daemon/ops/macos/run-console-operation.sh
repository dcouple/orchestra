#!/bin/bash
set -euo pipefail
[[ $# -eq 0 ]] || { echo "console operation runner accepts no arguments" >&2; exit 2; }
# shellcheck source=daemon-site-lib.sh
. "${DAEMON_SITE_LIB:-/usr/local/sbin/daemon-site-lib.sh}"
load_site_env
HOME_DIR=${LINEAR_AGENT_HOME:-$DAEMON_SERVICE_HOME}
STATE_DIR=$HOME_DIR/.local/state/linear-agent-operations
exec /usr/bin/env -i HOME="$HOME_DIR" USER="$DAEMON_SERVICE_USER" PATH=/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin \
  DB_PATH="${DB_PATH:-$HOME_DIR/events.db}" CONSOLE_OPERATION_SPOOL_DIR="$STATE_DIR/console-requests" \
  CONSOLE_PROTECTED_ENV_FILE="$HOME_DIR/.config/linear-agent-daemon/env" \
  CONSOLE_DAEMONCTL_PATH=/usr/local/sbin/daemonctl \
  /opt/homebrew/opt/node@22/bin/node "$HOME_DIR/linear-agent-daemon/dist/console-operation-executor-cli.js"
