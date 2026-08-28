#!/bin/bash
set -euo pipefail

usage() { echo "usage: deploy.sh [--dry-run] <source-daemon-dir>" >&2; exit 2; }
die() { echo "$*" >&2; exit 1; }

DRY_RUN=0
if [[ ${1:-} == --dry-run ]]; then DRY_RUN=1; shift; fi
[[ $# -eq 1 ]] || usage

SOURCE_DIR=$(cd "$1" && pwd)
SOURCE_ROOT=$(cd "$SOURCE_DIR/.." && pwd)
MACOS_DIR=$SOURCE_DIR/ops/macos
# shellcheck source=daemon-site-lib.sh
. "${DAEMON_SITE_LIB:-$MACOS_DIR/daemon-site-lib.sh}"
load_site_env || exit 78
[[ $(id -un) == "$DAEMON_SERVICE_USER" || ${DAEMON_DEPLOY_ALLOW_OTHER_USER:-0} == 1 ]] \
  || die "deploy.sh must run as $DAEMON_SERVICE_USER"
HOME_DIR=${LINEAR_AGENT_HOME:-$DAEMON_SERVICE_HOME}
CODE_DIR=${LINEAR_AGENT_CODE_DIR:-$HOME_DIR/linear-agent-daemon}
STATE_DIR=${OPERATIONS_STATE_DIR:-$HOME_DIR/.local/state/linear-agent-operations}
ENV_FILE=${LINEAR_AGENT_ENV_FILE:-$HOME_DIR/.config/linear-agent-daemon/env}
PROXY_ENV=${CLIPROXY_ENV_FILE:-$HOME_DIR/.config/linear-agent-daemon/cliproxyapi.env}
ACCEPTED_COMMIT_FILE=${ACCEPTED_COMMIT_FILE:-$STATE_DIR/accepted-commit}
DEPLOYED_COMMIT_FILE=${DEPLOYED_COMMIT_FILE:-$STATE_DIR/deployed-commit}
HEALTH_WAITER=${HEALTH_WAITER:-/usr/local/sbin/wait-for-daemon-health.sh}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8787/healthz}
CONSOLE_HEALTH_URL=${CONSOLE_HEALTH_URL:-http://127.0.0.1:$DAEMON_CONSOLE_PORT/api/health}
if [[ ! $CONSOLE_HEALTH_URL =~ ^http://127\.0\.0\.1:([1-9][0-9]{0,4})/api/health$ ]] \
  || (( 10#${BASH_REMATCH[1]:-0} > 65535 )); then
  die "CONSOLE_HEALTH_URL must be a loopback http://127.0.0.1:<port>/api/health URL"
fi
PNPM_BIN=${PNPM_BIN:-/usr/local/bin/pnpm}
SOURCE_COMMIT=${SOURCE_COMMIT:-}
MAINTENANCE_LOCK=$STATE_DIR/maintenance.lock

release_maintenance_lock() {
  [[ ${MAINTENANCE_LOCK_OWNED:-0} == 1 ]] || return 0
  if [[ -d $MAINTENANCE_LOCK && $(cat "$MAINTENANCE_LOCK/pid" 2>/dev/null || true) == "$$" ]]; then
    rm -f "$MAINTENANCE_LOCK/pid"
    rmdir "$MAINTENANCE_LOCK" 2>/dev/null || true
  fi
}
acquire_maintenance_lock() {
  local holder stale
  [[ -d $STATE_DIR ]] || install -d -m 0700 "$STATE_DIR"
  if [[ ${DAEMONCTL_LOCK_HELD:-0} == 1 ]]; then
    holder=$(cat "$MAINTENANCE_LOCK/pid" 2>/dev/null || true)
    [[ $holder =~ ^[1-9][0-9]*$ && $holder == "${DAEMONCTL_LOCK_PID:-}" ]] \
      || die "maintenance lock handoff is invalid: $MAINTENANCE_LOCK"
    kill -0 "$holder" 2>/dev/null \
      || die "maintenance lock handoff holder is not live: $holder"
    return
  fi
  while ! mkdir "$MAINTENANCE_LOCK" 2>/dev/null; do
    holder=$(cat "$MAINTENANCE_LOCK/pid" 2>/dev/null || true)
    [[ $holder =~ ^[1-9][0-9]*$ ]] \
      || die "maintenance lock has no valid holder pid: $MAINTENANCE_LOCK"
    if kill -0 "$holder" 2>/dev/null; then
      die "maintenance already in progress (pid $holder): $MAINTENANCE_LOCK"
    fi
    stale="$MAINTENANCE_LOCK.stale.$$.$RANDOM"
    while [[ -e $stale || -L $stale ]]; do stale="$MAINTENANCE_LOCK.stale.$$.$RANDOM"; done
    if mv "$MAINTENANCE_LOCK" "$stale" 2>/dev/null; then
      rm -f "$stale/pid"
      rmdir "$stale" 2>/dev/null || die "cannot reclaim stale maintenance lock: $stale"
    fi
  done
  printf '%s\n' "$$" > "$MAINTENANCE_LOCK/pid"
  chmod 0600 "$MAINTENANCE_LOCK/pid"
  MAINTENANCE_LOCK_OWNED=1
  trap 'release_maintenance_lock; rm -rf "${RENDER_DIR:-}"' EXIT
}

[[ -f "$SOURCE_DIR/package.json" ]] || die "source daemon directory is invalid: $SOURCE_DIR"
if (( DRY_RUN )); then
  echo "DRY RUN: deployment plan; no changes will be made."
  echo "plan sync: $SOURCE_DIR -> $CODE_DIR"
  echo "plan build: pnpm install --frozen-lockfile; pnpm build; pnpm prune --prod"
  echo "plan restart: $DAEMON_LABEL, $CONSOLE_LABEL"
  echo "plan health: $HEALTH_URL, $CONSOLE_HEALTH_URL"
  exit 0
fi
if [[ -z $SOURCE_COMMIT ]] && git -C "$SOURCE_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SOURCE_COMMIT=$(git -C "$SOURCE_ROOT" rev-parse HEAD)
fi
if [[ -n $SOURCE_COMMIT ]]; then
  [[ $SOURCE_COMMIT =~ ^[0-9a-fA-F]{40}$ ]] || die "invalid SOURCE_COMMIT"
fi
acquire_maintenance_lock

drift=0
check_artifact() {
  local source=$1 installed=$2 owner_group=$3 mode=$4
  if [[ ! -f $source || -L $installed || ! -f $installed ]] \
    || [[ $(stat -f %Su:%Sg "$installed" 2>/dev/null || true) != "$owner_group" ]] \
    || [[ $(stat -f %Lp "$installed" 2>/dev/null || true) != "${mode#0}" ]] \
    || ! cmp -s "$source" "$installed"; then
    echo "needs-provision: $installed" >&2
    drift=1
  fi
}
RENDER_DIR=$(mktemp -d); trap 'release_maintenance_lock; rm -rf "$RENDER_DIR"' EXIT
render_site_templates "$RENDER_DIR" || die "site templates did not render"
check_artifact "$DAEMON_SITE_ENV" /usr/local/etc/linear-agent-daemon/site.env root:wheel 0644
check_artifact "$MACOS_DIR/daemon-site-lib.sh" /usr/local/sbin/daemon-site-lib.sh root:wheel 0644
check_artifact "$RENDER_DIR/$DAEMON_LABEL.plist" "/Library/LaunchDaemons/$DAEMON_LABEL.plist" root:wheel 0644
check_artifact "$RENDER_DIR/$CONSOLE_LABEL.plist" "/Library/LaunchDaemons/$CONSOLE_LABEL.plist" root:wheel 0644
check_artifact "$RENDER_DIR/$PROXY_LABEL.plist" "/Library/LaunchDaemons/$PROXY_LABEL.plist" root:wheel 0644
if [[ -f $HOME_DIR/.cloudflared/config.yml ]]; then
  check_artifact "$RENDER_DIR/$TUNNEL_LABEL.plist" "/Library/LaunchDaemons/$TUNNEL_LABEL.plist" root:wheel 0644
else
  echo "skip-drift: cloudflared plist pending tunnel config" >&2
fi
# The sudoers policy is 0440 root:wheel — unreadable to the service user, so its
# content cannot be compared here; existence/owner/mode drift is still
# detectable, and content convergence is provision.sh's (root) job.
check_artifact_metadata_only() {
  local installed=$1 owner_group=$2 mode=$3
  if [[ -L $installed || ! -e $installed ]] \
    || [[ $(stat -f %Su:%Sg "$installed" 2>/dev/null || true) != "$owner_group" ]] \
    || [[ $(stat -f %Lp "$installed" 2>/dev/null || true) != "${mode#0}" ]]; then
    echo "needs-provision: $installed" >&2
    drift=1
  fi
}
check_artifact_metadata_only /etc/sudoers.d/linear-agent-daemon-services root:wheel 0440
check_artifact "$MACOS_DIR/run-daemon.sh" /usr/local/sbin/run-daemon.sh root:wheel 0755
check_artifact "$MACOS_DIR/run-console.sh" /usr/local/sbin/run-console.sh root:wheel 0755
check_artifact "$MACOS_DIR/install-console-service.sh" /usr/local/sbin/install-console-service.sh root:wheel 0755
check_artifact "$MACOS_DIR/run-cliproxyapi.sh" /usr/local/sbin/run-cliproxyapi.sh root:wheel 0755
check_artifact "$MACOS_DIR/run-cloudflared.sh" /usr/local/sbin/run-cloudflared.sh root:wheel 0755
check_artifact "$MACOS_DIR/deploy.sh" /usr/local/sbin/deploy.sh root:wheel 0755
check_artifact "$MACOS_DIR/daemonctl" /usr/local/sbin/daemonctl root:wheel 0755
check_artifact "$MACOS_DIR/orchestra-sim" /usr/local/bin/orchestra-sim root:wheel 0755
xcodebuildmcp_wrapper="$RENDER_DIR/xcodebuildmcp"
printf '#!/bin/sh\nexec %s/.pnpm/bin/xcodebuildmcp "$@"\n' "$HOME_DIR" > "$xcodebuildmcp_wrapper"
check_artifact "$xcodebuildmcp_wrapper" /usr/local/bin/xcodebuildmcp root:wheel 0755
check_artifact "$SOURCE_DIR/ops/wait-for-daemon-health.sh" /usr/local/sbin/wait-for-daemon-health.sh root:wheel 0755
check_artifact "$SOURCE_DIR/ops/codex-otel-wrapper.sh" /usr/local/bin/codex root:wheel 0755
check_artifact "$SOURCE_DIR/ops/claudex" "$HOME_DIR/.local/bin/claudex" "$DAEMON_SERVICE_USER:staff" 0750
check_artifact "$SOURCE_DIR/ops/claudex-fable" "$HOME_DIR/.local/bin/claudex-fable" "$DAEMON_SERVICE_USER:staff" 0750
(( drift == 0 )) || exit 78

[[ -d $CODE_DIR ]] || install -d -m 0750 "$CODE_DIR"
[[ -d $STATE_DIR ]] || install -d -m 0700 "$STATE_DIR"
rsync -aO --no-perms --no-owner --no-group --delete \
  --exclude node_modules --exclude dist --exclude '*.db*' --exclude '.env*' \
  "$SOURCE_DIR/" "$CODE_DIR/"
chmod 0755 "$CODE_DIR/ops/proxy-accounts.sh" "$CODE_DIR/ops/codex-provider-gate.sh"
# CI=true: pnpm otherwise refuses to purge a stale modules dir without a TTY
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) — deploys are always headless.
(cd "$CODE_DIR" && CI=true "$PNPM_BIN" install --frozen-lockfile && CI=true "$PNPM_BIN" build && CI=true "$PNPM_BIN" prune --prod)

env_has_key() { grep -Eq "^[[:space:]]*$1=[^[:space:]]+" "$ENV_FILE"; }
env_sessions_enabled() { ! grep -Eq '^[[:space:]]*SESSIONS_ENABLED=0([[:space:]]*(#.*)?)?$' "$ENV_FILE"; }
proxy_has_default_model() {
  local key attempt
  key=$(sed -n 's/^CLIPROXY_API_KEY=//p' "$PROXY_ENV" 2>/dev/null | head -1)
  [[ -n $key ]] || return 1
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    : "$attempt"
    if curl -fsS --connect-timeout 2 --max-time 10 -H "Authorization: Bearer $key" \
      http://127.0.0.1:8317/v1/models 2>/dev/null \
      | python3 -c 'import json,sys; raise SystemExit(0 if any(x.get("id")=="gpt-5.6-sol" for x in json.load(sys.stdin).get("data",[])) else 1)' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

[[ -s $ENV_FILE ]] || { echo "pending-human: populate $ENV_FILE" >&2; exit 3; }
if env_sessions_enabled; then
  missing=""
  for key in TARGET_REPO_PATH LINEAR_API_KEY DO_PERMISSION_MODE DO_MAX_TURNS; do
    env_has_key "$key" || missing="$missing $key"
  done
  [[ -z $missing ]] || { echo "pending-human: add$missing to $ENV_FILE" >&2; exit 3; }
  proxy_has_default_model || { echo "pending-human: authenticate CLIProxyAPI and expose gpt-5.6-sol" >&2; exit 3; }
fi

write_marker() {
  local marker=$1 commit=$2 tmp=${1}.tmp.$$
  printf '%s\n' "$commit" > "$tmp"
  chmod 0600 "$tmp"
  mv "$tmp" "$marker"
}
sudo /bin/launchctl kickstart -k "system/$DAEMON_LABEL"
sudo /bin/launchctl kickstart -k "system/$CONSOLE_LABEL"
if [[ -n $SOURCE_COMMIT ]]; then
  write_marker "$DEPLOYED_COMMIT_FILE" "$SOURCE_COMMIT"
fi
CURL_BIN=curl SLEEP_BIN=sleep bash "$HEALTH_WAITER" "$HEALTH_URL" \
  || die "daemon deployment failed at health acceptance"
CURL_BIN=curl SLEEP_BIN=sleep bash "$HEALTH_WAITER" "$CONSOLE_HEALTH_URL" \
  || die "console deployment failed at health acceptance"

if [[ -n $SOURCE_COMMIT ]]; then
  write_marker "$ACCEPTED_COMMIT_FILE" "$SOURCE_COMMIT"
fi
echo "deployment accepted${SOURCE_COMMIT:+: $SOURCE_COMMIT}"
