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

## Migrating a legacy bundle

When Grain is configured and `artifact_bundle` still points to an HTTP host,
read its inventory and every listed file using the legacy read procedure.
Apply the caller's existing local-document precedence and tracker metadata
rules. Do not proceed from an incomplete source or lean tracker stub. Keep
the source URL in the local migration notes for recovery; never write to it.

Before publishing a new plan, wrap-up, or PR artifact, discover or create the
work item's Grain workspace in the configured organization/folder. Record its
ID in local migration notes immediately and reuse it on retries. Copy the
complete recovered bundle plus current local artifacts, then push and verify
as above. Replace `artifact_bundle` in the local brief with the confirmed
Grain URL and push/read back the updated brief before changing the tracker.

Update the existing tracker's full fenced metadata and bundle link (or Linear
attachment) to that same Grain URL, preserving all other metadata, body
content, lifecycle state and legacy marker comments. Read back the tracker
and Grain brief and verify their pointers agree. Do not create a new tracker
item. Subsequent milestones reuse this Grain workspace. The PR's Development
Artifacts section links to it; no new artifacts go to the old host.

If any migration step fails, preserve both source and destination identities
locally, report the incomplete step and follow the failure policy below.
Keep the tracker pointer unchanged until the destination brief is verified.
If tracker update is incomplete, retry it against the same workspace before
claiming migration complete; never fall back to HTTP writes. PR creation may
proceed only with the repository's explicit blocked-artifact disclosure.

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
report the blocker. Legacy HTTP artifact bundles remain readable through
`.references/artifact-host-upload.md`. When Grain is configured, that legacy
transport is read-only and all new artifact writes require Grain.
