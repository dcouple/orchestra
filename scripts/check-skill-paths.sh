#!/usr/bin/env bash
# Check that every .references/, .claude/, and .codex/ path named in the
# synced directories and templates exists. Run from the repo root.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

known_missing='.claude/skills/hillclimb/SKILL.md' # tracked in issue #218
missing=$(grep -rhoE '\.(references|claude/(skills|agents)|codex/skills)/[A-Za-z0-9_./-]+' \
    claude codex references templates | sed 's/[.]$//' | sort -u |
  while read -r p; do
    [ -e "${p#.}" ] || [ "$p" = "$known_missing" ] || echo "$p"
  done)
[ -z "$missing" ] || { echo "Missing paths:"; echo "$missing"; exit 1; }
echo "skill paths ok"
