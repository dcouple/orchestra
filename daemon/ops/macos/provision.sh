#!/bin/bash
# shellcheck disable=SC2015
set -euo pipefail

usage() {
  cat <<'EOF'
Provision the Linear webhook daemon on an Apple Silicon Mac.

Usage: provision.sh [--dry-run] [source-daemon-dir]

  --dry-run  Inspect managed state without changing files, packages, or services.
EOF
}

DRY_RUN=0
SOURCE_ARG=
while (( $# )); do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    *) [[ -z $SOURCE_ARG ]] || { echo "only one source directory is allowed" >&2; exit 2; }; SOURCE_ARG=$1 ;;
  esac
  shift
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOURCE_DIR=${SOURCE_ARG:-$(cd "$SCRIPT_DIR/../.." && pwd)}
[[ -f $SOURCE_DIR/package.json && -d $SOURCE_DIR/ops ]] || { echo "invalid daemon source: $SOURCE_DIR" >&2; exit 1; }

AGENT=linearagent
AGENT_HOME=/Users/linearagent
CONFIG_DIR=$AGENT_HOME/.config/linear-agent-daemon
OPS_STATE=$AGENT_HOME/.local/state/linear-agent-operations
CHECKOUT=$AGENT_HOME/orchestra-source
CLIPROXY_ENV=$CONFIG_DIR/cliproxyapi.env
CLIPROXY_CONFIG=$CONFIG_DIR/cliproxyapi.yaml
CLIPROXY_MARKER=/usr/local/share/cliproxyapi-version
GH_VERSION=2.76.2
CLIPROXY_VERSION=7.2.93
CLIPROXY_SHA256=3ebffcf346c79925ff393225c2769a509a2297dcc1b8154c49235cb1d80a69ac
PNPM_VERSION=11.8.0
PLAYWRIGHT_MCP_VERSION=0.0.78
CODEX_MIN_VERSION=0.145.0
STATUS_NAMES=()
STATUS_VALUES=()

record() { STATUS_NAMES+=("$1"); STATUS_VALUES+=("$2"); }
fail() { echo "ERROR: $*" >&2; exit 1; }
print_summary() {
  local i
  printf '\n%-30s %s\n' SETTING STATUS
  printf '%-30s %s\n' '------------------------------' '---------------'
  for ((i=0; i<${#STATUS_NAMES[@]}; i++)); do printf '%-30s %s\n' "${STATUS_NAMES[$i]}" "${STATUS_VALUES[$i]}"; done
}
agent() { sudo -u "$AGENT" env HOME="$AGENT_HOME" USER="$AGENT" PATH="/usr/local/bin:$AGENT_HOME/.local/bin:/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin" "$@"; }
install_if_changed() {
  local source=$1 destination=$2 mode=$3 owner=$4 group=$5 readback=${3#0}
  if sudo test -f "$destination" && sudo cmp -s "$source" "$destination" \
    && [[ $(sudo stat -f %Lp "$destination") == "$readback" ]] \
    && [[ $(sudo stat -f %Su:%Sg "$destination") == "$owner:$group" ]]; then return 1; fi
  sudo install -o "$owner" -g "$group" -m "$mode" "$source" "$destination"
  return 0
}
file_correct() {
  sudo test -f "$2" && sudo cmp -s "$1" "$2" \
    && [[ $(sudo stat -f %Lp "$2") == "${3#0}" ]] \
    && [[ $(sudo stat -f %Su:%Sg "$2") == "$4:$5" ]]
}
version_at_least() {
  [[ -n $1 ]] || return 1
  python3 - "$1" "$2" <<'PY'
import re,sys
parts=lambda v: tuple(int(x) for x in re.findall(r"\d+",v)[:3])
raise SystemExit(0 if parts(sys.argv[1]) >= parts(sys.argv[2]) else 1)
PY
}
command_version() { "$1" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true; }
dir_correct() { [[ -d $1 && $(stat -f %Lp "$1") == "${2#0}" && $(stat -f %Su "$1") == "$AGENT" ]]; }

sudo -n true 2>/dev/null || fail "passwordless sudo is required temporarily; see README.md"
[[ $(uname -s) == Darwin ]] || fail "provision.sh must run on macOS"
[[ $(uname -m) == arm64 ]] || fail "provision.sh requires Apple Silicon (arm64)"
command -v git >/dev/null || fail "git from Command Line Tools is required"
[[ -x /opt/homebrew/bin/brew ]] || fail "Homebrew is required; run machines/mac-mini/apply.sh first"
record preflight already-correct

dry_inventory() {
  local status source destination
  id "$AGENT" >/dev/null 2>&1 && record account already-correct || record account would-apply
  for spec in "$AGENT_HOME/worktrees:0750" "$AGENT_HOME/repos:0750" "$AGENT_HOME/artifacts:0750" "$CONFIG_DIR:0700" "$AGENT_HOME/.local/bin:0750" "$AGENT_HOME/.cli-proxy-api:0700" "$OPS_STATE:0700" "$AGENT_HOME/Library/Logs:0750"; do
    dir_correct "${spec%:*}" "${spec#*:}" && status=already-correct || status=would-apply
    record "dir-$(basename "${spec%:*}")" "$status"
  done
  /opt/homebrew/bin/brew list --formula node@22 >/dev/null 2>&1 && record node already-correct || record node would-apply
  [[ -x /usr/local/bin/gh && $(/usr/local/bin/gh --version | head -1) == "gh version $GH_VERSION "* ]] && record gh already-correct || record gh would-apply
  [[ -x /usr/local/bin/pnpm && $(/usr/local/bin/pnpm --version 2>/dev/null) == "$PNPM_VERSION" ]] && record pnpm already-correct || record pnpm would-apply
  [[ -d '/Applications/Google Chrome.app' ]] && record chrome already-correct || record chrome would-apply
  [[ -x /usr/local/bin/cliproxyapi && -f $CLIPROXY_MARKER && $(sudo cat "$CLIPROXY_MARKER") == "$CLIPROXY_VERSION" ]] && record cliproxyapi already-correct || record cliproxyapi would-apply
  [[ -x $AGENT_HOME/.local/bin/claude ]] && record claude-cli already-correct || record claude-cli would-apply
  version_at_least "$(command_version "$AGENT_HOME/.codex-managed/bin/codex")" "$CODEX_MIN_VERSION" && record managed-codex already-correct || record managed-codex would-apply
  [[ -x $AGENT_HOME/.pnpm/playwright-mcp && -f $AGENT_HOME/.pnpm/playwright-mcp-version && $(<"$AGENT_HOME/.pnpm/playwright-mcp-version") == "$PLAYWRIGHT_MCP_VERSION" ]] && record playwright-mcp already-correct || record playwright-mcp would-apply
  [[ -f $CLIPROXY_ENV && -f $CLIPROXY_CONFIG ]] && record proxy-config already-correct || record proxy-config would-apply
  [[ -d $CHECKOUT/.git ]] && record source-checkout already-correct || record source-checkout would-apply
  file_correct "$SCRIPT_DIR/sudoers-linearagent-services" /etc/sudoers.d/linearagent-services 0440 root wheel && record sudoers already-correct || record sudoers would-apply
  for spec in "com.dcouple.linear-agent-daemon.plist:/Library/LaunchDaemons/com.dcouple.linear-agent-daemon.plist:0644" "com.dcouple.cliproxyapi.plist:/Library/LaunchDaemons/com.dcouple.cliproxyapi.plist:0644" "run-daemon.sh:/usr/local/sbin/run-daemon.sh:0755" "run-cliproxyapi.sh:/usr/local/sbin/run-cliproxyapi.sh:0755" "daemonctl:/usr/local/sbin/daemonctl:0755" "deploy.sh:/usr/local/sbin/deploy.sh:0755"; do
    source=$SCRIPT_DIR/${spec%%:*}; destination=${spec#*:}; destination=${destination%:*}
    file_correct "$source" "$destination" "${spec##*:}" root wheel && status=already-correct || status=would-apply
    record "file-$(basename "$destination")" "$status"
  done
  sudo /bin/launchctl print system/com.dcouple.cliproxyapi >/dev/null 2>&1 && record service-cliproxyapi already-correct || record service-cliproxyapi would-apply
  sudo /bin/launchctl print system/com.dcouple.linear-agent-daemon >/dev/null 2>&1 && record service-daemon already-correct || record service-daemon would-apply
  [[ -s $CONFIG_DIR/env ]] && record daemon-deploy already-correct || record daemon-deploy pending-human
  print_summary
}
if (( DRY_RUN )); then echo "DRY RUN: inspecting state; no changes will be made."; dry_inventory; exit 0; fi

if id "$AGENT" >/dev/null 2>&1; then
  [[ $(dscl . -read /Users/$AGENT NFSHomeDirectory | awk '{print $2}') == "$AGENT_HOME" ]] || fail "$AGENT has unexpected home"
  record account already-correct
else
  password=$(openssl rand -hex 16)
  sudo sysadminctl -addUser "$AGENT" -fullName "Linear Agent" -shell /bin/zsh -password "$password" -admin
  unset password
  id "$AGENT" >/dev/null 2>&1 || fail "account creation did not verify"
  record account applied
fi

layout_changed=0
for spec in "$AGENT_HOME/worktrees:0750" "$AGENT_HOME/repos:0750" "$AGENT_HOME/artifacts:0750" "$CONFIG_DIR:0700" "$AGENT_HOME/.local/bin:0750" "$AGENT_HOME/.cli-proxy-api:0700" "$OPS_STATE:0700" "$OPS_STATE/worktrees:0700" "$OPS_STATE/worktree-owners:0700" "$AGENT_HOME/Library/Logs:0750"; do
  path=${spec%:*}; mode=${spec#*:}
  if ! dir_correct "$path" "$mode"; then sudo install -d -o "$AGENT" -g staff -m "$mode" "$path"; layout_changed=1; fi
  dir_correct "$path" "$mode" || fail "layout did not verify: $path"
done
(( layout_changed )) && record layout applied || record layout already-correct

if /opt/homebrew/bin/brew list --formula node@22 >/dev/null 2>&1; then record node already-correct; else /opt/homebrew/bin/brew install node@22; record node applied; fi
[[ $(/opt/homebrew/opt/node@22/bin/node --version) == v22.* ]] || fail "node@22 did not verify"

if [[ -x /usr/local/bin/gh && $(/usr/local/bin/gh --version | head -1) == "gh version $GH_VERSION "* ]]; then record gh already-correct; else
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_macOS_arm64.tar.gz" -o "$tmp/gh.tgz"
  tar -xzf "$tmp/gh.tgz" -C "$tmp"
  sudo install -o root -g wheel -m 0755 "$tmp/gh_${GH_VERSION}_macOS_arm64/bin/gh" /usr/local/bin/gh
  rm -rf "$tmp"; trap - EXIT; record gh applied
fi

pnpm_wrapper=$(mktemp); trap 'rm -f "$pnpm_wrapper"' EXIT
printf '#!/bin/sh\nexec /Users/linearagent/.pnpm/bin/pnpm "$@"\n' > "$pnpm_wrapper"
if [[ ! -x $AGENT_HOME/.pnpm/bin/pnpm || $($AGENT_HOME/.pnpm/bin/pnpm --version 2>/dev/null || true) != "$PNPM_VERSION" ]]; then
  agent env PNPM_VERSION="$PNPM_VERSION" PNPM_HOME="$AGENT_HOME/.pnpm" SHELL=/bin/bash /bin/bash -c 'curl -fsSL https://get.pnpm.io/install.sh | sh -'
fi
if install_if_changed "$pnpm_wrapper" /usr/local/bin/pnpm 0755 root wheel; then record pnpm applied; else record pnpm already-correct; fi
rm -f "$pnpm_wrapper"; trap - EXIT
[[ $(/usr/local/bin/pnpm --version) == "$PNPM_VERSION" ]] || fail "pnpm did not verify"

if [[ -d '/Applications/Google Chrome.app' ]]; then record chrome already-correct; else /opt/homebrew/bin/brew install --cask google-chrome; record chrome applied; fi

if [[ -x /usr/local/bin/cliproxyapi && -f $CLIPROXY_MARKER && $(sudo cat "$CLIPROXY_MARKER") == "$CLIPROXY_VERSION" ]]; then record cliproxyapi already-correct; else
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  archive="CLIProxyAPI_${CLIPROXY_VERSION}_darwin_aarch64.tar.gz"
  curl -fsSL "https://github.com/router-for-me/CLIProxyAPI/releases/download/v$CLIPROXY_VERSION/$archive" -o "$tmp/$archive"
  (cd "$tmp" && printf '%s  %s\n' "$CLIPROXY_SHA256" "$archive" | shasum -a 256 -c -)
  tar -xzf "$tmp/$archive" -C "$tmp"
  sudo install -o root -g wheel -m 0755 "$tmp/cli-proxy-api" /usr/local/bin/cliproxyapi
  sudo mkdir -p /usr/local/share; printf '%s\n' "$CLIPROXY_VERSION" | sudo tee "$CLIPROXY_MARKER" >/dev/null
  sudo chown root:wheel "$CLIPROXY_MARKER"; sudo chmod 0644 "$CLIPROXY_MARKER"
  sudo xattr -d com.apple.quarantine /usr/local/bin/cliproxyapi 2>/dev/null || true
  rm -rf "$tmp"; trap - EXIT; record cliproxyapi applied
fi

if [[ -x $AGENT_HOME/.local/bin/claude ]]; then record claude-cli already-correct; else agent /bin/bash -c 'cd /tmp && curl -fsSL https://claude.ai/install.sh | bash'; record claude-cli applied; fi

codex_version=$(command_version "$AGENT_HOME/.codex-managed/bin/codex")
if version_at_least "$codex_version" "$CODEX_MIN_VERSION"; then record managed-codex already-correct; else
  tmp=$(mktemp -d /tmp/linearagent-codex.XXXXXX); trap 'rm -rf "$tmp"' EXIT
  curl -fsSL https://chatgpt.com/codex/install.sh -o "$tmp/codex-install.sh"
  chmod 0755 "$tmp" "$tmp/codex-install.sh"
  (cd "$tmp" && agent env CODEX_HOME="$AGENT_HOME/.codex" CODEX_INSTALL_DIR="$AGENT_HOME/.codex-managed/bin" CODEX_NON_INTERACTIVE=1 sh "$tmp/codex-install.sh" --release "$CODEX_MIN_VERSION")
  rm -rf "$tmp"; trap - EXIT; record managed-codex applied
fi
python3 - "$AGENT_HOME/.profile" <<'PY'
import re,sys
p=sys.argv[1]
try: old=open(p).read()
except FileNotFoundError: raise SystemExit(0)
new=re.sub(r"\n?# >>> Codex installer >>>.*?# <<< Codex installer <<<\n?","\n",old,flags=re.S)
if new!=old: open(p,"w").write(new)
PY
sudo rm -f "$AGENT_HOME/.local/bin/codex"

if install_if_changed "$SOURCE_DIR/ops/codex-otel-wrapper.sh" /usr/local/bin/codex 0755 root wheel; then record codex-wrapper applied; else record codex-wrapper already-correct; fi

MCP_VERSION=$(/opt/homebrew/opt/node@22/bin/node -p "require('$SOURCE_DIR/package.json').dependencies['@playwright/mcp']")
[[ $MCP_VERSION == "$PLAYWRIGHT_MCP_VERSION" ]] || fail "unexpected @playwright/mcp pin: $MCP_VERSION"
if [[ -x $AGENT_HOME/.pnpm/playwright-mcp && -f $AGENT_HOME/.pnpm/playwright-mcp-version && $(<"$AGENT_HOME/.pnpm/playwright-mcp-version") == "$MCP_VERSION" ]]; then mcp_changed=0; else
  agent env PNPM_HOME="$AGENT_HOME/.pnpm" /usr/local/bin/pnpm add --global "@playwright/mcp@$MCP_VERSION"
  printf '%s\n' "$MCP_VERSION" | sudo -u "$AGENT" tee "$AGENT_HOME/.pnpm/playwright-mcp-version" >/dev/null; mcp_changed=1
fi
mcp_wrapper=$(mktemp); trap 'rm -f "$mcp_wrapper"' EXIT
printf '#!/bin/sh\nexec /Users/linearagent/.pnpm/playwright-mcp "$@"\n' > "$mcp_wrapper"
install_if_changed "$mcp_wrapper" /usr/local/bin/playwright-mcp 0755 root wheel && mcp_changed=1
rm -f "$mcp_wrapper"; trap - EXIT
(( mcp_changed )) && record playwright-mcp applied || record playwright-mcp already-correct

helpers_changed=0
for helper in claudex claudex-fable; do
  if ! cmp -s "$SOURCE_DIR/ops/$helper" "$AGENT_HOME/.local/bin/$helper" 2>/dev/null; then sudo install -o "$AGENT" -g staff -m 0750 "$SOURCE_DIR/ops/$helper" "$AGENT_HOME/.local/bin/$helper"; helpers_changed=1; fi
done
(( helpers_changed )) && record harness-wrappers applied || record harness-wrappers already-correct

settings_tmp=$(mktemp); trap 'rm -f "$settings_tmp"' EXIT
printf '{\n  "sandbox": {\n    "enabled": false\n  }\n}\n' > "$settings_tmp"
sudo install -d -o "$AGENT" -g staff -m 0750 "$AGENT_HOME/.claude"
if ! cmp -s "$settings_tmp" "$AGENT_HOME/.claude/settings.json" 2>/dev/null; then sudo install -o "$AGENT" -g staff -m 0644 "$settings_tmp" "$AGENT_HOME/.claude/settings.json"; record claude-settings applied; else record claude-settings already-correct; fi
rm -f "$settings_tmp"; trap - EXIT

proxy_changed=0
if [[ ! -f $CLIPROXY_ENV ]]; then
  tmp=$(mktemp); printf 'CLIPROXY_API_KEY=%s\nCLIPROXY_MANAGEMENT_KEY=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > "$tmp"
  sudo install -o "$AGENT" -g staff -m 0600 "$tmp" "$CLIPROXY_ENV"; rm -f "$tmp"; proxy_changed=1
fi
api_key=$(sed -n 's/^CLIPROXY_API_KEY=//p' "$CLIPROXY_ENV"); management_key=$(sed -n 's/^CLIPROXY_MANAGEMENT_KEY=//p' "$CLIPROXY_ENV")
[[ $(grep -c '^CLIPROXY_API_KEY=' "$CLIPROXY_ENV") == 1 && $api_key =~ ^[0-9a-f]{48}$ ]] || fail "invalid CLIPROXY_API_KEY"
[[ $(grep -c '^CLIPROXY_MANAGEMENT_KEY=' "$CLIPROXY_ENV") == 1 && $management_key =~ ^[0-9a-f]{48}$ ]] || fail "invalid CLIPROXY_MANAGEMENT_KEY"
proxy_tmp=$(mktemp); trap 'rm -f "$proxy_tmp"' EXIT
sed -e "s|@API_KEY@|$api_key|g" -e "s|@MANAGEMENT_KEY@|$management_key|g" > "$proxy_tmp" <<'EOF'
host: "127.0.0.1"
port: 8317
auth-dir: "/Users/linearagent/.cli-proxy-api"
api-keys:
  - "@API_KEY@"
routing:
  strategy: "round-robin"
  session-affinity: true
  session-affinity-ttl: "168h"
save-cooldown-status: true
remote-management:
  secret-key: "@MANAGEMENT_KEY@"
  allow-remote: false
oauth-model-alias:
  codex:
    - {name: "gpt-5.6-sol", alias: "gpt-5.6-sol-low", fork: true}
    - {name: "gpt-5.6-sol", alias: "gpt-5.6-sol-medium", fork: true}
    - {name: "gpt-5.6-sol", alias: "gpt-5.6-sol-xhigh", fork: true}
payload:
  default:
    - models: [{name: "gpt-5.6-sol", protocol: "codex"}]
      params: {"reasoning.effort": "high"}
  override:
    - models: [{name: "gpt-5.6-sol-low", protocol: "codex"}]
      params: {"reasoning.effort": "low"}
    - models: [{name: "gpt-5.6-sol-medium", protocol: "codex"}]
      params: {"reasoning.effort": "medium"}
    - models: [{name: "gpt-5.6-sol-xhigh", protocol: "codex"}]
      params: {"reasoning.effort": "xhigh"}
EOF
if ! cmp -s "$proxy_tmp" "$CLIPROXY_CONFIG" 2>/dev/null; then sudo install -o "$AGENT" -g staff -m 0600 "$proxy_tmp" "$CLIPROXY_CONFIG"; proxy_changed=1; fi
rm -f "$proxy_tmp"; trap - EXIT
(( proxy_changed )) && record proxy-config applied || record proxy-config already-correct

if [[ ! -e $CONFIG_DIR/env ]]; then sudo install -o "$AGENT" -g staff -m 0600 /dev/null "$CONFIG_DIR/env"; record daemon-env pending-human; elif [[ ! -s $CONFIG_DIR/env ]]; then record daemon-env pending-human; else record daemon-env already-correct; fi

if [[ ! -d $CHECKOUT/.git ]]; then agent git clone https://github.com/dcouple/orchestra.git "$CHECKOUT"; record source-checkout applied
else
  [[ -z $(agent git -C "$CHECKOUT" status --porcelain) ]] || fail "persistent source checkout is dirty: $CHECKOUT"
  [[ $(agent git -C "$CHECKOUT" config --get remote.origin.url) == https://* ]] || fail "persistent checkout origin must use HTTPS"
  record source-checkout already-correct
fi

sudoers_tmp=$(mktemp); trap 'rm -f "$sudoers_tmp"' EXIT
cp "$SCRIPT_DIR/sudoers-linearagent-services" "$sudoers_tmp"
/usr/sbin/visudo -cf "$sudoers_tmp" >/dev/null || fail "sudoers source is invalid"
if install_if_changed "$sudoers_tmp" /etc/sudoers.d/linearagent-services 0440 root wheel; then record sudoers applied; else record sudoers already-correct; fi
sudo /usr/sbin/visudo -cf /etc/sudoers.d/linearagent-services >/dev/null || fail "installed sudoers did not verify"
rm -f "$sudoers_tmp"; trap - EXIT

root_files_changed=0
for spec in "run-daemon.sh:/usr/local/sbin/run-daemon.sh:0755" "run-cliproxyapi.sh:/usr/local/sbin/run-cliproxyapi.sh:0755" "daemonctl:/usr/local/sbin/daemonctl:0755" "deploy.sh:/usr/local/sbin/deploy.sh:0755"; do
  source=$SCRIPT_DIR/${spec%%:*}; destination=${spec#*:}; destination=${destination%:*}
  install_if_changed "$source" "$destination" "${spec##*:}" root wheel && root_files_changed=1
done
install_if_changed "$SOURCE_DIR/ops/wait-for-daemon-health.sh" /usr/local/sbin/wait-for-daemon-health.sh 0755 root wheel && root_files_changed=1
(( root_files_changed )) && record service-scripts applied || record service-scripts already-correct

for label in com.dcouple.cliproxyapi com.dcouple.linear-agent-daemon; do
  plist=$SCRIPT_DIR/$label.plist; installed=/Library/LaunchDaemons/$label.plist; changed=0; plist_changed=0
  install_if_changed "$plist" "$installed" 0644 root wheel && plist_changed=1
  if ! sudo /bin/launchctl print "system/$label" >/dev/null 2>&1; then
    sudo /bin/launchctl bootstrap system "$installed"
    changed=1
  elif (( plist_changed )); then
    sudo /bin/launchctl bootout "system/$label"
    sudo /bin/launchctl bootstrap system "$installed"
    changed=1
  elif (( root_files_changed )); then
    sudo /bin/launchctl kickstart -k "system/$label"
    changed=1
  fi
  sudo /bin/launchctl print "system/$label" >/dev/null 2>&1 || fail "$label did not verify"
  (( changed )) && record "service-$label" applied || record "service-$label" already-correct
done

source_commit=
git -C "$(cd "$SOURCE_DIR/.." && pwd)" rev-parse --is-inside-work-tree >/dev/null 2>&1 && source_commit=$(git -C "$(cd "$SOURCE_DIR/.." && pwd)" rev-parse HEAD)
accepted=$(cat "$OPS_STATE/accepted-commit" 2>/dev/null || true)
code_drift=1
if [[ -d $AGENT_HOME/linear-agent-daemon ]] && [[ -z $(agent rsync -ani --delete --exclude node_modules --exclude dist --exclude '*.db*' --exclude '.env*' "$SOURCE_DIR/" "$AGENT_HOME/linear-agent-daemon/") ]]; then code_drift=0; fi
if [[ -n $source_commit && $accepted == "$source_commit" && $code_drift -eq 0 ]]; then
  record daemon-deploy already-correct
else
  deploy_status=0
  agent env SOURCE_COMMIT="$source_commit" /usr/local/sbin/deploy.sh "$SOURCE_DIR" || deploy_status=$?
  case $deploy_status in 0) record daemon-deploy applied ;; 3) record daemon-deploy pending-human ;; *) fail "daemon deploy failed with status $deploy_status" ;; esac
fi

credential_status=1
management_json=$(curl -fsS --connect-timeout 2 --max-time 10 -H "Authorization: Bearer $management_key" http://127.0.0.1:8317/v0/management/auth-files 2>/dev/null || true)
if [[ -n $management_json ]] && python3 -c 'import json,sys; p=json.load(sys.stdin); xs=p.get("files",p.get("data",[])); raise SystemExit(0 if any(x.get("provider")=="codex" and not x.get("disabled",False) and (x.get("account") or x.get("email")) for x in xs) else 1)' <<<"$management_json"; then credential_status=0; fi
if (( credential_status == 0 )); then
  if agent env CLIPROXY_ENV_FILE="$CLIPROXY_ENV" CLIPROXY_VERSION_MARKER="$CLIPROXY_MARKER" EXPECTED_PROXY_VERSION="$CLIPROXY_VERSION" TARGET_CONFIG="$AGENT_HOME/.codex/config.toml" "$AGENT_HOME/linear-agent-daemon/ops/codex-provider-gate.sh"; then record provider-gate already-correct; else record provider-gate pending-human; fi
else record provider-gate pending-human; fi

print_summary
