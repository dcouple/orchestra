---
name: discussion
description: Interactive back-and-forth to clarify, understand, or figure something out — an idea, an approach, a tradeoff, or a suspected bug. Use when the user wants to think out loud or explore before committing to anything — e.g. "let's discuss X", "help me understand Y", "why is Z happening", "what should we do about W". Produces clarity plus a dated decision log, not deliverables; work items are created afterward with /create-plan or /create-epic.
argument-hint: "[idea, question, or topic]"
---

# Discussion

## Topic: $ARGUMENTS

Have an interactive, opinionated discussion. The goal is shared clarity — understanding
the problem, weighing the options, or pinning down what's actually happening — not a
document. When the discussion converges on something worth building or fixing, the user
invokes the matching `/create-*` skill; this skill's job ends at clarity.

## Conversation and research only — unless asked

Don't edit source files, propose diffs to apply, or write documents, specs, tickets,
or verification criteria unless the user explicitly asks for one mid-discussion.
Capture belongs to the `/create-*` skills. The one exception is Step 4's
decision log — a record of what was decided, not a deliverable.

## Steps

### 1. Dispatch the right specialist for each question
Delegate legwork to sub-agents so bulky exploration stays out of this thread. Pick by
what the user is actually asking:

- **How does our code work? What exists today?** → the `codex` skill, role
  `code-researcher` (returns file:line findings).
- **What do the docs / ecosystem / other people do?** → the `web-researcher`
  sub-agent (returns a cited dossier). Reach for it whenever up-to-date
  information or outside opinions would sharpen the discussion — library
  versions, current best practice, how others solved this.
- **Why is this broken? Is this a bug?** → the `codex` skill, role `investigator`
  (reproduces and root-causes, returns a finding with evidence and confidence).
  If reproduction requires driving the running app, dispatch `frontend-verifier`
  first to exercise the flow and capture evidence, then pass its transcript along
  with the defect report.

Only research what the discussion actually needs — let questions pull research, not
the other way around. Dispatch mid-conversation as new questions arise; run
independent dispatches in parallel.

**Success criteria**: every claim you make about the codebase, ecosystem, or defect
traces to a sub-agent finding or user statement, not a guess.

### 2. Keep a second voice in the thread
Every discussion can consult two models instead of one. At the first genuine
fork — competing approaches, a judgment call, a premise worth stress-testing —
or whenever the user asks for a second opinion, spawn the `discussant`
sub-agent (one per discussion) and keep it alive for the whole conversation:
continue the **same agent** via `SendMessage` each round, never a fresh spawn.
**Always dispatch it in the background** — the discussion never pauses on the
second voice: keep talking, and weave its reply in attributed when it
arrives. A discussion visibly waiting on a sub-agent is a bug. If a dispatch
fails (model overloaded, transient API error), resume the same agent once
via `SendMessage`; if it fails again, say so and continue single-voice —
the second voice degrades gracefully, it never blocks the conversation.
It runs on Fable, so under a proxied session the discussion pairs two
different models; in a native session it's a fresh-context adversary either
way.

**The briefing contract — load-bearing.** The discussant sees nothing of this
thread; it knows only what your messages carry (plus its own memory of prior
briefs). Every message to it is a self-contained delta brief:

- where the discussion stands now, and what changed since the last brief;
- the exact file paths it should read before opining (it has Read/Grep/Glob);
- any finding, constraint, or user statement the question depends on;
- the specific question or position to challenge.

Never reference conversation it hasn't been sent — if its reply shows a gap,
the fix is a fuller brief, not a re-spawn. Before a decision locks, send the
complete final picture for one closing challenge.

Relay its replies inline and attributed (e.g. **Discussant:** …), and push
back on it when you disagree — the point is two independent positions in
front of the user, who arbitrates. Don't route research legwork to it; that's
Step 1's specialists.

**Success criteria**: any decision the discussion locks was challenged by the
discussant against the full, current picture — or the user declined the
second voice.

### 3. Discuss and converge
- Present findings and options with tradeoffs; be opinionated — recommend with
  reasoning, defer to user judgment.
- **Validate, never guess.** A checkable fact (what the code does, what a tool
  supports, what a doc says) gets checked — Step 1's specialists or a direct
  look — before it shapes a decision; state what was validated vs what remains
  assumption. Where a choice hinges on an intangible — the user's risk
  appetite, priorities, taste — ask the user; never substitute an assumption
  for their answer.
- Name disagreements and unresolved choices instead of papering over them.
- Keep altitude: decisions and direction, not file-by-file detail.

**Success criteria**: the user says the question is answered, the direction is clear,
or they're ready to capture a work item.

### 4. Log the decisions, then hand off
When the discussion converges, write the decision log to
`./tmp/discussions/YYYY-MM-DD-<slug>.md`: the decisions made and why, the
direction chosen and over what alternatives, constraints the user stated,
open questions. A few lines each — dated and slugged so parallel
workstreams never collide. This is how intent survives past the
conversation: the `/create-*` drafting step reads it, and anyone resuming
the thread starts from it instead of from memory.

Then point at the capture skill — don't run it yourself unless the user asks:

```
Decision log: ./tmp/discussions/YYYY-MM-DD-<slug>.md

Suggested next steps:
- `/create-plan [title]` — capture a single-outcome change as a Feature Ticket, or a defect (investigated here) as a Bug Report
- `/create-epic [title]` — capture a multi-phase workstream as an Epic Spec
- `/discussion [follow-up]` — keep exploring a different aspect
```
