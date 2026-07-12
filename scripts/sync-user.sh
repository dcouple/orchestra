#!/usr/bin/env bash
# OPTIONAL user-level install: mirror orchestra into ~/.claude, ~/.codex,
# ~/.references so skills are available in every repo on this machine, not
# just consumer repos. The consumer-repo sync (scripts/sync.sh) remains the
# canonical path — this is a personal convenience layer on top.
#
# No --delete on purpose: user-level dirs are a union space (personal skills,
# p-* preserves from other sets live alongside). This only adds/updates.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

CS="$HOME/.claude/skills"; CA="$HOME/.claude/agents"
XS="$HOME/.codex/skills";  RF="$HOME/.references"
mkdir -p "$CS" "$CA" "$XS" "$RF"

rsync -a "$REPO/claude/skills/" "$CS/"
rsync -a "$REPO/claude/agents/" "$CA/"
rsync -a "$REPO/codex/skills/"  "$XS/"
rsync -a "$REPO/references/"    "$RF/"

# Synced content addresses shared docs repo-relative (.references/...) per
# rule 2 — correct inside consumer repos, broken at user level. Rewrite the
# INSTALLED copies (never the repo) to the absolute home path.
grep -rl '\.references/' "$CS" "$CA" "$XS" 2>/dev/null | while read -r f; do
  perl -pi -e 's{(?<![~\w/])\.references/}{~/.references/}g' "$f"
done

echo "user-level sync complete."
