# Implementation Plan — format

> Produced by `/do` (plan stage) from the work item. Saved as `./tmp/<id>/plan.md`
> (per issue; one per phase for epics). Reviewed by Plan Reviewer, then updated with
> progress and plan-deltas during implement.
> **Calibrated for a frontier implementer: what to build & why, at file/module**
> **granularity — not line-level code**, except a short pseudocode sketch inside
> a task marked *hot spot* (see Tasks). No placeholder content: "TBD" or "add
> appropriate error handling" in a plan is a plan failure, not a plan.
> Pre-save check: every `modify` path exists in the repo, every `new` path fits
> the repo's current conventions, no template/placeholder paths, no line number
> that wasn't verified in this checkout. Cheap mechanical catch: grep the plan
> for `<feature>`, `path/to/`, `TBD`, fact bullets missing `Evidence:`, and a
> Goal & invariants section still carrying template wording. Final gate: one
> fresh-eyes reread of the whole plan as if it were a stranger's — hunting
> blunders, oversights, omissions, misconceptions — before any reviewer sees it.

---
```yaml
---
type: implementation-plan
item: <id>
zone: <0-3 — the item's, or Overseer-classified>
effective_zone: <after any one-notch escalation — same as zone when none>
zone_reasoning: <why classified/escalated — omit when the item carried the zone unchanged>
lane: <light | full — derived from effective_zone; epics are always full (zones.md Epics)>
review_lanes: <dual | single — the item's explicit override when present, else the zone default>
phase: <n | —>
confidence: <1-10 — one-pass implementation confidence, scored after review>
---
```

# Implementation Plan — `<item / phase>`

## Goal & invariants
`<3–5 lines from the item's intent: what ships, why, and what must remain true`
`even if implementation details change. This is what the implementer steers by`
`when a plan delta is needed — a delta that breaks an invariant isn't a delta,`
`it's a blocker.>`

## Files changed
`<every file this plan touches — lets a reviewer gauge blast radius at a glance.`
`Keep the "what" to one clause; the tasks below carry the detail.>`

| File | Change | What |
|---|---|---|
| `path/to/file.ts` | modify | `<one clause>` |
| `path/to/new-file.ts` | new | `<one clause>` |
| `path/to/old-file.ts` | delete | `<one clause>` |

## Verified repo truths
`<what exists now, so the implementer needs no other doc — facts only, no proposals.`
`Present tense; no "we add", "will", or other future wording here. Every bullet:>`

- **Fact**: `<one present-tense claim about the repo>`
  **Evidence**: `path/to/file.ts:12-34` `<opened this session>`
  **Implication**: `<why it shapes this plan>`

`<Absence claims — "no X exists", "never called" — additionally carry`
`**Search evidence**: the search that came up empty.>`

## Key decisions (restated for this work)
`<the locked calls from the item that shape this work — so nothing load-bearing is lost.>`

## Known mismatches / assumptions
`<where the item's ask conflicts with repo reality — the conflict and how this`
`plan resolves it — plus any assumption the plan stands on. Or "none". A false`
`premise surfaced here is caught at plan review; buried, it ships to the PR.>`

## Known gotchas
`<concrete repo/library/runtime footguns near the change site — each with why`
`it bites — or "none". Full lane (zones 0–1): dossier gotchas land here; light (2–3) fills`
`it from direct research. Empty is a claim, not a default.>`

## Reconciliation notes
`<full lane: anchors/gotchas/docs imported from refs/research-dossier.md, conflicts`
`re-checked against the repo and how they resolved, dossier content intentionally`
`dropped as low-value. Zones 2–3: "light — no dossier".>`

## External references
`<only when the change leans on a library/framework/API the repo can't answer:`
`URL + section + the critical insight, imported from the web-researcher's`
`dossier findings — or omit the section.>`

## Tasks (ordered, file/module granularity)
- [ ] 1. `<task — what & why, where>` · Pattern: `<existing repo path to mirror, or —>` · Done: `<observable state>`
- [ ] 2. `<task>` · Pattern: `—` · Done: `<observable state>`

`<Hot spots: a task may carry an indented pseudocode sketch (≤10 lines, marked`
`"(hot spot)") ONLY where a wrong approach is likely and expensive — a subtle`
`algorithm, a fiddly integration handshake. Never for CRUD or boilerplate;`
`an unjustified hot spot is a review finding.>`

## Verification / acceptance
`<restate the item's numbered EARS criteria VERBATIM — the plan is`
`self-sufficient; the implementer never opens the item. Each AC lands under`
`exactly one subsection below.>`

### Automated
`<exact commands the implementer runs and self-fixes — build/typecheck/lint/`
`tests/curl — each mapped to the AC# it proves.>`

### Manual
`<flows only a human or the QA pass can exercise, each mapped to its AC#.>`

## Out of scope
`<carried from the item + anything explicitly deferred>`

## Deprecated / removed
`<code this change makes dead — hunted, not assumed: superseded helpers,`
`orphaned exports, flags nothing reads anymore — or "none">`

## Open questions
`<unresolved review findings carried at the cap, and anything the run must`
`judge as it goes — or omit the section>`

## Plan deltas (filled during implement)
- `<deviation + reason>`   *(or "none")*
