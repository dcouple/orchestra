---
name: codex
description: "Dispatch or resume one Codex role when a workflow needs an implementation, research, review, or verification report."
argument-hint: "[role] [inputs: item/plan paths, question, pass number]"
---

# Dispatch a Codex sub-agent

## Dispatch: $ARGUMENTS

Run one Codex sub-agent non-interactively and hand its report back to the
caller. One dispatch = one role + its inputs. Codex is the OpenAI coding
agent CLI; each dispatch is a fresh GPT-5.6 session that knows nothing about
this conversation - the prompt must carry everything the role needs.

## Role table

| Role | Model / effort | Sandbox | Session |
| --- | --- | --- | --- |
| `implementer` | `gpt-5.6-sol` / `medium` | `--yolo` | persistent - resume for fix rounds |
| `backend-verifier` | `gpt-5.6-sol` / `low` | `--yolo` | `--ephemeral` |
| `plan-reviewer` | `gpt-5.6-sol` / `low` | `--yolo` | `--ephemeral` |
| `code-reviewer` | `gpt-5.6-sol` / `low` | `--yolo` | `--ephemeral` |
| `code-researcher` | `gpt-5.6-sol` / `low` | `--yolo` | `--ephemeral` |
| `investigator` | `gpt-5.6-sol` / `low` | `--yolo` | `--ephemeral` |

Efforts are defaults: `medium` for the implementer and the refactor roles, `low` for every other role. The dispatcher may raise a reviewer to `medium` or
`high` - rarely, when the zone warrants it (zone 0, or a multi-phase item), with the
reason stated in the dispatch; never above `high`, never by default. The investigator and
backend-verifier act on the environment (tests, scripts, app boots), but
their charters forbid editing project files.

The table describes the configured unattended CLI deployment. Use `--yolo`
only where the operator and active harness permit it; a skill does not grant
permission to bypass a denial. Reviewers and researchers remain read-only by
charter, verified against the diff. The implementer owns the entire assigned
vertical slice and resumes the same session for fixes.

## Dispatch procedure

Read [dispatch mechanics](references/dispatch.md) when launching, resuming,
or collecting a role. It owns prompt construction, literal-path cleanup
(including `.otel.json`), detached launch, timeout, and the single retry.
Only load the selected role's instructions and report format. Return the role's
report with its status and token usage; a launch acknowledgment is not completion.

## Rules

- One dispatch, one role - never batch two roles into one Codex session.
- Every dispatch prompt carries the leaf-agent line from the template (you
  are a sub-agent; never spawn agents or invoke agent CLIs). A sub-agent
  that doesn't know it's a sub-agent can recursively spawn agent sessions -
  `--yolo` gives it the shell to do it. A report showing the run invoked
  `codex exec` or `claude` is a failed run; treat its output as suspect.
- Never describe the artifact under review as verified, tested, correct, or
  previously approved in a reviewer dispatch. Re-review dispatches present
  prior findings as claimed fixed, to be verified.
- Reviewer and researcher dispatches are read-only: one that edited files is
  a failed run, treat its output as suspect.
- Don't launch a second implementer session while one is resumable -
  `resume --last` preserves its context across fix rounds.
