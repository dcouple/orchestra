# Grain development artifacts

Use when the repository's `Work-item tracking` config selects
`artifact_provider: grain`, or an existing `artifact_bundle` is a Grain
workspace link. Read `grain_organization` and `grain_folder` from that config;
these are the organization name and folder path, not local paths or IDs.

## Access and identity

Use the authenticated Grain stdio MCP (`grain mcp`), discovering current tool
schemas, or the supported bundled CLI. Both use the installation's own
approved Grain login and macOS Keychain. Missing access is a blocker, never a
reason to copy credentials or invent tokens. `grain login` requires an
interactive terminal and approval in the same-machine Grain desktop app.

Discover the organization with `grain_list` (CLI `grain --json list`), verify
its name and membership, and use its returned ID explicitly. Multiple-org
errors can return candidates with IDs, names and roles. A sole returned ID
does not prove the configured organization name. Creation requires owner or
builder membership. List the organization before filtering by folder because
a missing folder can fail discovery. Find the existing work-item/branch/PR
workspace before creating; creation with the configured folder can create
missing folder segments.

## Complete bundle and publication

Use one HTML workspace for the whole bundle. `grain_new` accepts `name`,
`template: html`, `organization` (verified ID), and `folder`. Record its
returned workspace ID and checkout path immediately for recovery. A newly
created workspace is not a completed publication. For an existing workspace,
use `grain_checkout` with its explicit `workspace` ID and edit the returned
checkout. CLI equivalents are `grain --json new --name <name> --template html
--organization <id> --folder <path> --checkout --no-open --no-start` and
`grain --json --workspace <id> checkout`.

Copy `brief.html`, present `plan.md` and `wrapup.md`, and every regular file
under `refs/` into the checkout, preserving bytes and relative paths. Include
legacy `item.md` when present. For a PR without a work item, include its
actual development report and supporting files. Write `index.html` as a
readable entry page with relative links to these files. Write `index.json`
as a JSON array of the included artifact paths, excluding the inventory
itself and Grain's own configuration. Reject absolute paths, traversal and
symlinks escaping the bundle when copying or reading; never include auth,
checkout configuration, or unrelated files in the inventory.

Push with `grain_push` and the explicit workspace ID (CLI
`grain --json --workspace <id> push`). Confirm `ok: true`,
`filesSynced: true`, `revisionRecorded: true`, `commitOutcome: confirmed`
and a returned `revisionId`. Read back the saved revision's inventory and
files using a fresh checkout, comparing against the authored bytes. Use the
actual returned `workspaceUrl` or `openUrl` as `artifact_bundle` and the PR
link; these are private desktop links, not access grants. Do not manufacture
HTTP URLs or use `grain_share_create` without explicit audience approval.

Follow `.references/publish-work-item.md` for tracker metadata and publication
order. Preserve the same workspace for pointer write-back, tracker link
write-back, plan-complete and wrap-up. Rebuild the full inventory at each
milestone, removing obsolete artifact entries without deleting unrelated
workspace files. Keep `brief.html`'s metadata and the tracker's full YAML in
sync as that procedure requires. Never replace a multi-file bundle with
`grain_artifact`, which creates a new single-file workspace.

## Retrieval and recovery

For a returned `grain://workspace/open?...` pointer, parse `workspaceId` with
a URL parser, then explicitly checkout that workspace through authenticated
Grain. Never append `index.json` to the desktop URL or send it to curl.
Refresh an existing clean checkout with `grain_pull`; if it has edits,
preserve/reconcile them or use a separate fresh CLI checkout clone. Read
`index.json` from the checkout and copy every listed artifact into
`./tmp/<id>/` using the caller's local-content precedence rules. Require the
canonical brief (or a legacy item's `item.md`) and all inventoried files;
a missing file or unreadable inventory is a failed bundle retrieval.
Tracker metadata still replaces the loaded brief's metadata wholesale;
existing local document content still wins except for a lean tracker stub.

Retry failed retrieval once. If still unavailable, the `/do` load is blocked;
never proceed using the lean tracker stub. Publication failures preserve local
files, report the precise failure and set `artifact_upload: failed`; remove
it after a confirmed successful retry. A failed initial publish blocks lean
tracker creation. Later milestone failures remain explicit and are retried
at the next milestone; PR creation follows the repository's blocked-artifact
policy.

For an uncertain create/push, inspect the returned workspace ID, list and
history before retrying. Recover the same workspace rather than creating a
duplicate. On remote drift, pull and reconcile before pushing; do not force
through other edits. Retry a failed publish once after reconciliation, then
report the blocker. Legacy HTTP artifact bundles continue to use
`.references/artifact-host-upload.md`, regardless of the new default.
