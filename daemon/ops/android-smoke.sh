#!/usr/bin/env bash
set -euo pipefail

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT}}"
ANDROID_AVD_NAME="${ANDROID_AVD_NAME:-linear-smoke}"
ANDROID_SERIAL="${ANDROID_SERIAL:-emulator-5554}"
ANDROID_BOOT_TIMEOUT_SECONDS="${ANDROID_BOOT_TIMEOUT_SECONDS:-300}"
ANDROID_SCREENSHOT_PATH="${ANDROID_SCREENSHOT_PATH:-$(pwd)/android-smoke.png}"
APK_PATH="${1:-${ANDROID_APK_PATH:-}}"
PACKAGE_NAME="${ANDROID_PACKAGE_NAME:-}"
ACTIVITY_NAME="${ANDROID_ACTIVITY_NAME:-}"

if [[ -z "${APK_PATH}" || ! -f "${APK_PATH}" ]]; then
  echo "usage: ANDROID_PACKAGE_NAME=com.example.app $0 /path/to/app.apk" >&2
  exit 2
fi
if [[ -z "${PACKAGE_NAME}" ]]; then
  echo "set ANDROID_PACKAGE_NAME to the installed app package" >&2
  exit 2
fi

export ANDROID_SDK_ROOT ANDROID_HOME PATH="${ANDROID_SDK_ROOT}/platform-tools:${ANDROID_SDK_ROOT}/emulator:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${PATH}"

adb start-server >/dev/null
if adb devices | awk 'NR > 1 {print $1}' | grep -qx "${ANDROID_SERIAL}"; then
  adb -s "${ANDROID_SERIAL}" emu kill >/dev/null 2>&1 || true
  sleep 2
fi

cleanup() {
  adb -s "${ANDROID_SERIAL}" emu kill >/dev/null 2>&1 || true
}
trap cleanup EXIT

accel_args=()
if [[ "${ANDROID_NO_ACCEL:-0}" == "1" || ! -e /dev/kvm ]]; then
  accel_args=(-no-accel)
fi

emulator -avd "${ANDROID_AVD_NAME}" -no-window -no-audio -gpu swiftshader_indirect "${accel_args[@]}" >/tmp/android-smoke-emulator.log 2>&1 &
emulator_pid=$!

deadline=$((SECONDS + ANDROID_BOOT_TIMEOUT_SECONDS))
while ! adb devices | awk -v serial="${ANDROID_SERIAL}" 'NR > 1 && $1 == serial && $2 == "device" { found = 1 } END { exit found ? 0 : 1 }'; do
  if ! kill -0 "${emulator_pid}" 2>/dev/null; then
    echo "Android emulator exited before ${ANDROID_SERIAL} appeared" >&2
    exit 1
  fi
  if (( SECONDS >= deadline )); then
    echo "Android device ${ANDROID_SERIAL} did not appear within ${ANDROID_BOOT_TIMEOUT_SECONDS}s" >&2
    exit 1
  fi
  sleep 2
done

while [[ "$(adb -s "${ANDROID_SERIAL}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]]; do
  if ! kill -0 "${emulator_pid}" 2>/dev/null; then
    echo "Android emulator exited before boot completed" >&2
    exit 1
  fi
  if (( SECONDS >= deadline )); then
    echo "Android emulator did not boot within ${ANDROID_BOOT_TIMEOUT_SECONDS}s" >&2
    exit 1
  fi
  sleep 2
done

adb -s "${ANDROID_SERIAL}" shell input keyevent 82 >/dev/null
adb -s "${ANDROID_SERIAL}" install -r "${APK_PATH}" >/dev/null
if [[ -n "${ACTIVITY_NAME}" ]]; then
  adb -s "${ANDROID_SERIAL}" shell am start -n "${PACKAGE_NAME}/${ACTIVITY_NAME}" >/dev/null
else
  adb -s "${ANDROID_SERIAL}" shell monkey -p "${PACKAGE_NAME}" -c android.intent.category.LAUNCHER 1 >/dev/null
fi
sleep "${ANDROID_LAUNCH_SETTLE_SECONDS:-5}"
adb -s "${ANDROID_SERIAL}" exec-out screencap -p > "${ANDROID_SCREENSHOT_PATH}"
test -s "${ANDROID_SCREENSHOT_PATH}"
