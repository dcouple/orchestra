---
name: investigate
description: Investigates bugs through a single evidence-driven investigator, scaling from a normal root-cause pass to a deep falsifiable experiment loop. Use when something is broken, failing, or behaving unexpectedly.
argument-hint: "[bug description, error message, or unexpected behavior]"
---

# Investigate

Use one investigator to reproduce the defect, isolate its cause, and report the evidence. This skill is the human-facing front door; the `investigator` role owns the diagnostic work.

## 1. Frame the Defect

Build a compact self-contained brief from `$ARGUMENTS` and the conversation:

- expected behavior;
- observed behavior;
- reproduction steps or triggering state;
- environment, frequency, and relevant errors;
- evidence already available;
- constraints, especially whether diagnostic edits are authorized.

Ask the user only for missing information that prevents a meaningful investigation. Do not ask for details that can be obtained from the repository or runtime.

## 2. Select Depth

Read `.references/investigation-method.md` and choose:

- **normal** — deterministic, scoped, clear reproduction or error trail;
- **deep** — intermittent, stateful, cross-boundary, timing-sensitive, renderer-dependent, previously misdiagnosed, or explicitly requested as thorough.

Start normal unless the brief already meets a deep criterion. The investigator may escalate from normal to deep when evidence shows the simpler pass cannot distinguish the leading hypotheses.

## 3. Dispatch the Single Investigator

Use the `codex` skill with role `investigator`. Pass a self-contained prompt containing:

- the defect brief;
- selected depth;
- the instruction to follow `.references/investigation-method.md`;
- exact authorization boundaries for diagnostics and production access;
- any existing logs, screenshots, traces, or reproduction artifacts.

Do not dispatch a separate `code-researcher` for the same investigation. The investigator owns reproduction, code tracing, history, runtime evidence, and root-cause isolation end to end. A second dispatch is justified only when the first finding explicitly names missing evidence that has since become available.

If the Codex investigator is unavailable, follow the shared method directly in the current session and disclose that fallback.

## 4. Return the Finding

Relay the investigator's structured finding to the user with:

- root cause and confidence first;
- reproduction and observed behavior;
- file:line, trace, log, or persisted-state evidence;
- introducing commit or timeframe when known;
- high-level resolution direction;
- the exact evidence needed when confidence is below confirmed.

Do not silently upgrade confidence. Remove all approved diagnostic logging or temporary investigation edits before reporting completion.

## Stop Conditions

- Stop when the cause is confirmed and the resolution direction is clear.
- In deep mode, stop when the original reproduction and adjacent probes establish one reliable explanation or candidate.
- Preserve any known-good checkpoint before optional hardening.
- Move broader architecture work into a separate follow-up instead of expanding the investigation indefinitely.
