---
name: codex
description: Dispatches one Codex (GPT-5.6) sub-agent via `codex exec` — implementer, backend-verifier, plan-reviewer, code-reviewer, code-researcher, or investigator — and returns its report. Used by /do, /discussion, and /create-plan whenever one of these roles runs; not normally invoked by the user directly. Use when a pipeline stage needs its Codex sub-agent dispatched, resumed for a fix round, or re-run.
argument-hint: "[role] [inputs: item/plan paths, question, pass number]"
---

# Dispatch a Codex sub-agent

## Dispatch: $ARGUMENTS

Run one Codex sub-agent non-interactively and hand its report back to the
caller. One dispatch = one role + its inputs. Codex is the OpenAI coding
agent CLI; each dispatch is a fresh GPT-5.6 session that knows nothing about
this conversation — the prompt must carry everything the role needs.

## Role table

| Role | Model / effort | Sandbox | Session |
| --- | --- | --- | --- |
| `implementer` | `gpt-5.6-sol` / `medium` | `--yolo` | persistent — resume for fix rounds |
| `backend-verifier` | `gpt-5.6-sol` / `low` | `--yolo` | `--ephemeral` |
| `plan-reviewer` | `gpt-5.6-sol` / `low` | `--yolo` | `--ephemeral` |
| `code-reviewer` | `gpt-5.6-sol` / `low` | `--yolo` | `--ephemeral` |
| `code-researcher` | `gpt-5.6-sol` / `low` | `--yolo` | `--ephemeral` |
| `investigator` | `gpt-5.6-sol` / `low` | `--yolo` | `--ephemeral` |

Efforts are defaults: `medium` for the implementer, `low` for every other role. The dispatcher may raise a reviewer to `medium` or
`high` — rarely, when the zone warrants it (zone 0, or an epic), with the
reason stated in the dispatch; never above `high`, never by default. The investigator and
backend-verifier act on the environment (tests, scripts, app boots), but
their charters forbid editing project files.

**Approvals must never gate a pipeline dispatch.** Every role runs with
`--yolo` (`--dangerously-bypass-approvals-and-sandbox`) — the run is
unattended, and an approval prompt or approval-layer refusal mid-flight burns
the dispatch. The operator authorizes this via the /do preflight harness
check. Reviewer/researcher dispatches are still no-edit by charter (see
Rules: one that edited files is a failed run) — the guarantee is the charter
plus a diff check. The `implementer` role covers
every surface — backend/ops and frontend web/mobile alike, one effort
(`medium`), one session per slice.

## Steps

### 1. Build the prompt
Every prompt names the role instructions and output format by absolute path —
Codex reads them itself:

```
You are acting as the <role> in an automated software-development pipeline
conducted by the Overseer, a separate orchestrating agent. You are a
sub-agent — a leaf of this pipeline: never spawn further agents or invoke
agent CLIs (`codex exec`, `claude`, or any equivalent) — do the work in
this session yourself and print your report. Your report is
consumed by the Overseer, not by a human. <omit for the implementer, whose
work product is the diff and the updated plan.md: It is the sole evidence
the Overseer acts on; what you miss, the pipeline misses.>

First read these two files:
1. Your role instructions: <instructions path per the mapping below>.
2. Your output format: <format path per the mapping below> — your
   final message must follow it exactly.

Inputs for this run:
- work item: <item path>
- plan: <plan path, if the role uses one>
- question / defect report: <for code-researcher / investigator>
- review pass: <k>/<cap> <reviewers only — the dispatch states the resolved cap; /do derives it from the run's zone>
- prior findings by ID: <reviewers, pass 2+> / fix instructions: <implementer fix rounds>

Print the report as your final message, in exactly the specified format.
```

Role instructions: Codex-only roles (implementer, investigator,
backend-verifier) → `.references/agents/<role>/instructions.md` · roles
with a Claude twin (code-researcher, plan-reviewer, code-reviewer) →
`.claude/agents/<role>.md` (tell Codex to follow the body and ignore the
YAML frontmatter — it applies to a different harness).

Format files, under `.references/agents/<role>/`: implementer →
`implementation-result.md` · plan-reviewer / code-reviewer →
`review-report.md` · code-researcher → `codebase-findings.md` ·
investigator → `root-cause-finding.md` · backend-verifier →
`../frontend-verifier/verification-result.md` (shared verifier format,
verify mode).

**Path resolution**: all paths are relative to the current repo root —
`.references/` and `.claude/agents/` are synced into every consumer repo
from `dcouple/orchestra`. Confirm both files exist before dispatching — a
role that can't read its instructions improvises instead of failing.

**Success criteria**: prompt carries the role, both file paths (resolved
per the rule above, existence checked), and every input the role needs —
nothing assumed from this conversation.

### 2. Execute
Run every dispatch as a background Bash call from the repo root. The watchdog
is the dispatch's wall-clock bound. Use a 900-second cap for `--ephemeral`
roles and a 2700-second cap for the implementer. Redirect stdin because Codex
can read an open idle stdin pipe and hang even when given a positional prompt.

```bash
# cap: 900 for --ephemeral roles, 2700 for the implementer
perl -e 'alarm shift; exec @ARGV' <cap> \
  codex exec -m gpt-5.6-sol -c model_reasoning_effort="<effort>" --yolo \
  [--ephemeral] --skip-git-repo-check -C <repo root> \
  -o <scratchpad>/codex-<role>-<n>.md "<prompt>" </dev/null
```

For an implementer fix round, keep its session context:

```bash
perl -e 'alarm shift; exec @ARGV' 2700 \
  codex exec resume --last -o <scratchpad>/codex-implementer-fix<k>.md \
  "<combined review findings + fix instructions>" </dev/null
```

Parallel dispatches (e.g. several code-researchers, or a reviewer alongside a
Claude sub-agent) are issued in the same message as the sibling dispatch. A
dual-lane review that does not issue the background calls together serializes
the lanes and doubles the pass's wall-clock.

**Success criteria**: exit 0 and the `-o` output file exists and is non-empty.
Exit 142 is the watchdog's SIGALRM reap signature: it is a classified failure,
not a success, and step 3 handles it.

### 3. Return the report
Read the output file. Check the status line the format requires (reviewers:
`**Verdict:**` + `**Counts:**` with the Must Fix count — a reviewer report
that arrives tiered P0–P3 instead is a valid report, not a failed run:
P0/P1 ≡ Must Fix, P2 ≡ Should Fix, P3 ≡ Nice to Have; map the tiers,
synthesize the status line from the mapped counts yourself, and never
burn a retry or re-dispatch over format · implementer:
`**Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT` ·
code-researcher: `**Bottom line:**` · investigator: `**Root cause:**` with a
confidence word · backend-verifier: `**Verdict:**` pass|fail). Capture the
token usage `codex exec` prints in its end-of-run summary — for a background
dispatch it's in the task's stdout output file (the line after `tokens used`);
per-turn detail lives in `~/.codex/sessions/<date>/rollout-*.jsonl`
`token_count` events. `unknown` is only legal after checking both. Return the
report verbatim to the caller, prefixed with one line:
`CODEX <role>: <status line> · tokens <n | unknown>` — the Overseer sums
these per role into the wrap-up's run record.

Exit 142 (a SIGALRM watchdog reap) classifies the dispatch as a hung run. Retry
a hung, errored, timed-out, or status-line-missing run once: make a fresh
dispatch for an ephemeral role, or use `resume --last` for the implementer so
its session context survives. After that retry, return the error plus whatever
output exists to the caller.

**Success criteria**: caller received a well-formed report (or the error
after one retry).

## Rules

- One dispatch, one role — never batch two roles into one Codex session.
- Every dispatch prompt carries the leaf-agent line from the template (you
  are a sub-agent; never spawn agents or invoke agent CLIs). A sub-agent
  that doesn't know it's a sub-agent can recursively spawn agent sessions —
  `--yolo` gives it the shell to do it. A report showing the run invoked
  `codex exec` or `claude` is a failed run; treat its output as suspect.
- Never describe the artifact under review as verified, tested, correct, or
  previously approved in a reviewer dispatch. Re-review dispatches present
  prior findings as claimed fixed, to be verified.
- Reviewer and researcher dispatches are read-only: one that edited files is
  a failed run, treat its output as suspect.
- Don't launch a second implementer session while one is resumable —
  `resume --last` preserves its context across fix rounds.
