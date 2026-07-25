# The HTML plan — the work item artifact

The work item **is** one HTML page: `./tmp/<id>/plan.html`, authored by
`/create-plan` from `.references/plan-template.html`. It is simultaneously the
alignment surface the user reads and the contract `/do` executes against —
there is no separate machine-facing document, so what the user approved and
what the agents read can never drift. Supporting depth lives in
`./tmp/<id>/refs/` and is linked, never inlined.

## Metadata

The page's `<head>` carries the machine state in one element:

```html
<script type="application/yaml" id="orchestra-meta"> …YAML… </script>
```

- Fields: `type` (`feature | bug`), `id`, `status` (`draft | ready | done`),
  `zone`, optional `review_lanes`, `severity` (bugs), `phases` (list of
  `{n, title, done}` — one entry means a single-outcome item; two or more
  make the item multi-phase), and the publish/run fields `pr`,
  `artifact_bundle`, `linear_issues`, `github`.
- **State lives here, never in the body.** `status`, phase completion
  (`phases[].done`), and every publish/run field are read from and written to
  this block. Consumers that apply tracker state replace the element's text
  **wholesale** — body content is document content and is edited only by
  authoring steps.
- Read it by extracting the element's text and parsing as YAML; no HTML-aware
  tooling is needed beyond locating `id="orchestra-meta"`.

## Procedure

1. Author `./tmp/<id>/plan.html` from `.references/plan-template.html` (copy
   it; keep the token system, component classes, and the metadata block; fill
   the sections per the map below).
2. Open it in the user's browser: `open` (macOS) / `xdg-open` (Linux) /
   `start` (Windows) on the file path.
3. Walk the user through it and get explicit agreement — alignment happens
   against this page.
4. Later changes (Socratic gate, late user input) are **in-place edits** to
   the same file — there is nothing to regenerate or sync.

## Fidelity scales with the zone

The item's `zone:` (`.references/zones.md`) sets how much the page must
*teach*, not just show — the closer to zone 0, the more the reader must be
able to **judge** the change before it runs.

- **Zone 0 — teach it.** Add a Concepts panel (the invariants at stake, why
  the chosen mechanism is safe, what breaks if it isn't); the opening diagram
  shows the failure path being prevented; mockups are mandatory and open (not
  collapsed) when UI is touched; name what is irreversible and the rollback
  story.
- **Zone 1 — full standard.** Every applicable section at full depth.
- **Zone 2 — standard.** The normal lean page.
- **Zone 3 — minimal.** Masthead, one-line why, before/after, ACs, minimal
  diagram.

**Zone badge — always**, in the masthead meta-row AND the footer, with its
label (e.g. `zone 0 — must be perfect`).

## Section map

Masthead (type/status/zone badges, title, one-sentence intent), then the
opening diagram, then numbered sections, then the footer. Slot numbers are
fixed; omit sections that don't apply and leave the gap.

| # | Section | feature | bug |
|---|---------|---------|-----|
| — | Opening diagram | always — see below | always; the failure path |
| 01 | Why | intent (the why behind the request — what `/do` optimizes for) + desired end state as before/after panels | summary + **Environment** line + expected-vs-actual panels; defect screenshot when visible |
| 02 | User journeys | flow strips per journey + coverage (multi-journey items only) | failing path vs fixed path |
| 03 | Direction | locked decisions as `D1…` `.decision` cards (each with its rejected alternative) + advisory approach + work strip or phase timeline (see Work sequence) | root cause with confidence stated (`confirmed | likely | hypothesis`) + suggested resolution path |
| 04 | Dependencies & mechanics | see below — always present | same; often collapses to the schema-changes line |
| 05 | Phases | multi-phase items only — binding timeline + per-phase blocks (see below) | — |
| 06 | Scope | in / out-of-scope panels | business impact + severity; out-of-scope if any |
| 07 | Verification | categorized checklist + flow→AC map (see below) | AC1 = the reproduction steps flipping to pass (steps listed here, deterministic enough to re-run) + prevention criteria (regression test / lint rule / invariant) |
| 08 | Mockups | user-facing items — collapsed `details`, open at zone 0 | — |
| 09 | Run config | zone panel — see below | same |
| 10 | Justification | written by the Socratic gate: one line per surviving question (claim challenged — reason that held); on waiver, "Socratic gate waived by user." | same |
| 11 | Open questions | `[NEEDS CLARIFICATION]` `.question` blocks — named, never papered over; omit if none | same |

Verification criteria everywhere follow
`.references/verification-criteria.md`: EARS-style, numbered `AC1…`, each
mapped to a method from `.references/verification-methods.md` and the change
type's rubric in `.references/rubrics/`. No "works correctly".

## Opening diagram

Every plan opens with a diagram directly after the masthead — the whiteboard
sketch the page elaborates. **Always present**: a simple item gets a simple
diagram (three boxes and an arrow is fine), never a skipped one. Content is
whatever best orients: touched components and their connections, before/after
flow, the failure path for a bug, the phase sequence for a multi-phase item.
Form is at the agent's discretion — inline SVG on the tokens (safest),
`.pipeline` strip, or a `data:` URI image — legible at page width.

## Dependencies & mechanics

The section that forces discovery **before** implementation. Always present.

- **One `.dep` card per dependency**: external services and APIs, systems and
  subsystems touched, human work required (credentials, approvals,
  purchases), notable new packages. Each card states *what it does for this
  item* and *how the mechanism works* in a sentence or two, and carries a
  badge: `verified` (a researcher or investigator confirmed the mechanics —
  link the sub-report) or `assumed` (nobody checked). An `assumed` badge on
  an external integration is a visible red flag, and that is the point.
- **Schema changes — mandatory `.callout`, "none" allowed but never
  omitted.** A plan that can't state its schema delta doesn't understand its
  own data flow; a large delta is the strongest signal the item should split.
  Schema/migration touches are a zone escalator (`.references/zones.md`).
- **Sequencing — the `.scope` grid**: work that should land *before* this
  (prerequisites, named as candidate separate items) and work this *creates*
  (follow-ups, deferred items, named now rather than discovered later).
- `/do`'s preflight reads this section to surface human-actionable
  dependencies before launch.

### Research sub-reports

When a dependency or question warrants real research, the dispatch's finding
lands as its own simple page — `./tmp/<id>/refs/<topic>.html` — and the
`.dep` card links it, with a one-paragraph digest in a collapsed `details`
block. Sub-report pages are markdown-simple: the template's tokens, a title,
prose, at most a diagram — no section map. The plan page summarizes; the
sub-report carries the depth. This is how research survives the conversation
and how the user zooms in on exactly what they don't yet understand.

## Phases (multi-phase items)

When `phases` has two or more entries:

- The timeline (`.pipeline`, one `.stage` per phase, sequential) is
  **binding** — titles match `phases[].title` exactly; `.stage.done` mirrors
  `phases[].done` (state itself lives in the metadata).
- Each phase gets a self-contained block — scope, out of scope, advisory
  approach, and its own numbered verification criteria — so `/do` can pick
  the phase up alone. Criteria live in the block, never the timeline.
- A cross-cutting concerns passage (security, observability, migration —
  anything true across phases) sits above the phase blocks; cross-cutting
  locked decisions stay in section 03.
- One page for the whole item — never a page per phase.

## Work sequence

- **Multi-phase**: the phase timeline is the plan — binding, as above.
- **Feature (single-phase)**: section 03 carries an indicative work strip —
  3–6 stages named by outcome, never by file — captioned "indicative
  sequence — /do's plan stage owns the real plan."
- **Bug**: the resolution path becomes a strip only when it genuinely has
  stages; a one-step fix stays prose.

The advisory-approach rules (from the old templates) still govern anything
indicative: write only from what the conversation established, name areas to
touch and functionality to reuse with orienting file pointers inline, 3–5
bullets — never file-by-file lists or step sequences; `/do` may deviate where
the code disagrees, recording why, and reviewers never treat deviation as
Must Fix. Locked calls stay in the `D#` cards. If genuinely unknown, one
honest sentence deferring to `/do`'s plan stage is valid.

## UI mockups (user-facing items)

Inside a collapsed `details` (open at zone 0): a `.shots` stack, one `.pair`
per touched surface. "Before" is a screenshot of the real app; "after" is the
proposed change rendered inside the real app when a UI harness can drive it,
otherwise a schematic composed **from the template's `.mock` parts** — and
the caption says which side is real. Low fidelity is fine; the bar is that
the user clearly understands what's being built, not pixel accuracy. Never
set a fixed height on a mock; one pair per row; inline images as `data:`
URIs with raw PNGs kept in `refs/`. Backend-only items state "no UI delta"
in section 01 and omit the section.

## User journeys

When the change touches more than one journey or cohort: one `.pipeline`
strip per distinct journey with a bold `.journey-label`; `.stage.skip` for a
bypassed step, `.stage.term` for a terminal off-ramp; a coverage line stating
which journeys are mocked vs only described. Strips shrink to fit the page —
a strip that won't fit has too many stages.

## Verification

Render the ACs as a checklist grouped by surface — a `.vgroup` for **UX /
in-app flows** (proven by driving the running app) and one for **Backend /
data** (proven by tests) — plus a `.flowmap` table mapping each user flow to
the ACs it exercises. Multi-phase items group by phase first. The section
*is* the criteria (there is no other document), so every AC must be
observable and mapped to its method.

## Run config

The zone panel (`.dials`), last content section:

- **Zone** is the primary dial: the value with its stakes/consequence-radius
  reasoning and any escalator floor that raised it. Derived dials (loop caps,
  QA, research) reference `.references/zones.md` — never restate its table.
- **Settable dials** render the current metadata value: `review_lanes` (the
  one override honored in both directions) and, where the item warrants
  them, frontend-verifier and mockups inclusion. A static page can't write
  back — the caption says: state the choice during alignment and the agent
  updates the metadata and re-renders the pills. `review_lanes` stays
  editable as tracker metadata until `/do` runs.
- Collapse to a single line for a trivial item.

## Disclosure

Progressive disclosure uses native `<details>/<summary>` only — no JS.
Collapsed by default: research digests in `.dep` cards, mockups (except zone
0), long raw material. Always open: why, direction, dependencies themselves,
scope, verification, run config. Never nest `details`, and never collapse
something the reader must see to judge the change.

## Rules

- **Altitude**: direction, not design — no file lists, pseudo-code, or
  task-level sequences. `/do` starts fresh and is capable: omit anything it
  can reasonably decide itself.
- **Self-contained**: no external requests (fonts, scripts, images) — the
  page must render from disk and from the published bundle. Inline
  everything; relative links only to `refs/` files that travel in the same
  bundle.
- **Both themes**: keep all additions on the template's tokens.
- **Lean — relative to zone**: zone 2–3 reads in two minutes; zone 0 earns
  length only where it teaches judgment. Structure earns its place only when
  it encodes something true (phases are a real sequence; D-numbers are real
  locked decisions; an `assumed` badge is a real unknown).
