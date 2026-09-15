# Shared task artifacts

Apply this guidance to briefs, research, plans, reports, diagrams, and captures
created by the workflow and its helpers. Honor the user's chosen destination.

## When Grain is connected

- Follow the installed Grain skill. Reuse the task's workspace and stable
  artifact IDs; for new work, use `Development Artifacts/YYYY-MM-DD-<ticket-or-branch>`
  with enough repository context to distinguish it.
- Keep the folder and links stable as the work evolves. Once a PR exists,
  rename the folder to `PR-<number>-<title>` using supported operations.
- Save safe artifacts with their relative paths or a clear path mapping.
  Update the existing artifact after material changes and at handoff, then
  read it back before reporting it as shared.
- Keep the workspace link in existing references or run notes. Pass its ID
  and this guidance to helpers; helpers without access return artifacts to
  the coordinator for saving. Give independent reviewers only their assigned
  inputs, preserving the calling workflow's review isolation.

## Preserve the working contract

- Keep required local working files, exact paths, schemas, and evidence
  manifests available to their consumers. Source code stays in the project.
- Follow the configured tracker and artifact-host publication procedure,
  including `artifact_bundle`, metadata reconciliation, and upload failures.
  Grain is a shared companion alongside this required transport.
- On another device, restore needed working files and verify their task and
  version. Current tracker and runtime state remain authoritative for status,
  approvals, and attempt-specific QA evidence.
- Match access to the intended audience, redact sensitive content, and obtain
  authorization for public sharing. Keep credentials in their secure stores.
- When Grain is absent, continue with normal storage. If a connected save
  fails, retain the working copy, continue independent work, and report the
  unsynced artifact and its save status at handoff.
