---
name: postmortem-loop
description: Sweep postmortem proposals, reconcile them, apply only human-approved changes, and publish verdicts.
---

# Postmortem Loop — native Codex adapter

Treat `$ARGUMENTS` as the repository set and window. Follow
`.references/workflows/postmortem-loop.md` as the authoritative semantic
contract.

If reconciliation needs repository research, explicitly start the native
`code-researcher` custom agent through collaboration tools, never an agent
CLI, and await its report. The human decision gate is mandatory before any
proposal is applied.
