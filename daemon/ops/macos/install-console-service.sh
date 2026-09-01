#!/bin/bash
set -euo pipefail

usage() {
  echo "usage: install-console-service.sh [--dry-run] <runner-source> <plist-source> <launchd-label>" >&2
  exit 2
}
die() { echo "$*" >&2; exit 1; }

DRY_RUN=0
if [[ ${1:-} == --dry-run ]]; then DRY_RUN=1; shift; fi
[[ $# -eq 3 ]] || usage

RUNNER_SOURCE=$1
PLIST_SOURCE=$2
LABEL=$3
RUNNER_DEST=${CONSOLE_RUNNER_DEST:-/usr/local/sbin/run-console.sh}
PLIST_DEST=${CONSOLE_PLIST_DEST:-/Library/LaunchDaemons/$LABEL.plist}
SUDO_BIN=${SUDO_BIN:-sudo}
LAUNCHCTL_BIN=${LAUNCHCTL_BIN:-/bin/launchctl}
FORCE_RESTART=${CONSOLE_INSTALL_FORCE_RESTART:-0}

[[ -f $RUNNER_SOURCE && ! -L $RUNNER_SOURCE ]] || die "console runner source is invalid: $RUNNER_SOURCE"
[[ -f $PLIST_SOURCE && ! -L $PLIST_SOURCE ]] || die "console plist source is invalid: $PLIST_SOURCE"
[[ $LABEL =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "invalid launchd label: $LABEL"

file_correct() {
  local source=$1 destination=$2 mode=$3
  "$SUDO_BIN" test -f "$destination" && "$SUDO_BIN" cmp -s "$source" "$destination" \
    && [[ $("$SUDO_BIN" stat -f %Lp "$destination") == "${mode#0}" ]] \
    && [[ $("$SUDO_BIN" stat -f %Su:%Sg "$destination") == root:wheel ]]
}

runner_status=already-correct
plist_status=already-correct
file_correct "$RUNNER_SOURCE" "$RUNNER_DEST" 0755 || runner_status=would-apply
file_correct "$PLIST_SOURCE" "$PLIST_DEST" 0644 || plist_status=would-apply
if "$SUDO_BIN" "$LAUNCHCTL_BIN" print "system/$LABEL" >/dev/null 2>&1; then service_loaded=1; else service_loaded=0; fi

if (( DRY_RUN )); then
  service_status=already-correct
  if [[ $runner_status == would-apply || $plist_status == would-apply || $service_loaded == 0 || $FORCE_RESTART == 1 ]]; then
    service_status=would-apply
  fi
  echo "DRY RUN: console service; no changes will be made."
  echo "runner $runner_status: $RUNNER_DEST"
  echo "plist $plist_status: $PLIST_DEST"
  echo "service $service_status: $LABEL"
  exit 0
fi

runner_changed=0
plist_changed=0
if [[ $runner_status == would-apply ]]; then
  "$SUDO_BIN" install -o root -g wheel -m 0755 "$RUNNER_SOURCE" "$RUNNER_DEST"
  file_correct "$RUNNER_SOURCE" "$RUNNER_DEST" 0755 || die "console runner did not verify: $RUNNER_DEST"
  runner_changed=1
fi
if [[ $plist_status == would-apply ]]; then
  "$SUDO_BIN" install -o root -g wheel -m 0644 "$PLIST_SOURCE" "$PLIST_DEST"
  file_correct "$PLIST_SOURCE" "$PLIST_DEST" 0644 || die "console plist did not verify: $PLIST_DEST"
  plist_changed=1
fi

changed=0
if (( service_loaded == 0 )); then
  "$SUDO_BIN" "$LAUNCHCTL_BIN" bootstrap system "$PLIST_DEST"
  changed=1
elif (( plist_changed )); then
  "$SUDO_BIN" "$LAUNCHCTL_BIN" bootout "system/$LABEL"
  "$SUDO_BIN" "$LAUNCHCTL_BIN" bootstrap system "$PLIST_DEST"
  changed=1
elif (( runner_changed || FORCE_RESTART )); then
  "$SUDO_BIN" "$LAUNCHCTL_BIN" kickstart -k "system/$LABEL"
  changed=1
fi
"$SUDO_BIN" "$LAUNCHCTL_BIN" print "system/$LABEL" >/dev/null 2>&1 \
  || die "console service did not verify: $LABEL"

if (( changed || runner_changed || plist_changed )); then echo applied; else echo already-correct; fi
