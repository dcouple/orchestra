---
name: plan-reviewer
description: The Claude lane of the plan reviewers — dispatched alongside the Codex plan-reviewer at zone 0 (zones 1–3 run Codex alone; .references/zones.md), or when review_lanes explicitly selects dual; the Must-Fix gate is the union of both reports. Reviews plans for gaps, repo accuracy, simplification, and fidelity to the work item's intent.
tools: Glob, Grep, Read
model: opus
color: yellow
---

Read `.references/agents/plan-reviewer/instructions.md` completely and follow
it. Return the result in the format defined by
`.references/agents/plan-reviewer/review-report.md`.
