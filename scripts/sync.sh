#!/usr/bin/env bash
# Mirror orchestra's skill system into a consumer repo checkout.
# Usage: scripts/sync.sh <path-to-consumer-repo>
# Orchestra-owned entries are exact mirrors (stale files inside them are
# deleted on sync); entries that exist only in the consumer repo — e.g. a
# repo-local skill — are left untouched. Idempotent: a second run produces
# zero diff. Note: deleting/renaming a top-level entry in orchestra does NOT
# remove the old copy from consumers by itself — add the old name to the
# REMOVED_* lists below so syncs purge it everywhere.
set -euo pipefail

ORCHESTRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSUMER="${1:?usage: sync.sh <path-to-consumer-repo>}"
CONSUMER="$(cd "$CONSUMER" && pwd)"

if ! git -C "$CONSUMER" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: $CONSUMER is not a git repo (or worktree)" >&2
  exit 1
fi

# Mirror each top-level entry of src into dst. Entries orchestra ships are
# synced with --delete so they stay exact copies; anything in dst with no
# counterpart in src is left alone.
sync_dir() {
  local src="$1" dst="$2" entry name
  mkdir -p "$dst"
  for entry in "$src"/* "$src"/.[!.]* "$src"/..?*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    if [ -d "$entry" ]; then
      rsync -a --delete "$entry/" "$dst/$name/"
    else
      rsync -a "$entry" "$dst/$name"
    fi
  done
}

sync_dir "$ORCHESTRA_DIR/claude/skills" "$CONSUMER/.claude/skills"
sync_dir "$ORCHESTRA_DIR/claude/agents" "$CONSUMER/.claude/agents"
sync_dir "$ORCHESTRA_DIR/codex/skills"  "$CONSUMER/.codex/skills"
sync_dir "$ORCHESTRA_DIR/references"    "$CONSUMER/.references"

# Entries orchestra used to ship and has since removed or relocated: purged
# from consumers so a stale copy can't advertise a skill whose
# .references/agents/* counterparts --delete already removed. Names here were
# orchestra-owned, so this never touches consumer-local skills.
REMOVED_CLAUDE_SKILLS=(idea-duel dialectic)
for name in "${REMOVED_CLAUDE_SKILLS[@]}"; do
  rm -rf "$CONSUMER/.claude/skills/$name"
done
REMOVED_CLAUDE_AGENTS=(frontend-implementer discussant)
for name in "${REMOVED_CLAUDE_AGENTS[@]}"; do
  rm -f "$CONSUMER/.claude/agents/$name.md"
done

echo "synced orchestra -> $CONSUMER"
git -C "$CONSUMER" status --short -- .claude/skills .claude/agents .codex/skills .references
