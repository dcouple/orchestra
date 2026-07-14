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

## Section map

Every explainer: masthead (type badge, status, title, one-sentence intent),
then the opening diagram, then numbered sections, then the footer. Per type:

| # | feature-ticket | epic-spec | bug-report |
|---|----------------|-----------|------------|
| 01 · Why | intent + before/after panels; UI mockup pair when UI is touched | problem/context + before/after; UI mockup pair when UI is touched | summary + expected-vs-actual panels; screenshot of the defect when visible |
| 02 · Direction | proposed approach: `D1…` decision cards (each with its rejected alternative) + **work strip** (see Work sequence) | cross-cutting decisions as cards + **phase timeline** (the `.pipeline` strip, one `.stage` per phase, sequential) | root cause (state confidence: confirmed/likely/hypothesis) + suggested resolution path (a `.pipeline` strip when it genuinely has stages) |
| 03 · Scope | in / out-of-scope panels | per-epic goals vs non-goals panels | business impact + severity; out-of-scope if any |
| 04 · Done means | ACs as the auto-numbered `ol.acs` list | ACs per phase (subheading per phase) | AC1 = repro flips to pass, plus prevention criteria |
| 05 · Unresolved | open questions (omit if none) | open questions | open questions |

An epic is one page with the phase timeline — not a page per phase.

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
- **Lean**: a one-pager the user reads in two minutes. Structure only earns
  its place when it encodes something true (phases are a real sequence;
  D-numbers are real locked decisions).
