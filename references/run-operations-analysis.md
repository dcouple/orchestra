# Run operations analysis

Measure how a run spent time and tokens, including successful runs. Separate
execution, legitimate waits, human gates, and avoidable stalls.

## Locate the record

- Match the actual run, not every session in the worktree. Include resumed
  or compacted segments and their dispatched agents.
- Claude records normally live under `~/.claude/projects/<munged-cwd>/`;
  inspect JSONL timestamps, event types, message IDs, and usage. Subagent
  records live under the session's `subagents/` directory.
- Codex records use `~/.codex/sessions/<date>/rollout-*.jsonl`. Detached CLI
  reports and logs use `.codex-dispatches/<owner>/`.
- Use the host's actual format when different. Missing transcripts mean
  best-effort timing from dispatch files, commits, and PR timestamps, not
  permission to estimate from memory.
- Keep transcripts private. Save safe derived reports and timelines per
  `.references/artifact-storage.md`.

## Compute timing

Parse timestamps programmatically; do not eyeball durations.

- **Wall-clock**: first relevant event through completion. Report later human
  absence separately as post-completion idle, not a workflow defect.
- **Human-idle**: intervals genuinely waiting for a human. Distinguish human
  messages from tool results, task notifications, and harness metadata.
- **Agent-active**: span minus classified idle is an approximation, not CPU
  time. Label uncertainty; a silent interval may contain background work.
- **Stalls**: an agent ended its turn with runnable work and needed a nudge.
  Confirm this against events and the human's message; a long gap alone is
  not proof of a stall.
- **Blockers**: named human gates, rate limits, missing prerequisites, and
  legitimate tool/subagent waits. Keep productive waits out of the stall count.
- **Phase pacing**: correlate phase/fix commits using the actual PR base,
  for example `git log --reverse --date=iso <base>..HEAD`.

Compute the union of idle intervals rather than double-counting consecutive
human messages. Keep overlapping dispatches separate from total elapsed time;
handle empty records and zero-duration runs without inventing percentages.

## Per-step table

Required: one row per pipeline step and subagent dispatch.

| Step / dispatch | Start | End | Duration | Tokens | Est. cost | Note |
|---|---|---|---|---|---|---|
| `<name>` | `<clock time>` | `<clock time>` | `<elapsed>` | `<known or unknown>` | `<known or unknown>` | `<dominant work / overlap>` |

Use dispatch start and completion events. Report phase shares of wall-clock,
overseer turnaround gaps, and human-idle totals. Unknown timestamps remain
unknown; do not force them into a precise-looking timeline.

## Tokens and cost

Inspect each source actually used by the run before declaring it unknown:

1. **Claude main loop**: group assistant events by `message.id`, keep the final
   usage snapshot, then sum input, output, cache-read, and cache-write classes.
2. **Claude subagents**: apply the same deduplication to their transcripts.
   Completion-notification token totals are cross-checks, not billing usage.
3. **Codex**: inspect `token_count` events and the CLI log's `tokens used`
   summary. Distinguish cumulative counters from per-turn deltas. A resumed
   session's cumulative total must not be counted again for each dispatch.

- Attribute usage to the recorded model and step, including mixed-model runs.
- Apply `model-prices.md` per token class; check the actual model's usage
  schema before counting cached input or reasoning tokens separately.
- A blended token total cannot be priced accurately; report cost unknown.
- Cross-check `wrapup.md` and name discrepancies. A sum with unknown sources
  is a lower bound, not the true total.
- Compare review yield, stakes, time, and cost. A clean review is not by itself
  evidence of wasted effort.

## Timeline and handoff

- Fill the postmortem skill's `references/run-timeline-template.html` `RUN`
  object from measured phases, dispatches, tokens/yield, and idle intervals.
- Include an Overseer row and phase bands so concurrent versus sequential
  work is visible. The template derives the chart and accessible table.
- Use its sibling `render-timeline.sh`; `--check` reports the available
  renderer. On `NO_RENDERER`, deliver the HTML and note the missing PNG.
  Do not improvise another renderer mid-run.
- Keep the filled HTML under `./tmp/<id>/refs/`, with safe Grain copies when
  available. Embed the rendered image on existing authorized PR/tracker
  anchors using a durable host the viewer can access; retain exact source data.
- Fold the table, ranked stalls, blockers, and largest supported improvement
  into the postmortem's Run operations section. Propose no change when the
  evidence does not support one.
