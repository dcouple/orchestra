# Feature Ticket — format

> Produced by the create-plan feature track. Saved as `./tmp/<id>/item.md`.
> **Lean and high-signal.** Everything here is required-minimal; raw sources go in `refs/`.

---
```yaml
---
type: feature-ticket
id: <id>
status: ready         # draft | ready | done
zone: <0-3 — stakes + consequence radius, agreed with the user; .references/zones.md>
review_lanes: <dual | single — optional human override of the zone's lane dial; omit to derive from zone>
pr: <url or number — filled when the pipeline opens it>
---
```

# Feature: `<title>`

## Intent
`<the why + the underlying goal behind the request — not just the requested solution.`
`A few sentences. This is what the pipeline optimizes for and what PR review is judged against.>`

## Desired end state
`<what "done" looks like from the user's side. A before → after helps. No implementation.>`

## Key architecture directions
`<ONLY the locked decisions + any rejected alternative worth naming. Directions, not a`
`design — no file lists or pseudo-code. If the model can reasonably decide it, omit it.`
`Number them (D1, D2…) if there's more than one — reviews cite them by ID.>`

## Proposed approach
- `<area to touch + broad approach, with an orienting file/module pointer inline>`
- `<existing functionality to reuse + where it lives>`
- `<repurpose or refactor opportunity + relevant pointer>`

`<Advisory only: the pipeline may deviate where the code disagrees, recording why in plan.md;`
`reviewers never treat deviation as Must Fix. Locked calls stay in Key architecture directions.`
`Write only from what the conversation established — never dispatch research to fill this.`
`Name areas to touch, functionality to reuse, and repurpose/refactor opportunities, carrying`
`orienting file pointers inline. Use 3–5 bullets or a short paragraph, never file-by-file lists,`
`steps, or sequences. If genuinely unknown, write one honest sentence deferring to the plan stage.>`

## Dependencies
`<Omit section if none. List human work required (credentials, account setup, approvals, purchases),`
`external services/APIs newly depended on, and notable new third-party packages. Pipeline preflight`
`reads this section to surface human-actionable items before launch.>`

## Verification criteria
`<embed shared/verification-criteria.md — acceptance in EARS + how verify proves it>`

## Out of scope
- `<explicit exclusion — the guard against gold-plating>`

## Justification
- `<claim challenged in the Socratic gate>` — `<the reason that held>`

`<distilled from the socrates Q&A, one line per surviving question. This is the`
`item's "FAQ": why this exists, why this shape, why not the cheaper alternative.`
`On a fast pass, socrates' one line naming what convinced it; if the user waived`
`the gate: "Socratic gate waived by user." Full dialogue, if long, in`
`refs/socratic-dialogue.md.>`

## Open questions
- `[NEEDS CLARIFICATION]` `<unresolved design choice — name it, don't paper over it>`

`<omit section if none>`

## References (optional, in refs/)
- `refs/discussion.md`
- `refs/mockup.png`
