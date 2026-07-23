#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: proxy-accounts.sh list | add codex|claude [--dry-run]
       proxy-accounts.sh remove SELECTOR [--yes] [--dry-run]
       proxy-accounts.sh reauth codex|claude SELECTOR [--dry-run]
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
SLEEP_BIN="${SLEEP_BIN:-sleep}"
CURL="${CURL:-curl}"

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
    | "${CURL}" -fsS -K - "${PROXY_URL%/}/v0/management/auth-files"
}

list_accounts() {
  management_get | python3 -c '
import json, sys
payload = json.load(sys.stdin)
items = payload.get("files", payload.get("data", payload if isinstance(payload, list) else []))
for item in sorted(items, key=lambda value: (str(value.get("provider", "")), str(value.get("name", "")))):
    safe = {key: item.get(key) for key in ("name", "email", "provider", "disabled", "failed", "recent_requests")}
    safe["selector"] = item.get("name")
    safe["eligible"] = not bool(item.get("disabled", False))
    safe["status"] = "ineligible; run reauth" if item.get("disabled", False) else ("attention required" if item.get("failed", False) else "ready")
    print(json.dumps(safe, sort_keys=True, separators=(",", ":")))
'
}

validate_selector() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._@+-]{0,254}$ ]] || { echo "invalid account selector" >&2; exit 2; }
}

set_eligibility() {
  local selector="$1" disabled="$2"
  python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1],"disabled":sys.argv[2]=="true"},separators=(",",":")))' \
      "${selector}" "${disabled}" \
    | "${CURL}" -fsS -X PATCH -H 'content-type: application/json' \
        -K <(printf 'header = "Authorization: Bearer %s"\n' "${CLIPROXY_MANAGEMENT_KEY}") \
        --data-binary @- "${PROXY_URL%/}/v0/management/auth-files/status" >/dev/null
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
    "${SLEEP_BIN}" 2
    list_accounts
    ;;
  remove)
    selector="${2:-}"; validate_selector "${selector}"
    yes=0; dry_run=0
    shift 2
    while (( $# )); do case "$1" in --yes) yes=1 ;; --dry-run) dry_run=1 ;; *) usage >&2; exit 2 ;; esac; shift; done
    if (( dry_run )); then printf 'would mark subscription %s ineligible; credential file retained\n' "${selector}"; exit 0; fi
    if (( ! yes )); then
      if [[ "${DAEMONCTL_ALLOW_NON_ROOT:-0}" == 1 && -n "${PROXY_ACCOUNTS_CONFIRM_RESPONSE:-}" ]]; then
        answer="${PROXY_ACCOUNTS_CONFIRM_RESPONSE}"
      else
        [[ -t 0 ]] || { echo "confirmation requires a TTY or --yes" >&2; exit 1; }
        read -r -p "Remove ${selector} from routing eligibility (credential retained)? [y/N] " answer
      fi
      [[ "${answer}" == y || "${answer}" == Y ]] || { echo "unchanged"; exit 0; }
    fi
    set_eligibility "${selector}" true
    printf 'subscription %s is ineligible; credential file retained\n' "${selector}"
    list_accounts
    ;;
  reauth)
    provider="${2:-}"; selector="${3:-}"
    if [[ "${provider}" != codex && "${provider}" != claude ]]; then usage >&2; exit 2; fi
    validate_selector "${selector}"
    if [[ $# -gt 4 || ( $# -eq 4 && "${4}" != --dry-run ) ]]; then usage >&2; exit 2; fi
    if [[ "${4:-}" == --dry-run ]]; then
      printf 'would reauthenticate provider %s and restore selector %s to routing eligibility\n' "${provider}" "${selector}"
      exit 0
    fi
    "${CLIPROXY_BIN}" -config "${CLIPROXY_CONFIG}" "--${provider}-login" --no-browser
    set_eligibility "${selector}" false
    printf 'subscription %s reauthenticated and eligible\n' "${selector}"
    list_accounts
    ;;
  *) usage >&2; exit 2 ;;
esac
