#!/bin/bash
set -euo pipefail

exec /usr/local/bin/cliproxyapi \
  -config /Users/linearagent/.config/linear-agent-daemon/cliproxyapi.yaml
