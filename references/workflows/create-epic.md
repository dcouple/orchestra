# Create Epic workflow contract

## Input

An epic title or one-line summary, plus the converged conversation.

Turn what the conversation has established (typically a discussion workflow) into an Epic
Spec that the autonomous pipeline can execute phase by phase. The completion artifact is
`./tmp/<id>/item.md` with `status: ready`. Epics run **sequentially** in one PR —
phase n+1 starts only after phase n's channel completes.

This skill *captures and sharpens* — it does not re-run the discussion.

## Steps

> Epics carry a `zone:` like any item, agreed with the user; the epic
> override in `.references/zones.md` (Epics) governs how it applies.


### 1. Assemble the core from the conversation
Drive toward what the spec needs, pulling from the discussion so far:
- **Problem / context** — the broader problem and why now
- **Goals and desired end state** — what the world looks like when the epic lands
- **Locked directions** — only decisions the model shouldn't re-make (number them D1, D2…)
- **Out of scope**

Where the conversation left a gap, ask the user directly — one focused round. If a
codebase fact is missing, request the `code-researcher` role; for an
external fact, request the `web-researcher` role. The harness adapter owns
dispatch and lifecycle syntax.

**Success criteria**: the user has explicitly agreed to problem, end state, each locked
direction, and the out-of-scope list.

### 2. Cut the phases
Split the work into sequential phases, each a self-contained work item: one coherent
outcome, independently verifiable, buildable on the phases before it. Don't split
because many files are touched — split where verification surfaces genuinely differ.
If it collapses to one phase, say so and suggest the create-plan workflow instead.

**Success criteria**: phase table agreed with the user — each phase has a goal, scope,
and its own verification surface; order confirmed.

### 3. Write the work item
Draft `./tmp/<id>/item.md` per `.references/draft-work-item.md`, using
`.references/workflows/formats-and-assets/epic-spec.md` as the template. Epic specifics:
- Verification criteria are **per phase**: `AC1…` numbered within each phase,
  each mapped to a method matched to that phase's change type.
- Keep spec altitude: no file lists, pseudo-code, or task sequences —
  the autonomous pipeline's plan stage owns the *how* per phase.

**Success criteria**: `item.md` exists; phases are sequential and independently
verifiable; every AC is numbered, observable, and mapped; spec altitude respected.

### 4. Render the explainer and align
Generate `./tmp/<id>/refs/explainer.html` per `.references/html-explainer.md`
(one page for the whole epic, with the phase timeline) and open it in the
user's browser. This page is what the user aligns on: the problem, the phase
cut, and the cross-cutting directions. Fold corrections back into `item.md`
and regenerate.

**Success criteria**: explainer opened in the browser; user has confirmed
problem, phases, and directions against it; `item.md` and explainer agree.

### 5. Socratic gate
Run the gate per `.references/socratic-gate.md`. A multi-phase commitment
is never "straightforward" — expect the full challenge. For an epic it bears
down on shape (are the phases real?), appetite, consequences, and
completeness, alongside necessity and assumptions. If the dialogue collapses
the epic to one phase, hand off to the create-plan workflow.

**Success criteria**: gate procedure complete — socrates returned `pass` (or
the cap was reached, or the user waived); `## Justification` written into
`item.md`.

### 6. Mark ready and publish
If the gate changed the item, regenerate the explainer first so the attached
copy matches. Publish per `.references/publish-work-item.md` — title
`feat: <epic title>`, body = the epic's problem, end state, the
phases table, and the Justification section.

**Success criteria**: published and cross-linked per the shared procedure —
or, when the repo configures no destination, the item is complete in
`./tmp/<id>/` and the user was told nothing was published.

```
Suggested next steps:
- run the autonomous pipeline for the item — phases execute sequentially in one pull request
- continue the discussion workflow if a phase boundary needs more thinking first
```
