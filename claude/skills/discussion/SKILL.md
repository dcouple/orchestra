---
name: discussion
description: Interactive back-and-forth to clarify, understand, or figure something out — an idea, an approach, a tradeoff, or a suspected bug. Use when the user wants to think out loud or explore before committing to anything — e.g. "let's discuss X", "help me understand Y", "why is Z happening", "what should we do about W". Produces clarity plus a dated decision log, not deliverables; work items are created afterward with /create-plan or /create-epic.
argument-hint: "[idea, question, or topic]"
---

# Discussion — Claude adapter

Treat `$ARGUMENTS` as the topic. Follow
`.references/workflows/discussion.md` as the authoritative semantic contract.

Route code research and investigation through the detached `codex` skill.
Use Claude native `web-researcher` and `frontend-verifier` agents for external
research and live-app evidence. Independent work may run concurrently, but
await the reports needed for each claim. Use Claude slash-skill names for any
capture handoff.
