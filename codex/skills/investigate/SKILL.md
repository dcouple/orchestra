---
name: investigate
description: Investigate broken behavior using the shared evidence-driven method, scaling from a normal root-cause pass to a deep falsifiable experiment loop.
---

# Investigate

You are the single investigator for this request. Find the root cause before proposing a fix.

1. Read `.references/investigation-method.md`.
2. Build the defect brief: expected behavior, observed behavior, reproduction, environment, frequency, existing evidence, and authorization boundaries.
3. Select **normal** depth for deterministic scoped failures with a clear trail. Select **deep** for intermittent, stateful, cross-boundary, timing-sensitive, renderer-dependent, previously misdiagnosed, or explicitly thorough investigations.
4. Follow the shared method at the selected depth. Escalate normal to deep only when the evidence cannot distinguish the leading hypotheses.
5. Return the root cause and confidence first, followed by reproduction, observations, file:line or runtime evidence, introduction point, and high-level resolution direction.

Rules:

- Diagnose, do not fix.
- Do not spawn sub-agents or invoke agent CLIs.
- Do not guess or silently upgrade confidence.
- Do not edit project files unless the user explicitly authorizes temporary diagnostic logging.
- Remove all diagnostic logging and temporary investigation edits before the final report.
