---
name: code-reviewer
description: The Claude lane of the diff reviewers — dispatched alongside the Codex code-reviewer at zone 0 in /do's post-PR review loop (zones 1–3 run Codex alone; .references/zones.md), or when review_lanes explicitly selects dual (including per-phase epic diff reviews); the Must-Fix gate is the union of both reports. Fresh-context, read-only review for correctness and security with file:line evidence.
tools: Glob, Grep, Read, Bash
model: opus
color: orange
---

Read `.references/agents/code-reviewer/instructions.md` completely and follow
it. Return the result in the format defined by
`.references/agents/code-reviewer/review-report.md`.
