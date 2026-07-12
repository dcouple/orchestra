# orchestra

The canonical home of our agent skill system: Claude Code skills and
sub-agents, Codex role skills, and the shared references they point to.
Skills are edited **only here** and synced one-way into each repo that uses
them ("consumer repos"). Never edit the synced copies in a consumer repo —
the next sync overwrites them.

## Layout

| Directory | Contents | Synced to (in each consumer) |
|---|---|---|
| `claude/skills/` | Claude Code workflow skills (`/do`, `/create-*`, `/discussion`, `notion`, `postmortem`, `codex`) | `.claude/skills/` |
| `claude/agents/` | Claude sub-agent definitions (reviewers, researchers, verifiers, socrates) | `.claude/agents/` |
| `codex/skills/` | Codex role skills (implementer, verifiers, reviewers, researcher, investigator) — thin pointers into `references/` | `.codex/skills/` |
| `references/` | Shared skill-system documents: work-item formats, verification methods, rubrics, sub-agent role instructions and output formats | `.references/` |
| `templates/` | Per-project scaffolding (`AGENTS.md`, `CLAUDE.md`) to copy into a new consumer repo and fill in | not synced — copied once by hand |
| `scripts/sync.sh` | The mirror logic (four `rsync --delete` targets) | — |

## The rules that keep this sane

1. **One direction.** orchestra → consumer, via PR. A push to `main` touching
   `claude/**`, `codex/**`, or `references/**` triggers
   `.github/workflows/sync-consumers.yml`, which mirrors the four targets into
   each consumer and opens (or force-updates) a `chore/orchestra-sync` PR there.
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
2. Add the repo to the `matrix.consumer` list in
   `.github/workflows/sync-consumers.yml`.
3. Ensure the `ORCHESTRA_SYNC_TOKEN` secret (fine-grained PAT) has Contents +
   Pull-requests write access to the new repo.
4. Run the workflow (`gh workflow run sync-consumers.yml`) and merge the sync
   PR it opens.

## Manual sync

```bash
scripts/sync.sh /path/to/consumer-repo
```

Same mirror the workflow runs; useful for a first-time sync or local testing.

## History

This repo supersedes the `tyler/` tree of `dcouple/skills`, which previously
synced to `~/.claude`, `~/.codex`, and `~/.references` on each machine. Skills
now travel with each consumer repo instead, so clones, CI, and cloud agents
get them with no machine setup.
