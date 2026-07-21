#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: codex-provider-gate.sh [--help]

Prove CLIProxyAPI Responses compatibility, identity, resume, and affinity,
then install the daemon-owned Codex provider config. Failures remove only a
gate-managed target config.

Environment variables:
  PROXY_URL                 Proxy origin (default: http://127.0.0.1:8317)
  CLIPROXY_ENV_FILE         API-key env file (default: /etc/linear-agent-daemon/cliproxyapi.env)
  CLIPROXY_VERSION_MARKER   Version marker (default: /usr/local/share/cliproxyapi-version)
  CLIPROXY_BIN              Proxy binary (default: /usr/local/bin/cliproxyapi)
  CODEX_BIN                 Codex executable (default: codex)
  CODEX_HOME                Temporary Codex state directory (default: generated)
  TARGET_CONFIG             Installed config path (default: /var/lib/linear-agent-daemon/.codex/config.toml)
  EXPECTED_PROXY_VERSION    Required proxy version (default: 7.2.93)
  GATE_TIMEOUT_SECONDS      Per-Codex-command timeout (default: 900)
  GATE_COUNTER_WINDOW_SECONDS  Identity-counter poll window (default: 15)
EOF
}

if [[ $# -gt 0 ]]; then
  case "$1" in
    --help|-h)
      if [[ $# -ne 1 ]]; then usage >&2; exit 2; fi
      usage
      exit 0
      ;;
    *) usage >&2; exit 2 ;;
  esac
fi

# Coupled intentionally to claude/skills/codex/SKILL.md's detached dispatch and
# `codex exec resume --last` shapes. A pass proves the unchanged workflow.
EXPECTED_PROXY_VERSION="${EXPECTED_PROXY_VERSION:-7.2.93}"
PROXY_URL="${PROXY_URL:-http://127.0.0.1:8317}"
CLIPROXY_ENV_FILE="${CLIPROXY_ENV_FILE:-/etc/linear-agent-daemon/cliproxyapi.env}"
CLIPROXY_VERSION_MARKER="${CLIPROXY_VERSION_MARKER:-/usr/local/share/cliproxyapi-version}"
CLIPROXY_BIN="${CLIPROXY_BIN:-/usr/local/bin/cliproxyapi}"
CODEX_BIN="${CODEX_BIN:-codex}"
TARGET_CONFIG="${TARGET_CONFIG:-/var/lib/linear-agent-daemon/.codex/config.toml}"
GATE_TIMEOUT_SECONDS="${GATE_TIMEOUT_SECONDS:-900}"
GATE_COUNTER_WINDOW_SECONDS="${GATE_COUNTER_WINDOW_SECONDS:-15}"
MARKER='# managed by codex-provider-gate.sh — removed on gate failure'
work_dir="$(mktemp -d)"
gate_home="${CODEX_HOME:-${work_dir}/codex-home}"
mkdir -p "${gate_home}"

cleanup() {
  local status=$?
  rm -rf "${work_dir}"
  return "${status}"
}
trap cleanup EXIT

rollback() {
  if [[ -f "${TARGET_CONFIG}" ]] && head -n 1 "${TARGET_CONFIG}" | grep -Fqx "${MARKER}"; then
    rm -f "${TARGET_CONFIG}"
    echo "rollback: removed gate-managed provider config" >&2
  fi
}
fail() { rollback; echo "FAIL: $1" >&2; exit 1; }
on_error() {
  local status=$?
  rollback
  echo "FAIL: unexpected-error" >&2
  return "${status}"
}
trap on_error ERR

[[ -r "${CLIPROXY_ENV_FILE}" ]] || fail "environment-file"
CLIPROXY_API_KEY="$(grep -m1 '^CLIPROXY_API_KEY=' "${CLIPROXY_ENV_FILE}" | cut -d= -f2- || true)"
CLIPROXY_MANAGEMENT_KEY="$(grep -m1 '^CLIPROXY_MANAGEMENT_KEY=' "${CLIPROXY_ENV_FILE}" | cut -d= -f2- || true)"
if [[ -z "${CLIPROXY_API_KEY:-}" ]]; then
  fail "environment-file: ${CLIPROXY_ENV_FILE} is missing CLIPROXY_API_KEY"
fi
if [[ -z "${CLIPROXY_MANAGEMENT_KEY:-}" ]]; then
  fail "environment-file: ${CLIPROXY_ENV_FILE} is missing CLIPROXY_MANAGEMENT_KEY"
fi
export CLIPROXY_API_KEY

if [[ -r "${CLIPROXY_VERSION_MARKER}" ]]; then
  [[ "$(<"${CLIPROXY_VERSION_MARKER}")" == "${EXPECTED_PROXY_VERSION}" ]] || fail "proxy-version"
else
  version_output="$("${CLIPROXY_BIN}" --version 2>&1 || true)"
  grep -Fq "CLIProxyAPI Version: ${EXPECTED_PROXY_VERSION}" <<<"${version_output}" || fail "proxy-version"
fi

api_get() {
  printf 'header = "Authorization: Bearer %s"\n' "${CLIPROXY_API_KEY}" \
    | curl -fsS --connect-timeout 2 --max-time 15 -K - "$1"
}
management_get() {
  printf 'header = "Authorization: Bearer %s"\n' "${CLIPROXY_MANAGEMENT_KEY}" \
    | curl -fsS --connect-timeout 2 --max-time 15 -K - "${PROXY_URL%/}/v0/management/auth-files"
}

models=""
for _attempt in {1..20}; do
  if models="$(api_get "${PROXY_URL%/}/v1/models" 2>/dev/null)"; then break; fi
  sleep 1
done
[[ -n "${models}" ]] || fail "responses-model-catalog"
for model in gpt-5.6-sol gpt-5.6-sol-low gpt-5.6-sol-medium gpt-5.6-sol-xhigh; do
  python3 -c 'import json,sys; p=json.load(sys.stdin); needle=sys.argv[1]; raise SystemExit(0 if any(x.get("id")==needle for x in p.get("data",[])) else 1)' \
    "${model}" <<<"${models}" || fail "responses-model-catalog"
done

snapshot() {
  management_get | python3 -c '
import json, sys
p=json.load(sys.stdin); xs=p.get("files",p.get("data",p if isinstance(p,list) else []))
# recent_requests success counters are known as success, successful, or succeeded.
def successes(value):
    if isinstance(value, dict):
        return sum((v if isinstance(v,(int,float)) else 0) for k,v in value.items() if k in ("success","successful","succeeded")) + sum(successes(v) for k,v in value.items() if k not in ("success","successful","succeeded"))
    if isinstance(value, list): return sum(successes(v) for v in value)
    return 0
out={}
for x in xs:
    if x.get("provider")=="codex" and not x.get("disabled",False) and (x.get("account") or x.get("email")):
        out[str(x.get("name"))]=successes(x.get("recent_requests",{}))
print(json.dumps(out,sort_keys=True))
'
}

before="$(snapshot)" || fail "codex-credential-identity"
enabled_count="$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' <<<"${before}")"
(( enabled_count >= 1 )) || fail "codex-credential-identity"

candidate="${gate_home}/config.toml"
cat > "${candidate}" <<EOF
${MARKER}
model = "gpt-5.6-sol"
model_provider = "cliproxyapi"
[model_providers.cliproxyapi]
name = "CLIProxyAPI"
base_url = "${PROXY_URL%/}/v1"
wire_api = "responses"
env_key = "CLIPROXY_API_KEY"
EOF
chmod 0600 "${candidate}"

run_detached() {
  local mode="$1" report="$2" log="$3" done_file="$4"
  shift 4
  rm -f "${done_file}" "${done_file}.tmp"
  if [[ "${mode}" == initial ]]; then
    # shellcheck disable=SC2016
    nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec failed: $!"' \
      sh -c 'perl -e '\''alarm shift; exec @ARGV or die "exec failed: $!"'\'' "$1" "$2" exec -m gpt-5.6-sol -c model_reasoning_effort="medium" --yolo --skip-git-repo-check -C "$3" -o "$4" "$5"; status=$?; echo "$status" > "$6.tmp" && mv "$6.tmp" "$6"' \
      gate-launch "${GATE_TIMEOUT_SECONDS}" "${CODEX_BIN}" "$(pwd)" "${report}" "$1" "${done_file}" >"${log}" 2>&1 </dev/null &
  else
    # shellcheck disable=SC2016
    nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec failed: $!"' \
      sh -c 'perl -e '\''alarm shift; exec @ARGV or die "exec failed: $!"'\'' "$1" "$2" exec resume --last -o "$3" "$4"; status=$?; echo "$status" > "$5.tmp" && mv "$5.tmp" "$5"' \
      gate-resume "${GATE_TIMEOUT_SECONDS}" "${CODEX_BIN}" "${report}" "$1" "${done_file}" >"${log}" 2>&1 </dev/null &
  fi
  local deadline=$((SECONDS + GATE_TIMEOUT_SECONDS + 15))
  while [[ ! -f "${done_file}" && ${SECONDS} -lt ${deadline} ]]; do sleep 1; done
  [[ -f "${done_file}" ]] || return 124
  [[ "$(<"${done_file}")" == 0 ]]
}

export CODEX_HOME="${gate_home}"
tool_file="${work_dir}/tool-called"
initial_report="${work_dir}/initial.md"
initial_log="${work_dir}/initial.log"
initial_done="${work_dir}/initial.done"
prompt="Use the shell tool to run: printf GATE_TOOL_OK > ${tool_file}. Then reply with exactly GATE_STREAM_OK."
run_detached initial "${initial_report}" "${initial_log}" "${initial_done}" "${prompt}" || fail "detached-tool-stream"
[[ -s "${initial_log}" && -f "${tool_file}" && "$(<"${tool_file}")" == GATE_TOOL_OK ]] || fail "detached-tool-stream"
grep -Fq GATE_STREAM_OK "${initial_report}" || fail "detached-tool-stream"

resume_report="${work_dir}/resume.md"
resume_log="${work_dir}/resume.log"
resume_done="${work_dir}/resume.done"
run_detached resume "${resume_report}" "${resume_log}" "${resume_done}" "Reply with exactly GATE_RESUME_OK." || fail "resume-last"
grep -Fq GATE_RESUME_OK "${resume_report}" || fail "resume-last"

changed_credentials() {
  python3 - "$1" "$2" <<'PY'
import json, sys
before, after = json.loads(sys.argv[1]), json.loads(sys.argv[2])
print(sum(1 for name, value in after.items() if value > before.get(name, 0)))
PY
}
after="$(snapshot)" || fail "codex-credential-identity"
changed_count="$(changed_credentials "${before}" "${after}")"
counter_deadline=$((SECONDS + GATE_COUNTER_WINDOW_SECONDS))
while (( changed_count < 1 && SECONDS < counter_deadline )); do
  sleep 1
  after="$(snapshot)" || fail "codex-credential-identity"
  changed_count="$(changed_credentials "${before}" "${after}")"
done
(( changed_count >= 1 )) || fail "codex-credential-identity"
if (( enabled_count >= 2 )); then
  (( changed_count == 1 )) || fail "session-affinity"
else
  echo "session-affinity: N/A — single credential; rerun after enrollment"
fi
echo "effort-survival: request logging does not expose reasoning effort; client command used medium"

if [[ "${candidate}" == "${TARGET_CONFIG}" ]]; then
  chmod 0600 "${TARGET_CONFIG}"
else
  install -d -m 0700 "$(dirname "${TARGET_CONFIG}")"
  install -m 0600 "${candidate}" "${TARGET_CONFIG}"
fi
echo "PASS: standalone Codex provider installed"
