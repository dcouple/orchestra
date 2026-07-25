---
name: create-plan
description: Captures discussed work as a work item ready for /do — a feature plan for changes and additions (single-outcome or multi-phase), a bug plan for defects (running the investigator first if the root cause isn't established). Use when a conversation has converged on buildable work that has no work item yet — whether the user asks to capture it or convergence makes capture the obvious next step. Do not invoke for a passing idea, an unconverged thread, or work that already has an item.
argument-hint: "[title or one-line summary]"
---

# Create Plan

## Work: $ARGUMENTS

Turn what the conversation has established (typically a `/discussion`) into a
work item that `/do` can execute autonomously. The completion artifact is
`./tmp/<id>/plan.html` with `status: ready` in its metadata — one page that is
both what the user aligns on and what `/do` executes against
(`.references/html-plan.md`).

This skill *captures and sharpens* — it does not re-run the discussion, and it
never fixes code. If the conversation already settled a point, write it down;
don't re-litigate it. How many phases the work has is a property of the item
(step 3), not a different skill.

## Steps

### 1. Pick the shape
Two shapes, one decision:

- **Change or addition** (feature, refactor, chore — anything that builds) →
  feature track below.
- **Defect** (something worked, or should work, and doesn't) → bug track
  below.

When in doubt, prefer the smaller shape.

**Success criteria**: shape confirmed.

### 2. Assemble the core

**Feature track** — drive toward what the plan needs, pulling from the
discussion so far:
- **Intent** — the why behind the request
- **Desired end state** — user-visible "done"
- **Locked directions** — only decisions the model shouldn't re-make (number them D1, D2…)
- **Out of scope**
- **Dependencies & mechanics** — the inventory that forces discovery now, not
  during implementation: every external service, touched subsystem, human
  dependency, and notable new package; the schema delta (explicitly "none"
  when none); and sequencing (work that should land first, follow-ups this
  creates). For each dependency, either its mechanics are **verified** — a
  `codex` dispatch (role `code-researcher`) for codebase facts or the
  `web-researcher` sub-agent for external ones, its finding saved as a
  `refs/<topic>.html` sub-report — or it is marked **assumed** and the user
  consciously accepts that.

When the work **replaces existing behavior**, decide the compatibility
stance now, with the user, and lock it as a direction: clean replacement
(delete the old path, no shims or fallback layers) or
compatibility-preserving (existing consumers keep working). `/do`'s
reviewers treat an unnamed breaking change as a blocker, so an item that
means to break something must say so.

Clarification scales with the stakes (`.references/draft-work-item.md`):
zone 0–1 or multi-phase gets an interview loop that keeps digging until the
dependency inventory holds no unexamined `assumed` entries; zone 2–3
single-phase gets one focused round. A decision the user consciously defers
is recorded in Open questions as a deferral — named, never papered over.

Set the **zone** (0–3) with the user per `.references/zones.md` — stakes and
downstream consequence radius, never diff size; escalator surfaces force
zone ≤ 1. It goes in the item metadata and drives `/do`'s review effort.
Review defaults are dual at zone 0 and single Codex at zones 1–3. Offer the
user the explicit override; when they want a different review depth, set
`review_lanes: dual | single` in the metadata. It overrides the zone's lane
dial (zones.md), rides to the tracker with the item, and stays editable there
as metadata until `/do` runs.

**Success criteria**: the user has explicitly agreed to intent, end state, each
locked direction (including the compatibility stance when behavior is
replaced), the zone, the out-of-scope list, and every dependency's
verified/assumed standing including the schema delta.

**Bug track** — take stock of the investigation. Check what the conversation
already established: reproduction, root cause + evidence, confidence level. A
root-cause finding from an `investigator` dispatch during `/discussion` is the
ideal input — reuse it, don't redo it.

If the root cause is **not** yet established, run the investigation now:
- Dispatch the investigator via the `codex` skill (role `investigator`) with the full
  report (expected vs actual, environment, known repro steps, traces); it returns its
  standard root-cause finding.
- If reproduction requires driving the running app, dispatch `frontend-verifier`
  first to exercise the flow and capture evidence, then pass its transcript along
  with the defect report.
- If the investigator cannot reproduce: say so plainly. Do not invent a cause. Either
  gather more from the user (logs, exact environment) and re-dispatch, or proceed with
  root cause marked `Hypothesis:` and what-was-tried captured in `refs/`.

Then confirm impact and severity with the user where judgment is needed: who
is affected, how widespread, why it matters now, and whether the suggested
resolution path should be locked as a direction or left to `/do`. Skip the
ceremony when severity is obvious. Bugs still carry the Dependencies &
mechanics section — often just the mandatory schema-delta line.

**Success criteria**: a root-cause finding with an honest confidence level
(`confirmed | likely | hypothesis`) — or a documented failed-to-reproduce with
the attempts listed — plus severity (`critical | high | medium | low`) and
business impact agreed with the user.

### 3. Cut the phases (only when the work is multi-phase)
If the work is one coherent outcome, record a single `phases` entry and move
on. Otherwise split it into sequential phases, each a self-contained slice:
one coherent outcome, independently verifiable, buildable on the phases
before it. Don't split because many files are touched — split where
verification surfaces genuinely differ. Multi-phase items run sequentially
in one PR under `/do`. A phase that could stand alone entirely — or wait —
belongs in the Sequencing panel as a separate candidate item instead.

**Success criteria**: the `phases` list agreed with the user — each phase has
a goal, scope, and its own verification surface; order confirmed.

### 4. Author the plan and align
Author `./tmp/<id>/plan.html` per `.references/draft-work-item.md` (mechanics)
and `.references/html-plan.md` (page contract and section map), and open it in
the user's browser. This page is the work item: for a feature, the change,
the before/after, dependencies & mechanics, and the direction; for a bug,
expected vs actual, the root cause (confidence stated honestly), and the
resolution path; for multi-phase work, the binding phase timeline and
per-phase blocks. Fold corrections in as in-place edits.

Feature specifics — suitable AC methods: a lint rule, test, script (backend),
or natural navigation of the running app (frontend/mobile).

Bug specifics:
- Reproduction steps go **in the plan's Verification section** — deterministic
  enough for the verify stage to re-run them. Raw traces, logs, and long
  transcripts go to `./tmp/<id>/refs/` (e.g. `refs/error-trace.txt`), linked
  not inlined. If the investigation produced a current-state deep-dive worth
  keeping, save it per `.references/system-analysis.md` as
  `refs/system-analysis.md`.
- Verification criteria must include:
  - **AC1**: the reproduction flipping from fail to pass — the repro steps double as
    the failing case the fix must flip.
  - **Prevention criteria**: what stops this class of bug recurring — a regression
    test, a custom lint/static rule (the most durable guard), or an invariant —
    verifiable, not aspirational.

**Success criteria**: `plan.html` exists and the user has confirmed the item
against it in the browser; every AC is numbered, observable, and mapped; bug
items have a re-runnable repro, AC1 mapped to it, and prevention criteria;
nothing in the page restates what `refs/` or the model already covers.

### 5. Socratic gate
Run the gate per `.references/socratic-gate.md`. Intensity keys off the
stakes: a multi-phase item is never "straightforward" — expect the full
challenge on shape (are the phases real?), appetite, consequences, and
completeness.

- For a **feature** it bears down on necessity, root cause, simpler
  alternatives, shape, and mechanics (which dependency is `assumed` rather
  than `verified`?); a straightforward, well-justified draft fast-passes
  with zero to two questions. If the dialogue reveals a different phase
  shape, return to step 3 and recut.
- For a **bug** it bears down on root cause vs symptom (does the cause
  survive another "why"?), evidence, whether the fix prevents the class or
  just this instance, and completeness — sibling instances of the same
  defect class elsewhere, or follow-up work this fix implies. A confirmed
  cause with a contained fix fast-passes. If the dialogue surfaces a deeper
  cause to chase, re-dispatch the investigator before proceeding.

**Success criteria**: gate procedure complete — socrates returned `pass` (or
the cap was reached, or the user waived); the Justification section written
into `plan.html`.

### 6. Mark ready and publish
Publish per `.references/publish-work-item.md`, using
`.references/artifact-host-upload.md` for upload mechanics — title
`feat: <title>` (feature) or `fix: <title>` (bug); body = the item's intent,
end state or reproduction + root cause, verification criteria summary, and
the Justification section, with the phase list when multi-phase. Bug
exception: leave `status: draft` if the cause is still a hypothesis and the
user wants more evidence first — publish happens either way.

**Success criteria**: published and cross-linked per the shared procedure —
or, when the repo configures no artifact host, the item is complete in
`./tmp/<id>/` and the user was told publishing needs an `artifact_host`.

```
Suggested next steps:
- `/do <item ref or ./tmp/<id>/plan.html>` — run the autonomous pipeline against this item
- `/discussion [follow-up]` — if a gap surfaced that needs more thinking first
```
