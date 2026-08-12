#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Provision Cloud Logging/Monitoring for the Mac Mini heartbeat.

Usage: setup-monitoring.sh [--dry-run] [EMAIL]

  --dry-run  Describe existing resources and report what would be created;
             perform no GCP, SSH, or file mutations.
  --help     Show this help.

EMAIL defaults to tyler@bloomapi.com. MINI_HOST selects the SSH host (mini).
USAGE
}

DRY_RUN=0
EMAIL=tyler@bloomapi.com
email_seen=0
while (( $# > 0 )); do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    -*) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    *)
      (( email_seen == 0 )) || { printf 'Only one EMAIL may be supplied.\n' >&2; usage >&2; exit 2; }
      EMAIL=$1
      email_seen=1
      ;;
  esac
  shift
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT=bloom-agents
SA_NAME=mac-mini-heartbeat
SA_EMAIL="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
METRIC=mac_mini_heartbeat
CHANNEL_DISPLAY='Mac Mini heartbeat email'
POLICY_DISPLAY='Mac Mini heartbeat absent'
MINI_HOST=${MINI_HOST:-mini}

command -v gcloud >/dev/null || { printf 'gcloud is required\n' >&2; exit 1; }
command -v scp >/dev/null || { printf 'scp is required\n' >&2; exit 1; }
[[ $EMAIL =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || { printf 'invalid email address\n' >&2; exit 1; }
gcloud projects describe "$PROJECT" --format='value(projectId)' >/dev/null
if (( DRY_RUN )); then printf 'DRY RUN: inspecting state; no changes will be made.\n'; fi

if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  printf 'service-account: already-exists\n'
else
  if (( DRY_RUN )); then
    printf 'service-account: would-create\n'
  else
    gcloud iam service-accounts create "$SA_NAME" --project="$PROJECT" \
      --display-name='Mac Mini heartbeat writer'
    printf 'service-account: created\n'
  fi
fi

current_roles=$(gcloud projects get-iam-policy "$PROJECT" \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:$SA_EMAIL" \
  --format='value(bindings.role)')
unexpected_roles=$(printf '%s\n' "$current_roles" | sed '/^$/d;/^roles\/logging.logWriter$/d')
if [[ -n $unexpected_roles ]]; then
  if (( DRY_RUN )); then
    printf 'service-account-roles: unexpected (%s)\n' "$(printf '%s' "$unexpected_roles" | tr '\n' ',')"
  else
    printf 'ERROR: heartbeat service account has unexpected project roles:\n%s\n' "$unexpected_roles" >&2
    exit 1
  fi
fi
if printf '%s\n' "$current_roles" | grep -qx 'roles/logging.logWriter'; then
  printf 'log-writer-binding: already-exists\n'
else
  if (( DRY_RUN )); then
    printf 'log-writer-binding: would-create\n'
  else
    gcloud projects add-iam-policy-binding "$PROJECT" \
      --member="serviceAccount:$SA_EMAIL" --role=roles/logging.logWriter \
      --condition=None >/dev/null
    printf 'log-writer-binding: created\n'
  fi
fi

if ssh "$MINI_HOST" 'sudo test -f /usr/local/etc/dcouple/heartbeat-sa.json'; then
  printf 'service-account-key: already-exists-on-mini\n'
else
  if (( DRY_RUN )); then
    printf 'service-account-key: would-create-and-install\n'
  else
    key_file=$(mktemp /tmp/mac-mini-heartbeat-key.XXXXXX)
    created_key_id=''
    key_install_complete=0
    cleanup_key_install() {
      local cleanup_status=$? cleanup_key_id=$created_key_id
      trap - EXIT
      if [[ -z $cleanup_key_id && -s $key_file ]]; then
        cleanup_key_id=$(plutil -extract private_key_id raw -o - "$key_file" 2>/dev/null || true)
      fi
      if (( key_install_complete == 0 )) && [[ -n $cleanup_key_id ]]; then
        printf 'service-account-key: remote install failed; revoking key %s\n' "$cleanup_key_id" >&2
        if ! gcloud iam service-accounts keys delete "$cleanup_key_id" \
          --iam-account="$SA_EMAIL" --project="$PROJECT" --quiet; then
          printf 'ERROR: failed to revoke orphaned service-account key %s\n' "$cleanup_key_id" >&2
        fi
      fi
      rm -f "$key_file"
      exit "$cleanup_status"
    }
    trap cleanup_key_install EXIT
    chmod 0600 "$key_file"
    gcloud iam service-accounts keys create "$key_file" \
      --iam-account="$SA_EMAIL" --project="$PROJECT"
    created_key_id=$(plutil -extract private_key_id raw -o - "$key_file")
    [[ -n $created_key_id ]] || { printf 'created service-account key has no private_key_id\n' >&2; exit 1; }
    ssh "$MINI_HOST" 'sudo install -d -o root -g wheel -m 0755 /usr/local/etc/dcouple'
    scp "$key_file" "$MINI_HOST:/tmp/mac-mini-heartbeat-sa.json"
    ssh "$MINI_HOST" 'sudo install -o root -g wheel -m 0600 /tmp/mac-mini-heartbeat-sa.json /usr/local/etc/dcouple/heartbeat-sa.json && rm -f /tmp/mac-mini-heartbeat-sa.json'
    key_install_complete=1
    rm -f "$key_file"
    trap - EXIT
    printf 'service-account-key: created-and-installed\n'
  fi
fi

log_filter='logName="projects/bloom-agents/logs/mac-mini-heartbeat"'
if gcloud logging metrics describe "$METRIC" --project="$PROJECT" >/dev/null 2>&1; then
  printf 'log-metric: already-exists\n'
else
  if (( DRY_RUN )); then
    printf 'log-metric: would-create\n'
  else
    gcloud logging metrics create "$METRIC" --project="$PROJECT" \
      --description='Count of tunnel-gated Mac Mini heartbeats' \
      --log-filter="$log_filter"
    printf 'log-metric: created\n'
  fi
fi

api_token=$(gcloud auth print-access-token)
channel_response=$(mktemp /tmp/mac-mini-channels.XXXXXX)
trap 'rm -f "$channel_response"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$api_token" |
  curl -fsS --config - --get \
    --data-urlencode "filter=display_name=\"$CHANNEL_DISPLAY\" AND type=\"email\"" \
    "https://monitoring.googleapis.com/v3/projects/$PROJECT/notificationChannels" \
    >"$channel_response"
channel_name=$(plutil -extract notificationChannels.0.name raw -o - "$channel_response" 2>/dev/null || true)
if [[ -n $channel_name ]]; then
  printf 'notification-channel: already-exists\n'
else
  if (( DRY_RUN )); then
    printf 'notification-channel: would-create\n'
  else
    channel_file=$(mktemp /tmp/mac-mini-channel.XXXXXX)
    trap 'rm -f "$channel_file"' EXIT
    printf '{"type":"email","displayName":"%s","labels":{"email_address":"%s"}}\n' \
      "$CHANNEL_DISPLAY" "$EMAIL" >"$channel_file"
    printf 'header = "Authorization: Bearer %s"\n' "$api_token" |
      curl -fsS --config - -H 'Content-Type: application/json' \
        --data-binary "@$channel_file" \
        "https://monitoring.googleapis.com/v3/projects/$PROJECT/notificationChannels" \
        >"$channel_response"
    channel_name=$(plutil -extract name raw -o - "$channel_response")
    rm -f "$channel_file"
    printf 'notification-channel: created\n'
  fi
fi
if (( ! DRY_RUN )); then
  [[ -n $channel_name ]] || { printf 'notification channel name was not resolved\n' >&2; exit 1; }
fi
rm -f "$channel_response"
trap - EXIT

policy_name=$(gcloud monitoring policies list --project="$PROJECT" \
  --filter="displayName=\"$POLICY_DISPLAY\"" --format='value(name)' --limit=1)
if [[ -n $policy_name ]]; then
  printf 'alert-policy: already-exists\n'
else
  if (( DRY_RUN )); then
    printf 'alert-policy: would-create\n'
    exit 0
  fi
  probe_payload='{"host":"setup-probe","tailscale":"ok"}'
  gcloud logging write mac-mini-heartbeat "$probe_payload" \
    --payload-type=json --severity=INFO --project="$PROJECT"
  printf 'metric-readiness: waiting for first point'
  metric_ready=0
  for _ in {1..30}; do
    series_file=$(mktemp /tmp/mac-mini-series.XXXXXX)
    interval_end=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    interval_start=$(date -u -v-30M '+%Y-%m-%dT%H:%M:%SZ')
    api_token=$(gcloud auth print-access-token)
    printf 'header = "Authorization: Bearer %s"\n' "$api_token" |
      curl -fsS --config - --get \
        --data-urlencode 'filter=metric.type="logging.googleapis.com/user/mac_mini_heartbeat"' \
        --data-urlencode "interval.startTime=$interval_start" \
        --data-urlencode "interval.endTime=$interval_end" \
        --data-urlencode 'pageSize=1' \
        "https://monitoring.googleapis.com/v3/projects/$PROJECT/timeSeries" >"$series_file"
    if plutil -extract timeSeries.0.metric.type raw -o - "$series_file" >/dev/null 2>&1; then
      rm -f "$series_file"
      metric_ready=1
      break
    fi
    rm -f "$series_file"
    printf '.'
    sleep 10
  done
  printf '\n'
  (( metric_ready == 1 )) || { printf 'metric did not become readable; policy not created\n' >&2; exit 1; }

  policy_file=$(mktemp /tmp/mac-mini-policy.XXXXXX)
  trap 'rm -f "$policy_file"' EXIT
  sed "s|__NOTIFICATION_CHANNEL__|$channel_name|g" "$SCRIPT_DIR/alert-policy.json" >"$policy_file"
  gcloud monitoring policies create --project="$PROJECT" \
    --policy-from-file="$policy_file" >/dev/null
  rm -f "$policy_file"
  trap - EXIT
  printf 'alert-policy: created\n'
fi
