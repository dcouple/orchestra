#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Configure an Apple Silicon Mac as the headless dcouple server.

Usage: apply.sh [--dry-run] [--help]

  --dry-run  Inspect every managed setting and report would-apply/already-correct
             without changing files, packages, settings, or services.
  --help     Show this help.
USAGE
}

DRY_RUN=0
while (( $# > 0 )); do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATUS_NAMES=()
STATUS_VALUES=()

record() {
  STATUS_NAMES+=("$1")
  STATUS_VALUES+=("$2")
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

print_summary() {
  local i
  printf '\n%-28s %s\n' SETTING STATUS
  printf '%-28s %s\n' '----------------------------' '---------------'
  for ((i=0; i<${#STATUS_NAMES[@]}; i++)); do
    printf '%-28s %s\n' "${STATUS_NAMES[$i]}" "${STATUS_VALUES[$i]}"
  done
}

clean_zsh_has_tmux() {
  # The command is evaluated by zsh after it reads the managed system zshenv.
  # shellcheck disable=SC2016
  /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/tmp /bin/zsh -c '[[ $(command -v tmux) == /opt/homebrew/bin/tmux ]]'
}

remote_desktop_ready() {
  local ard_all_users naprivs

  ard_all_users=$(sudo defaults read /Library/Preferences/com.apple.RemoteManagement ARD_AllLocalUsers 2>/dev/null || true)
  if [[ $ard_all_users != 1 ]]; then
    naprivs=$(dscl . -read "/Users/$(id -un)" naprivs 2>/dev/null | awk 'END {print $NF}') || return 1
    [[ $naprivs =~ ^-?[0-9]+$ ]] || return 1
    case $naprivs in
      0|-0|-2147483648) return 1 ;;
    esac
  fi

  pgrep -x ARDAgent >/dev/null 2>&1 && /usr/bin/nc -z localhost 5900 >/dev/null 2>&1
}

dry_run_inventory() {
  local package setting key value power_correct
  printf 'DRY RUN: inspecting state; no changes will be made.\n'

  if xcode-select -p >/dev/null 2>&1; then record command-line-tools already-correct; else record command-line-tools would-apply; fi
  if [[ -x /opt/homebrew/bin/brew ]]; then record homebrew already-correct; else record homebrew would-apply; fi

  for package in tailscale tmux; do
    if [[ -x /opt/homebrew/bin/brew ]] && /opt/homebrew/bin/brew list --formula "$package" >/dev/null 2>&1; then
      record "package-$package" already-correct
    else
      record "package-$package" would-apply
    fi
  done

  if sudo launchctl print system/com.tailscale.tailscaled >/dev/null 2>&1; then
    record tailscaled-system-daemon already-correct
  else
    record tailscaled-system-daemon would-apply
  fi
  if [[ -x /opt/homebrew/bin/tailscale ]] && /opt/homebrew/bin/tailscale status >/dev/null 2>&1; then
    record tailscale-auth already-correct
  else
    record tailscale-auth pending-human
  fi

  if sudo test -f /etc/zshenv &&
     sudo grep -Fqx '# dcouple Homebrew PATH' /etc/zshenv &&
     [[ $(sudo stat -f %Su:%Sg /etc/zshenv) == root:wheel ]] &&
     [[ $(sudo stat -f %Lp /etc/zshenv) == 644 ]] &&
     clean_zsh_has_tmux; then
    record homebrew-shell-path already-correct
  else
    record homebrew-shell-path would-apply
  fi

  if sudo test -f /etc/ssh/sshd_config.d/010-orchestra-hardening.conf &&
     [[ $(sudo cat /etc/ssh/sshd_config.d/010-orchestra-hardening.conf) == $'PasswordAuthentication no\nKbdInteractiveAuthentication no' ]] &&
     [[ $(sudo stat -f %Su:%Sg /etc/ssh/sshd_config.d/010-orchestra-hardening.conf) == root:wheel ]] &&
     [[ $(sudo stat -f %Lp /etc/ssh/sshd_config.d/010-orchestra-hardening.conf) == 644 ]] &&
     [[ $(sudo sshd -T | awk 'tolower($1)=="passwordauthentication" {print $2; exit}') == no ]]; then
    record sshd-hardening already-correct
  else
    record sshd-hardening would-apply
  fi

  if [[ $(sudo fdesetup status 2>/dev/null || true) == *"FileVault is Off"* ]]; then
    record filevault-off already-correct
  else
    record filevault-off manual-action-required
  fi

  power_correct=1
  for setting in sleep:0 disksleep:0 displaysleep:0 standby:0 powernap:0 autorestart:1 womp:1 tcpkeepalive:1; do
    key=${setting%%:*}; value=${setting#*:}
    if ! pmset -g custom | awk -v key="$key" -v value="$value" '$1 == key && $2 == value {found=1} END {exit !found}'; then power_correct=0; fi
  done
  if (( power_correct )); then record power-profile already-correct; else record power-profile would-apply; fi

  if [[ $(sudo defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || true) == 0 ]]; then
    record automatic-update-installs already-correct
  else
    record automatic-update-installs would-apply
  fi

  if [[ $(sudo defaults read /Library/Preferences/.GlobalPreferences com.apple.autologout.AutoLogOutDelay 2>/dev/null || true) == 0 ]] &&
     [[ $(defaults -currentHost read com.apple.screensaver idleTime 2>/dev/null || true) == 0 ]]; then
    record session-settings already-correct
  else
    record session-settings would-apply
  fi

  if remote_desktop_ready; then record remote-desktop already-correct; else record remote-desktop would-apply; fi

  if ! sudo test -f /usr/local/etc/dcouple/heartbeat-sa.json; then
    record heartbeat-key pending-human
  elif [[ $(sudo stat -f %Su:%Sg /usr/local/etc/dcouple/heartbeat-sa.json) == root:wheel ]] &&
       [[ $(sudo stat -f %Lp /usr/local/etc/dcouple/heartbeat-sa.json) == 600 ]] &&
       sudo test -f /usr/local/libexec/dcouple/heartbeat.sh &&
       sudo cmp -s "$SCRIPT_DIR/bin/heartbeat.sh" /usr/local/libexec/dcouple/heartbeat.sh &&
       [[ $(sudo stat -f %Su:%Sg /usr/local/libexec/dcouple/heartbeat.sh) == root:wheel ]] &&
       [[ $(sudo stat -f %Lp /usr/local/libexec/dcouple/heartbeat.sh) == 755 ]] &&
       sudo test -f /Library/LaunchDaemons/com.dcouple.heartbeat.plist &&
       sudo cmp -s "$SCRIPT_DIR/launchd/com.dcouple.heartbeat.plist" /Library/LaunchDaemons/com.dcouple.heartbeat.plist &&
       [[ $(sudo stat -f %Su:%Sg /Library/LaunchDaemons/com.dcouple.heartbeat.plist) == root:wheel ]] &&
       [[ $(sudo stat -f %Lp /Library/LaunchDaemons/com.dcouple.heartbeat.plist) == 644 ]] &&
       sudo launchctl print system/com.dcouple.heartbeat >/dev/null 2>&1; then
    record heartbeat already-correct
  else
    record heartbeat would-apply
  fi

  print_summary
}

install_if_changed() {
  local source=$1 destination=$2 mode=$3 owner=$4
  local readback_mode=${mode#0}
  if sudo test -f "$destination" &&
     sudo cmp -s "$source" "$destination" &&
     [[ $(sudo stat -f %Lp "$destination") == "$readback_mode" ]] &&
     [[ $(sudo stat -f %Su:%Sg "$destination") == "$owner:wheel" ]]; then
    return 1
  fi
  sudo install -o "$owner" -g wheel -m "$mode" "$source" "$destination"
  return 0
}

sudo -n true 2>/dev/null || fail "passwordless sudo is required temporarily; see README.md"
[[ $(uname -s) == Darwin ]] || fail "apply.sh must run on macOS"
[[ $(uname -m) == arm64 ]] || fail "apply.sh requires Apple Silicon (arm64)"
record preflight already-correct

if (( DRY_RUN )); then
  dry_run_inventory
  exit 0
fi

if ! xcode-select -p >/dev/null 2>&1; then
  marker=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  sudo touch "$marker"
  trap 'sudo rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress' EXIT
  clt_label=$(softwareupdate -l 2>&1 | sed -n 's/^\* Label: \(Command Line Tools.*\)$/\1/p' | tail -1)
  [[ -n $clt_label ]] || fail "Command Line Tools update label was not found"
  sudo softwareupdate -i "$clt_label"
  sudo rm -f "$marker"
  trap - EXIT
  xcode-select -p >/dev/null 2>&1 || fail "Command Line Tools installation did not verify"
  record command-line-tools applied
else
  record command-line-tools already-correct
fi

if [[ ! -x /opt/homebrew/bin/brew ]]; then
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [[ -x /opt/homebrew/bin/brew ]] || fail "Homebrew installation did not verify"
  record homebrew applied
else
  record homebrew already-correct
fi

packages_changed=0
for package in tailscale tmux; do
  if ! /opt/homebrew/bin/brew list --formula "$package" >/dev/null 2>&1; then
    /opt/homebrew/bin/brew install "$package"
    packages_changed=1
  fi
  /opt/homebrew/bin/brew list --formula "$package" >/dev/null 2>&1 || fail "$package installation did not verify"
done
if (( packages_changed )); then record packages applied; else record packages already-correct; fi

zshenv_block=$(mktemp)
trap 'rm -f "$zshenv_block"' EXIT
cat >"$zshenv_block" <<'ZSHENV'
# dcouple Homebrew PATH
if [[ ":${PATH}:" != *":/opt/homebrew/bin:"* ]]; then
  export PATH="/opt/homebrew/bin:${PATH}"
fi
ZSHENV
path_changed=0
if ! sudo test -f /etc/zshenv; then
  sudo install -o root -g wheel -m 0644 "$zshenv_block" /etc/zshenv
  path_changed=1
elif ! sudo grep -Fqx '# dcouple Homebrew PATH' /etc/zshenv; then
  printf '\n' | sudo tee -a /etc/zshenv >/dev/null
  sudo /bin/sh -c 'cat "$1" >> /etc/zshenv' sh "$zshenv_block"
  path_changed=1
fi
if [[ $(sudo stat -f %Su:%Sg /etc/zshenv) != root:wheel ]]; then sudo chown root:wheel /etc/zshenv; path_changed=1; fi
if [[ $(sudo stat -f %Lp /etc/zshenv) != 644 ]]; then sudo chmod 0644 /etc/zshenv; path_changed=1; fi
rm -f "$zshenv_block"
trap - EXIT
sudo grep -Fqx '# dcouple Homebrew PATH' /etc/zshenv || fail "/etc/zshenv Homebrew PATH block is missing"
clean_zsh_has_tmux || fail "/etc/zshenv did not expose Homebrew tmux to a clean zsh"
if (( path_changed )); then record homebrew-shell-path applied; else record homebrew-shell-path already-correct; fi

if ! sudo launchctl print system/com.tailscale.tailscaled >/dev/null 2>&1; then
  sudo /opt/homebrew/bin/tailscaled install-system-daemon
  sudo launchctl print system/com.tailscale.tailscaled >/dev/null 2>&1 || fail "tailscaled system daemon did not load"
  record tailscaled-system-daemon applied
else
  record tailscaled-system-daemon already-correct
fi
if ! /opt/homebrew/bin/tailscale status >/dev/null 2>&1; then
  printf '\nHUMAN STEP: authenticate Tailscale using the URL printed below.\n'
  sudo /opt/homebrew/bin/tailscale up || true
  record tailscale-auth pending-human
else
  record tailscale-auth already-correct
fi

sshd_source=$(mktemp)
trap 'rm -f "$sshd_source"' EXIT
cat >"$sshd_source" <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
SSHD
if install_if_changed "$sshd_source" /etc/ssh/sshd_config.d/010-orchestra-hardening.conf 0644 root; then
  sudo sshd -t
  sudo launchctl kickstart -k system/com.openssh.sshd
  record sshd-hardening applied
else
  record sshd-hardening already-correct
fi
rm -f "$sshd_source"
trap - EXIT
[[ $(sudo sshd -T | awk 'tolower($1)=="passwordauthentication" {print $2; exit}') == no ]] || fail "effective PasswordAuthentication is not no"

# FileVault is deliberately off so power-loss and smart-plug boots come all the
# way up unattended (Tailscale, SSH, and the LaunchDaemons need no console
# unlock). apply.sh never toggles it; disable it once via an SSH TTY:
#   ssh -t <host> 'sudo fdesetup disable'
fv_status=$(sudo fdesetup status 2>&1) || fail "fdesetup status failed: $fv_status"
[[ $fv_status == *"FileVault is Off"* ]] || fail "FileVault is enabled; disable it first (sudo fdesetup disable) so unattended boots do not strand at the unlock prompt"
record filevault-off already-correct

pmset_changed=0
for setting in sleep:0 disksleep:0 displaysleep:0 standby:0 powernap:0 autorestart:1 womp:1 tcpkeepalive:1; do
  key=${setting%%:*}
  value=${setting#*:}
  if ! pmset -g custom | awk -v key="$key" -v value="$value" '$1 == key && $2 == value {found=1} END {exit !found}'; then
    pmset_changed=1
    break
  fi
done
if (( pmset_changed )); then
  sudo pmset -a sleep 0 disksleep 0 displaysleep 0 standby 0 powernap 0 autorestart 1 womp 1 tcpkeepalive 1
  record power-profile applied
else
  record power-profile already-correct
fi
for setting in sleep:0 disksleep:0 displaysleep:0 standby:0 powernap:0 autorestart:1 womp:1 tcpkeepalive:1; do
  key=${setting%%:*}; value=${setting#*:}
  pmset -g custom | awk -v key="$key" -v value="$value" '$1 == key && $2 == value {found=1} END {exit !found}' || fail "pmset $key did not verify as $value"
done

automatic_updates_changed=0
if [[ $(sudo defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || true) != 0 ]]; then
  sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
  automatic_updates_changed=1
fi
[[ $(sudo defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates) == 0 ]] || fail "automatic macOS update installs were not disabled"
if (( automatic_updates_changed )); then record automatic-update-installs applied; else record automatic-update-installs already-correct; fi

session_changed=0
if [[ $(sudo defaults read /Library/Preferences/.GlobalPreferences com.apple.autologout.AutoLogOutDelay 2>/dev/null || true) != 0 ]]; then
  sudo defaults write /Library/Preferences/.GlobalPreferences com.apple.autologout.AutoLogOutDelay -int 0
  session_changed=1
fi
if [[ $(defaults -currentHost read com.apple.screensaver idleTime 2>/dev/null || true) != 0 ]]; then
  defaults -currentHost write com.apple.screensaver idleTime -int 0
  session_changed=1
fi
[[ $(sudo defaults read /Library/Preferences/.GlobalPreferences com.apple.autologout.AutoLogOutDelay) == 0 ]] || fail "auto-logout setting did not verify"
[[ $(defaults -currentHost read com.apple.screensaver idleTime) == 0 ]] || fail "screensaver setting did not verify"
if (( session_changed )); then record session-settings applied; else record session-settings already-correct; fi

if remote_desktop_ready; then
  record remote-desktop already-correct
else
  remote_management_kickstart=/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart
  if sudo "$remote_management_kickstart" -activate -configure -access -on \
       -users "$(id -un)" -privs -all -restart -agent >/dev/null 2>&1 &&
     remote_desktop_ready; then
    record remote-desktop applied
  else
    printf '\nHUMAN STEP: enable Remote Management using docs/click-list.md.\n'
    record remote-desktop pending-human
  fi
fi

heartbeat_key=/usr/local/etc/dcouple/heartbeat-sa.json
if ! sudo test -f "$heartbeat_key"; then
  printf '\nPENDING: heartbeat key is absent; run gcp/setup-monitoring.sh first, then re-run apply.sh.\n'
  record heartbeat pending-human
else
  key_changed=0
  if [[ $(sudo stat -f %Lp "$heartbeat_key") != 600 ]]; then
    sudo chmod 0600 "$heartbeat_key"
    key_changed=1
  fi
  if [[ $(sudo stat -f %Su:%Sg "$heartbeat_key") != root:wheel ]]; then
    sudo chown root:wheel "$heartbeat_key"
    key_changed=1
  fi
  sudo mkdir -p /usr/local/libexec/dcouple
  heartbeat_changed=$key_changed
  if install_if_changed "$SCRIPT_DIR/bin/heartbeat.sh" /usr/local/libexec/dcouple/heartbeat.sh 0755 root; then heartbeat_changed=1; fi
  if install_if_changed "$SCRIPT_DIR/launchd/com.dcouple.heartbeat.plist" /Library/LaunchDaemons/com.dcouple.heartbeat.plist 0644 root; then heartbeat_changed=1; fi
  if ! sudo launchctl print system/com.dcouple.heartbeat >/dev/null 2>&1; then
    sudo launchctl bootstrap system /Library/LaunchDaemons/com.dcouple.heartbeat.plist
    heartbeat_changed=1
  elif (( heartbeat_changed )); then
    sudo launchctl kickstart -k system/com.dcouple.heartbeat
  fi
  sudo launchctl print system/com.dcouple.heartbeat >/dev/null 2>&1 || fail "heartbeat LaunchDaemon did not verify"
  if (( heartbeat_changed )); then record heartbeat applied; else record heartbeat already-correct; fi
fi

print_summary
