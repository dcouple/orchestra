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
   Title `<prefix> <item title>`, body per the caller. Upload or attach
   `item.md` and the `refs/` files however the destination supports, so
   the published item carries everything a remote `/do` needs. Record
   every URL the destination returns in `item.md` frontmatter (e.g.
   `github:`, `tracker:`) so `/do` can pull from it. For Linear, record each
   explicit link as one entry in an always-list:

   ```yaml
   linear_issues:
     - url: https://linear.app/<workspace>/issue/TEAM-123/<slug>
       identifier: TEAM-123
       relationship: completes
   ```

   `relationship` is exactly `completes` or `relates`. **YOU MUST** derive the
   paired identifier from the canonical URL returned by Linear. The identifier
   is the later lookup key; only `completes` entries generate standalone
   `Fixes TEAM-123` lines.
3. If the section is missing or gives no publishing instructions, publish
   nowhere: the work item is complete as local files under `./tmp/<id>/`.
   Tell the user nothing was published and where the files live.

## Artifact host (optional)

When the consumer's `Work-item tracking` block sets `artifact_host: <https
base URL>`, uploading and attaching the artifact bundle is a required,
additive publish step. Read the bearer token from `ARTIFACT_HOST_TOKEN`.
Repos with no `artifact_host` key skip this step. Existing tracker artifact
transport, including GitHub marker comments and `/do`'s pull, stays unchanged.

Build the manifest from `item.md`, any present `plan.md` and `wrapup.md`, and
every regular file under `refs/`. This dependency-free Node snippet writes the
wire format to stdout (set `ITEM_DIR` to the work-item directory):

```bash
node --input-type=module - "$ITEM_DIR" <<'NODE'
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const root = process.argv[2];
const files = [];
const add = path => files.push({ path: relative(root, path).split("\\").join("/"), contentBase64: readFileSync(path).toString("base64") });
for (const name of ["item.md", "plan.md", "wrapup.md"]) {
  const path = join(root, name); try { if (statSync(path).isFile()) add(path); } catch {}
}
const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
  const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.isFile()) add(path);
}};
try { walk(join(root, "refs")); } catch {}
process.stdout.write(JSON.stringify({ files }));
NODE
```

Redirect the snippet's stdout to a file from `mktemp`, then create the bundle
with (remove the temporary file afterward):

```bash
curl --fail-with-body --retry 1 \
  -H "Authorization: Bearer $ARTIFACT_HOST_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "@$MANIFEST_FILE" \
  "$ARTIFACT_HOST/a"
```

On first publish, send that manifest to `POST <artifact_host>/a` with
`Authorization: Bearer $ARTIFACT_HOST_TOKEN`. Record the returned `url` in
`item.md` frontmatter as `artifact_bundle:`; this stable URL identifies the
server-generated bundle id used for later uploads. Attach the URL to the
published tracker item: create a Linear `attachmentCreate` card for Linear,
or add an `Artifact bundle: <url>` link line to the GitHub issue body.

At the **plan-complete** and **wrap-up** milestones, rebuild the manifest and
re-upload it with an authenticated `PUT` to the recorded `artifact_bundle`
URL with its trailing slash removed. This makes the already-attached stable
URL serve the current `plan.md` and `wrapup.md` after a browser refresh.

Retry a failed upload once. If the retry also fails, surface the failure to
the user and record `artifact_upload: failed` in `item.md` frontmatter so the
next milestone retries; never silently skip an upload when `artifact_host` is
configured. On a successful later upload, remove the failure field.

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
