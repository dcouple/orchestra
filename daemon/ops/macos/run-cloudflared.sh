#!/bin/bash
set -euo pipefail

exec /opt/homebrew/bin/cloudflared --no-autoupdate tunnel \
  --config /Users/linearagent/.cloudflared/config.yml run
