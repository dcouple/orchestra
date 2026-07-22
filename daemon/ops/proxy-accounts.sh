#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: proxy-accounts.sh list | add codex|claude [--dry-run]
       proxy-accounts.sh --help
EOF
}

if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  if [[ $# -ne 1 ]]; then usage >&2; exit 2; fi
  usage
  exit 0
fi

PROXY_URL="${PROXY_URL:-http://127.0.0.1:8317}"
CLIPROXY_ENV_FILE="${CLIPROXY_ENV_FILE:-/etc/linear-agent-daemon/cliproxyapi.env}"
CLIPROXY_BIN="${CLIPROXY_BIN:-/usr/local/bin/cliproxyapi}"
CLIPROXY_CONFIG="${CLIPROXY_CONFIG:-/etc/linear-agent-daemon/cliproxyapi.yaml}"

if [[ ! -r "${CLIPROXY_ENV_FILE}" ]]; then
  echo "cannot read CLIProxyAPI environment file: ${CLIPROXY_ENV_FILE}" >&2
  exit 1
fi
CLIPROXY_MANAGEMENT_KEY="$(grep -m1 '^CLIPROXY_MANAGEMENT_KEY=' "${CLIPROXY_ENV_FILE}" | cut -d= -f2- || true)"
if [[ -z "${CLIPROXY_MANAGEMENT_KEY}" ]]; then
  echo "${CLIPROXY_ENV_FILE} is missing CLIPROXY_MANAGEMENT_KEY" >&2
  exit 1
fi

management_get() {
  printf 'header = "Authorization: Bearer %s"\n' "${CLIPROXY_MANAGEMENT_KEY}" \
    | curl -fsS -K - "${PROXY_URL%/}/v0/management/auth-files"
}

list_accounts() {
  management_get | python3 -c '
import json, sys
payload = json.load(sys.stdin)
items = payload.get("files", payload.get("data", payload if isinstance(payload, list) else []))
for item in sorted(items, key=lambda value: (str(value.get("provider", "")), str(value.get("name", "")))):
    safe = {key: item.get(key) for key in ("name", "email", "provider", "disabled", "failed", "recent_requests")}
    print(json.dumps(safe, sort_keys=True, separators=(",", ":")))
'
}

case "${1:-}" in
  list)
    if [[ $# -ne 1 ]]; then usage >&2; exit 2; fi
    list_accounts
    ;;
  add)
    provider="${2:-}"
    if [[ "${provider}" != codex && "${provider}" != claude ]]; then usage >&2; exit 2; fi
    if [[ $# -gt 3 ]]; then usage >&2; exit 2; fi
    dry_run=0
    if [[ "${3:-}" == --dry-run ]]; then dry_run=1; elif [[ $# -eq 3 ]]; then usage >&2; exit 2; fi
    login_flag="--${provider}-login"
    if (( dry_run )); then
      printf 'would run: %q -config %q %q --no-browser\n' \
        "${CLIPROXY_BIN}" "${CLIPROXY_CONFIG}" "${login_flag}"
      list_accounts
      exit 0
    fi
    "${CLIPROXY_BIN}" -config "${CLIPROXY_CONFIG}" "${login_flag}" --no-browser
    sleep 2
    list_accounts
    ;;
  *) usage >&2; exit 2 ;;
esac
