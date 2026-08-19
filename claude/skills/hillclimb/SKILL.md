---
name: hillclimb
description: Sustained improvement of one named metric toward a target — measure a baseline, then loop one hypothesis at a time, each with a re-measurement and a keep-or-revert verdict. Use for perf, bundle size, lint count, test time, or any number with a repeatable measurement.
argument-hint: "[metric and target, e.g. p95 render under 100ms]"
disable-model-invocation: true
---

# Hillclimb

## Metric: $ARGUMENTS

One metric, one target, one change per cycle. The number decides.

Check the branch before the first cycle: on the default branch, stop and ask the
user to set one up — never create one silently. Start from a clean tree, and
when it carries changes you did not make, confirm with the user first; rejected
cycles revert. The loop produces commits; they reach the default branch through
`/prepare-pull-request` on the finished climb.

## 1. Name the metric and the target

State the metric, its target, and the workload it is measured on — realistic
input, not a microbenchmark that flatters the change. When the request names a
direction ("faster") instead of a number, settle the target with the user first.

## 2. Measure the baseline

Write the measurement down as a command anyone can rerun, run it, and record the
result. Every later measurement uses this method on this workload; freeze both
for the run. A claim with no measurement behind it does not exist.

## 3. Loop

Keep a log at `./tmp/hillclimb/YYYY-MM-DD-<slug>.md` — one row per attempt:
hypothesis, change, before, after, verdict.

- Rank the open hypotheses by expected win and take the top one. Root each in a
  named mechanism — what specifically costs the time, the bytes, the errors.
- Implement it alone.
- Re-measure with the frozen method, and run the repo's checks in the same cycle
  (the workflow its own `AGENTS.md`, package scripts, or CI config names).
  Failing checks revert the change whatever the number says.
- Accept or revert on the number. A delta inside run-to-run noise is
  inconclusive — re-measure, and revert when it stays unclear. An accepted win
  gets its own commit of that cycle's files alone, named with the before and
  after (`perf: p95 420ms -> 180ms`) and carrying the measurement command in its
  body. A rejected one is reverted — the files this cycle touched, never a
  tree-wide reset — before the next cycle starts.

## 4. Stop

Stop at the target, after three consecutive hypotheses with no accepted win, or
when the ranked hypotheses run out.

## Report

- the trajectory table: baseline to final, one row per accepted win with its
  before and after;
- the rejected hypotheses and what each measurement showed;
- the measurement method, quoted as the runnable command — `./tmp/` is
  scratch, so the report and the accepted-win commit messages are where it
  survives for the next run.
