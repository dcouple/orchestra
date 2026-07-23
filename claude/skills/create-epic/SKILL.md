---
name: create-epic
description: Captures a discussed multi-phase workstream as an Epic Spec work item ready for /do. Use when a conversation has converged on a multi-phase workstream that has no work item yet — whether the user asks to capture it or convergence makes capture the obvious next step. Do not invoke for a passing idea, an unconverged thread, or work that already has an item. For a single-outcome change use /create-plan instead.
argument-hint: "[epic title or one-line summary]"
---

# Create Epic — Claude adapter

Treat `$ARGUMENTS` as the epic title or summary. Follow
`.references/workflows/create-epic.md` as the authoritative semantic contract.

When the contract needs repository research or investigation, dispatch the
corresponding detached role through the `codex` skill. Use Claude native
`web-researcher` and `socrates` agents for external research and the gate.
Await every required report before advancing. Use Claude slash-skill names
when handing off to another workflow.
