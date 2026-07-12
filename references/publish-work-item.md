# Publish a work item — shared procedure

Used by `/create-feature`, `/create-epic`, and `/create-issue` after
`item.md` is written. The caller supplies the issue title prefix (`feat:` or
`fix:`) and the issue body summary.

GitHub is the only assumed platform. Artifacts are created and kept locally
under `./tmp/<id>/`, and the published issue is self-contained. If the
project's `AGENTS.md` `Work-item tracking` section specifies a different
destination for work-item artifacts, follow its instructions instead of
step 3's default — the orchestra skills themselves never assume any
particular tool or application.

1. Set `status: ready` in `item.md`.
2. Create the GitHub issue: `gh issue create` in the project's repo (from the
   `Work-item tracking` section of the project's `AGENTS.md`, or the current
   repo) — title `<prefix> <item title>`, body per the caller. Record the
   issue URL in `item.md` frontmatter as `github:`.
3. The issue itself must carry everything a remote `/do` needs. GitHub issue
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

Done when: the issue exists, every artifact is reachable from it
(marker-delimited comments, or the destination `AGENTS.md` specified), and
the issue and `item.md` link to each other.
