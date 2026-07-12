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
artifact — attached to the work-item provider's page when one is configured,
inlined in issue comments otherwise. No extra publishing step.

## Section map

Every explainer: masthead (type badge, status, title, one-sentence intent),
then numbered sections, then the footer. Per type:

| # | feature-ticket | epic-spec | bug-report |
|---|----------------|-----------|------------|
| 01 · Why | intent + before/after panels | problem/context + before/after | summary + expected-vs-actual panels |
| 02 · Direction | proposed approach: pipeline/flow of touched components + `D1…` decision cards (each with its rejected alternative) | cross-cutting decisions as cards + **phase timeline** (the `.pipeline` strip, one `.stage` per phase, sequential) | root cause (state confidence: confirmed/likely/hypothesis) + suggested resolution path |
| 03 · Scope | in / out-of-scope panels | per-epic goals vs non-goals panels | business impact + severity; out-of-scope if any |
| 04 · Done means | ACs as the auto-numbered `ol.acs` list | ACs per phase (subheading per phase) | AC1 = repro flips to pass, plus prevention criteria |
| 05 · Unresolved | open questions (omit if none) | open questions | open questions |

An epic is one page with the phase timeline — not a page per phase.

## Rules

- **Altitude**: general direction, not design — no file lists, pseudo-code,
  or task sequences. If it isn't in `item.md`, it doesn't belong here.
- **Self-contained**: no external requests (fonts, scripts, images) — it must
  render from disk and from a file downloaded off whatever provider hosts the
  work item. Inline everything.
- **Both themes**: the template's tokens already handle light/dark; keep any
  additions on the tokens.
- **Lean**: a one-pager the user reads in two minutes. Structure only earns
  its place when it encodes something true (phases are a real sequence;
  D-numbers are real locked decisions).
