# Create Plan workflow contract

## Input

A work title or one-line summary, plus the converged conversation.

Turn what the conversation has established (typically a discussion workflow) into a
work item that the autonomous pipeline can execute. The completion artifact is
`./tmp/<id>/item.md` with `status: ready`.

This skill *captures and sharpens* — it does not re-run the discussion, and it
never fixes code. If the conversation already settled a point, write it down;
don't re-litigate it.

## Steps

### 1. Pick the shape
Three shapes, one decision:

- **Change or addition** (feature, refactor, chore — anything that builds) →
  Feature Ticket track below.
- **Defect** (something worked, or should work, and doesn't) → Bug Report
  track below.
- **Multiple sequential, independently verifiable phases** → say so and hand
  off to the create-epic workflow — don't force an epic into a ticket.

When in doubt, prefer the smaller shape.

**Success criteria**: shape confirmed (or handed off to create-epic).

### 2. Assemble the core

**Feature track** — drive toward the four things the ticket needs, pulling
from the discussion so far:
- **Intent** — the why behind the request
- **Desired end state** — user-visible "done"
- **Locked directions** — only decisions the model shouldn't re-make (number them D1, D2…)
- **Out of scope**

When the work **replaces existing behavior**, decide the compatibility
stance now, with the user, and lock it as a direction: clean replacement
(delete the old path, no shims or fallback layers) or
compatibility-preserving (existing consumers keep working). The pipeline's
reviewers treat an unnamed breaking change as a blocker, so an item that
means to break something must say so.

Where the conversation left a gap, ask the user directly — one focused round,
not a new discussion. If a codebase fact is missing, request the
`code-researcher` role; for an external fact, request the `web-researcher`
role. The harness adapter owns dispatch and lifecycle syntax. A decision the
user consciously defers is recorded in the item's
Open questions as a deferral — named, never papered over.

Set the **zone** (0–3) with the user per `.references/zones.md` — stakes and
downstream consequence radius, never diff size; escalator surfaces force
zone ≤ 1. It goes in the item frontmatter and drives pipeline review effort.
Review defaults are dual at zone 0 and single at zones 1–3. Offer the
user the explicit override; when they want a different review depth, set
`review_lanes: dual | single` in the frontmatter. It overrides the zone's lane
dial (zones.md), rides to the tracker with the item, and stays editable there
as metadata until the pipeline runs.

**Success criteria**: the user has explicitly agreed to intent, end state, each
locked direction (including the compatibility stance when behavior is
replaced), the zone, and the out-of-scope list.

**Bug track** — take stock of the investigation. Check what the conversation
already established: reproduction, root cause + evidence, confidence level. A
root-cause finding from an `investigator` request during discussion is the
ideal input — reuse it, don't redo it.

If the root cause is **not** yet established, run the investigation now:
- Request the `investigator` role with the full
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
resolution path should be locked as a direction or left to the pipeline. Skip the
ceremony when severity is obvious.

**Success criteria**: a root-cause finding with an honest confidence level
(`confirmed | likely | hypothesis`) — or a documented failed-to-reproduce with
the attempts listed — plus severity (`critical | high | medium | low`) and
business impact agreed with the user.

### 3. Write the work item
Draft `./tmp/<id>/item.md` per `.references/draft-work-item.md`, using the
track template:
`.references/workflows/formats-and-assets/feature-ticket.md` or
`.references/workflows/formats-and-assets/bug-report.md`.

Feature specifics — suitable AC methods: a lint rule, test, script (backend),
or natural navigation of the running app (frontend/mobile).

Bug specifics:
- Reproduction steps go **in the report** — deterministic enough for the verify stage
  to re-run them. Raw traces, logs, and long transcripts go to `./tmp/<id>/refs/`
  (e.g. `refs/error-trace.txt`), linked not inlined. If the investigation produced a
  current-state deep-dive worth keeping, save it per
  `.references/system-analysis.md` as `refs/system-analysis.md`.
- Verification criteria must include:
  - **AC1**: the reproduction flipping from fail to pass — the repro steps double as
    the failing case the fix must flip.
  - **Prevention criteria**: what stops this class of bug recurring — a regression
    test, a custom lint/static rule (the most durable guard), or an invariant —
    verifiable, not aspirational.

**Success criteria**: `item.md` exists; every AC is numbered, observable, and
mapped; bug items have a re-runnable repro, AC1 mapped to it, and prevention
criteria; nothing in the item restates what `refs/` or the model already
covers.

### 4. Render the explainer and align
Generate `./tmp/<id>/refs/explainer.html` per `.references/html-explainer.md`
and open it in the user's browser. This page — not raw `item.md` — is what the
user aligns on: for a feature, the change, the before/after, and the proposed
implementation direction; for a bug, expected vs actual, the root cause (with
its confidence level stated honestly), and the suggested resolution path.
Fold corrections back into `item.md` and regenerate.

**Success criteria**: explainer opened in the browser; user has confirmed the
item against it; `item.md` and explainer agree.

### 5. Socratic gate
Run the gate per `.references/socratic-gate.md`.

- For a **feature** it bears down on necessity, root cause, simpler
  alternatives, and shape; a straightforward, well-justified draft
  fast-passes with zero to two questions. If the dialogue reveals a
  multi-phase shape, hand off to create-epic.
- For a **bug** it bears down on root cause vs symptom (does the cause
  survive another "why"?), evidence, whether the fix prevents the class or
  just this instance, and completeness — sibling instances of the same
  defect class elsewhere, or follow-up work this fix implies. A confirmed
  cause with a contained fix fast-passes. If the dialogue surfaces a deeper
  cause to chase, re-dispatch the investigator before proceeding.

**Success criteria**: gate procedure complete — socrates returned `pass` (or
the cap was reached, or the user waived); `## Justification` written into
`item.md`.

### 6. Mark ready and publish
If the gate changed the item, regenerate the explainer first so the attached
copy matches. Publish per `.references/publish-work-item.md` — title
`feat: <title>` (feature) or `fix: <title>` (bug); body = the item's intent,
end state or reproduction + root cause, verification criteria summary, and
the Justification section. Bug exception: leave `status: draft` if the cause
is still a hypothesis and the user wants more evidence first — publish
happens either way.

**Success criteria**: published and cross-linked per the shared procedure —
or, when the repo configures no destination, the item is complete in
`./tmp/<id>/` and the user was told nothing was published.

```
Suggested next steps:
- run the autonomous pipeline against this item
- continue the discussion workflow if a gap surfaced that needs more thinking first
```
