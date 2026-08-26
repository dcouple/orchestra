# The HTML brief — the work item artifact

The work item **is** one HTML page: `./tmp/<id>/brief.html`, authored by
`/create-brief` from `.references/brief-template.html`. It is simultaneously the
alignment surface the user reads and the contract `/do` executes against —
there is no separate machine-facing document, so what the user approved and
what the agents read can never drift. Supporting depth lives in
`./tmp/<id>/refs/` and is linked, never inlined.

The brief exists so the user can see, as concretely as possible, what is
going to happen — and refine the idea *before* handing it to an agent,
minimizing intervention once implementation runs. It stays at the altitude
the user decides at; the implementation plan (`plan.md`) that `/do`'s plan
stage derives from it owns the task-level detail.

## Metadata

The page's `<head>` carries the machine state in one element:

```html
<script type="application/yaml" id="orchestra-meta"> …YAML… </script>
```

- Required fields: `type` (`feature | bug`), `id`, `status`
  (`draft | ready`), `zone`, and `phases` (list of `{n, title}` — one entry
  means a single-outcome item; two or more make the item multi-phase).
  Optional: `review_lanes`, `frontend_verifier`, `ios_testing` (`required |
  optional`, default `optional`; all honored by `/do` as the user's explicit overrides), `severity` (bugs), and the publish fields
  `artifact_bundle`, `artifact_upload`, `linear_issues`, `github`.
- **Authoring and publish state only.** `status` and the publish fields are
  read from and written to this block; consumers that apply tracker state
  replace the element's text **wholesale** — body content is document
  content and is edited only by authoring steps. **Run state never lives
  here**: the brief is the starting point `/do` reads, not a run log —
  phase completion and the PR are tracked in `/do`'s implementation plan
  and on the tracker.
- Read it by extracting the element's text and parsing as YAML; no HTML-aware
  tooling is needed beyond locating `id="orchestra-meta"`.

**Who reads this page**: the human, `/create-brief`, and `/do`'s overseer
(at run start and preflight). Sub-agents inside a run work from the
implementation plan the overseer derives — dispatches pass `plan.md`, not
this page. Machine readers skip the `<style>` block; content starts at
`<body>`.

## Procedure

1. Author `./tmp/<id>/brief.html` from `.references/brief-template.html` (copy
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
  collapsed) when UI is touched, and a flow that spans screens gets the
  clickable prototype rather than static pairs; name what is irreversible and
  the rollback story.
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
| 03 | Direction | locked decisions as `D1…` `.decision` cards (each with its rejected alternative) | root cause with confidence stated (`confirmed | likely | hypothesis`) |
| 04 | Dependencies & mechanics | see below — always present | same; often collapses to the schema-changes line |
| 05 | Approach | always present — how we'll tackle this (see below); multi-phase items add the binding timeline + per-phase blocks | the suggested resolution path; a strip only when it genuinely has stages |
| 06 | Scope | in / out-of-scope panels | business impact + severity; out-of-scope if any |
| 07 | Verification | categorized checklist + flow→AC map (see below) | AC1 = the reproduction steps flipping to pass (steps listed here, deterministic enough to re-run) + prevention criteria (regression test / lint rule / invariant) |
| 08 | Mockups | user-facing items — see below; a clickable prototype for multi-screen flows, a collapsed `.shots` pair otherwise (open at zone 0) | — |
| 09 | Run config | zone panel — see below | same |
| 10 | Justification | written by the Socratic gate: one line per surviving question (claim challenged — reason that held); on waiver, "Socratic gate waived by user." | same |
| 11 | Open questions | `[NEEDS CLARIFICATION]` `.question` blocks — named, never papered over; each must end resolved or explicitly deferred by the user (see Rules); omit if none | same |

Verification criteria everywhere follow
`.references/verification-criteria.md`: EARS-style, numbered `AC1…`, each
mapped to a method from `.references/verification-methods.md` and the change
type's rubric in `.references/rubrics/` — including the per-phase
numbering rule for multi-phase items. No "works correctly".

## Opening diagram

Every brief opens with a diagram directly after the masthead — the whiteboard
sketch the page elaborates. **Always present**: a simple item gets a simple
diagram (three boxes and an arrow is fine), never a skipped one. Content is
whatever best orients: touched components and their connections, before/after
flow, the failure path for a bug, the phase sequence for a multi-phase item.
Form is at the agent's discretion — inline SVG on the tokens (safest),
`.pipeline` strip, or a `data:` URI image — legible at page width.

## Dependencies & mechanics

The section that forces discovery **before** implementation. Always present.

- **Major components only — the systems this work will be based on.** A
  dependency earns a card by needing to be mapped out or discussed:
  third-party services, APIs, and packages the work newly leans on; things
  that must be added for the work to stand (a service, an account, a new
  capability); internal surfaces and subsystems the work will utilize whose
  mechanics shape the design; human work required (credentials, approvals,
  purchases). Routine small libraries, standard tooling, and trivial
  internals don't get listed — an overlisted inventory buries the
  dependency that matters.
- **One `.dep` card per major dependency.** Each card states *what it does
  for this item* and *how the mechanism works* in a sentence or two, and
  carries a badge: `verified` (a researcher or investigator confirmed the
  mechanics — link the sub-report) or `assumed` (nobody checked). An
  `assumed` badge on an external integration is a visible red flag, and
  that is the point.
- **Schema changes — mandatory `.callout`, "none" allowed but never
  omitted.** A brief that can't state its schema delta doesn't understand its
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
block. For a third-party integration, the sub-report answers the questions
the brief will bake in: what it does and how the mechanism works, what it
costs (pricing/plan tier), the specific calls or endpoints this item will
use, the library or SDK to use, and auth/limits — concrete enough that the
approach can be written from it, and honest enough to reveal when the
integration isn't needed at all. Sub-report pages are markdown-simple: the
template's tokens, a title, prose, at most a diagram — no section map. The
brief page summarizes; the sub-report carries the depth. This is how research
survives the conversation and how the user zooms in on exactly what they
don't yet understand.

## Approach

**Always present** — the major section on *how we are going to tackle this*.
It is about the shape of the attack, never specific steps: the areas to
touch and the broad approach for each, existing functionality to reuse,
repurpose/refactor opportunities, with orienting file/module pointers
inline. Every item has at least one phase; the section scales with the
`phases` metadata:

- **Single-phase**: the approach as prose or 3–6 bullets, optionally with an
  indicative work strip — stages named by outcome, never by file —
  captioned "indicative sequence — /do's plan stage owns the real plan."
- **Multi-phase**: the approach broken into phases. The timeline
  (`.pipeline`, one `.stage` per phase, sequential) is **binding** — titles
  match `phases[].title` exactly. Each phase gets a self-contained
  block — scope, out of scope, its approach, and its own numbered
  verification criteria — so `/do` can pick the phase up alone. Criteria
  live in the block, never the timeline. A cross-cutting concerns passage
  (security, observability, migration — anything true across phases) sits
  above the phase blocks. One page for the whole item — never a page per
  phase.
- **Bug**: the suggested resolution path is this section; it becomes a
  strip only when it genuinely has stages — a one-step fix stays prose.

The advisory rules (from the old templates) still govern: write only from
what the conversation established — never dispatch research to fill this
section; never file-by-file lists or step sequences; `/do` may deviate where
the code disagrees, recording why, and reviewers never treat deviation as
Must Fix. Locked calls stay in the `D#` cards. If genuinely unknown, one
honest sentence deferring to `/do`'s plan stage is valid.

## UI mockups (user-facing items)

Backend-only items state "no UI delta" in section 01 and omit the section.
Everything else starts from the same rule: **never invent a visual
language.** The app already has one, and a mockup drawn from imagination
teaches the user about a product that doesn't exist.

### Reconnaissance — inline tokens now, screenshots in the background

Reconnaissance precedes *fidelity*, never *drafting*: the brief must not
wait minutes on a browser before the user can start reading. Two lanes, and
only one of them is a dispatch:

1. **Design-system extraction is inline work, not a dispatch.** The
   authoring thread greps the token file(s) and the real CSS for
   buttons/inputs/selects/modals/tables itself — actual hex values, font
   stacks, control heights, radii, spacing — plus the structural markup of
   the touched screens, any step/wizard chrome worth reusing, and real
   user-facing copy. **Quoted values, not descriptions.** This is a few
   tool calls; a `code-researcher` dispatch here is a round-trip that buys
   nothing.
2. **Screen capture is one `frontend-verifier` dispatch, run in the
   background.** Boot the app, log in with the repo's testing account, and
   screenshot every surface the change touches, plus the app shell (global
   nav/chrome) and one existing multi-step flow if the item has a wizard,
   into `./tmp/<id>/refs/shots/` — with the agent's read of the visual
   language in words (colors, type, spacing, control shapes, how rows and
   headers are laid out). Dispatch it before drawing, then keep authoring
   while it runs.

**Two-pass fidelity.** The first pass — `.mock` parts (or prototype pages)
styled from the inline-quoted values — ships with the draft brief so
alignment starts immediately; captions say "first pass — real captures
pending." When the background capture returns, upgrade the mockups in
place ("before" becomes the real screenshot, "after" is re-rendered against
it) and re-upload the bundle if the item is already published. Zone 0 is
the exception: the upgrade lands before `status: ready` — everywhere else a
named fidelity gap may ride through publish.

If the app can't be booted or reached, say so in the brief and keep the
token-derived styling — a mockup built from quoted values is still far
better than one built from taste. Never present either shortfall as if it
were a capture of the real thing.

### Multi-screen flows — build a clickable prototype

When the change spans **more than about two screens or introduces a flow**
(a wizard, a new route, a redesigned journey), the mockup is a set of linked
HTML pages under `./tmp/<id>/mockups/`, not a stack of static pairs:

- One page per screen, named in flow order (`01-…`, `02-…`), plus an
  `index.html` flow map that describes each page in a sentence and links it.
- A **shared `mock.css`** built on the inline-quoted values, with a
  comment at the top naming its sources. Relative `<link>` is correct here;
  these files travel together in the bundle.
- Every page links to the next and back, so the user can walk the path
  without touching the address bar. A persistent bottom bar with
  position-in-flow, a link to the flow map, and prev/next keeps them
  oriented.
- **Make the interesting states reachable.** A prototype that only shows the
  happy path hides exactly the decisions worth reviewing — drive the flow
  into its error, empty, blocked, and mid-operation states, and make the
  failure genuinely fire rather than describing it. If the flow has an
  edit-after-the-fact path, that is a page too.
- The flow map ends with **what to look for, and where the agent made a call
  the user might disagree with** — the decisions the pictures encode that
  nobody asked for. This is the part that earns the mockups their place.
- **Fidelity gaps are stated, never papered over.** Licensed webfonts that
  can't load offline, an interaction that can't be shown statically: name it
  on the flow map.

Link the prototype prominently from the brief's masthead and from section
08, and keep section 08 itself short — a table mapping each page to what it
shows and the ACs it demonstrates. The brief points at the prototype; it
does not duplicate it.

Opening it: `file://` URLs are commonly blocked for browser-driving
extensions. Serving the item directory over `127.0.0.1` and handing the user
a localhost URL works everywhere, and makes the brief's relative links to
`mockups/` and `refs/` resolve too.

### Single-surface changes — the `.shots` pair stays

For a change confined to one or two surfaces, a clickable prototype is
overkill. Use the collapsed `details` (open at zone 0): a `.shots` stack,
one `.pair` per touched surface. "Before" is a screenshot of the real app;
"after" is the proposed change rendered inside the real app when a UI
harness can drive it, otherwise a schematic composed **from the template's
`.mock` parts** — and the caption says which side is real. The bar is that
the user clearly understands what's being built, not pixel accuracy. Never
set a fixed height on a mock; one pair per row; inline images as `data:`
URIs with raw PNGs kept in `refs/`.

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
the ACs it exercises. Multi-phase items group by phase first (numbering
per `.references/verification-criteria.md`). The section
*is* the criteria (there is no other document), so every AC must be
observable and mapped to its method.

## Run config

The zone panel (`.dials`), last content section:

- **Zone** is the primary dial: the value with its stakes/consequence-radius
  reasoning and any escalator floor that raised it. Derived dials (loop caps,
  QA, research) reference `.references/zones.md` — never restate its table.
- **Settable dials** render the current metadata values — exactly four:
  `zone` (the primary), plus `review_lanes`, `frontend_verifier`, and
  `ios_testing` (`optional` by default or `required`). All are proposed by the agent and overridable by
  the user; `/do` honors the overrides in both directions. A static page can't write back — the caption says: tell the
  agent, and it updates the metadata and re-renders the pills. `review_lanes` stays
  editable as tracker metadata until `/do` runs. `ios_testing: required`
  requires the frontend verifier; combining it with `frontend_verifier: false`
  is invalid metadata that must be corrected before `/do` proceeds.
- Collapse to a single line for a trivial item.

## Disclosure

Progressive disclosure uses native `<details>/<summary>` only — no JS.
Collapsed by default: research digests in `.dep` cards, mockups (except zone
0), long raw material. Always open: why, direction, dependencies themselves,
scope, verification, run config. Never nest `details`, and never collapse
something the reader must see to judge the change.

## Rules

- **Markers drive to zero.** A `[NEEDS CLARIFICATION]` marker anywhere in
  the brief is a follow-up owed to the user: the drafting skill keeps asking
  until every marker is either resolved or the **user explicitly defers
  it** (recorded in Open questions as a deferral, with the reason). The
  agent never defers a marker on its own, and the brief never goes
  `status: ready` while an unaddressed marker remains.
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
