#!/usr/bin/env bash
# OPTIONAL user-level install: mirror orchestra into ~/.claude, ~/.agents,
# ~/.codex, and ~/.references so skills are available in every repo on this
# machine, not just consumer repos. Set ORCHESTRA_SYNC_HOME to exercise the
# complete install safely inside a disposable home.
#
# No blanket --delete: user-level dirs are a union space (personal skills and
# p-* preserves live alongside). Exact tombstones purge retired orchestra files.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SYNC_HOME="${ORCHESTRA_SYNC_HOME:-${HOME}}"
case "$SYNC_HOME" in
  /*) ;;
  *) echo "error: ORCHESTRA_SYNC_HOME must be an absolute path" >&2; exit 2 ;;
esac
if [[ "$SYNC_HOME" == / ]]; then
  echo "error: refusing to use / as the sync home" >&2
  exit 2
fi
SYNC_HOME="$(
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$SYNC_HOME"
)"
if [[ "$SYNC_HOME" == / ]]; then
  echo "error: refusing to use / as the sync home" >&2
  exit 2
fi
mkdir -p "$SYNC_HOME"
SYNC_HOME="$(cd "$SYNC_HOME" && pwd -P)"

CS="$SYNC_HOME/.claude/skills"; CA="$SYNC_HOME/.claude/agents"
AS="$SYNC_HOME/.agents/skills"; XA="$SYNC_HOME/.codex/agents"
LEGACY_XS="$SYNC_HOME/.codex/skills"; RF="$SYNC_HOME/.references"
mkdir -p "$CS" "$CA" "$AS" "$XA" "$LEGACY_XS" "$RF"

# Mirror only orchestra-owned top-level entries with --delete. Unrelated
# entries in these union directories are never scanned, rewritten, or removed.
sync_owned_entries() {
  local src="$1" dst="$2" entry name
  for entry in "$src"/* "$src"/.[!.]* "$src"/..?*; do
    [[ -e "$entry" ]] || continue
    name="$(basename "$entry")"
    if [[ -d "$entry" ]]; then
      mkdir -p "$dst/$name"
      rsync -a --delete "$entry/" "$dst/$name/"
    else
      rsync -a "$entry" "$dst/$name"
    fi
  done
}

sync_owned_entries "$REPO/claude/skills" "$CS"
sync_owned_entries "$REPO/claude/agents" "$CA"
sync_owned_entries "$REPO/codex/skills" "$AS"
sync_owned_entries "$REPO/codex/agents" "$XA"
sync_owned_entries "$REPO/references" "$RF"

REMOVED_CLAUDE_SKILLS=(idea-duel dialectic)
for name in "${REMOVED_CLAUDE_SKILLS[@]}"; do
  rm -rf "${CS:?}/$name"
done
REMOVED_CLAUDE_AGENTS=(frontend-implementer discussant)
for name in "${REMOVED_CLAUDE_AGENTS[@]}"; do
  rm -f "$CA/$name.md"
done

REMOVED_CODEX_SKILLS=(
  backend-verifier
  code-researcher
  code-reviewer
  implementer
  investigate
  investigator
  plan-reviewer
)
for name in "${REMOVED_CODEX_SKILLS[@]}"; do
  rm -rf "${LEGACY_XS:?}/$name"
done

# Synced content addresses shared docs repo-relative (.references/...) per
# rule 2 — correct inside consumer repos, broken at user level. Rewrite the
# installed orchestra-owned copies only (never personal union-space entries).
rewrite_owned_entries() {
  local src="$1" dst="$2" entry target
  for entry in "$src"/* "$src"/.[!.]* "$src"/..?*; do
    [[ -e "$entry" ]] || continue
    target="$dst/$(basename "$entry")"
    [[ -e "$target" ]] || continue
    if [[ -d "$target" ]]; then
      while IFS= read -r -d '' file; do
        if grep -q '\.references/' "$file" 2>/dev/null; then
          ORCHESTRA_REFERENCE_ROOT="$SYNC_HOME/.references" \
            perl -pi -e \
              's{(?<![~\w/])\.references/}{$ENV{ORCHESTRA_REFERENCE_ROOT} . "/"}ge' \
              "$file"
        fi
      done < <(find "$target" -type f -print0)
    elif grep -q '\.references/' "$target" 2>/dev/null; then
      ORCHESTRA_REFERENCE_ROOT="$SYNC_HOME/.references" \
        perl -pi -e \
          's{(?<![~\w/])\.references/}{$ENV{ORCHESTRA_REFERENCE_ROOT} . "/"}ge' \
          "$target"
    fi
  done
}

rewrite_owned_entries "$REPO/claude/skills" "$CS"
rewrite_owned_entries "$REPO/claude/agents" "$CA"
rewrite_owned_entries "$REPO/codex/skills" "$AS"
rewrite_owned_entries "$REPO/codex/agents" "$XA"

echo "user-level sync complete: $SYNC_HOME"
