#!/usr/bin/env bash
# OPTIONAL user-level install: mirror orchestra into ~/.claude, ~/.codex,
# ~/.references so skills are available in every repo on this machine, not
# just consumer repos. The consumer-repo sync (scripts/sync.sh) remains the
# canonical path — this is a personal convenience layer on top.
#
# No blanket --delete: user-level dirs are a union space (personal skills and
# p-* preserves live alongside). Exact tombstones purge retired orchestra files.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

CS="$HOME/.claude/skills"; CA="$HOME/.claude/agents"
XS="$HOME/.codex/skills";  RF="$HOME/.references"
mkdir -p "$CS" "$CA" "$XS" "$RF"

rsync -a "$REPO/claude/skills/" "$CS/"
rsync -a "$REPO/claude/agents/" "$CA/"
rsync -a "$REPO/codex/skills/"  "$XS/"
rsync -a "$REPO/references/"    "$RF/"

# Retired orchestra-owned entries are safe to purge by exact name while the
# surrounding user-level directories remain a union space.
REMOVED_CLAUDE_AGENTS=(frontend-implementer discussant)
for name in "${REMOVED_CLAUDE_AGENTS[@]}"; do
  rm -f "$CA/$name.md"
done

# Synced content addresses shared docs repo-relative (.references/...) per
# rule 2 — correct inside consumer repos, broken at user level. Rewrite the
# INSTALLED copies (never the repo) to the absolute home path.
grep -rl '\.references/' "$CS" "$CA" "$XS" 2>/dev/null | while read -r f; do
  perl -pi -e 's{(?<![~\w/])\.references/}{~/.references/}g' "$f"
done

echo "user-level sync complete."
