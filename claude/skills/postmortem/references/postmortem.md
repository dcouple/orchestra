# Postmortem — format

> Produced by `/postmortem` on a `/do` run — the Run operations half always, the outcome
> half when the result fell short of intent. Saved as `./tmp/<id>/postmortem.md` and
> published to the tracker the repo's `AGENTS.md` `Work-item tracking` section configures,
> tagged `postmortem` (see SKILL.md step 5 for the metadata; no tracker → stays local).
> The point is **compound learning**: fix the root cause in *our system*
> (skill / agent / template / criteria), so the same stall or gap can't recur.

---
```yaml
---
type: postmortem
item: <id>
pr: <url or # of the /do PR — "none" if the failure predates a PR>
anchor: <the PR or issue this postmortem is connected to (same as pr when a PR exists)>
---
```

# Postmortem — `<item>`

## Run operations (always)
`<wall-clock span; agent-active vs human-idle time and its %; post-completion idle carved`
`out (human away after the run finished — inflates duration, not a defect); the`
`PER-STEP TIMING TABLE — required, never summarized away: one row per pipeline step and`
`per dispatch with start/end clock time (scripted from the transcript, not estimated),`
`duration, TOKENS (main JSONL usage + subagents/agent-*.jsonl or notification totals +`
`Codex "tokens used" stdout / rollout token_count events — "unknown" only after checking`
`all three) and est. cost, and note, closed with phase %-of-wall-clock aggregates and`
`summed turnaround gaps; the ranked in-run stalls (agent turn-ends that needed a "continue" nudge) with`
`what each waited on; per-phase pacing from the commits; blocker inventory`
`(AskUserQuestion gates, rate-limit hits, legitimate background-agent waits). Render the`
`table as a Gantt timeline (HTML/SVG in refs/, screenshot embedded on the anchor PR and`
`tracker issue — parallel vs sequential must read at a glance). Close with the single`
`change that would have removed the biggest stall. Per`
`.references/run-operations-analysis.md.>`

## What we asked for
`<the intent + desired end state, briefly>`

## Outcome vs intended
`<"On-target — no outcome gap" when the run delivered what was asked; otherwise the gap the`
`human found on PR review, concrete>`

## Why the gap happened
`<only when there was an outcome gap — root cause in OUR system, not just the code: a thin`
`ticket? a weak verification criterion? a review blind spot? a missing architecture`
`direction? Omit for an operational-only postmortem.>`

## What to change so it doesn't recur
`<the concrete improvements the findings support — each names a specific skill /`
`sub-agent / template / verification block and shows the proposed edit; zero is a`
`valid answer, and so is several>`

## Dial record & right-sizing
`<copy the wrap-up's dial-record block (zone, lanes, passes, findings split`
`first-pass/later per lane, verifiers/QA, wall-clock, pr_size, tokens,`
`spend_ratio, agents roster — filling any "unknown" the transcripts can now`
`resolve), then ONE judgment line: review effort was overdone | right-sized`
`| underdone — naming the single dial that would have changed it. Ground the`
`judgment in spend: tokens per review pass vs the Must Fixes that pass`
`caught — a pass that found nothing was pure spend. This tunes zones.md's`
`table.>`

## Acceptance
`<the human's verdict on the PR, when known: merged as-is | merged after`
`rework (count the post-label commits) | closed/rejected | still awaiting`
`review (operations-only postmortem). This is the outcome bit the score`
`aggregation joins against.>`

## System changes
`<URL of this postmortem in the repo's tracker (or "local-only"), plus the approval`
`verdicts on the proposed changes once the human gives them — pending until then;`
`an auto-run postmortem never waits for them>`
