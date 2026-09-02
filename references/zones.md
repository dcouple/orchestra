# Zones - stakes-based review-effort profiles

Every work item carries a `zone:` (0–3) assigned at capture. The zone
classifies **stakes and downstream consequence radius - never diff size**: a
one-line fix in the payment path is zone 0; a large internal refactor no user
will feel is zone 1; a UI behavior tweak with a small consequence radius can
be zone 2. `/do` derives its dials from the zone.

## The zones

- **Zone 0 - must be perfect.** Direct impact on production data, users,
  money, or security - or the user says perfection matters.
- **Zone 1 - substantial.** Large or system-shaping changes whose
  consequences stay short of zone 0's surfaces (big features, refactors,
  changes to the workflow/skills themselves).
- **Zone 2 - contained.** Focused fix or small change; blast radius limited
  to what it touches; consequences visible and cheap to reverse.
- **Zone 3 - trivial.** Docs, copy, comments, config text; no runtime
  behavior change.

## Dial table

| Zone | Review lanes | Loop caps (plan / post-PR passes = pre-QA + reserved / fix reads) | Frontend verifier | End QA pass | Research |
|---|---|---|---|---|---|
| 0 | dual (Codex + Claude), always | 3 / 4 = 3 + 1 / 2 | yes, when UI is touched | always | full (dossier) |
| 1 | single - Codex | 3 / 3 = 2 + 1 / 2 | when user-visible | always - full checklist when user-visible, command-shaped otherwise | full (dossier) |
| 2 | single - Codex | 1 / 1 = 1 + 0 / 1 | only when reproduction needs the running app | command-shaped items only | direct (no dossier) |
| 3 | **single - Codex** | 1 / 1 = 1 + 0 / 0 | no | no | direct |

Multi-phase items take zone 1's row as a floor (zone 0 keeps its own row). This table is the only place the post-PR counter values are stated; `plan.md`'s `review_state:` records the run's instance of them, and every other file references the two.

Wherever the table drops to one lane, **Codex is the lane that stays**.
The verifier and QA dials govern *discretionary* verification - an AC whose
only possible proof needs the running app always gets the frontend
verifier, at any zone: acceptance evidence is never trimmed by a **zone**
dial. The one thing that can skip it is the item's explicit
`frontend_verifier: false` - the user's call, honored in both directions
(`true` forces the verifier even where the zone wouldn't run it). When
`false` leaves app-only ACs unproven, they are recorded as
`unverified - frontend verifier disabled by the item` in the wrap-up,
never claimed passed.

## Rules

- **Escalation runs toward zone 0** (3 → 2 → 1 → 0): a lower number means
  higher stakes and more machinery. "Escalate one notch" always means one
  step toward 0.
- **Escalators are rules, not judgment.** Any touch of auth,
  schema/migrations, money, production config, or data deletion forces
  **zone 1 at minimum**, regardless of diff size; when the impact on
  production users/data/money is direct, it is zone 0. This list is
  canonical - other documents reference it, never restate it.
- **Floors before notches.** Apply in order: first the escalator floors
  normalize the zone (an item discovered mid-run to touch an escalator
  surface is re-zoned to the floor outright - a correction, recorded, not
  the one-notch deviation); then the Overseer may escalate one further
  notch toward 0 with a recorded reason. Escalation applies the target
  zone's full dial row, including its lane setting.
- **Escalate freely, de-escalate only via this table.**
  De-escalating below the item's zone is a capture-time decision (the human
  re-zones the item) - never an in-run one. Lowering this table's defaults
  requires postmortem evidence (yield data), one change at a time.
- **Loop caps are ceilings, never quotas.** A review loop ends the moment a
  pass returns zero Must Fix (Codex tiers: P0/P1) from every lane and the
  lanes roughly agree - remaining cap budget is never spent re-reviewing
  Should Fixes.
- **Post-PR code review has three units, each counted in lane-sets** (a dual-lane unit is one unit; a lane-set is complete when at least one lane reports - a lane whose dispatch and single retry both fail is recorded `lanes: codex-only | claude-only` on the unit's report entry and the run proceeds on the lane that reported). **Passes** are whole-diff reviews of the first phase or the PR, capped per the table; of the cap, **one pass is reserved** for the fix of a QA-found bug at zones 0–1 and on multi-phase items (none at zones 2–3 single-outcome), the rest are pre-QA. **Fix reads** are scoped reviews of a post-ceiling fix, with their own ceiling per the table, never moving the pass counter. **The reserved pass** is the third unit. Every first-phase review, whole-PR review, confirmation pass, and hosted review trigger spends a pre-QA pass; a QA-fix review spends the reserve; a checklist re-ask spends nothing; a unit whose every lane failed spends nothing - its range is labeled `unreviewed: <range> - dispatch failed (<reason>)`, it may be retried once after the next successful dispatch of any role, and a zone 0–1 item never reaches QA with no pass used unless that label explains it. Counters never reset - not at a phase boundary, PR open, QA, resume, or changed HEAD - and at least one pre-QA pass is held for the whole-PR review. When no read remains, a Must Fix is carried as a survivor, not fixed unread (zone 3 excepted, labeled `unreviewed:`). A changed HEAD alone is not a review trigger; P2/P3 findings never trigger another unit.
- **Reviewer-report intake (Overseer, every unit, before adjudicating).** (1) Persist the report verbatim as `./tmp/<id>/refs/review-<unit>-<lane>.md` (unit `p<k>`, `r<j>`, or `q`; lane `codex` or `claude`), record it with its commit range and lanes under `review_state.reports`, and clear `in_flight`. (2) Re-tier to Must Fix any Should Fix whose Evidence line names a concrete path or state describing data loss, a security defect, a config-widenable guard, or a missing authorization check - a Must Fix trigger regardless of the lane's verdict; a class claim with no concrete evidence goes to Cannot verify, not to Must Fix; a finding that reveals an escalator surface (above) re-zones the run to that floor now. (3) Check the System checklist: a report missing it, or carrying an `n/a` the reviewed range contradicts (code of that class present in the range - a filename alone is not a contradiction), gets one re-ask narrowed to those rows - Codex: a fresh `--ephemeral` dispatch carrying the prior report, persisted as `refs/review-<unit>-<lane>-reask.md`, not a unit; a Claude lane: `SendMessage` to the same sub-agent - and a second omission or contradiction records `checklist: missing` or `checklist: contradicted` for that unit.
- **`review_lanes:` and `frontend_verifier:` are the two human-settable
  dial overrides.** An item may
  carry `review_lanes: dual | single` in its metadata - set at capture or
  edited later as item metadata on the tracker. `/do` honors it over the
  table's lane dial in both directions (it's the human's explicit call, so
  unlike the zone it may also de-escalate); `single` keeps the Codex lane,
  same as everywhere the table drops to one. Every other dial still derives
  from the zone.
- Missing `zone:` on an item → the Overseer classifies from stakes +
  consequences, records the classification and reasoning in `plan.md`, and
  proceeds; the Socratic gate should have caught this at capture.

## The record (what every run emits)

The wrap-up's dial record and the postmortem carry: zone, effective dials
(lanes, passes used per loop, verifiers/QA run), findings per lane split
first-pass vs later passes (repeat-pass yield is the tuning signal), QA
findings, wall-clock, **tokens** (total, per source, per Codex role), **PR
size** (files changed, lines added/removed), the **spend ratio** (tokens
per changed line - the size-normalized cost score), and the **agents
roster** (role × model × effort × dispatches × duration × tokens) - and
the PR gets the `awaiting-human-review` label at wrap-up so that **commits
after that label's timestamp** are countable as post-review rework.
Aggregated later as zone × model × path → rework and spend, this is the
evidence that tunes this table; capture it even when a number is only
reachable as `unknown`.

## Multi-phase items

A multi-phase item (two or more entries in the item metadata's `phases` list) always uses the **full research/planning machinery**. Its review lanes come from its zone - dual at zone 0, single Codex at zones 1–3 - and its post-PR counters take **zone 1's row of the dial table as a floor** (zone 0 keeps its own row). Pre-QA passes on a multi-phase item are placed so: pass 1 over the first phase's diff at its commit; the whole-PR pass at open, chartered to list every later phase's commit range as required coverage alongside integration (as a phase-diff pass this caught 3 Must Fix on PR #8 and 1 on PR #7 - the charter must cover the same ground); at zone 0 the third pre-QA pass is a re-review or, with three or more phases, may instead cover the combined diff of phases 2..N−1 at the commit of phase N−1. Later phases never get a pass of their own. Phase boundaries never reset any counter.
The zone still gates
the frontend-verifier and QA dials per phase, and still rides in every record.
Skills reference this override here. An explicit `review_lanes:` on the item
itself outranks the zone default in either direction.
