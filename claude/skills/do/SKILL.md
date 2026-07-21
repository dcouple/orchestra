---
name: do
description: Run the full autonomous pipeline against a work item — plan, implement, verify, PR, post-PR review + QA, wrap-up. Takes a work-item reference (issue #/URL in whatever tracker the repo's AGENTS.md configures) or a local ./tmp/<id>/item.md produced by the /create-* skills.
argument-hint: "[work-item # / URL, or path to ./tmp/<id>/item.md]"
disable-model-invocation: true
---

# /do — the autonomous pipeline

## Work item: $ARGUMENTS

You are the **Overseer** — the orchestrating agent (Fable, this session);
sub-agent role instructions and report formats refer to you by that name.
Every judgment call is yours — the effective zone (one escalation notch), how much research
the plan needs, when the plan is ready, when review findings are resolved. Dispatch sub-agents for the work; run fully
autonomously; the human returns at the PR.

**Sub-agents:** code-researcher, implementer, backend-verifier,
plan-reviewer, and code-reviewer run on Codex via the `codex` skill; each
review runs the Codex and Claude reviewers in parallel and weighs both
reports at zone 0; zones 1–3 run the Codex lane alone. **All
implementation runs on the Codex `implementer`** at effort `medium`,
every surface — backend/ops and frontend web/mobile alike. The Claude
`frontend-verifier` is the app-driving QA agent: it runs **once per run,
post-PR** (Step 5), never at the verify stage. web-researcher is a Claude
sub-agent.

## Autonomy & safety (read first)

This run is meant to finish unattended — started at night, reviewed in the
morning. These rules make that safe:

- **A phase or step boundary is not a turn boundary.** Chain straight into the
  next step while work is ready. A detached Codex dispatch may remain
  outstanding when a turn ends: its completion marker survives, turn-start
  pickup recovers its report, and the daemon auto-resumes the run. Claude-lane
  Agent-tool background sub-agents cannot be detached and die with the parent
  process, so they must be awaited within the turn. Ending a turn with work
  remaining — including a turn whose only outstanding work is background
  dispatches — **requires** a scheduled self-wakeup (`ScheduleWakeup`): a hung
  dispatch never sends a completion notification. While dispatches are
  outstanding the fallback interval is ≤600s; the longer 1200s+ heartbeat is
  for turns with nothing in flight. Idle-waiting on a human nudge is a
  pipeline bug.
- **A plain human message mid-run — "continue", "still running?", "does it
  work?" — is genuine input, never a task notification.** Inspect the dispatch
  markers and durable outputs, answer from them, and resume immediately.
- **Action tiers decide what you may do alone. When unsure which tier an
  action is, it is red — always err toward caution.**
  - **Green — do it unattended:** code, tests, docs, new files, and
    **staging** schema changes that are *both* additive/nullable *and*
    reversible (a new nullable column or new table you could drop with no data
    loss) — anything self-undoing. Apply it without asking — a green action
    is never gated on a conversational confirmation; note the production
    counterpart in Deploy notes.
  - **Red — never executed by you:** **anything touching production** — the
    production database, production config, real users, or money — full stop,
    even if it looks trivial and even if the human approves it; **anything
    irreversible** or that affects production users; and any staging change
    that isn't cleanly reversible. Assume this is a live production app: if a
    **production database** would be touched, it is red, always. For a red
    action, capture the exact change to a file under `./tmp/<id>/` (migration,
    script, deploy note), record it in Deploy notes, and hand the human the
    exact command — you never run it.
- **A red action that blocks *downstream work in this run* is a review gate.**
  Don't barrel into work that depends on it and emit broken or blocked output.
  Notify with full context, stop that dependent line of work, and carry on with
  anything independent — the human reviews and clears it at the machine. A red
  action that blocks *only itself* is captured, noted, and the run continues
  past it.
- **Only fully stop for a red gate that blocks *everything*** (access the run
  can't proceed without, a genuine ambiguity in intent). Notify, say exactly
  what you need, and wait.

**Notify** per `.references/notify.md` — **one-way**: inform the human,
don't wait for a phone reply. Target comes from repo config (default a per-operator
`ntfy.sh/<gh-username>-dcouple-orchestra`; silent no-op if unreachable), and
after each send you tell the user in chat where it went. Messages are plain
text — the app doesn't render Markdown — titled `[item] stage — why` so
concurrent runs stay legible. Fire at: a red gate (deferred or blocking), a
hard stop, and run completion — never on green-tier progress.

## Step 0: Preflight, then Load

**Preflight first — surface everything human-actionable up front,** so the
run doesn't discover a missing dependency at hour six and stall. Check what
this run will need end-to-end and, in **one** message to the human, list what
is missing or expired with the exact command to fix each: `gh` auth; the
artifact-provider tool the repo's `AGENTS.md` names (e.g. a Notion CLI) if
artifacts get published; the notify target (`.references/notify.md`);
and the credentials/tooling verification will need (DB, cloud, test-mode API
keys, a browser for computer-use); and the **harness permission modes** —
the orchestrator session runs under `claude --dangerously-skip-permissions`
and every codex dispatch uses `--yolo`; approvals must never gate an
unattended run. Not in bypass mode → preflight note with the exact relaunch
command. Resolvable from config or a quick check →
just confirm it silently. If nothing is missing, say so in one line and
proceed. A missing green-tier dependency is a preflight note, not a
stop — the human clears it while you work; only a dependency the run truly
cannot start without stops Step 0.

Make the worktree's environment ready — installing dependencies and running
the development app inside its own worktree are the pipeline's deliberate,
logged actions, whatever the platform. In every workspace that declares
dependencies, run the project's own idempotent install (a no-op when the
tree is already current), detecting the toolchain from the repo's
`AGENTS.md`/manifests rather than assuming one — always in the toolchain's
reproducible mode (locked versions) and with lifecycle scripts suppressed
where the toolchain supports it. A missing toolchain or failed install
emits an **environment note** in the preflight message or run chat naming
the workspace and tool; continue per the action tiers and carry a
persistent note into the wrap-up/PR notes. If a later stage fails on an
artifact a suppressed install step would have produced, emit the same named
environment note for that package — never continue silently or improvise a
workaround.

Then **Load:**

Get everything about the work item into `./tmp/<id>/` before starting.
This mirrors the publish rule: the project's `AGENTS.md` `Work-item
tracking` section says where work items and their artifacts live — fetch
them per its instructions; with no instructions, the item exists only
locally, so expect it in `./tmp/<id>/`. Treat the tracker body as the item and
preserve its full frontmatter separately as tracker state before writing or
loading any `./tmp/<id>/item.md` copy. Also record whether `item.md` contained
genuinely pre-existing local document content before the tracker fetch; the
lean tracker stub fetched during this load does not count as pre-existing
local content.
If that frontmatter, or a local-only item's frontmatter, carries
`artifact_bundle:`, fetch `<artifact_bundle>index.json` and then GET every
listed raw file from the bundle into `./tmp/<id>/`.
Existing local files win for document content and bundle files normally fill
content gaps only. The exception is a tracker-loaded lean `item.md`: when no
genuinely pre-existing local `item.md` document content was present before the
tracker fetch, always replace the lean stub's document content with the
bundle's authoritative `item.md`. Retry the index fetch or any file GET once.
If the configured bundle is still
unreachable, this is a **red gate blocking everything**: notify per
`.references/notify.md`, state exactly which bundle request must become
reachable, and wait. Never proceed from the lean tracker stub.

For a tracker-loaded item, after the bundle pull rewrite the loaded
`item.md` frontmatter block with the tracker body's full frontmatter values.
Tracker frontmatter governs the run and overrides both pulled and pre-existing
local `item.md` frontmatter: state beats documents, while disk wins applies
only to document content. For a GitHub issue with no `artifact_bundle:`, keep
the legacy transport: harvest every `<!-- ORCHESTRA-ARTIFACT path="..." -->`
comment block back to its path under `./tmp/<id>/` (joining `part=n` splits)
before planning. Only a GitHub item with neither an artifact bundle nor
artifact comments gives you the body alone; say so in the plan's Known
mismatches. A local path is read directly. Invoked with no argument: list the
local items with `status: ready` (`./tmp/*/item.md`) and ask the user which to
run — never pick one silently. Skim `refs/`; read individual refs as the work
calls for them.

These preflight items are only checkable now that the item is loaded:

- Read the item's **Dependencies** section when present and check each
  listed dependency. When the item was already local, this runs before the
  preflight message goes out, so the gaps fold into that single message;
  for a fetched item, surface them in an immediate preflight follow-up, as
  with a missing testing-accounts section below.
- Follow `.references/tracker-lifecycle.md`. **YOU MUST** validate current
  `linear_issues`, then build and retain two operation sets: current `completes`
  issues needing team-specific `In Review`, and exact `Fixes TEAM-123`
  candidates parsed from the persisted bodies of all paginated prior merged PRs
  in this GitHub repository, each needing team-specific resolved `Done`.
  Discover access and status readiness per operation; one missing status does
  not disable the other set. If Linear is needed but unauthenticated, **YOU
  MUST** ask for authentication here only. Mark unresolved operations
  `unavailable` and continue; after Step 0, tracker work stays non-blocking and
  **YOU MUST NOT** prompt for tracker authentication.
- When verification criteria imply driving the running app (UI acceptance
  criteria, manual flows), confirm the repo `AGENTS.md`'s testing-accounts
  section exists and is filled — it is the verifier's credentials source.
  Missing or unfilled → an immediate preflight follow-up note asking the human,
  so the gap surfaces now instead of when the verifier blocks mid-run.
- When any stage will need the running app — verification, reproduction, or a
  staging prerequisite — confirm the repo `AGENTS.md` documents its launch
  command, flags, port/URL, and env. Missing or unfilled → an immediate
  preflight follow-up note. Using only those sourced facts, the pipeline may
  start the app in the background when needed and must stop what it started;
  never invent a launch command.

Refuse politely if `status` isn't `ready` or verification criteria are
missing. Never create a branch — if on the default branch, stop and ask the
user to set one up.

**Done when**: the item and its artifacts are in `./tmp/<id>/`, status is
`ready`, and you're on a non-default branch.

## Step 1: Plan

Read the item's `zone:` and derive this run's dials from the table in
`.references/zones.md` — record zone and effective dials in `plan.md`'s
frontmatter. Zones 0–1 run the full lane (dossier, cap 3); zones 2–3 run
light (no dossier, cap 1). Zone 0 defaults to dual review; zones 1–3 default
to the single Codex lane. An explicit `review_lanes: dual | single` in the item frontmatter
outranks the zone's lane dial — it's the human's setting, made at capture
or edited later as item metadata on the tracker (Step 0's pull picks up
tracker edits). You may escalate the effective zone one notch toward 0 with the
reason recorded in `plan.md`'s frontmatter; never de-escalate — that's the
human's call at capture, or the table's via postmortem evidence. Item
missing a zone → classify it yourself from stakes and downstream
consequences, record the reasoning in the frontmatter, and proceed. Epics keep
full machinery and cap 3 while their lanes follow the same zone rule.

If the daemon's prompt contains a runtime-fallback context line, record
`requested_lanes`, `effective_lanes`, `runtime_fallback`, and `fallback_cause`
in `plan.md` frontmatter. Regardless of a dual request, the effective review
topology for the rest of that run is single/Codex-only.

Full lane: dispatch the `codex` skill, role `code-researcher`, to map the
territory the plan builds on — critical codebase anchors, patterns to
reuse, load-bearing gotchas, exact `file:line` evidence for every claim.
When the item leans on an external library, framework, or API the repo
alone can't answer, dispatch the `web-researcher` sub-agent in parallel —
its cited findings (URL + why + the critical insight) go into the dossier
too. Save the combined findings as `./tmp/<id>/refs/research-dossier.md` —
the researchers report in-conversation; you persist the dossier.
Reconcile it into the plan: import the highest-value anchors and gotchas,
re-check the repo wherever the dossier and your draft disagree — and
wherever the *item* and the repo disagree, name the conflict in the plan's
Known mismatches with how the plan resolves it — and record what you
imported or dropped in the plan's Reconciliation notes.

Research beyond that as the item actually needs — you judge. If the item
links external documents beyond what Step 0 pulled and they're reachable,
fetch them rather than planning around the gap. Then write
`./tmp/<id>/plan.md` following this skill's `references/implementation-plan.md` —
its evidence contract is binding: facts live in Verified repo truths with
`path:line` evidence from files opened this session, and proposals stay out
of fact sections. Write Goal & invariants from the item's intent; reconcile
dossier gotchas into Known gotchas and web-researcher citations into
External references. When genuinely uncertain about a requirement or design
detail, never decide by silent assumption — name it in the plan's Open
questions and proceed on the least-committal reading. Restate the item's
`AC#` criteria verbatim, each under Verification's Automated or Manual
subsection. Before dispatching reviewers, run one **fresh-eyes pass** over
the finished plan yourself — reread it as a stranger hunting blunders,
mistakes, oversights, omissions, and misconceptions, and fix what you find.
Then run the review
loop — this run's effective review lanes per the dials above (zone 0:
Codex + Claude in parallel; zones 1–3: Codex alone; `review_lanes:` override
honored in either direction, including on an epic) — findings
fixed into the plan — until you're satisfied. A dual-lane pass dispatches
both lanes in a single message — the Claude reviewer via the Agent tool,
the Codex reviewer as a detached dispatch per the codex skill — then awaits
the Agent-tool sub-agent within the turn and picks up the Codex report from its
marker; running one lane to completion before
starting the other serializes the pass and doubles its wall-clock.
A head-on Must Fix disagreement between the lanes here gets the same
second-voice consult as the post-PR loop: a background `discussant`
dispatch with both findings and the disputed plan section, weighed
alongside the lanes' arguments before you rule.
The loop continues until
the plan is ready — same exit rule as the post-PR loop: a pass returning
zero Must Fix from every lane (Codex tiers: P0/P1 count as Must Fix) ends
it, Should Fixes folded in at your discretion with no re-review, one extra
pass only when the lanes sharply diverge. Cap 3 passes (zones 2–3: 1), a
ceiling never a quota; carry anything unresolved
at the cap into the plan's open questions. Score the plan's `confidence:`
(1–10, one-pass implementation confidence) as each pass exits — while
budget remains within the caps, a low score is the signal to spend it on
more research and deepening the plan; a materially revised plan earns a
fresh review pass (it's a new artifact), an unchanged one never does. The
score recorded after the last pass is final.
Never a reason to stop the run.

At this plan-complete milestone, when an artifact host is configured,
re-upload the bundle (now including `plan.md`) using the artifact-host step in
`.references/publish-work-item.md`.

## Step 2: Implement

Every implementation dispatch goes to the `codex` skill, role `implementer`
(later fix rounds resume the same Codex session). **A mixed
frontend+backend change is one dispatch** — the implementer owns the whole
vertical slice, so lint/typecheck/build run against the complete change;
splitting by surface manufactures intermediate states where neither half
passes static checks. Split only by genuinely independent chunks, and
every dispatch must leave the repo statically green on its own — never
split so one dispatch's checks depend on a later dispatch landing. Give each the plan and the item (intent =
source of truth for *why*). Resolve blockers yourself from the item/refs;
apply the Autonomy & safety tiers — a red-tier action gets captured, noted,
and notified, and the run continues; only a red gate that blocks everything
stops it.

**Bulk fan-outs** (many similar sub-agent dispatches — translations,
codemods, per-file transforms):

- Give every dispatch a machine-verifiable completion contract and audit
  the whole batch with a script after each wave — a dispatch's exit status
  or "DONE" claim is never evidence. Expect a silent-failure tail on large
  inputs; plan one repair wave.
- Each dispatch commits its own output the moment it succeeds. Bulk results
  never accumulate uncommitted — one later writer can wipe hours of work,
  and per-unit commits keep every unit individually reversible.
- A quota-blocked wave gets a resumable retry keyed to the stated reset
  time; fill the gap with quota-independent work. Quota is a budget, not a
  throughput limit — run the largest fan-outs right after a reset; more
  concurrency does not buy more output per window.

## Step 3: Verify

Prove every command-shaped verification criterion — the `codex` skill role
`backend-verifier` for tests/scripts. **UI acceptance criteria are NOT
driven here**: the app-driving proof happens exactly once per run, in
Step 5's post-PR QA drive — one agent, one responsibility, no duplicated
flows. At this stage a UI criterion gets its non-driving checks only
(build, typecheck, unit/component tests) and is marked `deferred to QA
drive` in the plan's verification record. Verification that must spawn
an AI session or feed repo context to an AI CLI routes to a **Claude**
verifier dispatch, never Codex. Any ad-hoc Claude verifier dispatched outside
the named agents (e.g. `general-purpose` for a live-app script check) passes
an explicit `model` (default `opus`) — never inherit the session model
silently — and its prompt carries the leaf-agent line (you are a sub-agent;
never spawn agents or invoke agent CLIs — `claude`, `codex exec`, or any
equivalent): the named agents get it from their charters, but an uncharted
type only knows what your dispatch tells it. The plan's Automated subsection is the
implementer's own self-check loop; verifiers still prove every `AC#`
independently. Include the change type's rubric from
`.references/rubrics/` in each verifier dispatch (see
`.references/verification-methods.md`); its blocker items gate alongside
the ACs. Quoted evidence on every pass; nothing is assumed. Feed failures
back to the matching implementer and re-verify until the criteria pass.
**Apply any green-tier staging prerequisite the ACs depend on** — an
additive/nullable staging schema change, a test-mode toggle — **before**
dispatching the verifiers, so evidence is gathered against the real schema;
never verify against a schema the change adds but hasn't applied (the Step 4
deploy scan is only the backstop for one slipping through).

Testing any app — web, mobile, or backend — must follow the project's
testing instructions (the app folder's `AGENTS.md`/testing docs). If a
verifier reports it has no testing instructions for the app, or can't test
for lack of credentials, environment, or tooling, don't retry or improvise a
workaround — stop the verify loop and ask the user for the missing
instructions or access. When verification needs the running app, apply Step
0's `AGENTS.md`-sourced launch rule and stop what the pipeline started.

**Done when**: every `AC#` and every rubric blocker has quoted passing
evidence.

## Step 4: PR

The PR is an artifact, not the finish line — open it once the work
verifies, then improve it in place (Step 5). All commit/PR prep lives here:

- **Build gate first**: discover the project's own build/typecheck/lint
  workflow (`package.json` scripts, Makefile, CI config — ask the repo,
  don't assume) and run it. Failures are must-fix before the PR opens.
- **Deploy notes scan**: scan the run's diff for schema/migrations, env
  vars/secrets, infra/CI, new third-party dependencies, and one-time
  scripts/backfills, then **split each finding by tier and act on it**
  (Autonomy & safety). A finding's **green-tier half** — an additive/nullable,
  reversible change on a non-production environment you can reach (e.g. the
  staging DB) — **must be applied before the verification that depends on it**:
  a staging column the tests read is a Step 3 prerequisite applied at
  implement/verify time, not a Step 4 discovery. This scan is the **backstop** —
  if it is the first to catch an unapplied green change, apply it **and re-run
  the affected verification**, since Step 3 finished before this scan and any
  evidence gathered against the missing schema is void. Its **red-tier half** —
  production, irreversible, or secrets — you **capture as a deploy note and
  never apply**. Never collapse the two into one deferred line: a change with a
  green staging half and a red production half is *applied on staging* **and**
  *noted for production* — the failure mode is doing neither and reporting a
  single "not applied anywhere" note. Flag any finding that **blocks
  verification/QA** — a *staging/test* resource the run gathers evidence against
  (a staging column the tests read, a test-mode key the QA pass needs) — as a
  **prerequisite**, distinct from deploy-time actions. A **production** change
  is never a verification prerequisite: verification runs against non-prod, so
  an unapplied prod migration is a deploy action, not a blocker.
- Commit selectively (only this run's files, never `git add -A`; secret-scan
  the staged diff), message style `type: short imperative summary`. Rebase
  onto the origin default branch; push (`--force-with-lease` on rewrites).
- Open the PR: typed title; write the body following this skill's
  `references/pr-body.md` — its section spine (Summary/What-Why-How, Visual
  overview, User journeys, Verification, Manual tests, QA results, Deploy
  notes, Residual risks), its body-state / comment-proof split, and its
  pre-open checklist are binding. The **Visual overview** is required — its
  only omission is the recorded `Visual overview: none — <reason>` line:
  user-visible changes lead with the before-state and the diagram at open —
  **after-shots land with the QA drive's first body update, minutes after
  open** (the pre-open Visual overview says so explicitly:
  `After-shots: landing with the QA drive`); anything already captured hosts
  on the rolling assets prerelease per Step 5's evidence rule, filenames
  keyed to the work item id;
  flow-/boundary-/lifecycle-shaped changes lead with the before → after
  diagram per the `excalidraw-pr-diagrams` skill — and for a change with
  **no user-visible surface**, the diagram lands with the QA drive's first
  body update instead of blocking PR open: open with
  `Visual overview: diagram landing with the first body update`, author the
  diagram while the post-PR lanes run, and embed it before the QA results
  close; the
  **User journeys** section carries both a journey map and — for branching
  flows — a fork map cross-tagged into the Manual tests; the deploy-notes
  scan above feeds the **Deploy notes** section. Follow
  `.references/tracker-lifecycle.md` for provider closing lines. After `gh pr
  create`, **YOU MUST** retrieve the persisted body, verify and repair the
  expected closing-line set, and read it back before leaving Step 4.

## Step 5: Post-PR review + QA

Reviews run against the open PR and fixes land on it — self-correction
happens on the artifact, not before it exists. The turn in which a reviewer
or verifier report arrives publishes its results (body edit, evidence
comment) before ending — a returned report is never parked for a later turn.

- Run the review lanes over the PR diff (zone 0: both reviewers,
  dispatched together in one message — Agent tool + detached `codex exec`
  — never serially; zones 1–3: Codex alone; the item's explicit
  `review_lanes:` outranks the zone default in either direction, including
  when set on the epic itself)
  (correctness + security, `(security)` tags). A Codex report may arrive
  tiered P0–P3 (its built-in review format) instead of the prescribed
  Must/Should format — map it, never re-dispatch over format: P0/P1 ≡
  Must Fix, P2 ≡ Should Fix, P3 ≡ Nice to Have. When the two lanes
  disagree head-on about a Must Fix, get a second voice before ruling:
  dispatch the `discussant` sub-agent (background) with both findings and
  the disputed diff hunks, weigh its take alongside the lanes', then rule.
  This is the one Overseer meta-call with no adversarial check and no
  downstream net — a wrongly dismissed Must Fix ships, because the loop
  ends on zero Must Fix. Every other judgment call (zone escalation,
  readiness, research depth) stays single-voice — they're bounded or
  self-correcting.
- **Another pass runs only on a trigger — the caps are ceilings, never
  quotas** (cap 3 passes; zones 2–3: 1; epics always 3 passes, with lanes
  derived from zone unless the epic's own `review_lanes:` says otherwise).
  Two triggers: (a) **any Must Fix / P0 / P1
  from either lane** — loop those findings back to the matching
  implementer, push the fixes, re-review; (b) the two lanes' reports
  **diverge sharply** (little overlap in what they caught, or conflicting
  overall verdicts) — one extra pass to confirm convergence. **A pass with
  zero Must Fix from every lane ends the loop**, even with Should Fixes
  open: apply the Should Fixes you judge worth it (or leave them to the
  inline comments below) — a Should Fix never triggers a re-review by
  itself.
- When the loop ends — zero Must Fix, or the cap reached with
  survivors flagged in the wrap-up — run the **QA drive**. This is the
  run's **single app-driving pass** (Step 3 defers all UI acceptance
  criteria here): the `frontend-verifier` proves the deferred UI ACs *and*
  executes the PR body's Manual tests checklist in one session, highest
  risk tier first; the `codex` skill role `backend-verifier` runs the
  command-shaped items. Zone dial (`.references/zones.md`): zones 0–1
  full; zone 2 trimmed to the command-shaped items *plus* the deferred UI
  ACs (record `qa_pass: trimmed`); zone 3 skips both the command-shaped
  items and the Manual-tests execution (record `skipped`) — but **an AC
  whose only possible proof needs the running app is driven at any zone,
  zone 3 included; acceptance evidence is never trimmed by a dial.** When the
  app is needed, apply Step 0's launch rule; the frontend-verifier dispatch
  carries the `AGENTS.md`-sourced launch command, flags, port/URL, and env.
  The dispatch also carries the QA-drive contract: map every touched surface
  and user journey to **ordered,
  step-named captures** (`01-<journey>-<state>.png`) covering meaningful
  states — empty/default, filled, expanded, validation error,
  loading/success, and one narrow viewport when responsive layout is in
  scope; generate a unique test marker (`agent-e2e-<timestamp>`) and
  verify external effects by **readback through connected tools** (a
  network request proves the browser tried; the provider/connector query
  proves the product received it). Both
  dispatches follow `.references/qa-verification.md` — external-system
  confirmation by unique marker, preflight, test-mode safety, cleanup.
  **The capture contract rides in every frontend-verifier/QA dispatch you
  write** — the sub-agent only knows what its prompt says, so state it:
  screenshot every UI state verified, record a video of every journey
  driven through a scriptable driver (one review-encoded mp4 per journey —
  `.references/qa-verification.md` § Journey videos), save all to the
  scratchpad, enumerate each in the report's Captures table (path · what it
  shows · AC#/J#). A report claiming a UI pass with an empty Captures table
  is incomplete — one re-ask for the enumeration before accepting it. Then
  **every enumerated capture gets hosted and embedded** — after-shots into
  the body's Visual overview, per-item evidence into the QA proof comment;
  journey videos get hosted for a durable link (the rolling `qa-assets`
  prerelease below) and linked next to their journey's gallery with the local
  path noted, since inline video players require a human web-UI upload; a
  capture that exists only as prose in a report is a dropped handoff, the
  exact failure this contract exists to prevent.
  Report at two altitudes, into the PR body first per `references/pr-body.md`
  (the body is the live dashboard, not a comment): with `gh pr edit
  --body-file`, flip the Manual-tests `[ ]`→`[x]` on passed items (append
  `— left to human: <reason>` on skipped ones) **and** fill the **QA results**
  summary line — items executed vs left to the human, plus any bug the pass
  found and its fix — changing nothing else. Then post the evidence as a PR
  comment: each item with its quoted output or hosted-image screenshot
  evidence (never committed files) — screenshots render **inline as grouped
  preview galleries**, one `<details open>` block per journey/surface in
  chronological step order, each capture labeled with what the reviewer
  should notice (`<img width="420">` when using HTML); a bare list of
  screenshot URLs is a failed handoff. The comment ends with an explicit
  split: **passed automated** vs **remaining for the human**, so the
  returning human's manual pass starts from the unchecked boxes and the
  remainder list. The QA drive's after-shots also complete the body's
  Visual overview (replacing its `After-shots: landing with the QA drive`
  note). **A bug the QA drive surfaces is never report-and-ship:** loop
  its fix to the implementer, then run one **scoped review pass over the
  fix's diff alone** — the zone's review lanes, additional to the review
  loop's cap — before the QA results line closes. The QA drive runs after
  the review loop exits, so without this pass a behavioral fix born from
  app-driving evidence (exactly the client-state bug a diff-reading
  reviewer can't see) would ship un-reviewed. Body carries state, comment
  carries proof — never
  leave the results only in a comment when the body has a checklist and a QA
  results line to update. After every body update, **YOU MUST** preserve and
  verify the persisted closing-line set per `.references/tracker-lifecycle.md`.
- **Hosting evidence media**: when the repo is on GitHub, host screenshots,
  GIFs, and videos as assets on a rolling `qa-assets` **prerelease**
  (once per repo: `gh release create qa-assets --prerelease
  --title "QA evidence assets" --notes "Rolling QA evidence host — not a
  software release."` — the explicit `--title`/`--notes` matter: without
  them `gh release create` prompts interactively and a headless run hangs;
  then `gh release upload qa-assets <pr#>-<name> --clobber`) and reference the
  `releases/download/...` URLs — CLI-native, permanent, permission-scoped,
  any file type. This rule is step-agnostic: Step 4 hosts the
  Visual-overview captures here *before* the PR exists, so prefix filenames
  with the **work item id** (stable from Step 0; add the PR number once one
  exists if it helps browsing) so the rolling release
  stays browsable. Images/GIFs render inline in comments; videos land as
  links (GitHub only inline-plays web-UI uploads). Expiring temp hosts are
  forbidden for evidence — a dead link months later is no evidence at all.
  On a private repo, note that inline rendering may fail for viewers
  without repo access; the links still work.
- After the loop and QA, post surviving Should Fix / Nice to Have findings
  as line-anchored inline PR comments (`gh api` reviews, event `COMMENT` —
  never `REQUEST_CHANGES`: the loop owns Must Fix, and capped survivors are
  flagged in the wrap-up; these orient the returning human, they gate
  nothing).

## Step 6: Wrap-up

- Assemble the dial record's **run record** before writing: `gh pr view
  --json changedFiles,additions,deletions` for `pr_size`; per-role Codex
  tokens summed from the dispatches' `CODEX <role>: … · tokens <n>` lines;
  Claude sub-agent tokens from the harness's task summaries where shown;
  the `agents` roster (role, model, effort, dispatches, duration, tokens)
  and `spend_ratio`. Record `unknown` where a source didn't expose a
  number — never estimate. This record is what the postmortem and the
  zones.md tuning aggregate consume; a run that doesn't emit it is
  invisible to that tuning.
  When runtime fallback occurred, also carry the plan's `requested_lanes`,
  `effective_lanes`, `runtime_fallback`, and `fallback_cause` into the dial
  record; effective lanes remain single/Codex-only regardless of the request.
- Write `./tmp/<id>/wrapup.md` following this skill's
  `references/wrap-up-report.md`; post
  it as a PR comment. `plan.md` and `wrapup.md` stay in `./tmp/<id>/` —
  unless the project's `AGENTS.md` `Work-item tracking` section specifies
  where work-item artifacts go, in which case save them there per its
  instructions.
- At this wrap-up milestone, when an artifact host is configured, re-upload
  the bundle (now including `wrapup.md`) using the artifact-host step in
  `.references/publish-work-item.md`.
- Immediately before the `awaiting-human-review` label, **YOU MUST** run the
  shared contract's current-item handoff set and report each `In Review`
  operation as `verified`, `already-correct`, `failed`, or `unavailable`.
- Label the PR `awaiting-human-review` (create the label if missing) —
  commits after this label's timestamp are the run's post-review rework
  metric (`.references/zones.md`, The record).
- Before the final report, **YOU MUST** run the shared contract's retained
  merged-PR hygiene set and report each `Done` operation as `verified`,
  `already-correct`, `failed`, or `unavailable`.
- Report to the user: **lead with the PR link**, then a short **Human action
  required** block *before* the prose summary — ordered by urgency and split
  into **✅ done for you** (green-tier actions the run already applied — e.g.
  staging DDL) and **⛔ you must do** (red deploy actions + external unblocks
  like a missing key or access), with anything that **blocks verification/QA
  surfaced first as a prerequisite**. Only then the wrap-up summary and
  anything unresolved. **Notify** run completion per `.references/notify.md`.
- Then run the `postmortem` skill on this run automatically, in its
  **ops-only mode** — the operations half (wall-clock, stalls, tokens,
  review-pass yield) needs no human input and attaches to the same work
  item, so every run leaves an analyzable record without being asked. Its
  change proposals are recorded in the published postmortem, never waited
  on — the run ends right after it publishes. The outcome half stays
  deferred: it runs when the human returns from PR review (or invokes
  `/postmortem` again), because "did the result match intent" isn't
  knowable at wrap-up.

## Epics (type: epic-spec)

Run Steps 1–3 per phase, sequentially — per-phase `plan-<n>.md`, tick the
phase ✓ in the spec on completion. After each phase verifies, review the
phase diff — the epic profile: cap 3, with lanes derived from zone unless
the epic has an explicit `review_lanes:` override — fix and
re-verify, then run the build gate and commit the phase following Step 4's
commit rules. After the last phase, continue from Step 4's PR steps
(deploy-notes scan over the whole epic diff, rebase, push, open the PR) and
run Steps 5–6 once for the whole epic. Phases chain without stopping — a
completed phase flows straight into the next phase's Step 1; never yield to
wait for a "continue" between phases (see Autonomy & safety).

## Rules

- Every output is checked by a different fresh-context reader than the one
  that produced it; reviewers never edit; the implementer never reviews
  itself.
- Never describe an artifact under review as verified, tested, correct, or
  previously approved in a reviewer dispatch. Re-review dispatches present
  prior findings as claimed fixed, to be verified.
- Never expand scope beyond the item.
- Finish unattended: chain steps and phases without stopping for a nudge;
  defer-note-and-notify red-tier actions rather than blocking; stop only for
  a red gate that blocks everything (see Autonomy & safety).
- The run is resumable: plan.md plus the item's ✓ state say where you were —
  and if a turn ends with work remaining, a self-wakeup resumes it rather
  than waiting for a human.
