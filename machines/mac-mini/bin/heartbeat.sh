#!/usr/bin/env bash
set -euo pipefail

TAILSCALE=/opt/homebrew/bin/tailscale
KEY_FILE=/usr/local/etc/dcouple/heartbeat-sa.json
PROJECT=bloom-agents
LOG_ID=mac-mini-heartbeat

"$TAILSCALE" status >/dev/null 2>&1 || exit 0
[[ -r $KEY_FILE ]] || { printf 'heartbeat service-account key is unreadable\n' >&2; exit 1; }

work_dir=$(mktemp -d /tmp/dcouple-heartbeat.XXXXXX)
chmod 0700 "$work_dir"
trap 'rm -rf "$work_dir"' EXIT

b64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

client_email=$(plutil -extract client_email raw -o - "$KEY_FILE")
private_key=$(plutil -extract private_key raw -o - "$KEY_FILE")
printf '%s' "$private_key" >"$work_dir/key.pem"
chmod 0600 "$work_dir/key.pem"

now=$(date +%s)
expires=$((now + 3600))
header=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | b64url)
claims=$(printf '{"iss":"%s","scope":"https://www.googleapis.com/auth/logging.write","aud":"https://oauth2.googleapis.com/token","iat":%s,"exp":%s}' "$client_email" "$now" "$expires" | b64url)
unsigned="$header.$claims"
printf '%s' "$unsigned" | openssl dgst -sha256 -sign "$work_dir/key.pem" -binary >"$work_dir/signature"
signature=$(b64url <"$work_dir/signature")
printf '%s.%s' "$unsigned" "$signature" >"$work_dir/assertion"

curl -fsS https://oauth2.googleapis.com/token \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' \
  --data-urlencode "assertion@$work_dir/assertion" >"$work_dir/token.json"
access_token=$(plutil -extract access_token raw -o - "$work_dir/token.json")

host=$(scutil --get LocalHostName 2>/dev/null || hostname)
[[ $host =~ ^[A-Za-z0-9._-]+$ ]] || { printf 'unsafe host name for heartbeat payload\n' >&2; exit 1; }
printf '{"logName":"projects/%s/logs/%s","resource":{"type":"global"},"entries":[{"severity":"INFO","jsonPayload":{"host":"%s","tailscale":"ok"}}]}' \
  "$PROJECT" "$LOG_ID" "$host" >"$work_dir/entry.json"

chmod 0600 "$work_dir/entry.json"
printf 'header = "Authorization: Bearer %s"\n' "$access_token" |
  curl -fsS --config - -H 'Content-Type: application/json' \
    --data-binary "@$work_dir/entry.json" \
    https://logging.googleapis.com/v2/entries:write >/dev/null
