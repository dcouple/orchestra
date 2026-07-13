# CLAUDE.md — template

> Copy this file to a codebase's root as `CLAUDE.md` and fill in each section.
> Universal instructions live in `AGENTS.md` (single copy, both harnesses);
> this file adds only what is Claude-specific. Delete this header block after
> copying.

See @AGENTS.md for the project overview, commands, architecture, conventions,
and boundaries. Everything there applies here — do not duplicate it.

Work-item tracking (where work items are published and where their
artifacts go) is defined in `AGENTS.md` — the skills read it from there.

Run notifications and their two-way reply target are configured in
`AGENTS.md` (`Run notifications` section) — the skills read them there.

## Claude-specific notes

- Sub-agent and skill definitions live in this repo (`.claude/`, `.codex/`,
  `.references/`), synced one-way from `dcouple/orchestra` — never edit them
  here; change them in orchestra and let the sync PR bring them in.
- <anything else only Claude needs: MCP servers to prefer, browser-automation
  notes for the frontend-verifier agent, model-routing exceptions for this project>
