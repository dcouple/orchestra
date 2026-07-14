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
reports at zones 0–2; zone 3 runs the Codex lane alone. Work routes by surface: backend/ops implementation and
verification → Codex (implementer, backend-verifier); frontend web/mobile
work (UI components, styling, client-side state, user-facing copy) → the
Claude `frontend-implementer`, verified by the Claude `frontend-verifier`.
web-researcher is a Claude sub-agent.

## Autonomy & safety (read first)

This run is meant to finish unattended — started at night, reviewed in the
morning. Three rules make that safe:

- **A phase or step boundary is not a turn boundary.** Never end your turn
  with work remaining and wait to be told "continue" — chain straight into
  the next step. Sub-agents run in the background and re-invoke you when they
  finish; that is not a reason to stop. If you are ever about to yield with
  work left (a long external wait, a tool that re-invokes you later),
  schedule a self-wakeup (`ScheduleWakeup`) so the run resumes on its own
  instead of idling until a human nudges it. Idle-waiting-on-a-nudge is the
  single biggest waste in a /do run; treat it as a bug.
- **Action tiers decide what you may do alone. When unsure which tier an
  action is, it is red — always err toward caution.**
  - **Green — do it unattended:** code, tests, docs, new files, and
    **staging** schema changes that are *both* additive/nullable *and*
    reversible (a new nullable column or new table you could drop with no data
    loss) — anything self-undoing. Apply it; note the production counterpart
    in Deploy notes.
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

**Notify** per `.references/notify.md` — **one-way for now**: inform the human,
don't wait for a phone reply (authenticated two-way approve/deny is future
work). Target comes from repo config (default a per-operator
`ntfy.sh/<gh-username>-dcouple-orchestra`; silent no-op if unreachable), and
after each send you tell the user in chat where it went. Messages are plain
text — the app doesn't render Markdown — titled `[item] stage — why` so
concurrent runs stay legible. Fire at: a red gate (deferred or blocking), a
hard stop, and run completion — never on green-tier progress.

## Step 0: Preflight, then Load

**Preflight first — surface everything human-actionable up front,** so the
run doesn't discover a missing dependency at hour six and stall. Check what
this run will need end-to-end and, in **one** message to the human, list what
is missing or expired with the exact command to fix each: tracker + `gh`
auth; the artifact-provider tool the repo's `AGENTS.md` names (e.g. a Notion
CLI) if artifacts get published; the notify target (`.references/notify.md`);
and the credentials/tooling verification will need (DB, cloud, test-mode API
keys, a browser for computer-use); and the **harness permission modes**: this
session must be running with bypassed permissions
(`claude --dangerously-skip-permissions` — check the process args or note the
first permission prompt as the tell) and Codex action-role dispatches use
`--yolo` per the codex skill — an approval prompt or approval-layer refusal
mid-run burns whole dispatches (a 29-minute environment boot was once wasted
on one). If the harness is NOT in bypass mode, that is a preflight note with
the exact relaunch command — not a stop. Resolvable from config or a quick check →
just confirm it silently. If nothing is missing, say so in one line and
proceed. A missing green-tier dependency is a preflight note, not a
stop — the human clears it while you work; only a dependency the run truly
cannot start without stops Step 0.

Then **Load:**

Get everything about the work item into `./tmp/<id>/` before starting.
This mirrors the publish rule: the project's `AGENTS.md` `Work-item
tracking` section says where work items and their artifacts live — fetch
them per its instructions; with no instructions, the item exists only
locally, so expect it in `./tmp/<id>/`. When the tracker is GitHub issues,
the issue body is the item and the issue's comments carry the refs —
harvest every `<!-- ORCHESTRA-ARTIFACT path="..." -->` block back to its
path under `./tmp/<id>/` (joining `part=n` splits) before planning; an
issue with no artifact comments gives you the body alone, so say so in the
plan's Known mismatches. A local `./tmp/<id>/` that
already exists wins over anything fetched — disk is the working truth;
only fill gaps. A local path is read directly. Invoked with no argument: list
the local items with `status: ready` (`./tmp/*/item.md`) and ask the user
which to run — never pick one silently. Skim `refs/`; read individual refs
as the work calls for them.

Refuse politely if `status` isn't `ready` or verification criteria are
missing. Never create a branch — if on the default branch, stop and ask the
user to set one up.

**Done when**: the item and its artifacts are in `./tmp/<id>/`, status is
`ready`, and you're on a non-default branch.

## Step 1: Plan

Read the item's `zone:` and derive this run's dials from the table in
`.references/zones.md` — record zone and effective dials in `plan.md`'s
frontmatter. Zones 0–1 run the full lane (dossier, dual reviews, cap 3);
zones 2–3 run light (no dossier, cap 1; zone 3 reviews single-lane on
Codex). You may escalate the effective zone one notch toward 0 with the
reason recorded in `plan.md`'s frontmatter; never de-escalate — that's the
human's call at capture, or the table's via postmortem evidence. Item
missing a zone → classify it yourself from stakes and downstream
consequences, record the reasoning in the frontmatter, and proceed. Epics:
see zones.md's Epics override.

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
subsection. Run the review
loop — the zone's review lanes (zones 0–2: Codex + Claude in parallel;
zone 3: Codex alone; epics: always both, per zones.md's Epics) — findings
fixed into the plan — until you're satisfied
the plan is ready, cap 3 passes (zones 2–3: 1); carry anything unresolved
at the cap into the plan's open questions. Score the plan's `confidence:`
(1–10, one-pass implementation confidence) as each pass exits — while
budget remains within the caps, a low score is the signal to spend it (more
research, another pass); the score recorded after the last pass is final.
Never a reason to stop the run.

## Step 2: Implement

Route each dispatch by surface: frontend work → the `frontend-implementer`
sub-agent; backend/ops work → the `codex` skill, role `implementer` (later
fix rounds resume the same Codex session). A mixed plan splits into separate
dispatches — you sequence them. Give each the plan and the item (intent =
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

Prove every verification criterion — the `frontend-verifier` sub-agent for
computer-use flows in the running app (dispatched per the zone's verifier
dial for discretionary checks; an AC whose only possible proof needs the
running app always gets the verifier, at any zone — acceptance evidence is
never trimmed by a dial), the `codex`
skill role `backend-verifier` for tests/scripts. Verification that must spawn
an AI session or feed repo context to an AI CLI routes to a **Claude**
verifier dispatch, never Codex. Any ad-hoc Claude verifier dispatched outside
the named agents (e.g. `general-purpose` for a live-app script check) passes
an explicit `model` (default `opus`) — never inherit the session model
silently. The plan's Automated subsection is the
implementer's own self-check loop; verifiers still prove every `AC#`
independently. Include the change type's rubric from
`.references/rubrics/` in each verifier dispatch (see
`.references/verification-methods.md`); its blocker items gate alongside
the ACs. Quoted evidence on every pass; nothing is assumed. Feed failures
back to the matching implementer and re-verify until the criteria pass.

Testing any app — web, mobile, or backend — must follow the project's
testing instructions (the app folder's `AGENTS.md`/testing docs). If a
verifier reports it has no testing instructions for the app, or can't test
for lack of credentials, environment, or tooling, don't retry or improvise a
workaround — stop the verify loop and ask the user for the missing
instructions or access.

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
  scripts/backfills. Surface findings; never apply or gate on them.
- Commit selectively (only this run's files, never `git add -A`; secret-scan
  the staged diff), message style `type: short imperative summary`. Rebase
  onto the origin default branch; push (`--force-with-lease` on rewrites).
- Open the PR: typed title; write the body following this skill's
  `references/pr-body.md` — its section spine (Summary/What-Why-How, Visual
  overview, User journeys, Verification, Manual tests, QA results, Deploy
  notes, Residual risks), its body-state / comment-proof split, and its
  pre-open checklist are binding. The **Visual overview** leads with the
  before → after diagram per the `excalidraw-pr-diagrams` skill (when
  available and the change is flow-/boundary-/lifecycle-shaped); the
  **User journeys** section carries both a journey map and — for branching
  flows — a fork map cross-tagged into the Manual tests; the deploy-notes
  scan above feeds the **Deploy notes** section. Link the tracker with its
  closing keyword (e.g. `Closes #<n>` for a GitHub issue).

## Step 5: Post-PR review + QA

Reviews run against the open PR and fixes land on it — self-correction
happens on the artifact, not before it exists.

- Run the zone's review lanes over the PR diff (zones 0–2: both reviewers;
  zone 3: Codex alone; epics always both — zones.md's Epics override)
  (correctness + security, `(security)` tags). Loop findings back to the matching implementer and push the fixes;
  cap 3 passes (zones 2–3: 1; zone 3 single-lane on Codex; epics always
  3, dual-lane — zones.md's Epics override).
- When no Must Fix remains from either reviewer — or the cap was reached,
  survivors flagged in the wrap-up — run the **QA pass per the zone's dial**
  (`.references/zones.md`): zones 0–1 as the table says, zone 2 trimmed to
  the command-shaped items (record `qa_pass: trimmed`), zone 3 skipped
  (record `skipped`). When it runs: execute the PR
  body's Manual tests checklist best-effort, highest risk tier first. The
  `frontend-verifier` drives the running app and captures screenshots; the
  `codex` skill role `backend-verifier` runs the command-shaped items. Both
  dispatches follow `.references/qa-verification.md` — external-system
  confirmation by unique marker, preflight, test-mode safety, cleanup.
  Report at two altitudes, into the PR body first per `references/pr-body.md`
  (the body is the live dashboard, not a comment): with `gh pr edit
  --body-file`, flip the Manual-tests `[ ]`→`[x]` on passed items (append
  `— left to human: <reason>` on skipped ones) **and** fill the **QA results**
  summary line — items executed vs left to the human, plus any bug the pass
  found and its fix — changing nothing else. Then post the evidence as a PR
  comment: each item with its quoted output or hosted-image screenshot URLs
  (never committed files). Body carries state, comment carries proof — never
  leave the results only in a comment when the body has a checklist and a QA
  results line to update.
- **Hosting evidence media**: when the repo is on GitHub, host screenshots,
  GIFs, and videos as assets on a rolling `qa-assets` **prerelease**
  (once per repo: `gh release create qa-assets --prerelease
  --title "QA evidence assets" --notes "Rolling QA evidence host — not a
  software release."` — the explicit `--title`/`--notes` matter: without
  them `gh release create` prompts interactively and a headless run hangs;
  then `gh release upload qa-assets <pr#>-<name> --clobber`) and reference the
  `releases/download/...` URLs — CLI-native, permanent, permission-scoped,
  any file type. Prefix filenames with the PR number so the rolling release
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

- Write `./tmp/<id>/wrapup.md` following this skill's
  `references/wrap-up-report.md`; post
  it as a PR comment. `plan.md` and `wrapup.md` stay in `./tmp/<id>/` —
  unless the project's `AGENTS.md` `Work-item tracking` section specifies
  where work-item artifacts go, in which case save them there per its
  instructions.
- Label the PR `awaiting-human-review` (create the label if missing) —
  commits after this label's timestamp are the run's post-review rework
  metric (`.references/zones.md`, The record).
- Report to the user: PR link + wrap-up summary + QA items left to the
  human + anything unresolved (including every red-tier action deferred to
  Deploy notes during the run). **Notify** run completion per
  `.references/notify.md`.

## Epics (type: epic-spec)

Run Steps 1–3 per phase, sequentially — per-phase `plan-<n>.md`, tick the
phase ✓ in the spec on completion. After each phase verifies, review the
phase diff — the epic profile: dual lanes, cap 3 (zones.md's Epics
override outranks the zone's lane/cap dials) — fix and
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
- Never expand scope beyond the item.
- Finish unattended: chain steps and phases without stopping for a nudge;
  defer-note-and-notify red-tier actions rather than blocking; stop only for
  a red gate that blocks everything (see Autonomy & safety).
- The run is resumable: plan.md plus the item's ✓ state say where you were —
  and if a turn ends with work remaining, a self-wakeup resumes it rather
  than waiting for a human.
