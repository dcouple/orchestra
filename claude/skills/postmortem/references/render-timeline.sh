#!/usr/bin/env bash
# Render a run-timeline HTML page to PNG, trying every renderer this
# machine might have. Usage: render-timeline.sh <in.html> <out.png>
# Exit 0 with the PNG written, or exit 3 after printing NO_RENDERER —
# the caller then attaches the HTML and notes the missing PNG instead
# of improvising a renderer mid-run.
set -u
in="$1"; out="$2"
[ -f "$in" ] || { echo "no such file: $in" >&2; exit 2; }
abs_in="$(cd "$(dirname "$in")" && pwd)/$(basename "$in")"

shot() { # $1 = browser binary
  "$1" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
       --window-size=1680,2400 --screenshot="$out" "file://$abs_in" \
       >/dev/null 2>&1 && [ -s "$out" ]
}

for b in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do
  if command -v "$b" >/dev/null 2>&1 || [ -x "$b" ]; then
    shot "$b" && { echo "$out"; exit 0; }
  fi
done

if command -v npx >/dev/null 2>&1 && npx --no-install playwright --version >/dev/null 2>&1; then
  npx --no-install playwright screenshot --full-page \
    --viewport-size=1680,900 "file://$abs_in" "$out" >/dev/null 2>&1 \
    && [ -s "$out" ] && { echo "$out"; exit 0; }
fi

echo "NO_RENDERER: no Chrome/Chromium binary and no installed Playwright" >&2
exit 3
