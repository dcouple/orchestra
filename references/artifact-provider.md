# Artifact provider — contract

The orchestra skills are platform-agnostic. By default, work-item artifacts
(`item.md`, `refs/`, `plan.md`, `wrapup.md`) are created locally under
`./tmp/<id>/` and published durably to the GitHub issue itself as
marker-delimited comments (see `publish-work-item.md`). No external tool or
application is assumed.

A repo may opt into a richer artifact host — a **provider** — by naming one
in its `CLAUDE.md` `Work-item tracking` section (`provider: <name>`, plus
whatever config that provider documents). The provider is implemented as a
skill named `provider-<name>` living in the consumer repo's
`.claude/skills/` — provider skills are consumer-owned; the orchestra sync
leaves `provider-*` directories alone. Orchestra's own skills never name a
specific product; they invoke the configured provider only through this
contract. Example implementations ship in orchestra's `templates/providers/`
directory — copy one in and adapt it; they are not synced.

## Operations

One invocation = one operation.

### publish  (called from the shared publish procedure)

Inputs: `./tmp/<id>/` with a ready `item.md`, plus the GitHub issue URL the
caller just created.

- Create or update exactly one provider page/record for the work item —
  dedup by the GitHub issue URL, so a re-publish updates in place, never
  duplicates.
- Host every artifact (`item.md` and everything in `refs/`) in a form
  `pull` can later recover byte-identically.
- Return the page URL. The caller cross-links both ways: append the
  canonical line `**Artifacts:** <page URL>` to the end of the GitHub issue
  body, and record the URL in `item.md` frontmatter as `artifacts:`. The
  exact `**Artifacts:**` line format matters — `pull` looks for it.

### upload  (called by /do at wrap-up, or ad hoc)

Inputs: the work item's provider page URL (from `item.md` frontmatter
`artifacts:` or the issue body) and the files to add (`plan.md`,
`wrapup.md`, new refs).

- Add each file; update in place if one with the same name exists (a re-run
  replaces, never duplicates).
- Update the item's status to match `item.md` (`done` after a successful
  `/do`), and add the PR URL if provided.

### pull  (called by /do before work)

Inputs: a GitHub issue number/URL or a provider page URL.

- From an issue: find the canonical `**Artifacts:** <url>` line in its body.
  None → return `NO PROVIDER ITEM` (the caller falls back to the issue body
  and its artifact comments).
- Recover `item.md` to `./tmp/<id>/item.md` and every hosted artifact to
  `./tmp/<id>/refs/<name>` (a prior run's plan to `./tmp/<id>/plan.md`). A
  local `./tmp/<id>/` that already exists wins over anything fetched — disk
  is the working truth; only fill gaps.
- May set the provider-side status (e.g. `in-progress`) so any board stays
  honest while `/do` runs.
- Return the local paths written.

## Unavailability

If the provider's tools/CLI can't be reached, return
`PROVIDER UNAVAILABLE: <what was tried>`. Callers proceed GitHub + local
only and say so — provider trouble never stops a run.

## Rules

- `./tmp/<id>/` on disk is the working truth during a run; the provider is
  a mirror — push at milestones (publish, wrap-up), don't sync continuously.
- Never store secrets with a provider; artifacts only.
- One work item = one provider page.
