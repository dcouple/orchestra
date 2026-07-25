# Publish a work item — shared procedure

Used by `/create-plan` after `plan.html` is written. The caller supplies the
title prefix (`feat:` or `fix:`) and the summary used in the published
tracker body. "Metadata" below always means the YAML in the plan's
`#orchestra-meta` head element (`.references/html-plan.md` · Metadata) —
read and written there, never in the page body.

Orchestra assumes no tracker. The skills define *what* gets published —
`plan.html` plus every `refs/` file — and the consumer repo defines *where*:
the `Work-item tracking` section of the project's `AGENTS.md` (or
`CLAUDE.md`) is the only authority on the destination.

`plan.html` and its `refs/` are always authored and kept locally under
`./tmp/<id>/` — publishing never changes what exists on disk. The
destination decides the transport: with an `artifact_host:` key the bundle
is the transport and the tracker gets a lean body (below); without one,
fall back to a **markdown rendition** of the plan as the tracker body
(**Without `artifact_host`** below). If the `Work-item tracking` section is
missing or gives no publishing instructions, publish nowhere: the work item
is complete as local files under `./tmp/<id>/`, and the user is told where
they live.

## With `artifact_host`

Read the bearer token from `ARTIFACT_HOST_TOKEN`. Build the manifest from
`plan.html`, any present `impl-plan.md` and `wrapup.md`, and every regular
file under `refs/`. Follow `.references/artifact-host-upload.md` for host
and token resolution, manifest construction, authenticated `POST`/`PUT`
requests, read URLs, cleanup, and the retry-once rule.

On first publish, perform these steps in order:

1. Set `status: ready` in the metadata, build the manifest, and send it to
   `POST <artifact_host>/a` with `Authorization: Bearer
   $ARTIFACT_HOST_TOKEN`.
2. Record the returned `url` in the metadata as `artifact_bundle:`. Rebuild
   the manifest and send it with authenticated `PUT` to that URL with its
   trailing slash removed, so the bundle's own `plan.html` carries the
   stable URL.
3. Only then create the tracker item, titled `<prefix> <item title>`. Its
   lean tracker body contains the item's full metadata YAML (as a fenced
   block), a short summary drawn from its Intent, and the bundle pointer. A
   GitHub body uses an `Artifact bundle: <url>` link line. For Linear,
   create an `attachmentCreate` attachment card after the item exists. For
   a multi-phase item, also render the metadata's `phases` list as a
   checklist in the lean tracker body so tracker-side completion ticks
   remain visible.
4. After tracker creation, record the canonical returned tracker
   URL/identifier in the local metadata: `github:` (or other tracker
   fields), or a `linear_issues` always-list entry for Linear:

   ```yaml
   linear_issues:
     - url: https://linear.app/<workspace>/issue/TEAM-123/<slug>
       identifier: TEAM-123
       relationship: completes
   ```

   `relationship` is exactly `completes` or `relates`. **YOU MUST** derive
   the paired identifier from the canonical URL returned by Linear. The
   identifier is the later lookup key; only `completes` entries generate
   standalone `Fixes TEAM-123` lines.

   Then rebuild the manifest one final time and send an authenticated `PUT`
   to the `artifact_bundle` URL with its trailing slash removed. This final
   PUT is mandatory: it makes the bundle's authoritative `plan.html` link
   back to the tracker while the tracker body or attachment links to the
   bundle.

Post no marker comments. The bundle's `plan.html`, `refs/`, and present
milestone `impl-plan.md` and `wrapup.md` are the complete artifact
transport; the lean tracker item is state plus summary plus pointer.
(Legacy items published under the old full-body contract keep their marker
comments; `/do`'s Step 0 still harvests them.)

At the **plan-complete** and **wrap-up** milestones, rebuild the manifest and
re-upload it with an authenticated `PUT` to the recorded `artifact_bundle`
URL with its trailing slash removed. This makes the already-attached stable
URL serve the current `impl-plan.md` and `wrapup.md` after a browser
refresh. These milestone uploads never rewrite an item that was published
under the older full-body contract.

Retry a failed upload once. If the retry also fails, surface the failure to
the user and record `artifact_upload: failed` in the metadata so the next
milestone retries; never silently skip an upload when `artifact_host` is
configured. A failed initial upload stops tracker publication because no
lean body can point at a complete bundle. On a successful later upload,
remove the failure field.

## Without `artifact_host`

Set `status: ready` in the metadata, then create the tracker item, titled
`<prefix> <item title>`. The tracker body is a **markdown rendition of the
plan**: the metadata YAML
as a fenced block, then the plan's content sections rendered as markdown at
the same altitude — intent, desired end state, locked directions,
dependencies & mechanics (cards as bullets with their verified/assumed
standing and the schema-delta line), approach (with the phase list when
multi-phase), verification criteria, scope, justification, open questions.
Derived from `plan.html` at publish time; the local HTML stays canonical.

When the destination is GitHub issues and the instructions don't already
say how to attach artifacts: issue attachments are web-UI-only, so post
`plan.html` and each `refs/` file as its own issue comment wrapped in
markers so `/do`'s Step 0 can harvest them back to disk:

```
<!-- ORCHESTRA-ARTIFACT path="plan.html" -->
<full file content>
<!-- /ORCHESTRA-ARTIFACT -->
```

One comment per file. A comment holds ~65K chars; split oversized files
into `part=1/2` markers. Binary refs (images, archives) can't ride in
comments — note them in the issue body by path and keep them in
`./tmp/<id>/refs/`. Record the tracker URL/identifier in the local metadata
exactly as in step 4 above (`github:` or the `linear_issues` always-list).

Done when: the item is published per the repo's instructions, every
artifact is reachable from it, and the published item and `plan.html` link
to each other — or, when the repo configures no destination at all, the
artifacts are in `./tmp/<id>/` and the user has been told so.
