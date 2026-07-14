# HTML explainer — shared procedure

Used by `/create-plan` and `/create-epic` after
`item.md` is drafted. The explainer is the **alignment surface**: a visual
one-pager the user reads to confirm what the change is and the general
implementation direction. `item.md` stays the machine-facing contract `/do`
executes against — the explainer never replaces or extends it, it projects it.

## Procedure

1. Render `./tmp/<id>/refs/explainer.html` from the item, using
   `.references/explainer-template.html` as the skeleton (copy it, keep its
   token system and component classes, fill the sections per the map below).
2. Open it in the user's browser automatically:
   `open` (macOS) / `xdg-open` (Linux) / `start` (Windows) on the file path.
3. Walk the user through it and get explicit agreement — this is where
   alignment happens, not against raw `item.md`.
4. If the item changes afterward (Socratic gate, late user input),
   regenerate before publish so the attached explainer matches what ships.

The file lives in `refs/`, so publish carries it along with every other
artifact — inlined in issue comments, or wherever the project's `AGENTS.md`
sends work-item artifacts. No extra publishing step.

## Fidelity scales with the zone

The item's `zone:` (stakes classification, `.references/zones.md`) sets how
much the explainer must *teach*, not just show. The closer to zone 0, the more
the reader must be able to **judge** the change — irreversible work approved
off a skim is how zone-0 mistakes ship. Model intelligence is spiky: the
explainer is where the human catches the over-engineered or wrongly-scaled
direction before it runs.

- **Zone 0 — teach it (highest fidelity).** Beyond the standard sections: a
  "Concepts" panel that teaches the domain ideas the change rests on — the
  invariants at stake, the terms of art, why the chosen mechanism is safe and
  what breaks if it isn't — written for a human who doesn't live in that
  subsystem. The opening diagram shows the failure path being prevented, not
  just the happy path. UI mockup pairs are mandatory when the item touches UI
  (backend-only zone-0 items keep the mockup section's skip rule — their
  fidelity budget goes to the Concepts panel and the failure-path diagram
  instead); the work strip is mandatory wherever the Work sequence section
  defines one for the item's type. Name explicitly what is irreversible and
  what the rollback story is.
- **Zone 1 — full standard.** Every section at full depth; mockups whenever UI
  is touched; concepts explained where the change is system-shaping.
- **Zone 2 — standard.** The normal lean one-pager.
- **Zone 3 — minimal.** Masthead, one-line why, before/after, ACs, and the
  minimal opening diagram — three boxes and an arrow satisfies it; the
  Opening diagram section's always-present rule stands at every zone.

**Zone badge — always.** The masthead meta-row AND the footer carry the zone
with its label (e.g. `zone 0 — must be perfect`), so the reader calibrates
attention before reading and is reminded at the sign-off point. The template's
`.badge.zone` / footer slot render it.

## Opening diagram

Every explainer opens with a diagram, directly after the masthead and before
section 01. It gives the reader the architecture or the shape of what's
happening at a glance, before any prose — the "whiteboard sketch" the rest
of the page elaborates on.

- **Always present** — a simple item gets a simple diagram (three boxes and
  an arrow is fine), never a skipped one.
- **Content**: whatever best orients this item — the touched components and
  how they connect, the before/after flow, the failure path for a bug, the
  phase sequence for an epic. Show relationships and flow, not a list of
  labels.
- **Form is at the agent's discretion**: inline SVG, the template's
  `.pipeline`/`.stage` strip, an HTML/CSS box-and-arrow layout, or a
  rendered image inlined as a `data:` URI (e.g. via the excalidraw skill
  when it's available and the item warrants it). Whatever form, it must obey
  the self-contained and both-themes rules below — inline SVG on the
  template's tokens is the safest default.
- **Legible at page width**: if the reader must zoom to follow it, simplify.

## UI before/after mockups

When the item touches anything user-facing, the diagram and prose are not
enough — the explainer must show every touched surface pixel-accurately,
or the visualization has missed the change:

- **One `.pair` per touched surface.** "Before" is a screenshot of the
  real app. "After" is the proposed change rendered *inside* the real app:
  drive it with whatever UI harness the repo already has (a Playwright +
  mocked-API setup, a dev server, Storybook), DOM-inject the proposed
  element next to its real siblings so it inherits the true design system,
  and screenshot. Only when the app genuinely can't be driven, fall back
  to a schematic replica **built from the template's `.mock` parts**
  (`.mock-eyebrow` / `.mock-q` / `.mock-opt` / `.mock-field` / `.mock-doc`
  / `.mock-actions` / `.mock-note`) on the template tokens — and say so in
  the caption. Captions always state which side is real and which is mocked.
- **Compose the mock, never hand-roll it.** Use the `.mock` component parts
  as-is; do not invent one-off classes or set a fixed `height` on a mock.
  The whole point of `.pair` + content-sized `.mock` is that cards can't
  stretch and captions can't overflow into the next pair — the moment you
  add a height or a bespoke grid, overlap comes back.
- **Let it breathe.** One before|after `.pair` per row, full pairs stacked
  with clear vertical space between them; a mock sizes to its content, so
  short cards stay short. If a mock feels cramped it's carrying too much —
  cut detail, don't shrink padding. After rendering, eyeball it at page
  width: no card overlaps a caption, no caption overlaps the next pair, no
  horizontal scroll.
- **Name the journey.** One line stating which user journeys change — or
  explicitly that the shown surface is the only thing touched. If the
  item's UI delta is genuinely none (backend-only), state that in section
  01 and skip the mockups; the opening diagram carries the page.
- **Stay self-contained.** Inline any real images as `data:` URIs; keep the
  raw PNGs in `refs/` next to the explainer.

## User journeys

When the change touches more than one user journey or cohort — a routed flow,
an entry fork, divergent end-states — the explainer carries a **User journeys**
section (its own numbered section, right after 01 · Why). One `.pipeline` strip
per distinct journey, each with a bold `.journey-label`, showing that journey's
actual path through the (re)ordered steps:

- **One strip per journey, not per screen** — the SMS buyer, the free-path
  cohort, the enterprise off-ramp are each their own row.
- Mark a step the journey **bypasses** with `.stage.skip` (muted/dashed) and a
  **terminal off-ramp** with `.stage.term`, so a reader sees where a path
  diverges or dead-ends, not just the happy line.
- **State coverage underneath:** which journeys are drawn as mockups in 01 vs
  only described. A screen-by-screen mockup set must not leave a whole journey
  unshown — the divergent end-states (free/skip, enterprise, error) are journeys
  too, the same discipline as the PR body's journey map.
- **Fit the page** — journey stages shrink to share the row (`min-width: 0`)
  rather than scrolling off the edge; if a strip still won't fit, it has too
  many stages, not too little room.

## Work sequence

Every explainer shows how the work unfolds over time, using the template's
`.pipeline` strip — epics and features differ in what the strip *is*:

- **Epic**: the phase timeline is the spec — one `.stage` per phase,
  sequential, titles matching `item.md`'s phases exactly. Binding.
- **Feature**: section 02 carries a **work strip** — 3–6 stages named by
  outcome ("setting + default" → "blocker service" → "settings row" →
  "proven"), never by file or task. It is indicative, not binding: `/do`'s
  plan stage owns the real plan, and the strip's caption must say so
  (e.g. "indicative sequence — /do re-plans"). It exists so the reader
  sees the shape and rough size of the work at a glance, not to
  pre-commit an implementation order.
- **Bug report**: the suggested resolution path becomes a strip only when
  it genuinely has stages; a one-step fix stays prose.

Keep stages at outcome altitude — if a stage name only makes sense with a
file path in it, it's too low.

## Verification (categorized checklist)

The verification section renders the item's acceptance criteria as a
**checklist grouped by surface**, not a flat numbered list — so the reader
sees what will be proven and how:

- Two `.vgroup`s: **UX / in-app flows** (the ACs proven by driving the running
  app) and **Backend / data** (the ACs proven by tests). Each is a `.vlist` of
  unchecked checkbox items phrased as human-runnable / test-provable checks.
- A `.flowmap` table maps each **user flow → the ACs it exercises**, so the
  SMS-user path and the free-path path each visibly trace to their checks —
  the bridge between the User-journeys strips and the criteria.
- The ACs still come verbatim-in-substance from `item.md`; the explainer only
  regroups and maps them (it never invents criteria).

## Run config (the zone panel)

The final section projects how `/do` will execute — an estimate the human
finalizes at capture, never a silent default:

- The primary dial is the item's **`zone:` (0–3)** per `.references/zones.md`:
  render the estimated zone with its stakes / consequence-radius reasoning and
  any escalator floor that raised it. The remaining dials — review lanes, loop
  caps, frontend verifier, QA, research — are shown as **derived from the
  zone**, not independently set; `.references/zones.md` owns that mapping, so
  reference it, never restate the table.
- Use the `.dials` component: one `.dial` per row, `.pill` options with the
  recommended one `.on`, a one-line `.dial-why`, and a caption noting the
  estimate is `/create-plan`'s and the human sets the final zone.
- Collapse to a single line for a trivial item (a `zone: 3` doc change has no
  execution shape worth a full panel).

## Section map

Every explainer: masthead (type badge, status, title, one-sentence intent),
then the opening diagram, then numbered sections, then the footer. Per type:

| # | feature-ticket | epic-spec | bug-report |
|---|----------------|-----------|------------|
| 01 · Why | intent + before/after panels; UI mockup pair when UI is touched | problem/context + before/after; UI mockup pair when UI is touched | summary + expected-vs-actual panels; screenshot of the defect when visible |
| 02 · User journeys | flow strips per journey + coverage (multi-journey items; omit for single-path) | per-phase journeys when they diverge | the failing path vs the fixed path |
| 03 · Direction | proposed approach: `D1…` decision cards (each with its rejected alternative) + **work strip** (see Work sequence) | cross-cutting decisions as cards + **phase timeline** (the `.pipeline` strip, one `.stage` per phase, sequential) | root cause (state confidence: confirmed/likely/hypothesis) + suggested resolution path (a `.pipeline` strip when it genuinely has stages) |
| 04 · Scope | in / out-of-scope panels | per-epic goals vs non-goals panels | business impact + severity; out-of-scope if any |
| 05 · Verification | categorized checklist (UX / Backend `.vgroup`s) + flow→AC `.flowmap` | ACs per phase (subheading per phase) | AC1 = repro flips to pass, plus prevention criteria |
| 06 · Unresolved | open questions (omit if none) | open questions | open questions |
| 07 · Run config | zone panel (`.dials`; dials derived per `.references/zones.md`) | zone panel (epic = full machinery per zones.md) | zone panel |

An epic is one page with the phase timeline — not a page per phase. Sections
02 and 07 are conditional: 02 · User journeys only when the change is
multi-journey; 07 · Run config whenever the item carries a zone (all but the
most trivial).

One template serves all three types — the differences live in this section
map, not in forked templates. Don't create per-type template files; if a
type's explainer genuinely outgrows the shared skeleton, split into shared
`<style>` + per-type body skeletons rather than duplicating the visual
system.

## Rules

- **Altitude**: general direction, not design — no file lists, pseudo-code,
  or task-level sequences (work sequences stay at the outcome level defined
  in Work sequence). If it isn't in `item.md`, it doesn't belong here —
  except the feature work strip, which is explicitly indicative.
- **Self-contained**: no external requests (fonts, scripts, images) — it must
  render from disk and from a file downloaded off wherever the work item is
  published. Inline everything.
- **Both themes**: the template's tokens already handle light/dark; keep any
  additions on the tokens.
- **Lean — relative to zone**: zone 2–3 reads in two minutes; zone 0 earns
  more length only where it teaches judgment. Structure only earns its place
  when it encodes something true (phases are a real sequence; D-numbers are
  real locked decisions).
