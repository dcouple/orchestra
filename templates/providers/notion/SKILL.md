---
name: provider-notion
description: Example artifact-provider implementation (Notion) — creates a provider work item mirroring a GitHub issue, uploads artifacts (item.md, refs/, plan.md, wrapup.md) to it, and pulls a work item's artifacts down to ./tmp/<id>/. Implements the publish/upload/pull contract in .references/artifact-provider.md; invoked by the workflow skills when the repo's CLAUDE.md sets `provider: notion`.
argument-hint: "[publish|upload|pull] [work-item id, GitHub issue #/URL, or provider page URL]"
---

# Notion artifact provider (example implementation)

> **Not synced.** This is an example provider from orchestra's
> `templates/providers/` directory. To use it, copy this directory into a
> consumer repo as `.claude/skills/provider-notion/` and set
> `provider: notion` in that repo's `CLAUDE.md` `Work-item tracking`
> section. Provider skills are consumer-owned — the orchestra sync leaves
> `provider-*` directories alone. To target a different platform, copy this
> skill and swap the platform mechanics; the contract it implements is
> `.references/artifact-provider.md`.

## Request: $ARGUMENTS

The provider is the durable home for work-item artifacts; GitHub carries the
issue and the PR; `./tmp/<id>/` is the local working copy. This skill is the
one place that knows how to move material between the three. One invocation
= one operation: `publish`, `upload`, or `pull`.

## Setup (every invocation)

1. **Load the platform tools**: use ToolSearch with a query like
   `+notion search create fetch update attachment` and load what the
   operation needs (search, fetch, create-pages, update-page,
   create-attachment). Tool names vary by connector — match on the `notion`
   prefix. If no MCP tools resolve and no `notion` CLI is on PATH, return
   `PROVIDER UNAVAILABLE: <what was tried>` — the caller proceeds
   GitHub + local only and says so.
2. **Find the target database** — resolution order, most specific wins:
   1. The project `CLAUDE.md`'s `Work-item tracking` section
      (`notion_data_source`, optional `properties`) — per-repo override.
   2. `config.yaml` in this skill's directory — the default this copy was
      set up with.
   3. Neither set → search the workspace for the work-items database once,
      confirm the match with the user, and offer to save it into the project
      `CLAUDE.md`'s `Work-item tracking` section so the search never
      repeats.

**Success criteria**: tools loaded and a data source resolved (or an explicit
`PROVIDER UNAVAILABLE`).

## Operation: publish  (called by the shared publish procedure)

Inputs: `./tmp/<id>/` with a ready `item.md`, plus the GitHub issue URL the
caller just created.

1. Dedup first: query the data source for a page whose GitHub-issue-URL
   property equals this issue — an exact property query, not workspace
   full-text search. Found → this publish updates that page in place.
2. Create (or update) one page in the work-items data source:
   - Title: the item's title (same as the GitHub issue title).
   - Properties (as the database schema allows): GitHub issue URL, work-item
     type (`feature-ticket | epic-spec | bug-report`), status `ready`.
   - Page body: a **high-level summary only** — intent / desired end state
     (a few sentences), a one-line verification summary, and links to the
     GitHub issue and attached files. The page is a board card, not a
     mirror; the full item travels as files.
3. Attach every file — `item.md`, `refs/explainer.html`, and everything
   else in `./tmp/<id>/refs/` — to the database's files property
   (`properties.files`, default `Files`), named as on disk; if the schema
   has no files property, attach them to the page body instead. Also write
   the RAW bytes of `item.md` and each markdown ref to a sub-page named
   `raw/<name>` whose entire content is one fenced code block: the platform
   re-renders rendered content but never touches code-block contents, and
   file attachments are served as expiring, integration-scoped URLs that
   another session's pull may 404 on — the `raw/` sub-pages are what make
   pull reliable.
4. Return the new page URL to the caller — the caller cross-links it in both
   directions per the contract: append the canonical line
   `**Artifacts:** <page URL>` to the end of the GitHub issue body
   (`gh issue edit --body-file`), and write the URL into `item.md`'s
   frontmatter as `artifacts:`. When publish runs ad hoc (no calling skill),
   do both edits as part of this operation. The exact `**Artifacts:**` line
   format matters — `pull` looks for it.

**Success criteria**: page exists with the item summary and every `refs/`
file; page URL returned.

## Operation: upload  (called by /do at wrap-up, or ad hoc)

Inputs: the work item's provider page URL (from `item.md` frontmatter
`artifacts:` or the GitHub issue body) and the files to add (`plan.md`,
`wrapup.md`, new refs).

1. Add each file as in publish step 3 (files property + `raw/` sub-page for
   markdown) — update in place if one with the same name exists (a re-run
   replaces, never duplicates).
2. Update the page's status property to match `item.md` (`done` after a
   successful `/do`), and add the PR URL if provided.

**Success criteria**: every input file visible on the page; status/PR current.

## Operation: pull  (called by /do before work)

Inputs: a GitHub issue number/URL or a provider page URL.

1. If given a GitHub issue: `gh issue view` and find the canonical
   `**Artifacts:** <url>` line in its body (fall back to any workspace page
   URL found anywhere in the body). No provider link → return
   `NO PROVIDER ITEM` (the caller falls back to treating the issue body
   itself as the work item).
2. Fetch the page. Derive `<id>` from the item's frontmatter `id:` (or slug
   the title). Prefer the `raw/item.md` code-block sub-page when present —
   its contents are byte-identical to what was published. Only legacy pages
   carry a full mirror in the body; on current pages the body is just a
   summary, so reconstructing `item.md` from it is a last resort. Treat file-
   attachment 404s as normal (expiring, integration-scoped URLs), never as
   an error worth stopping for.
3. Fetch every sub-page and attachment; save each to `./tmp/<id>/refs/<name>`
   (same preference: `raw/<name>` code block over rendered sub-page). If a
   plan from a prior run exists, save it as `./tmp/<id>/plan.md`. A local
   `./tmp/<id>/` that already exists wins over anything fetched — disk is
   the working truth; only fill gaps.
4. Set the page's status property to `in-progress` — the database stays an
   honest at-a-glance board while `/do` runs (`upload` flips it to `done`).
5. Return the local paths written.

**Success criteria**: `./tmp/<id>/item.md` exists locally and every artifact
on the page has a local copy under `./tmp/<id>/`.

## ntn CLI notes

When the platform is reached via the `ntn` CLI (no MCP tools resolve):
- `ntn pages create` hangs — create pages with `ntn api /v1/pages -d '<json>'`
  instead, then set the body with `ntn pages edit <id> --content="$(cat file.md)"`.
- Always use the `--content=` equals form: with a space, markdown starting with
  `---` frontmatter is parsed as CLI flags.

## Rules

- The provider page is the mirror, `item.md` on disk is the working truth
  during a run — push at milestones (publish, wrap-up), don't sync
  continuously.
- Never store secrets in provider pages; artifacts only.
- One work item = one page. Dedup by exact GitHub-issue-URL property query
  against the data source (workspace full-text search only as a fallback) —
  re-publishing must update, not duplicate.
