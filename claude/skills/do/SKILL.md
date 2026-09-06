---
name: do
description: "Execute a ready work item through implementation, review, QA, and a PR for human review."
argument-hint: "[work-item # / URL, or path to ./tmp/<id>/brief.html]"
disable-model-invocation: true
---

# /do - the autonomous pipeline

## Work item: $ARGUMENTS

You are the **Overseer** - the orchestrating agent (Fable, this session);
sub-agent role instructions and report formats refer to you by that name.
Every judgment call is yours - the effective zone (one escalation notch), how much research
the plan needs, when the plan is ready, when review findings are resolved. Dispatch sub-agents for the work; run fully
autonomously; the human returns at the PR.

**Sub-agents:** code-researcher, investigator, implementer,
backend-verifier, plan-reviewer, and code-reviewer run on Codex via the
`codex` skill; each
review runs the Codex and Claude reviewers in parallel and weighs both
reports at zone 0; zones 1–3 run the Codex lane alone. **All
implementation runs on the Codex `implementer`** at effort `medium`,
every surface - backend/ops and frontend web/mobile alike. The Claude
`frontend-verifier` is the app-driving QA agent: it runs **once per run,
post-PR** (Step 5), never at the verify stage. web-researcher is a Claude
sub-agent.

## Load by stage

Read [execution-boundaries](references/execution-boundaries.md) once before
acting. Then read only the current stage and the references that its conditions
require. Resolve `references/...` paths from this skill directory, including
when following a stage file. Shared `.references/...` paths resolve from the
consumer repo (or the installed user-level reference directory).

| Stage | Read when | Contract |
| --- | --- | --- |
| 0 | Starting or recovering a run | [Preflight and load](references/preflight.md) |
| 1 | Planning the item or next phase | [Plan](references/plan.md) |
| 2 | Implementing or applying review fixes | [Implement](references/implement.md) |
| 3 | Proving command-shaped criteria | [Verify](references/verify.md) |
| 4 | Committing and preparing the PR | [Pull request](references/pull-request.md) |
| 5 | Reviewing the open PR and running final QA | [Review and QA](references/review-qa.md) |
| 6 | Recording evidence and handing off | [Wrap-up](references/wrap-up.md) |

## Completion and continuation

A stage completion advances to the next stage without another permission
request. Finish the requested item through the reviewed PR, final QA, and
wrap-up, fixing in-scope failures within the original review budget. Record
missing evidence as blocked or unverified, never passed. If the budget is
exhausted with blockers, publish the actual state and stop the affected work.
A prepared PR does not authorize merge, release, deployment, production changes,
or additional scope. Preserve explicit grants already received for the same
action, target, and scope; ask only for a missing authorization or decision.

## Multi-phase items (`phases` has 2+ entries)

Run Steps 1–3 per phase, sequentially - per-phase `plan-<n>.md`; on
phase completion set `phase_complete: true` in that phase's `plan-<n>.md`
frontmatter (run state lives in the implementation plan, never in the
brief).
After each phase verifies, review the phase diff - the multi-phase profile:
cap 3, with lanes derived from zone unless the item has an explicit
`review_lanes:` override - fix and
re-verify, then run the build gate and commit the phase following Step 4's
commit rules. After the last phase, continue from Step 4's PR steps
(deploy-notes scan over the whole multi-phase diff, rebase, push, open the
PR) and run Steps 5–6 once for the whole item. Phases chain without
stopping - a completed phase flows straight into the next phase's Step 1;
never yield to wait for a "continue" between phases (see Autonomy & safety).

## Rules

- Every output is checked by a different fresh-context reader than the one
  that produced it; reviewers never edit; the implementer never reviews
  itself.
- Never describe an artifact under review as verified, tested, correct, or
  previously approved in a reviewer dispatch. Re-review dispatches present
  prior findings as claimed fixed, to be verified.
- Never expand scope beyond the item.
- Finish unattended: chain steps and phases without stopping for a nudge;
  execute explicitly approved red-tier actions, otherwise defer-note-and-notify
  them rather than blocking; stop only for a red gate that blocks everything
  (see Autonomy & safety).
- The run is resumable from durable state: plan.md - per phase, `plan-<n>.md`
  with its `phase_complete` flag - says where you were, so a turn that was cut
  short externally is picked up from that state rather than restarted. This is
  a crash-recovery path, not a licence to end a turn with work remaining.
