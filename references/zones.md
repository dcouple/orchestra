# Zones — stakes-based review-effort profiles

Every work item carries a `zone:` (0–3) assigned at capture. The zone
classifies **stakes and downstream consequence radius — never diff size**: a
one-line fix in the payment path is zone 0; a large internal refactor no user
will feel is zone 1; a UI behavior tweak with a small consequence radius can
be zone 2. `/do` derives its dials from the zone.

## The zones

- **Zone 0 — must be perfect.** Direct impact on production data, users,
  money, or security — or the user says perfection matters.
- **Zone 1 — substantial.** Large or system-shaping changes whose
  consequences stay short of zone 0's surfaces (big features, refactors,
  changes to the workflow/skills themselves).
- **Zone 2 — contained.** Focused fix or small change; blast radius limited
  to what it touches; consequences visible and cheap to reverse.
- **Zone 3 — trivial.** Docs, copy, comments, config text; no runtime
  behavior change.

## Dial table

| Zone | Review lanes | Loop caps (plan / post-PR) | Frontend verifier | End QA pass | Research |
|---|---|---|---|---|---|
| 0 | dual (Codex + Claude), always | 3 / 3 | yes, when UI is touched | always | full (dossier) |
| 1 | single — Codex | 3 / 3 | when user-visible | always — full checklist when user-visible, command-shaped otherwise | full (dossier) |
| 2 | single — Codex | 1 / 1 | only when reproduction needs the running app | command-shaped items only | direct (no dossier) |
| 3 | **single — Codex** | 1 / 1 | no | no | direct |

Wherever the table drops to one lane, **Codex is the lane that stays**.
The verifier and QA dials govern *discretionary* verification — an AC whose
only possible proof needs the running app always gets the frontend
verifier, at any zone: acceptance evidence is never trimmed by a dial.

## Rules

- **Escalation runs toward zone 0** (3 → 2 → 1 → 0): a lower number means
  higher stakes and more machinery. "Escalate one notch" always means one
  step toward 0.
- **Escalators are rules, not judgment.** Any touch of auth,
  schema/migrations, money, production config, or data deletion forces
  **zone 1 at minimum**, regardless of diff size; when the impact on
  production users/data/money is direct, it is zone 0. This list is
  canonical — other documents reference it, never restate it.
- **Floors before notches.** Apply in order: first the escalator floors
  normalize the zone (an item discovered mid-run to touch an escalator
  surface is re-zoned to the floor outright — a correction, recorded, not
  the one-notch deviation); then the Overseer may escalate one further
  notch toward 0 with a recorded reason.
- **Escalate freely, de-escalate only via this table.**
  De-escalating below the item's zone is a capture-time decision (the human
  re-zones the item) — never an in-run one. Lowering this table's defaults
  requires postmortem evidence (yield data), one change at a time.
- **Loop caps are ceilings, never quotas.** A review loop ends the moment a
  pass returns zero Must Fix (Codex tiers: P0/P1) from every lane and the
  lanes roughly agree — remaining cap budget is never spent re-reviewing
  Should Fixes.
- **`review_lanes:` is the one human-settable dial override.** An item may
  carry `review_lanes: dual | single` in its frontmatter — set at capture or
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
per changed line — the size-normalized cost score), and the **agents
roster** (role × model × effort × dispatches × duration × tokens) — and
the PR gets the `awaiting-human-review` label at wrap-up so that **commits
after that label's timestamp** are countable as post-review rework.
Aggregated later as zone × model × path → rework and spend, this is the
evidence that tunes this table; capture it even when a number is only
reachable as `unknown`.

## Epics

An epic is always **full machinery**: dossier and cap 3. Its review lanes follow
the zone rule: dual at zone 0, single Codex at zones 1–3. The zone still gates
the frontend-verifier and QA dials per phase, and still rides in every record.
Skills reference this override here. An explicit `review_lanes:` on the epic
itself outranks the zone default in either direction.
