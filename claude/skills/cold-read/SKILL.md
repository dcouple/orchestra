---
name: cold-read
description: Have a fresh agent read an artifact without prior context and report confusion, contradictions, and missing information without editing it.
---

# Cold Read

## Dispatch

- Use a fresh sub-agent with no conversation history, prior reviews, or explanation of the intended conclusion.
- Supply only the artifact and the task of reading it. Walk through the whole artifact in order.

## Report

- What is broken, confusing, contradictory, or unnecessarily hard to understand?
- What information is missing: what, why, how, when, or where?
- Quote or locate each issue and explain where the reader got stuck.
- Do not edit or invent fixes that depend on context you were not given.

If the coordinator saves the report, use `.references/artifact-storage.md`. Keep the blind reader isolated from other artifacts and conclusions in the shared folder.
