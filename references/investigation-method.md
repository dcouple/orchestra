# Investigation Method

Shared method for the user-facing `/investigate` workflow and the pipeline `investigator` role.

## Depth

Choose the lightest depth that can establish the cause with evidence.

### Normal

Use when the failure is deterministic, scoped to one subsystem, and has a clear reproduction or error trail.

- Rank three plausible hypotheses.
- Reproduce from a known state.
- Trace backward from the failure and compare with a working sibling.
- Check recent history and blame the failing lines.
- Confirm the cause from code plus one independent observation.
- Return the finding as soon as the cause is established.

### Deep

Use when the failure is intermittent, stateful, cross-boundary, timing-sensitive, renderer-dependent, previously misdiagnosed, or explicitly requested as a thorough investigation.

Deep mode includes the normal method plus the falsifiable experiment loop below. It may inspect multiple evidence layers and continue until one candidate survives the original reproduction and adjacent probes.

## Shared Rules

- Diagnose before proposing a fix.
- Separate observation from diagnosis.
- Define evidence that would confirm an unproven claim.
- Use the real product surface when the behavior is observable through a CLI, socket, browser, desktop window, or TUI.
- Prefer fresh isolated state: temporary profile, database, repository, worktree, port, or process namespace.
- Do not leave diagnostic logging or temporary investigation edits in the worktree.
- Do not present a plausible explanation as confirmed.

## Core Method

1. **Frame the defect** — expected behavior, observed behavior, shortest known reproduction, environment, frequency, and constraints.
2. **Categorize it** — compile/type, logic, race/timing, state, integration/contract, environment/config, or UI/rendering.
3. **Rank hypotheses before deep tracing** — include one line explaining why each is plausible.
4. **Reproduce from a known state** — if reproduction fails, record exactly what was tried and what evidence is missing.
5. **Localize the path** — trace backward from the symptom, inspect recently changed code, compare broken and working paths, follow data across boundaries, and use blame/log to identify the introducing change.
6. **Confirm or downgrade** — confirmed means the code path predicts the failure and explains why the expected behavior does not occur. Otherwise report `likely` or `hypothesis` and name the confirming evidence.
7. **Sketch the resolution direction** — high level only; implementation belongs to the next workflow stage.

## Falsifiable Experiment Loop

Use in deep mode when inspection alone cannot distinguish the leading hypotheses.

1. State one falsifiable claim.
2. Define the observable pass/fail signal before changing anything: screenshot state, log order, raw-buffer marker count, persisted row, response, process state, or another concrete output.
3. Capture the failing baseline from fresh isolated state.
4. Change one variable with the smallest disposable diagnostic or authorized implementation experiment.
5. Drive the real product surface.
6. Capture user-visible evidence plus logs and authoritative raw or persisted state when available.
7. Classify the result as supported, refuted, or inconclusive.
8. Revert failed or inconclusive experimental edits immediately.
9. Record the claim, variable, command or driver, evidence locations, and verdict before the next iteration.
10. After three inconclusive cycles, reconsider the layer rather than repeating variations of the same theory.

## Freeze the First Reliable Result

When an authorized candidate change passes:

- Record the exact diff or checkpoint.
- Rerun the original reproduction from fresh isolated state.
- Probe the nearest regression surfaces and one negative or stress case.
- Preserve the known-good checkpoint before optional hardening.
- Treat each hardening change as a separate experiment with its own failure signal.
- Stop expanding once the acceptance criteria and adjacent probes pass; move broader architecture work to a follow-up.

## Evidence Ledger

For deep investigations, keep a compact ledger:

| Claim | Single variable | Runtime command/driver | Evidence | Verdict |
|---|---|---|---|---|
| `<falsifiable claim>` | `<one change>` | `<surface exercised>` | `<paths or excerpts>` | `supported / refuted / inconclusive` |
