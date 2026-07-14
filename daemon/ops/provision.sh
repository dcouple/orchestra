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
apt-get install -y ca-certificates curl git gnupg rsync sqlite3 ufw

if ! command -v node >/dev/null || [[ "$(node --version)" != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
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
install -d -o linear-daemon -g linear-daemon -m 0750 /var/lib/linear-agent-daemon/worktrees /var/lib/linear-agent-daemon/repos
install -d -o root -g linear-daemon -m 0750 /etc/linear-agent-daemon
if [[ ! -f /etc/linear-agent-daemon/env ]]; then
  install -o linear-daemon -g linear-daemon -m 0600 /dev/null /etc/linear-agent-daemon/env
  echo "created /etc/linear-agent-daemon/env; populate it before starting the service" >&2
fi

if [[ ! -x /var/lib/linear-agent-daemon/.local/bin/claude ]]; then
  runuser -u linear-daemon -- env HOME=/var/lib/linear-agent-daemon bash -c \
    'curl -fsSL https://claude.ai/install.sh | bash'
fi

if ! command -v pnpm >/dev/null || [[ "$(pnpm --version)" != 11.* ]]; then
  install -d -m 0755 /opt/pnpm
  curl -fsSL https://get.pnpm.io/install.sh \
    | env PNPM_VERSION=11.8.0 PNPM_HOME=/opt/pnpm SHELL=/bin/bash sh -
  ln -sfn /opt/pnpm/pnpm /usr/local/bin/pnpm
fi

rsync -a --delete \
  --exclude node_modules --exclude dist --exclude '*.db*' --exclude '.env*' \
  "${SOURCE_DIR}/" /opt/linear-agent-daemon/
chown -R linear-daemon:linear-daemon /opt/linear-agent-daemon
runuser -u linear-daemon -- bash -c 'cd /opt/linear-agent-daemon && pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod'

install -o root -g root -m 0644 "${SOURCE_DIR}/ops/linear-agent-daemon.service" /etc/systemd/system/linear-agent-daemon.service
cat > /etc/caddy/Caddyfile <<EOF
${DAEMON_HOST} {
  request_body {
    max_size 1MB
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
systemctl enable caddy linear-agent-daemon
systemctl restart caddy
env_has_key() {
  local key="$1"
  grep -Eq "^[[:space:]]*${key}=[^[:space:]]+" /etc/linear-agent-daemon/env
}
env_sessions_enabled() {
  ! grep -Eq '^[[:space:]]*SESSIONS_ENABLED=0([[:space:]]*(#.*)?)?$' /etc/linear-agent-daemon/env
}
env_ready_for_restart() {
  if [[ ! -s /etc/linear-agent-daemon/env ]]; then
    echo "service enabled but not started: populate /etc/linear-agent-daemon/env, then systemctl restart linear-agent-daemon" >&2
    return 1
  fi
  if env_sessions_enabled; then
    local missing=()
    for key in TARGET_REPO_PATH LINEAR_API_KEY; do
      if ! env_has_key "$key"; then missing+=("$key"); fi
    done
    if (( ${#missing[@]} )); then
      echo "service enabled but not restarted: SESSIONS_ENABLED=1 requires ${missing[*]} in /etc/linear-agent-daemon/env" >&2
      return 1
    fi
  fi
  return 0
}
if env_ready_for_restart; then
  systemctl restart linear-agent-daemon
fi
