---
name: investigate
description: Investigates bugs through a single evidence-driven investigator, scaling from a normal root-cause pass to a deep falsifiable experiment loop. Use when something is broken, failing, or behaving unexpectedly.
argument-hint: "[bug description, error message, or unexpected behavior]"
---

# Investigate — Claude adapter

Treat `$ARGUMENTS` as the defect report. Follow
`.references/workflows/investigate.md` as the authoritative semantic contract.

Dispatch exactly one `investigator` through the detached `codex` skill with
the complete brief and authorization boundary. Await its report, preserving
the daemon wakeup/pickup lifecycle when the dispatch crosses turns. Do not add
a separate researcher for the same investigation.
