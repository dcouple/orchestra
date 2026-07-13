---
name: create-plan
description: Captures discussed work as a work item ready for /do — a Feature Ticket for changes and additions, a Bug Report for defects (running the investigator first if the root cause isn't established). For multi-phase workstreams use /create-epic instead.
argument-hint: "[title or one-line summary]"
disable-model-invocation: true
---

# Create Plan

## Work: $ARGUMENTS

Turn what the conversation has established (typically a `/discussion`) into a
work item that `/do` can execute autonomously. The completion artifact is
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
  off to `/create-epic` — don't force an epic into a ticket.

When in doubt, prefer the smaller shape.

**Success criteria**: shape confirmed (or handed off to `/create-epic`).

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
compatibility-preserving (existing consumers keep working). `/do`'s
reviewers treat an unnamed breaking change as a blocker, so an item that
means to break something must say so.

Where the conversation left a gap, ask the user directly — one focused round,
not a new discussion. If a codebase fact is missing, dispatch the `codex`
skill (role `code-researcher`); for an external fact, the `web-researcher`
sub-agent. A decision the user consciously defers is recorded in the item's
Open questions as a deferral — named, never papered over.

**Success criteria**: the user has explicitly agreed to intent, end state, each
locked direction (including the compatibility stance when behavior is
replaced), and the out-of-scope list.

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
ceremony when severity is obvious.

**Success criteria**: a root-cause finding with an honest confidence level
(`confirmed | likely | hypothesis`) — or a documented failed-to-reproduce with
the attempts listed — plus severity (`critical | high | medium | low`) and
business impact agreed with the user.

### 3. Write the work item
Draft `./tmp/<id>/item.md` per `.references/draft-work-item.md`, using this
skill's template for the track: `references/feature-ticket.md` or
`references/bug-report.md`.

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
  multi-phase shape, hand off to `/create-epic`.
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
happens either way, so the evidence trail lives with the published item.

**Success criteria**: published and cross-linked per the shared procedure —
or, when the repo configures no destination, the item is complete in
`./tmp/<id>/` and the user was told nothing was published.

```
Suggested next steps:
- `/do <item ref or ./tmp/<id>/item.md>` — run the autonomous pipeline against this item
- `/discussion [follow-up]` — if a gap surfaced that needs more thinking first
```
