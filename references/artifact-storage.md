# Shared task artifacts

Use this rule whenever a skill creates or updates a workflow artifact: briefs, research, plans, reports, diagrams, captures, or manifests.

## When Grain is connected

- Read the installed Grain skill and reuse the task's existing folder or
  equivalent workspace. Otherwise create `Development Artifacts/YYYY-MM-DD-<ticket-or-branch>`
  using its supported organization model; add repository context to avoid collisions.
- Keep every safe workflow artifact there, preserving its relative path or a clear path-to-grain mapping. Use stable grain IDs when updating, not a new duplicate for every step.
- Rename the folder to `PR-<number>-<title>` once the PR exists. Preserve its ID and links so another device can find the same work.
- Record the folder link in the plan/report's existing references or run notes. Do not add fields to machine schemas merely to store it.
- Pass the folder ID and this storage rule to every dispatch. A leaf agent without Grain access returns its files/report to the Overseer for synchronization; it does not spawn a storage agent.
- Sync after artifact creation or material updates and at handoff. Read back the saved artifact before claiming it is shared.

## Keep execution contracts intact

- Grain replaces **local-only storage**, not required local working files. Keep `./tmp/<id>/`, exact filenames, relative links, JSON/YAML formats, completion markers, and evidence manifests where their consumers expect them.
- Source code and executable files remain in their required project locations. Share workflow artifacts, not an indiscriminate copy of the repository or environment.
- Preserve the configured tracker/artifact-bundle publication and reload protocol. Grain links are not substitutes for `artifact_bundle`, tracker metadata, daemon state, or required PR evidence URLs.
- On another device, materialize needed working copies and validate their task/version. Fresh tracker metadata and runtime state outrank a saved document; do not restore old status, approvals, credentials, or attempt-specific QA proof from Grain.
- Independent reviewers and competing candidates receive only their assigned inputs. Folder access must not leak other lanes' conclusions or the implementer's rationale into a blind review.

## Privacy and fallback

- Keep secrets and unsafe captures out of Grain. Save a safe redacted artifact where possible; record omissions without exposing the withheld content.
- Shared storage does not authorize public hosting, release creation, tracker mutations, or permission changes. Follow the calling workflow's publication rules.
- If Grain is absent, silently use normal storage. If a connected save fails, retain the working copy and report the unsynced artifact at handoff; continue independent work without claiming a successful upload.

This rule applies to invoked skills and their supporting files. Their execution, evidence, authorization, and publication contracts still apply.
