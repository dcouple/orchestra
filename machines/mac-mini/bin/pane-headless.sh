#!/bin/sh
# Started by the com.dcouple.pane-headless LaunchDaemon as the operator.
# Pane's terminals inherit this environment, so the owner-only env file
# carries the agent credentials the locked login Keychain cannot provide.
set -eu

export PANE_DIR="$HOME/.pane"
credentials="$HOME/.config/pane-headless/env"
if [ -f "$credentials" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$credentials"
  set +a
fi

exec /Applications/Pane.app/Contents/MacOS/Pane --daemon-headless --pane-dir "$PANE_DIR"
