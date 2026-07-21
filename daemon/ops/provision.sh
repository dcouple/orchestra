#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root: sudo DAEMON_HOST=agent.example.com $0 [daemon-source-dir]" >&2
  exit 1
fi

SOURCE_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
: "${DAEMON_HOST:?set DAEMON_HOST to the public DNS name}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  build-essential ca-certificates curl git gnupg libatomic1 openssl pkg-config python3 \
  rsync sqlite3 ufw \
  libcairo2 libdrm2 libgbm1 libnss3 libpango-1.0-0 libxcomposite1 \
  libxdamage1 libxfixes3 libxkbcommon0 libxrandr2

# Keep scripts-suppressed installs usable with native modules and headless browsers.
install_apt_release_variant() {
  local t64_package="$1"
  local legacy_package="$2"
  if apt-cache show "${t64_package}" >/dev/null 2>&1; then
    apt-get install -y "${t64_package}"
  else
    apt-get install -y "${legacy_package}"
  fi
}
install_apt_release_variant libasound2t64 libasound2
install_apt_release_variant libatk1.0-0t64 libatk1.0-0
install_apt_release_variant libatk-bridge2.0-0t64 libatk-bridge2.0-0
install_apt_release_variant libcups2t64 libcups2
install_apt_release_variant libatspi2.0-0t64 libatspi2.0-0

GH_VERSION="2.76.2"
ARCH="$(dpkg --print-architecture)"
case "${ARCH}" in amd64) GH_ARCH="amd64" ;; arm64) GH_ARCH="arm64" ;; *) echo "unsupported gh architecture: ${ARCH}" >&2; exit 1 ;; esac
if ! command -v gh >/dev/null || [[ "$(gh --version | head -1)" != "gh version ${GH_VERSION} "* ]]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" -o "${tmp}/gh.tgz"
  tar -xzf "${tmp}/gh.tgz" -C "${tmp}"
  install -m 0755 "${tmp}/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/gh
  rm -rf "${tmp}"; trap - EXIT
fi

CLIPROXY_VERSION="7.2.93"
case "${ARCH}" in
  amd64)
    CLIPROXY_ARCH="amd64"
    CLIPROXY_SHA256="3ca18073c87a7d21391dcc437558c37ee9b98ce1eb1cd2c013e064a236664322"
    ;;
  arm64)
    CLIPROXY_ARCH="aarch64"
    CLIPROXY_SHA256="fc9d27799c97950614e98f191c3a6fea5c1b61bd390c44d2977090678b1c5794"
    ;;
  *) echo "unsupported CLIProxyAPI architecture: ${ARCH}" >&2; exit 1 ;;
esac
CLIPROXY_MARKER="/usr/local/share/cliproxyapi-version"
if [[ ! -x /usr/local/bin/cliproxyapi ]] || [[ ! -f "${CLIPROXY_MARKER}" ]] \
    || [[ "$(<"${CLIPROXY_MARKER}")" != "${CLIPROXY_VERSION}" ]]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
  archive="CLIProxyAPI_${CLIPROXY_VERSION}_linux_${CLIPROXY_ARCH}.tar.gz"
  curl -fsSL "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXY_VERSION}/${archive}" \
    -o "${tmp}/${archive}"
  printf '%s  %s\n' "${CLIPROXY_SHA256}" "${tmp}/${archive}" | sha256sum -c -
  tar -xzf "${tmp}/${archive}" -C "${tmp}"
  install -m 0755 "${tmp}/cli-proxy-api" /usr/local/bin/cliproxyapi
  install -d -m 0755 "$(dirname "${CLIPROXY_MARKER}")"
  printf '%s\n' "${CLIPROXY_VERSION}" > "${CLIPROXY_MARKER}"
  rm -rf "${tmp}"; trap - EXIT
fi

if ! command -v node >/dev/null || [[ "$(node --version)" != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Headless rasterizer for agent sessions (screenshot HTML mock-ups before
# attaching to Linear): google-chrome --headless=new --no-sandbox --screenshot=…
if ! command -v google-chrome >/dev/null; then
  tmp="$(mktemp -d)"
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "${tmp}/chrome.deb"
  apt-get install -y "${tmp}/chrome.deb"
  rm -rf "${tmp}"
fi

if ! command -v caddy >/dev/null; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

if ! id linear-daemon >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/linear-agent-daemon --create-home --shell /usr/sbin/nologin linear-daemon
fi
install -d -o linear-daemon -g linear-daemon -m 0750 /opt/linear-agent-daemon /var/lib/linear-agent-daemon
install -d -o linear-daemon -g linear-daemon -m 0750 /var/lib/linear-agent-daemon/worktrees /var/lib/linear-agent-daemon/repos /var/lib/linear-agent-daemon/artifacts
install -d -o root -g linear-daemon -m 0750 /etc/linear-agent-daemon
if [[ ! -f /etc/linear-agent-daemon/env ]]; then
  install -o linear-daemon -g linear-daemon -m 0600 /dev/null /etc/linear-agent-daemon/env
  echo "created /etc/linear-agent-daemon/env; populate it before starting the service (see README.md Environment; optional ARTIFACT_TOKEN enables artifact hosting)" >&2
fi

if [[ ! -x /var/lib/linear-agent-daemon/.local/bin/claude ]]; then
  runuser -u linear-daemon -- env HOME=/var/lib/linear-agent-daemon bash -c \
    'curl -fsSL https://claude.ai/install.sh | bash'
fi

install -d -o linear-daemon -g linear-daemon -m 0700 \
  /var/lib/linear-agent-daemon/.cli-proxy-api \
  /var/lib/linear-agent-daemon/.local/bin
CLIPROXY_ENV="/etc/linear-agent-daemon/cliproxyapi.env"
if [[ ! -f "${CLIPROXY_ENV}" ]]; then
  install -o root -g linear-daemon -m 0640 /dev/null "${CLIPROXY_ENV}"
  printf 'CLIPROXY_API_KEY=%s\nCLIPROXY_MANAGEMENT_KEY=%s\n' \
    "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > "${CLIPROXY_ENV}"
elif ! grep -q '^CLIPROXY_MANAGEMENT_KEY=' "${CLIPROXY_ENV}"; then
  printf 'CLIPROXY_MANAGEMENT_KEY=%s\n' "$(openssl rand -hex 24)" >> "${CLIPROXY_ENV}"
fi
chown root:linear-daemon "${CLIPROXY_ENV}"
chmod 0640 "${CLIPROXY_ENV}"
CLIPROXY_API_KEY="$(grep -E '^CLIPROXY_API_KEY=[0-9a-f]{48}$' "${CLIPROXY_ENV}" | cut -d= -f2- || true)"
if [[ "$(grep -c '^CLIPROXY_API_KEY=' "${CLIPROXY_ENV}" || true)" -ne 1 ]] \
    || [[ ! "${CLIPROXY_API_KEY}" =~ ^[0-9a-f]{48}$ ]]; then
  echo "${CLIPROXY_ENV} must contain one CLIPROXY_API_KEY=<48 lowercase hex characters> entry" >&2
  exit 1
fi
CLIPROXY_MANAGEMENT_KEY="$(grep -E '^CLIPROXY_MANAGEMENT_KEY=[0-9a-f]{48}$' "${CLIPROXY_ENV}" | cut -d= -f2- || true)"
if [[ "$(grep -c '^CLIPROXY_MANAGEMENT_KEY=' "${CLIPROXY_ENV}" || true)" -ne 1 ]] \
    || [[ ! "${CLIPROXY_MANAGEMENT_KEY}" =~ ^[0-9a-f]{48}$ ]]; then
  echo "${CLIPROXY_ENV} must contain one CLIPROXY_MANAGEMENT_KEY=<48 lowercase hex characters> entry" >&2
  exit 1
fi
cat > /etc/linear-agent-daemon/cliproxyapi.yaml <<EOF
host: "127.0.0.1"
port: 8317
auth-dir: "/var/lib/linear-agent-daemon/.cli-proxy-api"
api-keys:
  - "${CLIPROXY_API_KEY}"
routing:
  strategy: "round-robin"
  session-affinity: true
  session-affinity-ttl: "168h"
save-cooldown-status: true
remote-management:
  secret-key: "${CLIPROXY_MANAGEMENT_KEY}"
  allow-remote: false
oauth-model-alias:
  codex:
    - name: "gpt-5.6-sol"
      alias: "gpt-5.6-sol-low"
      fork: true
    - name: "gpt-5.6-sol"
      alias: "gpt-5.6-sol-medium"
      fork: true
    - name: "gpt-5.6-sol"
      alias: "gpt-5.6-sol-xhigh"
      fork: true
payload:
  default:
    - models:
        - name: "gpt-5.6-sol"
          protocol: "codex"
      params:
        "reasoning.effort": "high"
  override:
    - models:
        - name: "gpt-5.6-sol-low"
          protocol: "codex"
      params:
        "reasoning.effort": "low"
    - models:
        - name: "gpt-5.6-sol-medium"
          protocol: "codex"
      params:
        "reasoning.effort": "medium"
    - models:
        - name: "gpt-5.6-sol-xhigh"
          protocol: "codex"
      params:
        "reasoning.effort": "xhigh"
EOF
chown root:linear-daemon /etc/linear-agent-daemon/cliproxyapi.yaml
chmod 0640 /etc/linear-agent-daemon/cliproxyapi.yaml

install -o linear-daemon -g linear-daemon -m 0750 "${SOURCE_DIR}/ops/claudex" \
  /var/lib/linear-agent-daemon/.local/bin/claudex

# The VM is single-purpose isolation; Claude Code's Bash sandbox (whose seccomp
# filter kills Chrome with SIGSYS) is disabled so sessions behave like a local
# developer machine and can run headless Chrome, etc.
if [[ ! -f /var/lib/linear-agent-daemon/.claude/settings.json ]]; then
  install -d -o linear-daemon -g linear-daemon -m 0750 /var/lib/linear-agent-daemon/.claude
  install -o linear-daemon -g linear-daemon -m 0644 /dev/null /var/lib/linear-agent-daemon/.claude/settings.json
  cat > /var/lib/linear-agent-daemon/.claude/settings.json <<'EOF'
{
  "sandbox": {
    "enabled": false
  }
}
EOF
fi

if ! command -v pnpm >/dev/null || [[ "$(pnpm --version)" != 11.* ]]; then
  install -d -m 0755 /opt/pnpm
  curl -fsSL https://get.pnpm.io/install.sh \
    | env PNPM_VERSION=11.8.0 PNPM_HOME=/opt/pnpm SHELL=/bin/bash sh -
  # pnpm's launcher resolves its real binary relative to $0, so a symlink
  # breaks it — wrap instead. The installer places it under $PNPM_HOME/bin.
  printf '#!/bin/sh\nexec /opt/pnpm/bin/pnpm "$@"\n' > /usr/local/bin/pnpm
  chmod 0755 /usr/local/bin/pnpm
fi

CODEX_VERSION="0.144.5"
if ! command -v codex >/dev/null || [[ "$(codex --version)" != *"${CODEX_VERSION}"* ]]; then
  env PNPM_HOME=/opt/pnpm PATH="/opt/pnpm/bin:${PATH}" \
    pnpm add --global "@openai/codex@${CODEX_VERSION}"
  printf '#!/bin/sh\nexec /opt/pnpm/bin/codex "$@"\n' > /usr/local/bin/codex
  chmod 0755 /usr/local/bin/codex
fi

if [[ "${INSTALL_ANDROID:-0}" == "1" ]]; then
  ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-35}"
  ANDROID_AVD_NAME="${ANDROID_AVD_NAME:-linear-smoke}"
  ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
  ANDROID_CMDLINE_TOOLS_VERSION="${ANDROID_CMDLINE_TOOLS_VERSION:-11076708}"
  ANDROID_SYSTEM_IMAGE="system-images;android-${ANDROID_API_LEVEL};google_apis;x86_64"
  apt-get install -y unzip libgl1 libpulse0 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6
  install -d -o linear-daemon -g linear-daemon -m 0755 "${ANDROID_SDK_ROOT}"
  if [[ ! -x "${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager" ]]; then
    tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
    curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip" -o "${tmp}/cmdline-tools.zip"
    unzip -q "${tmp}/cmdline-tools.zip" -d "${tmp}"
    install -d -o linear-daemon -g linear-daemon -m 0755 "${ANDROID_SDK_ROOT}/cmdline-tools/latest"
    rsync -a "${tmp}/cmdline-tools/" "${ANDROID_SDK_ROOT}/cmdline-tools/latest/"
    chown -R linear-daemon:linear-daemon "${ANDROID_SDK_ROOT}/cmdline-tools"
    rm -rf "${tmp}"; trap - EXIT
  fi
  runuser -u linear-daemon -- env ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT}" ANDROID_HOME="${ANDROID_SDK_ROOT}" \
    bash -c "yes | '${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager' --licenses >/dev/null"
  runuser -u linear-daemon -- env ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT}" ANDROID_HOME="${ANDROID_SDK_ROOT}" \
    "${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager" \
      "platform-tools" "emulator" "platforms;android-${ANDROID_API_LEVEL}" "${ANDROID_SYSTEM_IMAGE}"
  if runuser -u linear-daemon -- env ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT}" ANDROID_HOME="${ANDROID_SDK_ROOT}" \
      "${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/avdmanager" list avd | grep -q "Name: ${ANDROID_AVD_NAME}$"; then
    runuser -u linear-daemon -- env ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT}" ANDROID_HOME="${ANDROID_SDK_ROOT}" \
      "${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/avdmanager" delete avd -n "${ANDROID_AVD_NAME}" >/dev/null || true
  fi
  runuser -u linear-daemon -- env ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT}" ANDROID_HOME="${ANDROID_SDK_ROOT}" \
    bash -c "printf 'no\n' | '${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/avdmanager' create avd -n '${ANDROID_AVD_NAME}' -k '${ANDROID_SYSTEM_IMAGE}' --force"
  if [[ -e /dev/kvm ]]; then
    if getent group kvm >/dev/null; then usermod -aG kvm linear-daemon; fi
    echo "Android AVD ${ANDROID_AVD_NAME} installed with KVM device present" >&2
  else
    echo "Android AVD ${ANDROID_AVD_NAME} installed; /dev/kvm missing, smoke script will use -no-accel" >&2
  fi
fi

rsync -a --delete \
  --exclude node_modules --exclude dist --exclude '*.db*' --exclude '.env*' \
  "${SOURCE_DIR}/" /opt/linear-agent-daemon/
chown -R linear-daemon:linear-daemon /opt/linear-agent-daemon
chmod 0755 /opt/linear-agent-daemon/ops/proxy-accounts.sh /opt/linear-agent-daemon/ops/codex-provider-gate.sh
runuser -u linear-daemon -- bash -c 'cd /opt/linear-agent-daemon && pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod'

install -o root -g root -m 0644 "${SOURCE_DIR}/ops/cliproxyapi.service" /etc/systemd/system/cliproxyapi.service
install -o root -g root -m 0644 "${SOURCE_DIR}/ops/linear-agent-daemon.service" /etc/systemd/system/linear-agent-daemon.service
cat > /etc/caddy/Caddyfile <<EOF
${DAEMON_HOST} {
  request_body {
    max_size 32MB
  }
  reverse_proxy 127.0.0.1:8787
}
EOF
caddy validate --config /etc/caddy/Caddyfile

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 443/tcp
ufw --force enable

systemctl daemon-reload
systemctl enable caddy cliproxyapi linear-agent-daemon
systemctl restart caddy cliproxyapi
GATE_TARGET_CONFIG=/var/lib/linear-agent-daemon/.codex/config.toml
cliproxy_has_enabled_codex_credential() {
  local _attempt management_json
  for _attempt in {1..10}; do
    if management_json="$(printf 'header = "Authorization: Bearer %s"\n' "${CLIPROXY_MANAGEMENT_KEY}" \
        | curl -fsS --connect-timeout 2 --max-time 10 -K - \
          http://127.0.0.1:8317/v0/management/auth-files 2>/dev/null)"; then
      python3 -c 'import json, sys; payload = json.load(sys.stdin); files = payload.get("files", payload.get("data", [])); raise SystemExit(0 if any(item.get("provider") == "codex" and not item.get("disabled", False) and (item.get("account") or item.get("email")) for item in files) else 1)' \
        <<<"${management_json}"
      return $?
    fi
    sleep 1
  done
  return 2
}
GATE_CREDENTIAL_STATUS=0
cliproxy_has_enabled_codex_credential || GATE_CREDENTIAL_STATUS=$?
if [[ "${GATE_CREDENTIAL_STATUS}" -eq 0 ]]; then
  if ! runuser -u linear-daemon -- env \
      HOME=/var/lib/linear-agent-daemon \
      CLIPROXY_ENV_FILE="${CLIPROXY_ENV}" \
      CLIPROXY_VERSION_MARKER="${CLIPROXY_MARKER}" \
      EXPECTED_PROXY_VERSION="${CLIPROXY_VERSION}" \
      TARGET_CONFIG="${GATE_TARGET_CONFIG}" \
      /opt/linear-agent-daemon/ops/codex-provider-gate.sh; then
    echo "standalone Codex provider gate failed; direct authentication remains selected" >&2
  fi
else
  if [[ -f "${GATE_TARGET_CONFIG}" ]] \
      && head -n 1 "${GATE_TARGET_CONFIG}" | grep -Fqx '# managed by codex-provider-gate.sh — removed on gate failure'; then
    rm -f "${GATE_TARGET_CONFIG}"
  fi
  if [[ "${GATE_CREDENTIAL_STATUS}" -eq 1 ]]; then
    echo "standalone Codex provider gate skipped: no enabled Codex OAuth credentials; direct authentication remains selected" >&2
  else
    echo "standalone Codex provider gate skipped: management API unavailable; direct authentication remains selected" >&2
  fi
fi
env_has_key() {
  local key="$1"
  grep -Eq "^[[:space:]]*${key}=[^[:space:]]+" /etc/linear-agent-daemon/env
}
env_sessions_enabled() {
  ! grep -Eq '^[[:space:]]*SESSIONS_ENABLED=0([[:space:]]*(#.*)?)?$' /etc/linear-agent-daemon/env
}
cliproxy_has_default_model() {
  local _attempt
  for _attempt in {1..10}; do
    if printf 'header = "Authorization: Bearer %s"\n' "${CLIPROXY_API_KEY}" \
        | curl -fs --connect-timeout 2 --max-time 10 -K - http://127.0.0.1:8317/v1/models \
        | python3 -c 'import json, sys; data = json.load(sys.stdin).get("data", []); raise SystemExit(0 if any(model.get("id") == "gpt-5.6-sol" for model in data) else 1)' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
env_ready_for_restart() {
  if [[ ! -s /etc/linear-agent-daemon/env ]]; then
    echo "service enabled but not started: populate /etc/linear-agent-daemon/env, then systemctl restart linear-agent-daemon" >&2
    return 1
  fi
  if env_sessions_enabled; then
    local missing=()
    for key in TARGET_REPO_PATH LINEAR_API_KEY DO_PERMISSION_MODE DO_MAX_TURNS; do
      if ! env_has_key "$key"; then missing+=("$key"); fi
    done
    if (( ${#missing[@]} )); then
      echo "service enabled but not restarted: SESSIONS_ENABLED=1 requires ${missing[*]} in /etc/linear-agent-daemon/env" >&2
      return 1
    fi
    if ! systemctl is-active --quiet cliproxyapi || ! cliproxy_has_default_model; then
      echo "service enabled but not started: authenticate CLIProxyAPI as linear-daemon and verify gpt-5.6-sol, then systemctl restart linear-agent-daemon" >&2
      return 1
    fi
  fi
  return 0
}
if env_ready_for_restart; then
  systemctl restart linear-agent-daemon
fi
