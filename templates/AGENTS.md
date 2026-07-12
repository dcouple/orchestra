# AGENTS.md — template

> Copy this file to a codebase's root as `AGENTS.md` and fill in each section.
> This is the **universal** instruction file: every coding agent (Claude,
> Codex, or any other harness) reads it. Keep anything harness-specific out —
> `CLAUDE.md` points here and adds the Claude-only parts. Delete this header
> block after copying.

## What this project is

One or two sentences: what the product does, who uses it, and the one thing an
agent must not break.

## Commands

The exact commands, not descriptions. Agents run these verbatim.

```bash
# install:    <e.g. npm install>
# dev server: <e.g. npm run dev>
# typecheck:  <e.g. npm run typecheck>
# lint:       <e.g. npm run lint>
# format:     <e.g. npm run format>
# tests:      <e.g. npm run test>
# build:      <e.g. npm run build>
```

## Architecture

The map an agent needs before editing — keep it to what's load-bearing:

- Top-level layout: which directory owns what.
- The request/data flow in one paragraph (e.g. route → service → repository).
- Where new code of each common kind goes (endpoint, component, migration,
  background job).

## Conventions

Only rules an agent would otherwise get wrong — not a style guide:

- Patterns to follow (name the canonical example file for each).
- Things that look editable but aren't (generated files, vendored code).
- Error-handling and logging idioms.

## Work-item tracking

The workflow skills (`/create-feature`, `/create-epic`, `/create-issue`,
`/do`) create work-item artifacts (item.md, refs/ including explainer.html,
plan.md, wrapup.md) locally under `./tmp/<id>/`. `./tmp/` is scratch —
never commit it.

This section decides where work items get published. Describe the
destination and the exact steps — the skills follow these instructions at
publish, pull, and wrap-up. If this section gives no instructions, nothing
is published: work items stay local under `./tmp/<id>/`.

Example — publish to GitHub issues (replace or delete):

```yaml
tracker: github
github_repo: <owner>/<repo>   # where gh issue create targets; omit to use the current repo
```

> Publish every work item as a self-contained GitHub issue: `item.md` is
> the issue body; `refs/` files ride as marker-delimited issue comments.

## Boundaries

- Commands that must never run automatically (destructive ops, deploys,
  production migrations).
- Files/paths that are off-limits.
- Secrets: where config lives; never commit values.
