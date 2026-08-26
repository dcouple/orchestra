#!/bin/bash
set -euo pipefail

# shellcheck source=daemon-site-lib.sh
. "${DAEMON_SITE_LIB:-/usr/local/sbin/daemon-site-lib.sh}"
load_site_env
exec /usr/local/bin/cliproxyapi \
  -config "$DAEMON_SERVICE_HOME/.config/linear-agent-daemon/cliproxyapi.yaml"
