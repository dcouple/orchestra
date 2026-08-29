See @AGENTS.md for the project overview, commands, architecture, conventions,
and boundaries. Everything there applies here - do not duplicate it.

Work-item tracking (where work items are published and where their
artifacts go) is defined in `AGENTS.md` - the skills read it from there.

## Rules

- **You must verify after every mutation.** After a merge, push, PR
  creation, file move, or any operation that changes state: read the
  actual result back. Never trust command output alone - check that the
  change landed where you expected it to.

- **You must not solve discoverable problems.** If the agent can query it
  at runtime (via MCP, the environment, or the repo), don't hardcode it.
  Describe roles, boundaries, and rules - not configuration.

- **Less is more.** Every line should earn its place. If removing a line
  wouldn't change behavior, remove it. Overspecification leads to
  configuration ceremony, leads to brittleness. When things are brittle,
  they break.

- **No feedback loops.** A step that mutates code after review invalidates
  downstream work. The pipeline is linear. Refactoring and cold-read are
  manual skills, never inline.

- **You must never use em dashes.** Use commas, periods, colons, or
  parentheses instead.

## Claude-specific notes

- `.claude/`, `.codex/`, and `.references/` are symlinks to this repo's own
  canonical `claude/`, `codex/`, and `references/` directories - orchestra
  consumes its own skills. Editing under the dot-paths edits the canonical
  copy, which here (unlike in consumer repos) is exactly right.
