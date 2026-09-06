# Orchestra Claude Code skills

This directory is a one-way mirror of `claude/skills/` in
[dcouple/orchestra](https://github.com/dcouple/orchestra). Any edit made in a
consumer repo is overwritten by the next sync PR. Change skills in orchestra.

Repo-specific configuration (e.g. work-item tracking and where work-item
artifacts go) belongs in this repo's `AGENTS.md` / `CLAUDE.md`, never in
these files.

## Entrypoints

[`codex`](codex/SKILL.md) [`cold-read`](cold-read/SKILL.md) [`create-brief`](create-brief/SKILL.md) [`discussion`](discussion/SKILL.md) [`do`](do/SKILL.md) [`excalidraw-pr-diagrams`](excalidraw-pr-diagrams/SKILL.md) [`investigate`](investigate/SKILL.md) [`postmortem`](postmortem/SKILL.md) [`postmortem-loop`](postmortem-loop/SKILL.md) [`prepare-pull-request`](prepare-pull-request/SKILL.md) [`sentry-loop`](sentry-loop/SKILL.md)

`do/SKILL.md` routes to stage contracts under `do/references/`. Load
execution boundaries once, then the current stage and its conditional references.
Skill frontmatter and role instructions define this harness's routing; the
Claude and Codex entrypoints retain their own dispatch and QA procedures.
