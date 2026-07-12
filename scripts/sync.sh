#!/usr/bin/env bash
# Mirror orchestra's skill system into a consumer repo checkout.
# Usage: scripts/sync.sh <path-to-consumer-repo>
# Idempotent: full --delete mirrors; a second run produces zero diff.
set -euo pipefail

ORCHESTRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSUMER="${1:?usage: sync.sh <path-to-consumer-repo>}"
CONSUMER="$(cd "$CONSUMER" && pwd)"

if [[ ! -d "$CONSUMER/.git" ]]; then
  echo "error: $CONSUMER is not a git repo" >&2
  exit 1
fi

rsync -a --delete "$ORCHESTRA_DIR/claude/skills/" "$CONSUMER/.claude/skills/"
rsync -a --delete "$ORCHESTRA_DIR/claude/agents/" "$CONSUMER/.claude/agents/"
rsync -a --delete "$ORCHESTRA_DIR/codex/skills/"  "$CONSUMER/.codex/skills/"
rsync -a --delete "$ORCHESTRA_DIR/references/"    "$CONSUMER/.references/"

echo "synced orchestra -> $CONSUMER"
git -C "$CONSUMER" status --short -- .claude/skills .claude/agents .codex/skills .references
