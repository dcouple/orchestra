# AGENTS.md

orchestra is the canonical home of the dcouple skill system: Claude Code
skills, sub-agent definitions, Codex role skills, and the shared
`references/` documents, synced one-way into consumer repos. The one thing
an agent must not break: everything under the synced directories
(`claude/`, `codex/`, `references/`) must stay repo-agnostic - no
consumer-specific names, paths, or IDs.

## Where to look

- [README.md](README.md): what this is, the layout, the sync model.
- [docs/workflow.md](docs/workflow.md): the workflow and model routing.
- [daemon/README.md](daemon/README.md): the daemon package, its checks, a local run.
- [RUNBOOK.md](RUNBOOK.md): operating a daemon deployment.
- [docs/daemon/](docs/daemon/): daemon configuration, macOS provisioning, deep procedures, MCP secrets.

## Commands

```bash
scripts/sync.sh <path-to-consumer-repo>   # mirror the skills into a consumer checkout
scripts/sync-user.sh                      # mirror into user-level ~/.claude, ~/.codex, ~/.references
scripts/check-dispatch-survival.sh        # Codex dispatches survive the parent shell exiting; run after editing the codex skill
```

CI (`.github/workflows/docs.yml`) checks relative links and anchors, and
that every `.references/`, `.claude/`, and `.codex/` path named in
`claude/`, `codex/`, `references/`, and `templates/` exists. Run the link
check locally with
`docker run --rm -v "$PWD":/input -w /input lycheeverse/lychee --offline --include-fragments './**/*.md'`.

Daemon checks are in [daemon/README.md](daemon/README.md#local-checks). They
need Node 22 and pnpm 11; under another Node major, `better-sqlite3` fails
to build, so put a Node 22 install first on `PATH`.

## Rules

- **Verify after every mutation.** After a merge, push, PR creation, file
  move, or any state change, read the actual result back.
- **Don't solve discoverable problems.** If an agent can query it at runtime
  (MCP, the environment, the repo), don't hardcode it. Describe roles,
  boundaries, and rules, not configuration.
- **Less is more.** Every line earns its place; remove a line that doesn't
  change behavior.
- **No feedback loops.** A step that mutates code after review invalidates
  downstream work. Refactoring and cold-read are manual skills, never inline.
- **Never use em dashes.** Use commas, periods, colons, or parentheses.

## Conventions

- Skills and references are repo-agnostic; all paths inside them are
  consumer-repo-relative (`.references/…`, `.claude/agents/…`). They resolve
  here too, because `.claude/skills`, `.claude/agents`, `.codex/skills`, and
  `.references` are symlinks to the canonical directories. Editing under
  the dot-paths edits the canonical copy.
- `daemon/` and `machines/` are orchestra-only: no sync script includes
  them, and daemon code never goes in a synced directory.
- `templates/` is scaffolding copied once into new consumer repos, never
  synced.
- Removing or renaming a top-level skill or agent: add the old name to the
  `REMOVED_*` lists in `scripts/sync.sh` (and, for agents,
  `scripts/sync-user.sh`) so syncs purge the stale copy.
- Skill, agent, and reference bodies state what exists. Rejected designs,
  removed modes, editor-facing warnings, and tuning rationale go in PR
  descriptions and commit messages. Sole exception: a one-line live footgun
  the invoking agent will hit this session.
- Shell in skill bodies never deletes through a shell variable (no
  `rm "$dir/$name".*`, no `rm -rf "$DIR"/`). Claude Code's critical-path
  check prompts on that form even under `--dangerously-skip-permissions`,
  which halts unattended runs. Write the resolved path as a literal, or
  don't delete.
- README illustrations follow [docs/assets/visual-style.md](docs/assets/visual-style.md).

## Docs

- A change that alters a command, path, env var, port, script, workflow, or
  deploy step updates every doc that states it, in the same PR. A doc you
  can no longer make true gets deleted, not left behind.
- Each topic has one home (README for humans, AGENTS.md for agent rules,
  RUNBOOK.md for operations, docs/ for depth). Link to it; never restate it.
- A skill, agent, or reference may only point at skills, agents, and
  references that ship from `claude/`, `codex/`, or `references/` on main.

## Work-item tracking

The workflow skills (`/create-brief`, `/do`) create work-item artifacts
(brief.html - the canonical HTML work item, refs/ including research
sub-reports, plan.md, wrapup.md) locally under `./tmp/<id>/`.
`./tmp/` is scratch - never commit it.

```yaml
tracker: github
github_repo: dcouple/orchestra
```

> Publish per `.references/publish-work-item.md`. No `artifact_host` is
> configured, so issues carry the markdown rendition of the brief.

## Boundaries

- Never run `scripts/sync.sh` pointed at a consumer repo automatically;
  syncs land in consumers via their own `update-skills` PR flow.
- Never provision, deploy, or restart a daemon deployment; RUNBOOK.md is
  for the operator. Deployment hosts, aliases, and hostnames live in the
  consumer repo's daemon docs, never in this repo.
- Don't commit `./tmp/` or `.DS_Store`.
