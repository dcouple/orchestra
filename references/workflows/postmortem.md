# Postmortem workflow contract

## Input

A work-item identifier, pull-request reference, or completed local run.

Compound learning on the last autonomous-pipeline run — on **two** axes:

- **Operations (always):** how the run actually ran — wall-clock, how much was
  the agent working vs idle waiting on a human, where it stalled, what blocked
  it. This half runs on every run, successful or not.
- **Outcome (only when it fell short):** where the delivered result missed the
  intent, root-caused in **our system** — the skills, agents, templates, and
  criteria — not just the code. (Also covers another workflow skill producing
  the wrong outcome: a ticket the gate should have killed, a skill that fired
  at the wrong moment.)

The completion artifact is `./tmp/<id>/postmortem.md`, published **as comments
on the run's anchors** — the work item it executed and its pull request — never as
a separate tracker issue (a postmortem is run metadata about existing work,
not a work item; local-only when neither anchor exists), plus the proposed (never
applied) system changes its findings support.

This workflow changes nothing: no code fixes, no workflow edits. If the code itself needs
fixing, that goes through work-item capture and the autonomous pipeline; the proposed system change is
presented for the human to approve, not applied.

> Every postmortem carries the run's dial record (zone, lanes, passes,
> findings per lane, QA yield, tokens, PR size, spend ratio, agents roster
> — from `wrapup.md`, cross-checked against the transcripts) plus one
> judgment line: review effort was overdone / right-sized / underdone,
> naming the single dial that would have changed it. Review passes are the
> first place to look — a pass that found nothing was pure spend. This is
> the data that tunes `.references/zones.md`'s table.

The autonomous pipeline invokes this workflow automatically at wrap-up in **ops-only mode**:
steps 3–4 are skipped (the outcome half needs the human's PR review, so it
runs on a later invocation) and step 6's proposals are recorded in the
published postmortem without waiting on anyone — the unattended run ends
right after publishing. Standalone invocations cover both halves as
applicable.

## Steps

### 1. Load the record
Resolve `<id>` from the input (a work-item id directly, or match a PR to the `pr:` field
across `./tmp/*/item.md`). Then read:
- `./tmp/<id>/item.md` — what we asked for
- `./tmp/<id>/plan.md` — what the pipeline planned
- `./tmp/<id>/wrapup.md` — what the pipeline claims it delivered and verified
- PR feedback — `gh pr view <pr> --comments` and the review threads, or ask the user to
  paste it if it lives outside GitHub
- the run's session transcripts supplied by the harness adapter (a run may
  span several files after compaction) and the phase/fix commits
  (`git log --reverse --date=... origin/main..HEAD`) — the raw material for step 2

**Success criteria**: all sources loaded (or their absence noted — a missing wrapup
is itself a finding; missing transcripts mean the operational analysis is best-effort
from commit timestamps alone).

### 2. Analyze how the run ran (operations) [always]
Follow `.references/run-operations-analysis.md`: script the transcripts (don't eyeball) to
compute wall-clock span, agent-active vs human-idle time and its %, post-completion idle
(carved out — it inflates duration but isn't a defect), the ranked stalls (agent turn-ends
that needed a human nudge), per-phase pacing from the commits, and the blocker inventory
(`AskUserQuestion` gates, rate-limit hits, legitimate background-agent waits). Name the
single change that would have removed the biggest stall.

**Success criteria**: the wall-clock/active/idle split is quantified, each in-run stall is
attributed to what it waited on, and the highest-leverage operational fix is named — even
for a run that delivered the right outcome.

### 3. Establish the outcome gap [human] — only if the run fell short
If the run delivered what was asked, say so and skip to step 5 (an operational-only
postmortem is complete). Otherwise discuss with the human what fell short: delivered vs
intended, concretely. Anchor on the item's intent and ACs — did the pipeline miss the ticket, or
did the ticket miss the intent?

**Success criteria**: either the run is confirmed on-target (outcome track skipped), or the
gap is stated in one or two concrete sentences the human agrees with.

### 4. Root-cause it in OUR system — only if there was an outcome gap
Trace the gap upstream through the pipeline and name where it entered:
- **Thin ticket** — intent or end state under-specified, so the pipeline optimized the wrong thing
- **Weak AC** — verification criteria passed while the intent failed (untestable or
  mis-aimed criteria)
- **Missing direction** — a decision the model shouldn't have made alone wasn't locked
- **Review blind spot** — a reviewer should have caught it and the report shows it didn't
- **Skill/agent gap** — a pipeline stage lacks an instruction this failure needed

The code defect (if any) is a symptom here. Note it, and route the fix through
work-item capture and the autonomous pipeline — not this workflow.

**Success criteria**: one primary system-level cause identified, with evidence from the
step-1 documents (quote the thin section, the weak AC, the review miss).

### 5. Write the postmortem
Write `./tmp/<id>/postmortem.md` following
`.references/workflows/formats-and-assets/postmortem/postmortem.md` —
emit the filled-in frontmatter and body only; the template's "— format" header and
guidance quotes are authoring notes, not output. Always fill the **Run operations**
section from step 2; fill the outcome sections only when step 3 found a gap (say
"on-target" otherwise).

Then publish it **as comments on its anchors — never as a separate tracker
issue or work item**. A postmortem is run metadata about existing work; a
standalone issue orphans it from the thing it analyzes and pollutes the
backlog with non-actionable items. The anchors:
- **The work item** (tracker issue the run executed): post the postmortem
  body as a comment there, following the repo's artifact-comment convention
  (e.g. `ORCHESTRA-ARTIFACT` markers with `path="postmortem.md"`), so a
  later pull harvests it with the other run artifacts.
- **The pipeline PR** (when one exists): post the same body as a PR comment —
  the reviewer arriving at the PR must see how the run ran without leaving
  the page.
- The two anchors are independent — post to every anchor that exists. A
  local work item (no tracker configured) whose run still opened a PR gets
  the postmortem on that PR; a tracked item whose run died before a PR gets
  it on the work item alone. Only when **neither anchor exists** (e.g. a
  failure inside a capture workflow before anything was published) does the
  postmortem stay local in `./tmp/<id>/postmortem.md` — and you tell the
  user so.

Title the comment's first line `# Postmortem — <item> (<ops-only | full>)`
so it's scannable in a long thread. Record the comment URLs in
postmortem.md's "System changes" section. A second invocation on the same
run (the deferred outcome half) posts a follow-up comment on the same
anchors — it never edits or replaces the ops-only comment.

**Success criteria**: `postmortem.md` exists with the Run operations section filled and
(when the run fell short) the "why the gap happened" section naming the system cause (not
just the code defect); the postmortem body is a comment on the work item and on the
anchor PR when they exist (local-only and the user told, only when neither exists); **no new tracker
issue was created for it**; the comment URLs are recorded.

### 6. Propose system changes
Propose the system changes the findings actually support — zero, one, or several:
don't force a proposal when nothing is wrong, and don't cap them when the run
surfaced more. Each proposal names one concrete change to one specific file — a
workflow adapter, role contract, template, or criteria block, by its path in
the canonical skill-system source. Installed copies are synced mirrors; edits
land in the canonical source and re-sync. Quote the file path and show the
proposed edit. Proposals target **operational** findings from step 2 (pre-authorize a
green-tier gate, add a self-wakeup, make a fallback non-blocking) as readily as
outcome gaps.

Do **not** apply any of them. Record each in postmortem.md's "What to change so it
doesn't recur" section for the human to weigh later — this step is a report, never a
gate: don't wait for approval, and an automatic pipeline wrap-up run ends after
publishing, full stop.

**Success criteria**: each proposal names an exact file and shows the concrete edit;
nothing outside `./tmp/<id>/` was modified; the run never paused for approval.

```
Suggested next steps:
- capture the defect, then run the autonomous pipeline to fix the code gap
- run the postmortem adoption workflow to land approved system changes
```
