# orchestra

The canonical home of our agent skill system: Claude Code skills and
sub-agents, Codex role skills, and the shared references they point to.
Skills are edited **only here** and synced one-way into each repo that uses
them ("consumer repos"). Never edit the synced copies in a consumer repo —
the next sync overwrites them.

What the workflow is and how models are routed: [WORKFLOW.md](WORKFLOW.md).

## Layout

| Directory | Contents | Synced to (in each consumer) |
|---|---|---|
| `claude/skills/` | Claude Code workflow skills (`/do`, `/create-*`, `/discussion`, `notion`, `postmortem`, `codex`, `excalidraw-pr-diagrams`) | `.claude/skills/` |
| `claude/agents/` | Claude sub-agent definitions (reviewers, researchers, verifiers, socrates) | `.claude/agents/` |
| `codex/skills/` | Codex role skills (implementer, verifiers, reviewers, researcher, investigator) — thin pointers into `references/` | `.codex/skills/` |
| `references/` | Shared skill-system documents: work-item formats, verification methods, rubrics, sub-agent role instructions and output formats | `.references/` |
| `templates/` | Per-project scaffolding (`AGENTS.md`, `CLAUDE.md`) to copy into a new consumer repo and fill in | not synced — copied once by hand |
| `scripts/sync.sh` | The mirror logic (four `rsync --delete` targets) | — |

## The rules that keep this sane

1. **One direction.** orchestra → consumer, via PR. Each consumer repo
   carries an `update-skills` script (e.g. `pnpm update-skills` in
   bloomapi/bloom-mono) that fetches this repo's `main`, runs
   `scripts/sync.sh` against a temp worktree, and opens (or force-updates)
   the consumer's `chore/orchestra-sync` PR. Run it after pushing a skill
   change here.
2. **Repo-agnostic skills.** Nothing in the synced directories may name a
   specific codebase, database ID, or machine path. All paths are
   consumer-repo-relative (`.references/…`, `.claude/agents/…`).
3. **Repo-specific knowledge lives in the consumer repo** — its `CLAUDE.md` /
   `AGENTS.md` (e.g. the `Work-item tracking` section with the Notion
   database) or its docs. Skills know to look there.
4. **Idempotent.** The sync is a full mirror (`rsync --delete`); running it
   twice produces zero diff. Nothing in the synced dirs is written to at
   runtime.
5. **Postmortems** are filed as `postmortem`-labeled issues in the repo where
   the run happened; proposed system changes are applied here in orchestra.

## Adding a consumer repo

1. Copy `templates/AGENTS.md` and `templates/CLAUDE.md` into the repo root and
   fill in the sections (including `Work-item tracking`).
2. Add an `update-skills` script to the repo that clones this repo and runs
   `scripts/sync.sh` in a temp worktree, then opens the sync PR —
   bloomapi/bloom-mono's `scripts/update-skills.sh` is the reference
   implementation.
3. Run it and merge the first sync PR.

## Manual sync

```bash
scripts/sync.sh /path/to/consumer-repo
```

The mirror primitive the consumer scripts wrap; useful for a first-time sync
or local testing. It mutates the target working tree and prints the diff —
committing and PR-ing is the caller's job.

## History

This repo supersedes the `tyler/` tree of `dcouple/skills`, which previously
synced to `~/.claude`, `~/.codex`, and `~/.references` on each machine. Skills
now travel with each consumer repo instead, so clones, CI, and cloud agents
get them with no machine setup.
