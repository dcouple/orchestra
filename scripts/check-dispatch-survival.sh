#!/usr/bin/env bash
set -euo pipefail

# This is the cheap parent-shell-exit regression check. The claude -p harness
# teardown itself is covered by AC1's manual verification.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/dispatch-survival.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
wait_for_marker() {
  local marker="$1" attempts=0
  while [[ ! -f "$marker" && "$attempts" -lt 100 ]]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  [[ -f "$marker" ]] || fail "marker not written: $marker"
}
write_launcher() {
  local name="$1" cap="$2" delay="$3"
  cat > "$scratch/$name.sh" <<EOF
#!/usr/bin/env bash
perl -e 'alarm shift; exec @ARGV or die "exec failed: \$!"' "$cap" \
  bash -c 'sleep "\$1"; echo report > "\$2"' bash "$delay" "$scratch/$name.md" </dev/null
status=\$?
echo "\$status" > "$scratch/$name.done.tmp" && mv "$scratch/$name.done.tmp" "$scratch/$name.done"
EOF
}
detach_from_exiting_parent() {
  local name="$1"
  NAME="$name" SCRATCH="$scratch" bash -c \
    'nohup perl -MPOSIX -e '\''POSIX::setsid(); exec @ARGV or die "exec failed: $!"'\'' bash "$SCRATCH/$NAME.sh" > "$SCRATCH/$NAME.log" 2>&1 & disown'
}

launch_epoch="$(date +%s)"
sequence=0
allocate_name() {
  local target="$1" role="$2"
  sequence=$((sequence + 1))
  printf -v "$target" '%s-%s-%s-%s' "$role" "$launch_epoch" "$$" "$sequence"
}

allocate_name name survival
write_launcher "$name" 10 3
detach_from_exiting_parent "$name"
wait_for_marker "$scratch/$name.done"
[[ "$(<"$scratch/$name.done")" == "0" ]] || fail "survival marker did not record 0"
[[ "$(<"$scratch/$name.md")" == "report" ]] || fail "survival report missing"

allocate_name name timeout
write_launcher "$name" 2 60
detach_from_exiting_parent "$name"
wait_for_marker "$scratch/$name.done"
[[ "$(<"$scratch/$name.done")" == "142" ]] || fail "watchdog marker did not record 142"

allocate_name first reviewer
allocate_name second reviewer
[[ "$first" != "$second" ]] || fail "concurrent names collided"
write_launcher "$first" 10 1
write_launcher "$second" 10 1
detach_from_exiting_parent "$first"
detach_from_exiting_parent "$second"
wait_for_marker "$scratch/$first.done"
wait_for_marker "$scratch/$second.done"
[[ "$(<"$scratch/$first.done")" == "0" && "$(<"$scratch/$second.done")" == "0" ]] || fail "concurrent dispatch failed"
[[ -f "$scratch/$first.md" && -f "$scratch/$second.md" ]] || fail "concurrent reports clobbered"

echo "PASS: detached dispatch survives parent exit, records 142, and avoids name collisions"
