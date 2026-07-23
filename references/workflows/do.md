# Autonomous pipeline workflow contract

Run a work item from readiness through planning, implementation, verification,
pull-request publication, post-publication review and QA, wrap-up, and an
operations-only postmortem. The harness adapter owns all dispatch syntax,
child lifecycle details, and role-to-runtime routing.

## Inputs and completion

Accept a tracker reference or `./tmp/<id>/item.md`. Resolve the item into
`./tmp/<id>/`, including its `refs/` directory. The item must be `ready` and
the checkout must be on a non-default branch.

When no work-item input is supplied, list every local
`./tmp/*/item.md` whose frontmatter says `status: ready` and ask the human
which one to run. Never choose among ready items silently.

Completion requires:

- the item, plan, and wrap-up artifacts agree;
- all required acceptance criteria have quoted evidence;
- every configured review lane has no unresolved must-fix finding, or the
  review cap is reached and survivors are disclosed;
- the pull request body is current and its tracker closing lines persist;
- QA evidence is published without entering the repository;
- production or irreversible work remains an explicit human action;
- tracker handoff operations and completion notification are attempted.

Continue through phase boundaries while work is ready. A harness adapter may
pause only for a genuine blocker, required human judgment, or its documented
child-lifecycle boundary. If work remains when a turn must end, the adapter
must arrange a durable continuation and recover outstanding child reports;
waiting for a human to say "continue" is a pipeline defect.

## Roles

The adapter must provide these roles and await their reports when required:

- `code-researcher` for repository facts and file-line evidence;
- `web-researcher` for current external facts and citations;
- `investigator` for evidence-driven root cause;
- `socrates` for necessity and approach challenges;
- `plan-reviewer` for plan correctness and completeness;
- `implementer` for the entire authorized implementation slice;
- `backend-verifier` for command-shaped verification;
- `frontend-verifier` for the single post-publication app-driving QA pass;
- `code-reviewer` for each configured review lane.

Independent roles should run concurrently. Each role is a leaf. A role's
success claim is not evidence: consume its durable report and independently
check the output or command results that gate the next phase.

## Autonomy and action tiers

This pipeline is intended to finish unattended, but autonomy is bounded:

- **Green:** repository code, tests, docs, new files, local tooling, and
  additive/nullable/reversible staging changes. Execute, verify, and record.
- **Red:** production access or mutation, real-user or money impact,
  irreversible work, and staging work that is not cleanly reversible. Never
  execute. Capture the exact migration, script, or command under
  `./tmp/<id>/`, record it in deploy notes, and hand it to the human.

If a red action blocks only its own deployment, capture it and continue. If it
blocks a dependent branch, notify, stop that branch, and continue independent
work. Stop the whole run only when every branch is blocked or intent is
genuinely ambiguous.

Notifications follow `.references/notify.md` and are one-way. Notify only for
red gates, hard stops, and completion. Never wait for a notification reply.

## Step 0 — Preflight and load

Read the root `AGENTS.md`, tracker configuration, contributing guidance, and
app-specific testing instructions. In one message, identify missing or
expiring prerequisites and give exact remediation commands. Check:

- tracker and git-host authentication;
- artifact-host and notification configuration;
- cloud, database, test-mode API, and browser credentials needed later;
- the adapter's required unattended permission mode;
- repository toolchains and locked dependency installation;
- current branch and existing pull-request ownership.

Prove credentials with non-mutating token-producing checks and compare expiry
to the expected run. Install dependencies with the repository's locked,
idempotent command and suppress lifecycle scripts when supported. A missing
green prerequisite is a note unless no useful work can begin.

Load and validate the work item per `.references/draft-work-item.md`,
`.references/publish-work-item.md`, and `.references/tracker-lifecycle.md`.
Fetch tracker metadata and artifact bundles without overwriting newer local
artifacts. Validate `zone`, `review_lanes`, acceptance criteria, refs, and
readiness. Materialize all work under `./tmp/<id>/`.

Preserve the tracker's full frontmatter as authoritative state. Local document
content wins over older transported content, except that a newly fetched lean
tracker stub must be replaced by the artifact bundle's authoritative
`item.md`. Fetch the bundle index and every listed file, retrying each request
once. An unreachable configured bundle is a red gate because planning from a
lean stub is unsafe. Legacy marker comments may be harvested only when the
configured tracker contract permits them.

Classify browser need from the authoritative item. When browser proof is
required and `ORCHESTRA_BROWSER_REQUEST_FILE` is available on the initial
turn, atomically write `{"requested":true}` and return exactly
`ORCHESTRA_BROWSER_RELAUNCH_REQUIRED`. After relaunch, require
`ORCHESTRA_BROWSER_EVIDENCE_DIR`, prove the attached browser transport with a
snapshot and clean close, and distinguish transport startup, browser launch,
and target-app reachability failures. Browser evidence may not silently fall
back to scripts or logs.

Build and retain the tracker lifecycle's current-item handoff set and
merged-item hygiene set during preflight. Authentication may be requested only
here. After preflight, tracker operations are non-blocking and each later
attempt is reported as `verified`, `already-correct`, `failed`, or
`unavailable`.

Check the item's Dependencies section after loading. When any stage needs a
running application, require `AGENTS.md` to document its launch command,
flags, port or URL, and environment; never invent these values. When criteria
require app-driving proof, require both a documented testing-accounts source
and executable readiness of the browser transport and named test identities.
Report each missing half immediately rather than discovering it during QA.

Fetch the HTTPS origin default branch and report whether it moved past the
branch point. Check whether the current branch already has an open pull
request. Never create a branch silently, work on the default branch, or amend
an unrelated existing pull request; stop and ask for a suitable branch.

## Step 1 — Plan

Derive effort and review dials from `.references/zones.md`:

- zones 0–1 use full research and a review cap of three;
- zones 2–3 use light research and a review cap of one;
- zone 0 defaults to dual review; zones 1–3 default to single review;
- an explicit `review_lanes: dual | single` overrides the zone default;
- an epic always retains full machinery and a cap of three;
- the Overseer may escalate one notch toward zone 0, with a recorded reason,
  but never de-escalate.

If `zone` is absent, classify it from stakes and downstream consequences,
record the classification and reasoning in plan frontmatter, and proceed.
Do not invent or silently default the value without that record.

When runtime fallback context is supplied, record requested and effective
lanes plus the fallback cause. The adapter determines the supported effective
lane topology and keeps it stable for the run.

For the full lane, commission repository research and, when necessary,
external research concurrently. Save the reconciled dossier at
`./tmp/<id>/refs/research-dossier.md`. Recheck conflicts between the dossier,
the item, and the repository; record retained anchors, dropped claims, known
mismatches, and their resolution.

Write `./tmp/<id>/plan.md` using
`.references/workflows/formats-and-assets/implementation-plan.md`. Facts require
fresh `path:line` evidence. Proposals do not belong in verified-fact sections.
Carry each `AC#` verbatim into Automated or Manual verification. Name open
questions and take the least-committal interpretation instead of silently
assuming.

Perform a fresh-eyes self-review, then run the configured plan-review lanes
concurrently. Reconcile disagreement and revise until every lane reports zero
must-fix findings or the cap is reached. A materially changed plan earns
another pass; an unchanged plan does not. Record the final confidence and any
survivors. Upload the refreshed artifact bundle when configured.

If the approved plan pins a dependency that repository install gates require
a human to approve, send the approval request at plan exit. Do not defer
discovering that gate until implementation.

## Step 2 — Implement

Give each implementer the item, approved plan, refs, authorization boundaries,
and relevant known-issues pages. A mixed frontend/backend change is one
vertical slice unless chunks are genuinely independent. Every independent
chunk must leave the repository statically green without relying on a later
chunk.

The implementer owns source changes and the complete touched-surface
typecheck/lint/build loop. Resolve item or reference questions at the Overseer.
Apply green actions and capture red actions as defined above.

For bulk fan-outs:

- specify a machine-verifiable completion contract;
- audit the complete batch after every wave;
- expect and repair a silent-failure tail;
- preserve each successful unit in a recoverable commit;
- make quota retries resumable and use blocked intervals for independent work.

## Step 3 — Verify

Commission `backend-verifier` to prove every command-shaped acceptance
criterion and relevant rubric in `.references/rubrics/`, following
`.references/verification-methods.md`. Reports quote exact commands and
evidence. Feed failures to the matching implementer and re-verify.

Verification that itself must start an AI session or feed repository context
to an AI CLI must not run through the ordinary `backend-verifier` role. The
adapter must route that criterion to an expressly authorized, non-recursive
verifier lane. If the adapter has no such lane, report the criterion as blocked
rather than violating the leaf-agent contract or substituting weaker evidence.

Do not drive UI acceptance here. Run build, typecheck, and component checks,
then mark app-driving criteria `deferred to QA drive`. Apply safe staging
prerequisites before verification so evidence targets the intended schema.

Testing follows the app's documented instructions. Missing test guidance is a
blocker for that surface, not permission to invent a workflow. Keep secrets
out of argv, logs, artifacts, reports, and telemetry.

When verification needs a service, start it detached from tool-call timeouts
and record its PID under `./tmp/<id>/`. Stop every service the pipeline
started. When freeing a port, kill only PIDs enumerated before the next launch;
never use a broad process-name kill. Missing testing instructions,
credentials, environment, or tooling stops that verification branch for human
input—do not retry blindly or improvise a substitute.

This step is complete only when every acceptance criterion and every selected
rubric blocker has quoted passing evidence, except UI criteria explicitly
deferred to the single QA drive.

## Step 4 — Prepare and open the pull request

Before staging, inspect status and diffs, preserve unrelated changes, and run a
secret scan. Stage only files belonging to the item. Run the repository's full
touched-surface checks, then commit in the repository's established style.
Synchronize with the HTTPS origin and use force-with-lease only when rewriting
already-pushed history.

Run a deploy-notes scan over schema and migrations, environment variables and
secrets, infrastructure and CI, new third-party dependencies, and one-time
scripts or backfills. Split every finding by action tier:

- apply a green non-production prerequisite before the evidence that depends
  on it; if this scan finds it late, apply it and rerun the affected proof;
- capture the red production, irreversible, or secret-bearing counterpart as
  a human deploy action and never execute it;
- never describe an unapplied production change as a verification
  prerequisite, because evidence must target a safe non-production system;
- when one change has both halves, record both the applied staging action and
  deferred production action rather than collapsing them into one note.

Build the pull-request body from
`.references/workflows/formats-and-assets/pr-body.md`. Include:

- summary and What/Why/How at reviewer altitude;
- visual overview, with before/after evidence for user-visible changes or a
  rendered diagram for flow-shaped changes;
- user journeys and manual tests only when they exist;
- automated verification and residual risks;
- QA placeholders and deploy notes;
- exact tracker closing lines from `.references/tracker-lifecycle.md`.

Host evidence in a durable, permission-scoped location. Never commit QA media.
Open the pull request with repository-defined labels and metadata; never
invent taxonomy. Read back the persisted body and repair any lost closing
line before advancing.

## Step 5 — Post-publication review and QA

Run all effective code-review lanes concurrently against the open pull-request
diff. Map native severity formats to:

- critical/high or P0/P1: must fix;
- medium or P2: should fix;
- low or P3: nice to have.

Loop must-fix findings to the implementer, selectively commit and push fixes,
then re-review. A sharp lane divergence permits one convergence pass. A pass
with zero must-fix findings ends the loop; should-fix findings alone never
trigger another pass. At the cap, disclose survivors in the wrap-up.

Then perform one QA drive:

- `frontend-verifier` proves deferred UI criteria and manual journeys;
- `backend-verifier` proves command-shaped manual items;
- zones 0–1 run full QA, zone 2 trims non-acceptance manual work, and zone 3
  skips non-acceptance manual work;
- acceptance evidence that requires the running app is never trimmed.

The frontend brief includes launch commands, flags, URL, environment, test
mode, cleanup, and `.references/qa-verification.md`. Require ordered,
step-named screenshots for meaningful states and one video per scripted
journey. Use a unique marker and verify external effects by provider readback.
Before dispatch, save `git status --short`. Accept only the actual dispatched
verifier's completed `evidence-manifest.json` and files within its current
attempt evidence directory; reject missing, partial, unlisted, fixture, or
older-attempt evidence. Compare `git status --short` afterward byte-for-byte
with the saved value so evidence publication never edits the repository.

Update the pull-request body first: check passed manual items, mark human-only
items, fill the QA summary, and add after-shots. Then post a proof comment with
quoted command output and grouped chronological galleries. Host every
enumerated capture and verify it is present in the persisted body or comment.
Repository status must remain byte-for-byte unchanged by evidence publication.

A QA-discovered defect is fixed before shipping, followed by a scoped review
of the fix and rerun of affected QA. Publish surviving non-blocking review
findings as line-anchored comments.

## Step 6 — Wrap up

Assemble the run record from actual sources:

- zone, requested/effective dials, fallback context, and pass counts;
- pull-request size;
- per-role model, effort, dispatch count, duration, and token usage;
- total spend ratio when source data supports it;
- verification and QA outcomes;
- remaining risks and human actions.

Record `unknown` when a source does not expose a value; never estimate.
Write `./tmp/<id>/wrapup.md` from
`.references/workflows/formats-and-assets/wrap-up-report.md`, post it to the
pull request, and refresh the artifact bundle.

Run the tracker lifecycle's current-item handoff set, recording each operation
as `verified`, `already-correct`, `failed`, or `unavailable`. Apply the
`awaiting-human-review` label when configured, creating it when missing. Run
retained merged-PR hygiene and record outcomes.

Lead the final report with the pull-request link and a Human action required
block split into completed green actions and outstanding red/external actions.
Then summarize implementation, verification, review, QA, and unresolved risk.
Notify completion.

Finally run the postmortem workflow in operations-only mode. It publishes run
timing and stall analysis but does not gate or modify the completed work.

## Epic protocol

For an epic-spec item, execute one phase at a time: run Steps 1–3 separately
for each phase and never overlap phases.

1. Write `plan-<n>.md` for the current phase.
2. Implement and verify only that phase.
3. Run the configured review lanes over that phase's diff, using the epic
   review cap of three and the zone-derived lane count unless the epic has an
   explicit override.
4. Fix and re-verify must-fix findings, run the build gate, and commit the
   verified phase.
5. Mark that phase complete in the epic spec only after the commit exists,
   then proceed immediately to the next phase.

After the final phase, perform the deploy-notes scan over the complete epic
diff, synchronize and publish the final pull request, and run post-publication
review, QA, wrap-up, and postmortem once for the whole epic. The phase
checkmarks plus per-phase plans are the durable resume record. Never pause
between phases for a human nudge.

## Non-negotiable rules

- Never expand scope beyond the work item. Record adjacent work separately.
- Every artifact is checked by a fresh-context reader other than its author.
  Reviewers never edit, and an implementer never reviews its own output.
- Reviewer prompts are neutral. Never describe the artifact as verified,
  tested, correct, or previously approved. On later passes, describe prior
  findings only as claimed fixed and requiring verification.
- A child completion status or prose claim is not proof. Inspect the durable
  artifact, diff, manifest, or quoted command evidence required by the gate.
- Preserve unrelated dirty-worktree content and select files from current
  status, never a remembered list.
- Keep secrets out of prompts, argv, logs, tracker comments, evidence,
  artifacts, and telemetry.
- Chain steps and epic phases without waiting for a nudge. Defer, record, and
  notify red actions; stop only when a red gate blocks every useful branch.
- Preserve resumability in the item state, plan artifacts, phase checkmarks,
  child identities, and adapter lifecycle. A resumed run re-reads these
  durable sources before launching new work.
