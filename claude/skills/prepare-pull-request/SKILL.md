---
name: prepare-pull-request
description: Take ad-hoc changes made in-session (outside /do) to a pull request — gate them through Socrates (right approach?) and the PR reviewers (correct?), then commit, push, and open the PR in the repo's standard format. /do handles its own PR prep; this skill is for everything else.
argument-hint: "[optional: issue # to close, or extra context for the PR body]"
disable-model-invocation: true
---

# Prepare Pull Request

## Context: $ARGUMENTS

Changes made ad-hoc in a session were never planned, reviewed, or verified
the way `/do` output is — this skill closes that gap before anything goes
up. Two gates run before the PR: **Socrates** challenges whether the
approach was right at all, then the **PR reviewers** check that the code is
correct. Socrates runs first because a `rethink` verdict invalidates any
line-level review that ran before it; the reverse is not true.

You are the Overseer. PR conventions (labels, title format, required body
sections, milestones) are the repo's to define: read the project's root
`AGENTS.md` and any contributing/PR docs it names before creating the PR.
Where the repo documents nothing, the defaults below apply. Tracker links and
PR closing lines follow `.references/tracker-lifecycle.md`; this skill does not
run `/do`'s readiness or status lifecycle and does not prompt for tracker auth.

## Step 1: Preflight

- Never work on the default branch. If on it, stop and ask the user to set
  up a branch — don't create one silently.
- Review `git status` and `git diff` so the gates and the PR describe what
  actually changed, not what you remember changing. If the working tree
  contains files you didn't produce this session, confirm with the user
  which changes belong in this PR.
- Materialize the review artifacts under `./tmp/pr-<branch>/`:
  - `intent.md` — the problem being solved, why this approach was chosen,
    what alternatives were considered or rejected in the session, and what
    "done" means. Written for a reader who wasn't in the session; this is
    what Socrates interrogates.
  - `diff.patch` — the full diff of the candidate changes.

## Step 2: Socrates gate (right approach?)

Dispatch the `socrates` agent with the round number, the paths to
`intent.md` and `diff.patch`, and the contents of this skill's
`references/socratic-pr-gate.md` — it adapts his standard challenge to a
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
Must-Fix gate is the union of both reports.

- Fix Must-Fix findings yourself (these are your own session's changes —
  there is no separate implementer), then re-run both reviewers on the
  updated diff. Cap 3 passes.
- Must-Fix findings still open at the cap: stop and put them to the user —
  don't open the PR with known critical issues.
- Non-blocking findings you chose not to take: note them for the PR body's
  Residual risks.
- **Build gate**: discover the project's own build/typecheck/lint workflow
  (the `Commands` section of its `AGENTS.md`, `package.json` scripts,
  Makefile, CI config — ask the repo, don't assume) and run it over the
  touched surfaces. Failures are must-fix before the PR opens.

## Step 4: Commit and push

- Stage selectively — only the files that belong to this change, never
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
- Write the body following the `/do` skill's `references/pr-body.md` — the
  single source for the section spine, the body-state / comment-proof split,
  and the pre-open checklist. Right-size to an ad-hoc change:
  **Summary** (from the final `intent.md`), **Verification**, and **Residual
  risks** are usually the whole body; **Visual overview** follows
  pr-body.md's requirement — user-visible change → before/after captures,
  flow-shaped change → rendered diagram (keep its `.excalidraw` source in
  `./tmp/pr-<branch>/`), neither → the explicit
  `Visual overview: none — <reason>` line, never a silent omission;
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
