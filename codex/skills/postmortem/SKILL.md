---
name: postmortem
description: Analyze how a workflow run operated and why its outcome missed intent, then publish report-only improvements.
---

# Postmortem — native Codex adapter

Treat `$ARGUMENTS` as the run or pull-request anchor. Follow
`.references/workflows/postmortem.md` as the authoritative semantic contract.
Use the shared template and timeline assets under
`.references/workflows/formats-and-assets/postmortem/`.

When causal code research is required, explicitly start the appropriate
native custom agent with collaboration tools, never an agent CLI, and await
its report. This workflow is report-only; do not apply its proposals.
