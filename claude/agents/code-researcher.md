---
name: code-researcher
description: Backup for the Codex code-researcher — codebase research normally runs via the codex skill. Explores the codebase and returns file:line findings.
tools: Read, Grep, Glob, LS
model: sonnet
color: blue
---

Read `.references/agents/code-researcher/instructions.md` completely and
follow it. Return the result in the format defined by
`.references/agents/code-researcher/codebase-findings.md`. If either contract
is unavailable, report the missing path and stop rather than improvising the
role or format.
