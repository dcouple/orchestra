# AGENTS.md

## What this project is

orchestra is the canonical home of the dcouple skill system: Claude Code
skills, sub-agent definitions, Codex role skills, and the shared
`references/` documents, synced one-way into consumer repos. The one thing
an agent must not break: everything under the synced directories
(`claude/`, `codex/`, `references/`) must stay repo-agnostic — no
consumer-specific names, paths, or IDs.

## Commands

The skill system is Markdown, HTML templates, and bash. The orchestra-only
Linear webhook daemon is a Node 22 / pnpm 11 TypeScript package.

```bash
# sync into a consumer repo checkout:
scripts/sync.sh <path-to-consumer-repo>
# mirror into user-level ~/.claude and ~/.codex dirs:
scripts/sync-user.sh

# daemon checks (run from daemon/):
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
bash -n ops/provision.sh ops/claudex
```

## Live daemon diagnostics

The user-level `~/.zshrc` alias `bloom-deamon` connects to the Bloom daemon
host for live service-log inspection. Its canonical target command is
`gcloud compute ssh linear-agent --project=bloom-agents --zone=us-central1-a`.

## Architecture

See the Layout table in `README.md`. Canonical sources live in
`claude/skills/`, `claude/agents/`, `codex/skills/`, and `references/`;
`scripts/sync.sh` mirrors them into consumers' dot-directories.

`daemon/` is an orchestra-only service package. Neither sync script includes
it, and daemon code must never be placed in a synced directory.

This repo is also a consumer of itself: `.claude/skills`, `.claude/agents`,
`.codex/skills`, and `.references` are **symlinks** to those canonical
directories, so the skills are usable when working on orchestra and are
always current. Unlike in consumer repos, editing under the dot-paths here
edits the canonical copy — that is intended.

## Conventions

- Skills and references are repo-agnostic; all paths inside them are
  consumer-repo-relative (`.references/…`, `.claude/agents/…`) — which
  resolve here too, via the symlinks.
- `templates/` is scaffolding copied once into new consumer repos, never
  synced.
- Skill, agent, and reference bodies state what exists. Rejected designs,
  removed modes, editor-facing warnings, and tuning/benchmark rationale go
  in PR descriptions and commit messages — not the body. Sole exception: a
  one-line live footgun the invoking agent will hit this session.

## Work-item tracking

The workflow skills (`/create-plan`, `/create-epic`,
`/do`) create work-item artifacts (item.md, refs/ including explainer.html,
plan.md, wrapup.md) locally under `./tmp/<id>/`. `./tmp/` is scratch —
never commit it.

```yaml
tracker: github
github_repo: dcouple/orchestra
artifact_host: https://linear-agent.bloomapi.com
```

> Publish a lean GitHub issue body containing the full frontmatter, an Intent
> summary, and an `Artifact bundle: <url>` link. The bundle is the complete
> artifact transport. Post no marker comments; marker comments remain only for
> legacy items published before this configured contract.

## Boundaries

- Never run `scripts/sync.sh` pointed at a consumer repo automatically —
  syncs land in consumers via their own `update-skills` PR flow.
- Don't commit `./tmp/` or `.DS_Store`.
