#!/bin/bash
set -u

usage() {
  cat <<EOF
Usage:
  $0 <simulator-udid> [output-directory]
  $0 --dry-run [simulator-udid]
  $0 --help | -h

Arguments:
  simulator-udid   Simulator to probe. With --dry-run, defaults to an
                   available stock "iPhone 17" simulator.
  output-directory New or empty directory for probe artifacts. If omitted,
                   a temporary directory is created.

Environment overrides:
  XCODEBUILD_MCP_BIN  XcodeBuildMCP executable (default: /usr/local/bin/xcodebuildmcp)
  DEVELOPER_DIR       Xcode developer directory (default: /Applications/Xcode.app/Contents/Developer)
  SIM_PROBE_APP_SRC   Fixture source directory (default: sim-probe-app beside this script)

Exit codes:
  0  Probe passed, help printed, or dry-run checks passed.
  1  A prerequisite, dry-run validation, or probe step failed.
  2  Invalid arguments/output directory, or an unknown run-mode simulator UDID.

State changes:
  The probe may boot the selected simulator, replace the fixture app, launch
  it, and capture artifacts. Cleanup terminates and uninstalls the fixture and
  restores the simulator to Shutdown only when it began in Shutdown. Dry-run
  performs no boot, build, install, launch, screenshot, snapshot, or cleanup.
EOF
}

MODE="run"
UDID=""
OUT_ARG=""
case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --dry-run)
    MODE="dry-run"
    shift
    if [ "$#" -gt 1 ]; then
      usage >&2
      exit 2
    fi
    UDID="${1:-}"
    if [ -n "$UDID" ] && [ "${UDID#-}" != "$UDID" ]; then
      usage >&2
      exit 2
    fi
    ;;
  -* )
    usage >&2
    exit 2
    ;;
  "")
    usage >&2
    exit 2
    ;;
  *)
    if [ "$#" -gt 2 ]; then
      usage >&2
      exit 2
    fi
    UDID="$1"
    OUT_ARG="${2:-}"
    if [ -n "$OUT_ARG" ] && [ "${OUT_ARG#-}" != "$OUT_ARG" ]; then
      usage >&2
      exit 2
    fi
    ;;
esac

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
XCODEBUILD_MCP_BIN="${XCODEBUILD_MCP_BIN:-/usr/local/bin/xcodebuildmcp}"
DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
SIM_PROBE_APP_SRC="${SIM_PROBE_APP_SRC:-$SCRIPT_DIR/sim-probe-app}"
export DEVELOPER_DIR

context_line() {
  echo "user=$(id -un 2>&1) uid=$(id -u 2>&1) managername=$(launchctl managername 2>&1) manageruid=$(launchctl manageruid 2>&1) xcode-select=$(xcode-select -p 2>&1)"
}

dry_run_fail() {
  echo "[probe] check: FAILED ($1)"
  echo "RESULT dry-run=FAILED out=-"
  exit 1
}

if [ "$MODE" = "dry-run" ]; then
  echo "[probe] context: $(context_line)"
  if ! command -v xcrun >/dev/null 2>&1; then
    dry_run_fail "xcrun is not available"
  fi
  echo "[probe] check xcrun: ok"

  if ! DEVICE_INFO="$(xcrun simctl list devices available -j 2>/dev/null | python3 -c '
import json
import sys
requested = sys.argv[1]
try:
    devices = json.load(sys.stdin)["devices"]
except Exception:
    raise SystemExit(1)
matches = [device for runtime in devices.values() for device in runtime
           if (device.get("udid") == requested if requested else device.get("name") == "iPhone 17")]
if not matches:
    raise SystemExit(1)
print(matches[0]["udid"] + "|" + matches[0].get("state", ""))
' "$UDID")"; then
    dry_run_fail "simulator UDID was not found"
  fi
  if [ -z "$DEVICE_INFO" ]; then
    dry_run_fail "simulator UDID was not found"
  fi
  UDID="${DEVICE_INFO%%|*}"
  PRIOR_STATE="${DEVICE_INFO#*|}"
  echo "[probe] device: prior state=$PRIOR_STATE udid=$UDID"

  if [ ! -f "$SIM_PROBE_APP_SRC/main.m" ] || [ ! -f "$SIM_PROBE_APP_SRC/Info.plist" ]; then
    dry_run_fail "fixture sources are missing from $SIM_PROBE_APP_SRC"
  fi
  echo "[probe] check fixture sources: ok"
  if ! SDK_PATH="$(xcrun -sdk iphonesimulator --show-sdk-path 2>/dev/null)"; then
    dry_run_fail "iPhone simulator SDK is unavailable"
  fi
  if [ -z "$SDK_PATH" ] || [ ! -d "$SDK_PATH" ]; then
    dry_run_fail "iPhone simulator SDK is unavailable"
  fi
  echo "[probe] check simulator SDK: ok ($SDK_PATH)"
  if [ ! -x "$XCODEBUILD_MCP_BIN" ]; then
    dry_run_fail "XCODEBUILD_MCP_BIN is not executable: $XCODEBUILD_MCP_BIN"
  fi
  echo "[probe] check XCODEBUILD_MCP_BIN: ok ($XCODEBUILD_MCP_BIN)"

  if [ "$PRIOR_STATE" != "Booted" ]; then
    echo "[probe] would boot simulator $UDID"
  fi
  echo "[probe] would uninstall any previous fixture"
  echo "[probe] would build fixture app"
  echo "[probe] would install fixture app"
  echo "[probe] would launch fixture app"
  echo "[probe] would capture simulator screenshot"
  echo "[probe] would request snapshot_ui through XcodeBuildMCP"
  echo "[probe] would terminate fixture app"
  echo "[probe] would uninstall fixture app"
  if [ "$PRIOR_STATE" = "Shutdown" ]; then
    echo "[probe] would restore simulator to Shutdown"
  fi
  echo "RESULT dry-run=ok out=-"
  exit 0
fi

if [ -n "$OUT_ARG" ]; then
  OUT="$OUT_ARG"
  if [ -e "$OUT" ]; then
    if [ ! -d "$OUT" ] || [ -n "$(find "$OUT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
      echo "output directory must not exist or must be empty: $OUT" >&2
      exit 2
    fi
  elif ! mkdir -p "$OUT"; then
    echo "could not create output directory: $OUT" >&2
    exit 2
  fi
else
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/orchestra-sim-probe.XXXXXX")" || exit 1
fi

LOG="$OUT/probe.log"
INSTALL_STATUS="FAILED"
SCREENSHOT_STATUS="MISSING"
SNAPSHOT_STATUS="MISSING"
PRIOR_STATE=""
CLEAN_DEVICE=0
FINISHED=0
BUNDLE_ID="org.example.orchestra.simprobe"

log() { echo "[probe] $*" | tee -a "$LOG"; }

finish() {
  status="$1"
  [ "$FINISHED" -eq 0 ] || return
  FINISHED=1
  trap - EXIT INT TERM
  if [ "$CLEAN_DEVICE" -eq 1 ]; then
    if xcrun simctl terminate "$UDID" "$BUNDLE_ID" >>"$LOG" 2>&1; then
      log "terminate: ok"
    else
      log "terminate: skipped"
    fi
    if xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >>"$LOG" 2>&1; then
      log "uninstall: ok"
    else
      log "uninstall: skipped"
    fi
    if [ "$PRIOR_STATE" = "Shutdown" ]; then
      if xcrun simctl shutdown "$UDID" >>"$LOG" 2>&1; then
        log "shutdown: ok"
        log "cleanup: terminated, uninstalled, and restored device to Shutdown"
      else
        log "shutdown: FAILED"
        log "cleanup: fixture removed; failed to restore device to Shutdown"
        status=1
      fi
    else
      log "shutdown: skipped"
      log "cleanup: fixture terminated and uninstalled; device left $PRIOR_STATE"
    fi
  fi
  echo "RESULT install=$INSTALL_STATUS screenshot=$SCREENSHOT_STATUS snapshot_ui=$SNAPSHOT_STATUS out=$OUT" | tee -a "$LOG"
  exit "$status"
}

trap 'finish $?' EXIT
trap 'exit 1' INT TERM

log "context: $(context_line)"

DEVICE_JSON="$OUT/devices.json"
if ! xcrun simctl list devices -j >"$DEVICE_JSON" 2>>"$LOG"; then
  log "device: failed to list simulators"
  finish 2
fi
PRIOR_STATE="$(python3 - "$UDID" "$DEVICE_JSON" <<'PY'
import json
import sys
udid, path = sys.argv[1:]
with open(path) as handle:
    devices = json.load(handle)["devices"]
for runtime_devices in devices.values():
    for device in runtime_devices:
        if device.get("udid") == udid:
            print(device.get("state", ""))
            raise SystemExit(0)
raise SystemExit(2)
PY
)"
DEVICE_RC=$?
if [ "$DEVICE_RC" -ne 0 ] || [ -z "$PRIOR_STATE" ]; then
  log "device: unknown UDID $UDID"
  finish 2
fi
CLEAN_DEVICE=1
log "device: prior state=$PRIOR_STATE udid=$UDID"

if [ "$PRIOR_STATE" != "Booted" ] && ! xcrun simctl boot "$UDID" >>"$LOG" 2>&1; then
  log "boot: FAILED"
  finish 1
fi
if ! xcrun simctl bootstatus "$UDID" -b >>"$LOG" 2>&1; then
  log "bootstatus: FAILED"
  finish 1
fi
log "boot: ok"

if xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >>"$LOG" 2>&1; then
  log "uninstall previous fixture: ok"
else
  log "uninstall previous fixture: skipped"
fi
APP_DIR="$OUT/Probe.app"
mkdir -p "$APP_DIR"
if ! cp "$SIM_PROBE_APP_SRC/Info.plist" "$APP_DIR/Info.plist" >>"$LOG" 2>&1 || \
   ! xcrun -sdk iphonesimulator clang -target arm64-apple-ios17.0-simulator \
      -fobjc-arc -framework UIKit -framework Foundation \
      "$SIM_PROBE_APP_SRC/main.m" -o "$APP_DIR/Probe" >>"$LOG" 2>&1; then
  log "build: FAILED"
  finish 1
fi
log "build: ok"
if ! xcrun simctl install "$UDID" "$APP_DIR" >>"$LOG" 2>&1; then
  log "install: FAILED"
  finish 1
fi
log "install: ok"
if ! xcrun simctl launch "$UDID" "$BUNDLE_ID" >>"$LOG" 2>&1; then
  log "launch: FAILED"
  finish 1
fi
INSTALL_STATUS="ok"
log "launch: ok"
sleep 5

SCREENSHOT="$OUT/screenshot.png"
if xcrun simctl io "$UDID" screenshot "$SCREENSHOT" >>"$LOG" 2>&1 && [ -s "$SCREENSHOT" ]; then
  SCREENSHOT_STATUS="ok"
  log "screenshot: ok ($SCREENSHOT)"
else
  log "screenshot: MISSING"
fi

cat >"$OUT/mcp.mjs" <<'JS'
import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
const [binary, udid, out] = process.argv.slice(2);
const child = spawn(binary, ["mcp"], { stdio: ["pipe", "pipe", openSync(`${out}/mcp.log`, "a")], env: process.env });
let buffer = "", nextId = 0, settled = false, lastResponse = "";
const pending = new Map();
const responseText = (message) => (message.result?.content || []).map((item) => item.text || "").join("\n");
const recordError = (value) => writeFileSync(`${out}/snapshot_ui.error.txt`,
  (typeof value === "string" ? value : JSON.stringify(value, null, 2)) || "unknown MCP error");
const stop = (code, error) => {
  if (settled) return;
  settled = true;
  if (error !== undefined) recordError(error);
  clearTimeout(overallTimeout);
  child.kill();
  process.exit(code);
};
const writeMessage = (message) => new Promise((resolve, reject) => {
  const fail = (error) => {
    const detail = `MCP stdin write failed: ${error instanceof Error ? error.message : String(error)}`;
    stop(1, detail);
    reject(new Error(detail));
  };
  try {
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) fail(error);
      else resolve();
    });
  } catch (error) {
    fail(error);
  }
});
const call = async (method, params) => {
  const id = ++nextId;
  const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  try {
    await writeMessage({ jsonrpc: "2.0", id, method, params });
  } catch (error) {
    pending.delete(id);
    throw error;
  }
  return response;
};
child.stdout.on("data", (data) => {
  buffer += data;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(message.error);
      else request.resolve(message);
    }
  }
});
child.on("error", (error) => stop(1, error.message));
child.stdin.on("error", (error) => stop(1, `MCP stdin failed: ${error.message}`));
child.on("exit", (code) => { if (!settled) stop(1, `MCP server exited before completion (exit ${code})`); });
const overallTimeout = setTimeout(() => stop(1, "MCP request timed out after 90 seconds"), 90000);
try {
  const initialized = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "orchestra-sim-context-probe", version: "1" } });
  if (!Object.prototype.hasOwnProperty.call(initialized, "result")) throw new Error("initialize returned no result");
  await writeMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  const defaults = await call("tools/call", { name: "session_set_defaults", arguments: { simulatorId: udid } });
  if (defaults.result?.isError) throw new Error(responseText(defaults) || "session_set_defaults failed");
  let snapshot;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    snapshot = await call("tools/call", { name: "snapshot_ui", arguments: {} });
    lastResponse = responseText(snapshot);
    if (!snapshot.result?.isError) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (snapshot.result?.isError) stop(1, lastResponse || snapshot);
  if (!lastResponse.includes("Targets (") || !lastResponse.includes("orchestra-sim-probe")) stop(1, lastResponse || "snapshot_ui returned no fixture accessibility tree");
  writeFileSync(`${out}/snapshot_ui.txt`, lastResponse);
  stop(0);
} catch (error) {
  stop(1, error instanceof Error ? error.message : error);
}
JS

if node "$OUT/mcp.mjs" "$XCODEBUILD_MCP_BIN" "$UDID" "$OUT" >>"$LOG" 2>&1 && [ -s "$OUT/snapshot_ui.txt" ]; then
  SNAPSHOT_STATUS="ok"
  log "snapshot_ui: ok ($OUT/snapshot_ui.txt)"
else
  log "snapshot_ui: MISSING"
fi

if [ "$INSTALL_STATUS" = "ok" ] && [ "$SCREENSHOT_STATUS" = "ok" ] && [ "$SNAPSHOT_STATUS" = "ok" ]; then
  finish 0
fi
finish 1
