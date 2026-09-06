See @AGENTS.md for the project overview, commands, architecture, conventions,
and boundaries. Everything there applies here - do not duplicate it.

Work-item tracking (where work items are published and where their
artifacts go) is defined in `AGENTS.md` - the skills read it from there.

## Rules

- Discover runtime configuration through the repo or tools; do not hardcode it.
- Fixes after review invalidate affected evidence. Keep final QA after the last
  reviewed code change. Refactoring and cold-read remain manual skills.
- Do not use em dashes.

## Claude-specific notes

- `.claude/`, `.codex/`, and `.references/` are symlinks to this repo's own
  canonical `claude/`, `codex/`, and `references/` directories - orchestra
  consumes its own skills. Editing under the dot-paths edits the canonical
  copy, which here (unlike in consumer repos) is exactly right.
