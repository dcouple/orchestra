---
name: create-brief
description: Captures discussed work as a work item ready for /do — a feature brief for changes and additions (single-outcome or multi-phase), a bug brief for defects (running the investigator first if the root cause isn't established). Use when a conversation has converged on buildable work that has no work item yet — whether the user asks to capture it or convergence makes capture the obvious next step. Do not invoke for a passing idea, an unconverged thread, or work that already has an item.
argument-hint: "[title or one-line summary]"
---

# Create Brief

## Work: $ARGUMENTS

Turn what the conversation has established (typically a `/discussion`) into a
work item that `/do` can execute autonomously. The completion artifact is
`./tmp/<id>/brief.html` with `status: ready` in its metadata — one page that is
both what the user aligns on and what `/do` executes against
(`.references/html-brief.md`).

The brief is the user's document. Its purpose is to show the user, as
concretely as possible, what is going to happen — so the idea gets refined
*before* it is handed to an agent, minimizing the need for intervention once
implementation runs. `/do` later derives its own implementation plan
(`plan.md`) from the brief; the brief stays at the altitude the user decides
at.

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

**Feature track** — drive toward what the brief needs, pulling from the
discussion so far:
- **Intent** — the why behind the request
- **Desired end state** — user-visible "done"
- **Locked directions** — only decisions the model shouldn't re-make (number them D1, D2…)
- **Out of scope**
- **Dependencies & mechanics** — research the load-bearing dependencies
  and systems this work will rely on and how they work
  (`.references/html-brief.md` · Dependencies & mechanics owns the full
  contract, including sub-reports and sequencing). The required outcome:
  every dependency ends **verified** — a `codex` dispatch (role
  `code-researcher`) for codebase facts, the `web-researcher` sub-agent
  for external ones — or **assumed** with the user consciously accepting
  that, and the schema delta is stated (explicitly "none" when none).

Ask the user the clarifying questions **before** drafting the brief — never
substitute an assumption for an answer the user could give. And expect that
more research may be needed before the brief is ready to present: dispatching
further sub-agents (code-researcher, web-researcher, the investigator)
mid-capture is normal and encouraged — a brief built on guesses is worse than
a brief that took one more dispatch.

When the work **replaces existing behavior**, decide the compatibility
stance now, with the user, and lock it as a direction: clean replacement
(delete the old path, no shims or fallback layers) or
compatibility-preserving (existing consumers keep working). `/do`'s
reviewers treat an unnamed breaking change as a blocker, so an item that
means to break something must say so.

**Clarification scales with the stakes.** Zone 0–1 or multi-phase: run an
interview loop (AskUserQuestion) — technical mechanics, dependencies, edge
cases, tradeoffs; don't ask obvious questions, dig into what the user
hasn't considered — until the dependency inventory holds no `assumed`
entry the user isn't consciously accepting. Zone 2–3 single-phase: one
focused round. At every stake level, markers drive to zero
(`.references/html-brief.md` · Rules): the brief never goes `ready` with
an unaddressed `[NEEDS CLARIFICATION]` marker.

**Propose the zone** (0–3) per `.references/zones.md` — stakes and
downstream consequence radius, never diff size; escalator surfaces force
zone ≤ 1 — and confirm it with the user; the user's override is always
honored. It goes in the item metadata and tells `/do` how thorough to be
in review. Offer the other two dials with it: `review_lanes: dual | single`
(review defaults are dual at zone 0, single Codex at zones 1–3) and
`frontend_verifier: true | false` (whether the app-driving QA agent runs —
the user's call even when UI criteria exist). Both override the zone's
defaults in either direction, ride to the tracker with the item, and stay
editable there as metadata until `/do` runs.

**Success criteria**: the user has explicitly agreed to intent, end state, each
locked direction (including the compatibility stance when behavior is
replaced), the three dials (zone, and any `review_lanes` /
`frontend_verifier` override), the out-of-scope list, and every
dependency's verified/assumed standing including the schema delta.

**Bug track** — take stock of the investigation. Check what the conversation
already established: reproduction, root cause + evidence, confidence level. A
root-cause finding from an `investigator` dispatch during `/discussion` is the
ideal input — reuse it, don't redo it.

If the root cause is **not** yet established, dispatch the investigator now
via the `codex` skill (role `investigator`) with the full defect report
(expected vs actual, environment, repro steps, traces); when reproduction
needs the running app, dispatch `frontend-verifier` first and pass its
transcript along. If it cannot reproduce, say so plainly — never invent a
cause: gather more from the user and re-dispatch, or proceed with the root
cause marked `Hypothesis:` and what-was-tried captured in `refs/`.

Then confirm impact and severity with the user where judgment is needed: who
is affected, how widespread, why it matters now, and whether the suggested
resolution path should be locked as a direction or left to `/do`. Skip the
ceremony when severity is obvious. Bugs still carry the Dependencies &
mechanics section — often just the mandatory schema-delta line.

**Success criteria**: a root-cause finding with an honest confidence level
(`confirmed | likely | hypothesis`) — or a documented failed-to-reproduce with
the attempts listed — plus severity (`critical | high | medium | low`) and
business impact agreed with the user.

### 3. Shape the approach and cut phases
Every item's brief carries an **Approach** section — how the work will be
tackled, at approach altitude (`.references/html-brief.md` · Approach) — and
at least one `phases` entry. If the work is one coherent outcome, record a
single entry and move on. Otherwise split it into sequential phases, each a
self-contained slice:
one coherent outcome, independently verifiable, buildable on the phases
before it. Don't split because many files are touched — split where
verification surfaces genuinely differ. Multi-phase items run sequentially
in one PR under `/do`. A phase that could stand alone entirely — or wait —
belongs in the Sequencing panel as a separate candidate item instead.

**Success criteria**: the `phases` list agreed with the user — each phase has
a goal, scope, and its own verification surface; order confirmed.

### 4. Author the brief and align
Check `./tmp/discussions/` for a decision log from the conversation that
produced this item (match by slug and date) — carry its decisions into the
locked directions rather than re-deriving them, and link it from `refs/`
if it holds more than the brief should inline. Pick `<id>` (short
kebab-case slug from the title), create `./tmp/<id>/`, and author
`brief.html` per `.references/html-brief.md` (page contract, section map,
and rules), opening it in the user's browser. Save transcript-worthy raw
material (key discussion excerpts, links, research worth keeping) to
`./tmp/<id>/refs/`, linked never inlined. This page is the work item: for a feature, the change,
the before/after, dependencies & mechanics, the direction, and the
approach; for a bug, expected vs actual, the root cause (confidence stated
honestly), and the resolution path; for multi-phase work, the Approach
section carries the binding phase timeline and per-phase blocks. Fold
corrections in as in-place edits.

Bug specifics: the Verification section's bug form — repro steps as AC1
(flipping from fail to pass) plus prevention criteria — is specified in
`.references/html-brief.md` (section map, row 07). Raw traces, logs, and
long transcripts go to `./tmp/<id>/refs/` (e.g. `refs/error-trace.txt`),
linked not inlined; a current-state deep-dive worth keeping is saved per
`.references/system-analysis.md` as `refs/system-analysis.md`.

**Success criteria**: `brief.html` exists and the user has confirmed the item
against it in the browser; every AC is numbered, observable, and mapped; bug
items have a re-runnable repro, AC1 mapped to it, and prevention criteria;
nothing in the page restates what `refs/` or the model already covers.

### 5. Socratic gate
Run the gate per `.references/socratic-gate.md` — socrates calibrates its
own intensity. Supply the per-type emphasis in the dispatch:

- **Feature**: necessity, root cause, simpler alternatives, shape, and
  mechanics (which dependency is `assumed` rather than `verified`?). If
  the dialogue reveals a different phase shape, return to step 3 and recut.
- **Bug**: root cause vs symptom (does the cause survive another "why"?),
  evidence, whether the fix prevents the class or just this instance, and
  completeness — sibling instances of the defect class, follow-up work the
  fix implies. If the dialogue surfaces a deeper cause to chase,
  re-dispatch the investigator before proceeding.

**Success criteria**: the gate's "Done when" holds
(`.references/socratic-gate.md`).

### 6. Mark ready and publish
Publish per `.references/publish-work-item.md`, using
`.references/artifact-host-upload.md` for upload mechanics — title
`feat: <title>` (feature) or `fix: <title>` (bug); the shared procedure owns
the tracker body. Bug exception: leave `status: draft` if the cause is still
a hypothesis and the user wants more evidence first — publish happens either
way.

**Success criteria**: published and cross-linked per the shared procedure
(bundle transport with an `artifact_host`, markdown-rendition fallback
without one) — or, when the repo configures no destination at all, the item
is complete in `./tmp/<id>/` and the user was told nothing was published.

```
Suggested next steps:
- `/do <item ref or ./tmp/<id>/brief.html>` — run the autonomous pipeline against this item
- `/discussion [follow-up]` — if a gap surfaced that needs more thinking first
```
