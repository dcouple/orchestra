# Discussion workflow contract

## Input

The idea, question, tradeoff, or suspected defect to discuss.

Have an interactive, opinionated discussion. The goal is shared clarity — understanding
the problem, weighing the options, or pinning down what's actually happening — not a
document. When the discussion converges on something worth building or fixing and no work
item exists, capture starts through the matching create workflow; this
workflow's job still ends at clarity.

## Conversation and research only — unless asked

Don't edit source files, propose diffs to apply, or write documents, specs, tickets,
or verification criteria unless the user explicitly asks for one mid-discussion.
Capture belongs to the create workflows. The one exception is Step 3's
decision log — a record of what was decided, not a deliverable.

## Steps

### 1. Dispatch the right specialist for each question
Delegate legwork to specialist roles so bulky exploration stays out of this thread. Pick by
what the user is actually asking:

- **How does our code work? What exists today?** → `code-researcher`
  (returns file:line findings).
- **What do the docs / ecosystem / other people do?** → the `web-researcher`
  role (returns a cited dossier). Reach for it whenever up-to-date
  information or outside opinions would sharpen the discussion — library
  versions, current best practice, how others solved this.
- **Why is this broken? Is this a bug?** → `investigator`
  (reproduces and root-causes, returns a finding with evidence and confidence).
  If reproduction requires driving the running app, dispatch `frontend-verifier`
  first to exercise the flow and capture evidence, then pass its transcript along
  with the defect report.

Only research what the discussion actually needs — let questions pull research, not
the other way around. Dispatch mid-conversation as new questions arise; run
independent dispatches in parallel.

The harness adapter owns dispatch and lifecycle syntax.

**Success criteria**: every claim you make about the codebase, ecosystem, or defect
traces to a specialist finding or user statement, not a guess.

### 2. Discuss and converge
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

### 3. Log the decisions, then hand off
When the discussion converges, write the decision log to
`./tmp/discussions/YYYY-MM-DD-<slug>.md`: the decisions made and why, the
direction chosen and over what alternatives, constraints the user stated,
open questions. A few lines each — dated and slugged so parallel
workstreams never collide. This is how intent survives past the
conversation: the create-workflow drafting step reads it, and anyone resuming
the thread starts from it instead of from memory.

When the discussion has converged on capturable work with no existing item, start capture
yourself: create-plan for a single-outcome change or create-epic for a multi-phase
workstream. Publish remains gated by the capture workflow's alignment pause. Otherwise, suggest
the relevant next steps:

```
Decision log: ./tmp/discussions/YYYY-MM-DD-<slug>.md

Suggested next steps:
- create-plan — capture a single-outcome change or investigated defect
- create-epic — capture a multi-phase workstream
- continue discussion — keep exploring a different aspect
```
