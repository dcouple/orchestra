## Step 6: Wrap-up

- Assemble the dial record's **run record** before writing: `gh pr view
  --json changedFiles,additions,deletions` for `pr_size`; per-role Codex
  tokens summed from the dispatches' `CODEX <role>: … · tokens <n>` lines;
  Codex main-loop and sub-agent tokens scripted from the session transcript
  JSONL (group by `message.id`, keep the final usage snapshot per id; harness
  task summaries are a cross-check only);
  the `agents` roster (role, model, effort, dispatches, duration, tokens)
  and `spend_ratio`. Record `unknown` where a source didn't expose a
  number - never estimate. This record is what the postmortem and the
  zones.md tuning aggregate consume; a run that doesn't emit it is
  invisible to that tuning.
  When runtime fallback occurred, also carry the plan's `requested_lanes`,
  `effective_lanes`, `runtime_fallback`, and `fallback_cause` into the dial
  record; effective lanes remain single/Codex-only regardless of the request.
- Write `./tmp/<id>/wrapup.md` following this skill's
  `references/wrap-up-report.md`. Before posting it as a PR comment,
  consolidate the run's final state into the PR body with `gh pr edit
  --body-file`: fold the review outcome, QA results, user journey summary,
  deploy notes, and residual risks into their existing body sections so
  the returning human sees the complete picture in one scroll without
  reading comments. Comments stay as the evidence trail; the body is the
  dashboard. Read back the persisted body afterward and verify every
  section was updated. Then post the detailed wrap-up as a comment.
  `plan.md` and `wrapup.md` stay in `./tmp/<id>/` -
  unless the project's `AGENTS.md` `Work-item tracking` section specifies
  where work-item artifacts go, in which case save them there per its
  instructions.
- At this wrap-up milestone, when an artifact host is configured, re-upload
  the bundle (now including `wrapup.md`) using the artifact-host step in
  `.references/publish-work-item.md`.
- Immediately before the `awaiting-human-review` label, **YOU MUST** run the
  shared contract's current-item handoff set and report each `In Review`
  operation as `verified`, `already-correct`, `failed`, or `unavailable`.
- Label the PR `awaiting-human-review` (create the label if missing) -
  commits after this label's timestamp are the run's post-review rework
  metric (`.references/zones.md`, The record).
- Before the final report, **YOU MUST** run the shared contract's retained
  merged-PR hygiene set and report each `Done` operation as `verified`,
  `already-correct`, `failed`, or `unavailable`.
- Report to the user: **lead with the PR link**, then a short **Human action
  required** block *before* the prose summary - ordered by urgency and split
  into **✅ done for you** (green-tier actions the run already applied - e.g.
  staging DDL) and **⛔ you must do** (red deploy actions + external unblocks
  like a missing key or access), with anything that **blocks verification/QA
  surfaced first as a prerequisite**. Only then the wrap-up summary and
  anything unresolved. **Notify** run completion per `.references/notify.md`.
- Then run the `postmortem` skill on this run automatically, in its
  **ops-only mode** - the operations half (wall-clock, stalls, tokens,
  review-pass yield) needs no human input and attaches to the same work
  item, so every run leaves an analyzable record without being asked. Its
  change proposals are recorded in the published postmortem, never waited
  on - the run ends right after it publishes. The outcome half stays
  deferred: it runs when the human returns from PR review (or invokes
  `/postmortem` again), because "did the result match intent" isn't
  knowable at wrap-up.
