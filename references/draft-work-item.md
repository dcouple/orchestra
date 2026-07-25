# Draft a work item — shared mechanics

Used by `/create-plan` when authoring `./tmp/<id>/plan.html` (the single
canonical artifact — see `.references/html-plan.md` for the page contract and
section map).

- Check `./tmp/discussions/` for a decision log from the conversation that
  produced this item (match by slug and date). Carry its decisions and
  constraints into the item's locked directions rather than re-deriving
  them; link it from `refs/` if it holds more than the item should inline.
- Pick `<id>`: short kebab-case slug from the title. Create `./tmp/<id>/`.
- Author `plan.html` from `.references/plan-template.html` per
  `.references/html-plan.md`. The template's HTML comments are authoring
  notes: emit filled-in content only, never the commented guidance.
- **Clarification scales with the stakes.** Zone 0–1 or multi-phase: run an
  interview loop (AskUserQuestion) — technical mechanics, dependencies, edge
  cases, tradeoffs; don't ask obvious questions, dig into what the user
  hasn't considered — and keep going until the Dependencies & mechanics
  section has no `assumed` entry the user isn't consciously accepting. Zone
  2–3 single-phase: one focused round. At every stake level, follow up on
  each `[NEEDS CLARIFICATION]` marker until it is resolved or the user
  explicitly defers it — deferral is the user's call, recorded in Open
  questions with its reason, never the agent's; `status: ready` requires
  zero unaddressed markers.
- Embed verification criteria per `.references/verification-criteria.md`:
  EARS-style, numbered `AC1…`, each mapped to a method from
  `.references/verification-methods.md` and matched to the change type's
  rubric in `.references/rubrics/`. No "works correctly".
- Keep it LEAN: `/do` starts fresh and is capable — omit anything it can
  reasonably decide itself.
- Save transcript-worthy raw material (key discussion excerpts, links,
  research worth keeping) to `./tmp/<id>/refs/` and link from the plan —
  never inline. Research findings that back a dependency card land as
  `refs/<topic>.html` sub-report pages per `.references/html-plan.md`.
- Set `zone:` (0–3) in the metadata block per `.references/zones.md` —
  agreed with the user, classified by stakes and downstream consequences,
  never diff size. That file's escalator rules are canonical.
- Leave `status: draft` in the metadata block until publish.
