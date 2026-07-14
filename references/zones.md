# Zones — stakes-based review-effort profiles

Every work item carries a `zone:` (0–3) assigned at capture. The zone
classifies **stakes and downstream consequence radius — never diff size**: a
one-line fix in the payment path is zone 0; a large internal refactor no user
will feel is zone 1; a UI behavior tweak with a small consequence radius can
be zone 2. `/do` derives its dials from the zone.

## The zones

- **Zone 0 — must be perfect.** Touches production data, users, money, auth,
  schema/migrations, security surfaces — or the user says perfection matters.
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
| 1 | dual | 3 / 3 | when user-visible | when user-visible | full (dossier) |
| 2 | dual | 1 / 1 | only when reproduction needs the running app | command-shaped items only | direct (no dossier) |
| 3 | **single — Codex** | 1 / 1 | no | no | direct |

Wherever the table drops to one lane, **Codex is the lane that stays**.

## Rules

- **Escalators are rules, not judgment.** Any touch of auth, schema/
  migrations, money, production config, or data deletion forces zone ≤ 1
  regardless of diff size.
- **Up freely, down only via this table.** The Overseer may raise the
  effective zone by one notch with a recorded reason. Lowering below the
  item's zone requires the human — and lowering this table's defaults
  requires postmortem evidence (yield data), one change at a time.
- **The initial table is deliberately conservative**: zones 0–1 preserve
  full effort; reductions exist only where yield is already known to be low.
- Missing `zone:` on an item → the Overseer classifies from stakes +
  consequences, records the classification and reasoning in `plan.md`, and
  proceeds; the Socratic gate should have caught this at capture.

## The record (what every run emits)

The wrap-up's dial record and the postmortem carry: zone, effective dials
(lanes, passes used per loop, verifiers/QA run), findings per pass per lane,
QA findings, wall-clock — and the PR gets the `awaiting-human-review` label
at wrap-up so that **commits after that label's timestamp** are countable as
post-review rework. Aggregated later as zone × model × path → rework, this
is the evidence that tunes this table.
