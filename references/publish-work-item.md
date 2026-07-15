# Publish a work item — shared procedure

Used by `/create-plan` and `/create-epic` after
`item.md` is written. The caller supplies the title prefix (`feat:` or
`fix:`) and the summary that becomes the published body.

Orchestra assumes no tracker. The skills define *what* gets published —
`item.md` plus every `refs/` file — and the consumer repo defines *where*:
the `Work-item tracking` section of the project's `AGENTS.md` (or
`CLAUDE.md`) is the only authority on the destination.

1. Set `status: ready` in `item.md`.
2. Read the project's `Work-item tracking` section and publish exactly as
   it instructs — GitHub issues, Linear, or anything else it documents.
   Treat tracker organization, workspace, project, and team names as
   repo-specific configuration. Resolve them from the project's instructions
   or explicit user input; if a required destination remains unspecified or
   ambiguous, ask before publishing.
   Title `<prefix> <item title>`, body per the caller. Upload or attach
   `item.md` and the `refs/` files however the destination supports, so
   the published item carries everything a remote `/do` needs. Record
   every URL the destination returns in `item.md` frontmatter (e.g.
   `github:`, `tracker:`) so `/do` can pull from it.
3. If the section is missing or gives no publishing instructions, publish
   nowhere: the work item is complete as local files under `./tmp/<id>/`.
   Tell the user nothing was published and where the files live.

When the configured destination is GitHub issues and the instructions
don't already say how to attach artifacts: issue attachments are
web-UI-only (no API/CLI path), so post each artifact as its own issue
comment, wrapped in markers so `/do`'s Step 0 can harvest them back:

```
<!-- ORCHESTRA-ARTIFACT path="refs/explainer.html" -->
<full file content>
<!-- /ORCHESTRA-ARTIFACT -->
```

One comment per file (`item.md` itself is the issue body, so just the
`refs/` files). A comment holds ~65K chars; split oversized files into
`part=1/2` markers. Binary refs (images, archives) can't ride in comments —
note them in the issue body by path and keep them in `./tmp/<id>/refs/`.

Done when: the item is published per the repo's instructions, every
artifact is reachable from it, and the published item and `item.md` link
to each other — or, when the repo configures no destination, the artifacts
are in `./tmp/<id>/` and the user has been told so.
