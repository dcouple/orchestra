# Epic Spec — format

> Produced by create-epic. Saved as `./tmp/<id>/item.md`.
> Same spine as a Feature Ticket at higher altitude, **plus sequential phases**.
> Each phase is a self-contained work item; the pipeline runs each phase in order.

---
```yaml
---
type: epic-spec
id: <id>
status: ready         # draft | ready | done
zone: <0-3 — stakes + consequence radius; the zones.md Epics override governs how it applies>
review_lanes: <dual | single — optional; epics follow the zone lane rule, and an explicit choice here always wins>
pr: <one PR for the whole epic — phases commit sequentially>
---
```

# Epic: `<title>`

## Problem / context
`<the broader problem this epic addresses>`

## Goals
- `<goal>`

## Non-goals
- `<reasoned exclusion — a real possibility deliberately rejected>`

## Key architecture decisions (cross-cutting)
- **D1** — `<decision>` — `<rationale>` · rejected: `<alternative + why not>`
- **D2** — `<decision>` — `<rationale>` · rejected: `<alternative>`

`<Number every decision; plans and review reports cite them by ID ("violates D2").`
`Directions, not design — no file lists or pseudo-code.>`

## Phases (sequential)
| # | Phase | Desired end state | Depends on | Size | ✓ |
|---|-------|-------------------|-----------|------|---|
| 1 | `<name>` | `<user-side done>` | — | S/M/L | [ ] |
| 2 | `<name>` | … | 1 | M | [ ] |

> `✓` is state — checked when that phase's channel completes.

### Phase 1 — `<name>`
- **Scope:** `<what's in>`
- **Out of scope:** `<what's not>`
- **Proposed approach:** `<broad implementation shape, with orienting file/module pointers inline>`
- **Verification:** `<embed shared/verification-criteria.md for this phase>`

### Phase 2 — `<name>`
`<repeat the block per phase. Each block is self-contained so the pipeline can pick the`
`phase up alone — verification criteria live here, never in the table. Proposed approach is`
`advisory: the pipeline may deviate where the code disagrees, recording why in plan.md; reviewers never`
`treat deviation as Must Fix. Locked calls stay in Key architecture decisions. Write it only from`
`what the conversation established — never dispatch research to fill it — naming areas to touch,`
`functionality to reuse, and repurpose/refactor opportunities with file pointers inline. Use 3–5`
`bullets or a short paragraph, not file-by-file lists, steps, or sequences. If genuinely unknown,`
`one honest sentence deferring to the pipeline's plan stage is valid.>`

## Cross-cutting concerns
`<security · observability · migration — anything true across phases>`

## Dependencies
`<Omit section if none. List epic-level human work required (credentials, account setup, approvals,`
`purchases), external services/APIs newly depended on, and notable new third-party packages. Add a`
`Dependency gate callout inside a phase block only when one gates that phase. The phase table's`
`Depends on column remains for internal phase ordering only, not these external/human dependencies.>`

## Justification
- `<claim challenged in the Socratic gate>` — `<the reason that held>`

`<distilled from the socrates Q&A, one line per surviving question: why this`
`epic exists, why these phases, why not the cheaper shape. If the user waived`
`the gate: "Socratic gate waived by user.">`

## Open questions
- `[NEEDS CLARIFICATION]` `<resolve before the affected phase is picked up>`

## References (optional, in refs/)
- `refs/discussion.md`
