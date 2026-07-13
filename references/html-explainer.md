# HTML explainer — shared procedure

Used by `/create-feature`, `/create-epic`, and `/create-issue` after
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

## Section map

Every explainer: masthead (type badge, status, title, one-sentence intent),
then the opening diagram, then numbered sections, then the footer. Per type:

| # | feature-ticket | epic-spec | bug-report |
|---|----------------|-----------|------------|
| 01 · Why | intent + before/after panels | problem/context + before/after | summary + expected-vs-actual panels |
| 02 · Direction | proposed approach: pipeline/flow of touched components + `D1…` decision cards (each with its rejected alternative) | cross-cutting decisions as cards + **phase timeline** (the `.pipeline` strip, one `.stage` per phase, sequential) | root cause (state confidence: confirmed/likely/hypothesis) + suggested resolution path |
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
  or task sequences. If it isn't in `item.md`, it doesn't belong here.
- **Self-contained**: no external requests (fonts, scripts, images) — it must
  render from disk and from a file downloaded off wherever the work item is
  published. Inline everything.
- **Both themes**: the template's tokens already handle light/dark; keep any
  additions on the tokens.
- **Lean**: a one-pager the user reads in two minutes. Structure only earns
  its place when it encodes something true (phases are a real sequence;
  D-numbers are real locked decisions).
