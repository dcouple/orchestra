# Publish a work item — shared procedure

Used by `/create-feature`, `/create-epic`, and `/create-issue` after
`item.md` is written. The caller supplies the issue title prefix (`feat:` or
`fix:`) and the issue body summary.

GitHub is the only assumed platform. A richer artifact host (Notion today,
anything else tomorrow) is a **provider** — used only when the project's
`CLAUDE.md` `Work-item tracking` section names one (`provider: notion`, plus
whatever config that provider skill needs). The orchestra skills themselves
stay provider-agnostic.

1. Set `status: ready` in `item.md`.
2. Create the GitHub issue: `gh issue create` in the project's repo (from the
   `Work-item tracking` section of the project's `CLAUDE.md`, or the current
   repo) — title `<prefix> <item title>`, body per the caller.
3. **Provider configured** → invoke that provider's skill, operation
   `publish`, with `./tmp/<id>/` and the issue URL — it hosts the artifacts
   (`item.md` + every `refs/` file, including `explainer.html`) and returns a
   page URL. Cross-link: add the page URL to the GitHub issue body
   (`gh issue edit`), and record both in `item.md` frontmatter (`github:` and
   the provider's key, e.g. `notion:`).
4. **No provider configured, or the provider returns UNAVAILABLE** → the
   issue itself must carry everything a remote `/do` needs. GitHub issue
   attachments are web-UI-only (no API/CLI path), so post each artifact as
   its own issue comment, wrapped in markers so Step 0 can harvest them back:

   ```
   <!-- ORCHESTRA-ARTIFACT path="refs/explainer.html" -->
   <full file content>
   <!-- /ORCHESTRA-ARTIFACT -->
   ```

   One comment per file (`item.md` itself is the issue body, so just the
   `refs/` files). A comment holds ~65K chars; split oversized files into
   `part=1/2` markers. Binary refs (images, archives) can't ride in comments —
   note them in the issue body by path and keep them in `./tmp/<id>/refs/`.
   If a provider was configured but unavailable, tell the user it was skipped
   and the issue is self-contained.

Done when: the issue exists, every artifact is reachable from it (provider
page, or marker-delimited comments), and each of issue / provider page /
item.md links to the others.
