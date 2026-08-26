#!/bin/bash
set -euo pipefail

# shellcheck source=daemon-site-lib.sh
. "${DAEMON_SITE_LIB:-/usr/local/sbin/daemon-site-lib.sh}"
load_site_env
exec /opt/homebrew/bin/cloudflared --no-autoupdate tunnel \
  --config "$DAEMON_SERVICE_HOME/.cloudflared/config.yml" run
