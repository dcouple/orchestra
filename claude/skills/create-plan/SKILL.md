---
name: create-plan
description: Captures discussed work as a work item ready for /do — a Feature Ticket for changes and additions, a Bug Report for defects (running the investigator first if the root cause isn't established). Use when a conversation has converged on a single buildable change that has no work item yet — whether the user asks to capture it or convergence makes capture the obvious next step. Do not invoke for a passing idea, an unconverged thread, or work that already has an item. For multi-phase workstreams use /create-epic instead.
argument-hint: "[title or one-line summary]"
---

# Create Plan — Claude adapter

Treat `$ARGUMENTS` as the proposed work title or summary. Follow
`.references/workflows/create-plan.md` as the authoritative semantic contract.

Dispatch repository research and defect investigation through the `codex`
skill with the contract's named role. Use Claude native `frontend-verifier`,
`web-researcher`, and `socrates` agents where the contract calls for them.
Await every required report before advancing. Use Claude slash-skill names
for workflow handoffs.
