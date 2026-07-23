#!/usr/bin/env bash
set -uo pipefail

real_codex=${ORCHESTRA_CODEX_REAL_BIN:-/opt/pnpm/bin/codex}
wrapper_path=$(realpath "$0" 2>/dev/null || true)
real_path=$(realpath "$real_codex" 2>/dev/null || true)
if [[ ! -x "$real_codex" || -z "$real_path" || "$real_path" == "$wrapper_path" ]]; then
  printf 'codex wrapper: real binary unavailable\n' >&2
  exit 127
fi

strip_telemetry_environment() {
  unset \
    OTEL_EXPORTER_OTLP_ENDPOINT \
    OTEL_EXPORTER_OTLP_HEADERS \
    OTEL_EXPORTER_OTLP_PROTOCOL \
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT \
    OTEL_EXPORTER_OTLP_TRACES_HEADERS \
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL \
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT \
    OTEL_EXPORTER_OTLP_LOGS_HEADERS \
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL \
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT \
    OTEL_EXPORTER_OTLP_METRICS_HEADERS \
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL \
    OTEL_RESOURCE_ATTRIBUTES \
    OTEL_SERVICE_NAME \
    OTEL_PROPAGATORS \
    TRACESTATE \
    BAGGAGE \
    ORCHESTRA_SELECTED_ACCOUNT \
    CODEX_PROXY_ACCOUNT \
    CLIPROXYAPI_ACCOUNT \
    CLIPROXYAPI_API_KEY \
    HTTP_PROXY \
    HTTPS_PROXY \
    ALL_PROXY \
    http_proxy \
    https_proxy \
    all_proxy
}

report=""
resume_mode=fresh
for ((index = 1; index <= $#; index++)); do
  value=${!index}
  if [[ "$value" == "-o" || "$value" == "--output-last-message" ]]; then
    next=$((index + 1))
    report=${!next:-}
  fi
  if [[ "$value" == "resume" ]]; then
    resume_mode=resume
  fi
done

traceparent=${TRACEPARENT:-}
relay=${ORCHESTRA_OTEL_RELAY_ENDPOINT:-}
owner=${ORCHESTRA_DISPATCH_OWNER:-}
if [[ -z "$traceparent" && -z "$relay" && -z "$owner" ]]; then
  exec "$real_codex" "$@"
fi
valid_owner='^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
valid_traceparent='^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$'
valid_relay='^http://127\.0\.0\.1:[0-9]+/[A-Za-z0-9_-]+/v1/traces$'
if [[ ! "$traceparent" =~ $valid_traceparent || ! "$relay" =~ $valid_relay || ! "$owner" =~ $valid_owner || -z "$report" ]]; then
  strip_telemetry_environment
  unset TRACEPARENT ORCHESTRA_OTEL_RELAY_ENDPOINT ORCHESTRA_DISPATCH_OWNER
  exec "$real_codex" "$@"
fi

report_name=$(basename "$report")
report_dir=$(cd "$(dirname "$report")" 2>/dev/null && pwd -P) || {
  strip_telemetry_environment
  unset TRACEPARENT ORCHESTRA_OTEL_RELAY_ENDPOINT ORCHESTRA_DISPATCH_OWNER
  exec "$real_codex" "$@"
}
dispatch_name=${report_name%.md}
valid_dispatch='^(.+)-([0-9]+)-([0-9]+)-([0-9]+)$'
if [[ "$report_dir" != */.codex-dispatches/"$owner" || "$report_name" != *.md || ! "$dispatch_name" =~ $valid_dispatch ]]; then
  strip_telemetry_environment
  unset TRACEPARENT ORCHESTRA_OTEL_RELAY_ENDPOINT ORCHESTRA_DISPATCH_OWNER
  exec "$real_codex" "$@"
fi

role=${BASH_REMATCH[1]}
if [[ -z "$role" || "$role" == -* || "$role" == *..* || ! "$role" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
  strip_telemetry_environment
  unset TRACEPARENT ORCHESTRA_OTEL_RELAY_ENDPOINT ORCHESTRA_DISPATCH_OWNER
  exec "$real_codex" "$@"
fi

umask 077
span_id=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
trace_id=${traceparent:3:32}
turn_span_id=${traceparent:36:16}
dispatch_parent="00-$trace_id-$span_id-01"
base="$report_dir/$dispatch_name"
sidecar="$base.otel.json"
capture=$(mktemp "${TMPDIR:-/tmp}/orchestra-codex-json.XXXXXX") || exit 1
started_ms=$(node -e 'process.stdout.write(String(Date.now()))')
deadline_seconds=900
if [[ "$role" == "implementer" ]]; then
  deadline_seconds=2700
fi
deadline_ms=$((started_ms + deadline_seconds * 1000))
model=${ORCHESTRA_CODEX_MODEL:-unknown}
child_pid=""
terminal_written=0

write_sidecar() {
  local state=$1
  local ended=${2:-null}
  local exit_code=${3:-null}
  local parse=${4:-unknown}
  local session=${5:-null}
  local turn=${6:-null}
  local cumulative=${7:-null}
  local temp="$sidecar.tmp.$$"
  node - "$temp" "$state" "$owner" "$dispatch_name" "$role" "$started_ms" "$deadline_ms" \
    "$trace_id" "$turn_span_id" "$span_id" "$model" "$resume_mode" "$ended" "$exit_code" \
    "$parse" "$session" "$turn" "$cumulative" <<'NODE'
const fs = require("fs");
const [
  file, state, owner, basename, role, started, deadline, traceId, turnSpanId,
  spanId, model, mode, ended, exitCode, parseStatus, sessionId, turnId, cumulative,
] = process.argv.slice(2);
const nullable = value => value === "null" ? null : value;
const numeric = value => value === "null" ? null : Number(value);
const sidecar = {
  version: 1,
  state,
  owner,
  basename,
  role,
  started_at: Number(started),
  deadline_at: Number(deadline),
  trace_id: traceId,
  turn_span_id: turnSpanId,
  dispatch_span_id: spanId,
  model,
  mode,
  ended_at: numeric(ended),
  exit_code: numeric(exitCode),
  parse_status: parseStatus,
  provider_session_id: nullable(sessionId),
  provider_turn_id: nullable(turnId),
  cumulative_tokens: numeric(cumulative),
};
fs.writeFileSync(file, `${JSON.stringify(sidecar)}\n`, { mode: 0o600 });
NODE
  mv -f "$temp" "$sidecar"
}

write_sidecar running

finish_signal() {
  local status=$1
  local signal=$2
  trap - HUP INT QUIT TERM ALRM
  if [[ -n "$child_pid" ]]; then
    kill -s "$signal" "$child_pid" 2>/dev/null || true
    for _ in {1..20}; do
      if ! kill -0 "$child_pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    if kill -0 "$child_pid" 2>/dev/null; then
      kill -TERM "$child_pid" 2>/dev/null || true
    fi
    for _ in {1..20}; do
      if ! kill -0 "$child_pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    if kill -0 "$child_pid" 2>/dev/null; then
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
    wait "$child_pid" 2>/dev/null || true
    child_pid=""
  fi
  local ended_ms
  ended_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  write_sidecar terminal "$ended_ms" "$status" "signal:$signal" null null null
  terminal_written=1
  exit "$status"
}

finish_exit() {
  local status=$?
  if [[ -n "$child_pid" ]]; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  if [[ "$terminal_written" -eq 0 ]]; then
    local ended_ms
    ended_ms=$(node -e 'process.stdout.write(String(Date.now()))')
    write_sidecar terminal "$ended_ms" "$status" wrapper_exit null null null || true
  fi
  rm -f "$capture"
}

trap finish_exit EXIT
trap 'finish_signal 129 HUP' HUP
trap 'finish_signal 130 INT' INT
trap 'finish_signal 131 QUIT' QUIT
trap 'finish_signal 143 TERM' TERM
trap 'finish_signal 142 ALRM' ALRM

strip_telemetry_environment
unset ORCHESTRA_OTEL_RELAY_ENDPOINT ORCHESTRA_DISPATCH_OWNER
export TRACEPARENT=$dispatch_parent
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=$relay
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf

"$real_codex" "$@" --json >"$capture" &
child_pid=$!
wait "$child_pid"
status=$?
child_pid=""
ended_ms=$(node -e 'process.stdout.write(String(Date.now()))')
parsed=$(node - "$capture" <<'NODE'
const fs = require("fs");
let session = null;
let turn = null;
let usage = null;
for (const line of fs.readFileSync(process.argv[2], "utf8").split(/\n/)) {
  if (!line.trim()) continue;
  try {
    const event = JSON.parse(line);
    if (event.type === "thread.started") session = event.thread_id ?? event.thread?.id ?? session;
    if (event.type === "turn.started" || event.type === "turn.completed") {
      turn = event.turn_id ?? event.turn?.id ?? turn;
    }
    const value = event.usage ?? event.token_usage ?? event.turn?.usage;
    if (value) {
      const total = value.total_tokens ?? value.total ??
        ((value.input_tokens ?? 0) + (value.output_tokens ?? 0));
      if (Number.isFinite(total)) usage = total;
    }
  } catch {}
}
process.stdout.write([session ?? "", turn ?? "", usage ?? ""].join("|"));
NODE
)
IFS='|' read -r provider_session provider_turn cumulative <<<"$parsed"
parse_status=ok
if [[ -z "$provider_session" || -z "$cumulative" ]]; then
  parse_status=unknown
fi
write_sidecar terminal "$ended_ms" "$status" "$parse_status" \
  "${provider_session:-null}" "${provider_turn:-null}" "${cumulative:-null}"
terminal_written=1
if [[ -n "$cumulative" ]]; then
  printf 'tokens used\n%s\n' "$cumulative"
fi
exit "$status"
