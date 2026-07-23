#!/usr/bin/env bash
# Render a run-timeline HTML page to PNG with whatever Chromium-family
# browser or Playwright install the machine has — macOS, Linux, or
# Windows (git-bash). Usage:
#   render-timeline.sh <in.html> <out.png> [height]   render (height default 2400;
#     size it ~800 + 50 per dispatch row so a long run's table isn't clipped)
#   render-timeline.sh --check               print the renderer this machine will use
# TIMELINE_BROWSER=/path/to/browser overrides discovery. Run --check at
# preflight on a box that will publish postmortems. Exit 0 on success;
# 3 (NO_RENDERER) when nothing can render — the caller attaches the HTML
# and notes the missing PNG instead of improvising a renderer mid-run.
set -u

candidates() {
  [ -n "${TIMELINE_BROWSER:-}" ] && printf '%s\n' "$TIMELINE_BROWSER"
  # PATH names (Linux distros, brew, Windows shims)
  printf '%s\n' google-chrome google-chrome-stable chromium chromium-browser \
    microsoft-edge microsoft-edge-stable brave-browser chrome
  # macOS app bundles
  printf '%s\n' \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  # Windows via git-bash/MSYS
  printf '%s\n' \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
}

find_browser() {
  while IFS= read -r b; do
    [ -x "$b" ] && { printf '%s' "$b"; return 0; }
    p=$(command -v "$b" 2>/dev/null) && { printf '%s' "$p"; return 0; }
  done < <(candidates)
  return 1
}

have_playwright() {
  command -v npx >/dev/null 2>&1 && npx --no-install playwright --version >/dev/null 2>&1
}

if [ "${1:-}" = "--check" ]; then
  if b=$(find_browser); then echo "renderer: $b"; exit 0; fi
  if have_playwright; then echo "renderer: playwright (npx)"; exit 0; fi
  echo "NO_RENDERER: install Chrome/Chromium/Edge, or 'npx playwright install chromium'" >&2
  exit 3
fi

in="${1:?usage: render-timeline.sh <in.html> <out.png> [height] | --check}"
out="${2:?usage: render-timeline.sh <in.html> <out.png> [height] | --check}"
height="${3:-2400}"
[ -f "$in" ] || { echo "no such file: $in" >&2; exit 2; }
abs_in="$(cd "$(dirname "$in")" && pwd)/$(basename "$in")"
if command -v cygpath >/dev/null 2>&1; then
  url="file:///$(cygpath -m "$abs_in")"   # Windows browsers need Windows paths
  out="$(cygpath -m "$out")"              # for the --screenshot target too
else
  url="file://$abs_in"
fi

shot() { # $1 = browser, $2 = headless flag (new Chromium wants =new, old wants bare)
  "$1" "$2" --disable-gpu --no-sandbox --hide-scrollbars \
       --window-size=1680,"$height" --screenshot="$out" "$url" >/dev/null 2>&1 \
  && [ -s "$out" ]
}

if b=$(find_browser); then
  { shot "$b" --headless=new || shot "$b" --headless; } && { echo "$out"; exit 0; }
fi
if have_playwright; then
  npx --no-install playwright screenshot --full-page \
    --viewport-size=1680,900 "$url" "$out" >/dev/null 2>&1 \
    && [ -s "$out" ] && { echo "$out"; exit 0; }
fi
echo "NO_RENDERER: install Chrome/Chromium/Edge, or 'npx playwright install chromium'" >&2
exit 3
