---
name: postmortem
description: >-
  Runs a postmortem on a /do run — after the human reviewed the PR, or as a
  routine after-run review. Covers how the run operated and, when the result
  fell short, why. Use when a workflow missed intent or when reviewing how a
  completed run spent its time. Proposes supported system improvements but
  never applies them or creates a gate.
argument-hint: "[PR url/# or work-item id]"
---

# Postmortem — Claude adapter

Treat `$ARGUMENTS` as the run or pull-request anchor. Follow
`.references/workflows/postmortem.md` as the authoritative semantic contract.
Use the shared postmortem template and timeline assets under
`.references/workflows/formats-and-assets/postmortem/`.

When causal code research is required, dispatch the appropriate detached
Codex role and await its report. This workflow remains report-only: do not
apply proposed system changes.
