---
name: prepare-pull-request
description: Review, verify, and publish session changes as a PR outside the /do pipeline.
argument-hint: "[optional: issue # to close, or extra context for the PR body]"
---

# Prepare Pull Request

## Context: $ARGUMENTS

Run the Socrates approach gate before the correctness review, then verify
and publish the scoped changes. An unresolved `rethink` blocks the PR.

You are the Overseer. PR conventions (labels, title format, required body
sections, milestones) are the repo's to define: read the project's root
`AGENTS.md` and any contributing/PR docs it names before creating the PR.
Where the repo documents nothing, the defaults below apply. Tracker links and
PR closing lines follow `.references/tracker-lifecycle.md`; this skill does not
run `/do`'s readiness or status lifecycle and does not prompt for tracker auth.

## Step 1: Preflight

- Read `.references/artifact-storage.md`; share safe review artifacts when
  Grain is connected, retain required local files, and pass the folder ID and
  rule to every agent. Keep parallel reviews blind to one another.
- Never work on the default branch. If on it, stop and ask the user to set
  up a branch - don't create one silently.
- Review `git status` and `git diff` so the gates and the PR describe what
  actually changed, not what you remember changing. If the working tree
  contains files you didn't produce this session, confirm with the user
  which changes belong in this PR.
- Materialize the review artifacts under `./tmp/pr-<branch>/`:
  - `intent.md` - the problem being solved, why this approach was chosen,
    what alternatives were considered or rejected in the session, and what
    "done" means. Written for a reader who wasn't in the session; this is
    what Socrates interrogates.
  - `diff.patch` - the full diff of the candidate changes.

  Author `intent.md` with the provenance fields in
  `.references/pr-writing.md`: origin/starting request, current accepted
  intent, decision trail, trigger, source-grounded why and impact, intended
  outcome, constraints, non-goals, rationale, assumptions, open questions, and
  sources. Mark each material claim as user/tracker/decision, repository
  evidence, inference, or assumption. Socrates and the required user
  alignment may refine or reject the origin; record what changed and why, then
  make the PR follow the current accepted intent. If the reason for the change
  or approach was never established, write `Rationale not established`; keep
  that gap separate from an assumption used to proceed. The file must remain
  understandable without an artifact host.

## Step 2: Socrates gate (right approach?)

Dispatch the `socrates` agent with the round number, the paths to
`intent.md` and `diff.patch`, and the contents of this skill's
`references/socratic-pr-gate.md` - it adapts his standard challenge to a
completed change awaiting PR (sunk cost is not a defense; diff-vs-intent
fidelity joins the lines of attack).

- Answer his questions yourself first from session context, updating
  `intent.md` with the reasoning; relay to the user only what you genuinely
  can't answer.
- `pass` → proceed. `press` → answer and re-dispatch (his cap is two judged
  rounds). `rethink` → stop; take the verdict to the user before any rework
  or PR. Never open the PR over an unresolved `rethink`.

## Step 3: Review gate (is it correct?)

Run both reviewers over the diff in parallel, as `/do` does: the `codex`
skill with role `code-reviewer`, and the Claude `code-reviewer` agent. The
Must-Fix gate is the union of both reports. When the reviewers disagree,
adjudicate it yourself. Use sub-agents to help you understand what is true when
needed.

- Fix Must-Fix findings yourself (these are your own session's changes -
  there is no separate implementer), then re-run both reviewers on the
  updated diff. Cap 3 passes.
- Must-Fix findings still open at the cap: stop and put them to the user -
  don't open the PR with known critical issues.
- Non-blocking findings you chose not to take: note them for the PR body's
  Residual risks.
- **Build gate**: discover the project's own build/typecheck/lint workflow
  (the `Commands` section of its `AGENTS.md`, `package.json` scripts,
  Makefile, CI config - ask the repo, don't assume) and run it over the
  touched surfaces. Failures are must-fix before the PR opens.

## Step 4: Commit and push

- Stage selectively - only the files that belong to this change, never
  `git add -A`.
- Secret-scan the staged diff (keys, tokens, credentials) before
  committing.
- Commit message style: `type: short imperative summary`, using the types
  the repo's history actually uses (`fix`, `feat`, `docs`, `chore`, ...).
- Rebase onto the origin default branch; push with `--force-with-lease`
  only when rewriting already-pushed history.

## Step 5: Labels and metadata

Per the repo's documented conventions (root `AGENTS.md` or the docs it
names):

- Apply the label taxonomy the repo defines (type labels, area labels,
  milestones). Match the labels of the issue the PR implements, when there
  is one.
- Never invent new labels; if the repo documents no taxonomy and the issue
  gives no signal, open the PR unlabeled rather than guess.

## Step 6: Open the PR

- Title: same `type: short imperative summary` style as the commit.
- Read `.references/pr-writing.md` before drafting. Carry the final
  `intent.md` provenance into a self-contained Summary and changed-area map:
  explain concepts and dependencies in logical order, include concrete
  examples or diagrams where they clarify behavior, and state the tested SHA,
  QA coverage, and limits. The existing `references/pr-body.md` remains
  authoritative for section order, manual-test parsing, tracker lifecycle,
  evidence-publication fallback, and gates.
- Write the body following the `/do` skill's `references/pr-body.md` - the
  single source for the section spine, the body-state / comment-proof split,
  and the pre-open checklist. Right-size to an ad-hoc change:
  **Summary** (from the final `intent.md`), **Verification**, and **Residual
  risks** are usually the whole body; **Visual overview** follows
  pr-body.md's requirement - user-visible change → before/after captures,
  flow-shaped change → rendered diagram (keep its `.excalidraw` source in
  `./tmp/pr-<branch>/`), neither → the explicit
  `Visual overview: none - <reason>` line, never a silent omission;
  **User journeys**, **Manual tests**, **QA results**,
  and **Deploy notes** appear only when the change actually has branches,
  human-runnable flows, or deploy steps.
- Two additions specific to this skill's gated path: fold the **gate
  outcomes** (Socrates verdict, review passes used, build gate) into
  Verification, and seed **Residual risks** from the review findings you
  chose not to take.
- Apply `.references/tracker-lifecycle.md` to explicit tracker links from
  $ARGUMENTS or the conversation: `Closes #123` for completing GitHub issues,
  standalone `Fixes TEAM-123` for completing Linear issues, one line each.
- Create with `gh pr create` against the default branch, applying the
  Step 5 labels (and milestone, when the repo's conventions call for one).
  **YOU MUST** retrieve the persisted body, verify and repair its expected
  closing lines, and read it back before reporting and after later edits.

## Step 7: Report

Give the user the PR URL plus a one-paragraph recap: what's in it, what the
gates found and how it was resolved, how it was verified, and anything
unresolved.
