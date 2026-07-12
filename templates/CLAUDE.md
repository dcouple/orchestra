# CLAUDE.md — template

> Copy this file to a codebase's root as `CLAUDE.md` and fill in each section.
> Universal instructions live in `AGENTS.md` (single copy, both harnesses);
> this file adds only what is Claude-specific. Delete this header block after
> copying.

See @AGENTS.md for the project overview, commands, architecture, conventions,
and boundaries. Everything there applies here — do not duplicate it.

## Work-item tracking

The workflow skills (`/create-feature`, `/create-epic`, `/create-issue`,
`/do`) publish every work item as a GitHub issue. By default the issue is
self-contained (artifacts ride as marker-delimited comments). Naming a
`provider` here opts this repo into a richer artifact host — its skill hosts
`item.md` + `refs/` and gets cross-linked from the issue.

```yaml
github_repo: <owner>/<repo>   # where gh issue create targets; omit to use the current repo
# provider: notion            # OPT-IN — artifact host for this repo; omit for GitHub-only
# notion_data_source: <ID or URL>   # OVERRIDE only — the default lives in the
#                                   # notion skill's config.yaml; set this only
#                                   # if this repo publishes to a different database
# properties: <only if they differ from the defaults in the notion skill's
#              config.yaml — list the property names/schema to use>
```

Work-item artifacts (item.md, refs/ including explainer.html, plan.md,
wrapup.md) live locally under `./tmp/<id>/` during a run and durably with
the published issue (provider page, or issue comments). `./tmp/` is
scratch — never commit it.

## Claude-specific notes

- Sub-agent and skill definitions live in this repo (`.claude/`, `.codex/`,
  `.references/`), synced one-way from `dcouple/orchestra` — never edit them
  here; change them in orchestra and let the sync PR bring them in.
- <anything else only Claude needs: MCP servers to prefer, browser-automation
  notes for the frontend-verifier agent, model-routing exceptions for this project>
