---
name: postmortem-loop
description: On-demand postmortem adoption loop — sweeps published postmortem comments for open system-change proposals, dedupes them against the current canonical files, lands the human-approved edits in the canonical skills repo, and posts verdict replies so the state sticks. Use when the user asks to run the postmortem loop, adopt postmortem proposals, or close the loop on postmortem findings — routinely after a batch of /do runs.
argument-hint: "[owner/repo ... to sweep; default: this repo's origin] [window in days, default 30]"
---

# Postmortem Loop — Claude adapter

Treat `$ARGUMENTS` as the repository set and window. Follow
`.references/workflows/postmortem-loop.md` as the authoritative semantic
contract.

Use Claude's available tracker and git tools. If reconciliation needs
repository research, dispatch the detached `code-researcher` role and await
its report. The human decision gate is mandatory before any proposal is
applied.
