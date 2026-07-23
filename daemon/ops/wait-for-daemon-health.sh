#!/usr/bin/env bash
set -euo pipefail

HEALTH_URL="${1:-http://127.0.0.1:8787/healthz}"
CURL_BIN="${CURL_BIN:-curl}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
SLEEP_BIN="${SLEEP_BIN:-sleep}"
DAEMON_HEALTH_MAX_ATTEMPTS="${DAEMON_HEALTH_MAX_ATTEMPTS:-30}"
DAEMON_HEALTH_RETRY_DELAY_SECONDS="${DAEMON_HEALTH_RETRY_DELAY_SECONDS:-1}"

if [[ ! "${DAEMON_HEALTH_MAX_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "DAEMON_HEALTH_MAX_ATTEMPTS must be a positive integer" >&2
  exit 2
fi
if [[ ! "${DAEMON_HEALTH_RETRY_DELAY_SECONDS}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "DAEMON_HEALTH_RETRY_DELAY_SECONDS must be a non-negative number" >&2
  exit 2
fi

for ((attempt = 1; attempt <= DAEMON_HEALTH_MAX_ATTEMPTS; attempt++)); do
  if response="$("${CURL_BIN}" -fsS --connect-timeout 1 --max-time 2 "${HEALTH_URL}" 2>/dev/null)" \
      && "${PYTHON_BIN}" -c 'import json,sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)' \
        <<<"${response}" 2>/dev/null; then
    exit 0
  fi
  if (( attempt < DAEMON_HEALTH_MAX_ATTEMPTS )); then
    "${SLEEP_BIN}" "${DAEMON_HEALTH_RETRY_DELAY_SECONDS}"
  fi
done

echo "daemon health did not report ok=true after ${DAEMON_HEALTH_MAX_ATTEMPTS} attempts" >&2
exit 1
