# Linear agent sessions - shared contract

Used by `/linear-work-orchestrator`. What the Linear agent daemon's sessions
look like from inside Linear, what each action on them costs, and how to read
their state through the Linear MCP alone. Agent display names come from the
consumer repo's `AGENTS.md` (`linear_agents:` under `Work-item tracking`) or
are derived from the workspace's app users; `<planner>` and `<implementer>`
below stand for those names.

## How work starts and resumes

- **Start**: set the issue's `delegate` to the agent (`save_issue` with
  `delegate: <planner|implementer>`). The human stays `assignee`. Linear opens
  an agent session; the daemon acknowledges it and queues one turn. The
  `delegate` field persists after the session ends, so it **never indicates
  that anything is running**.
- **Resume / steer**: reply in the session's thread (`save_comment` with
  `parentId` = the thread's root comment id). The reply text is delivered to
  the resumed Claude session verbatim - for an implementer session it lands
  inside the running `/do` Overseer, so write it as an instruction to that
  agent, not as a note to a human.
- **A fresh session on an already-delegated issue**: re-setting the same
  `delegate` is a no-op. Clear it (`delegate: null`), read back, set it again;
  or @-mention the agent in a new top-level comment. Prefer resuming the
  existing thread whenever it exists - the daemon reuses the issue's worktree
  and branch `agents/<identifier>` either way.
- **Stop**: only from the Linear UI (the session's Stop control). No MCP tool
  sends the stop signal. A stopped session answers
  `Stopped at your request. Send a follow-up message to continue.` and can be
  resumed by a reply.
- A **planner** session is a resumable discussion in the issue's worktree; it
  publishes a brief only when told to (`/create-brief`), and publishing
  creates a **new** issue carrying the brief metadata - it does not rewrite
  the discussion issue. An **implementer** session runs `/do <identifier>`
  once, unattended, to an opened PR; every later reply resumes that same
  `/do` session.

## What a session looks like in the issue's comments

Linear creates one top-level comment per session, authored by the "Linear"
system user:

```
This thread is for an agent session with <agent display name>.
```

The display name in that sentence is which agent the session belongs to.

Everything durable the agent says appears as **replies in that thread**
(`parentId` = the root comment). Human prompts to the session are replies in
the same thread. `list_comments` on the issue returns the flat set; group by
`parentId`, and treat the newest root carrying that sentence as the session
that matters; other top-level comments - a human's note, an orchestrator's
own - are roots too, and none of them is a session.

Only two activity kinds are durable: the agent's **response** (its reply, a
question, the `/do` final report) and its **error**. Thoughts, tool actions,
the pickup ack, turn-start banners, keepalives and worktree-cleanup notes are
posted ephemeral and are not readable through the MCP - a session that has
been running for an hour can look identical to one that is queued and has not
started. **Both are "busy".**

Daemon strings that do appear as replies, exact:

| Reply text | Meaning |
|---|---|
| `Planner turn failed: <detail>` / `Implementer turn failed: <detail>` | The turn ended in error. `<detail>` classifies it (table below). |
| `Stopped at your request. Send a follow-up message to continue.` | A human pressed Stop; nothing is running; a reply resumes. |
| `Turn completed without reply text - ` (match this prefix; the rest names the turn, model, `subtype=` and token count) | The run finished but its output was lost - a daemon defect. Treat as failed; escalate to the daemon operator. `subtype=` is the one place a budget or turn ceiling is named. |
| A reply containing `was interrupted` (three restart-recovery notices) | Nothing is running. The notice says what revives it: "prompt again" → a reply resumes; "Assign … again" → clear and re-set the delegate; "hard restart" → a human reviews the worktree state first. All three are spend decisions. |
| Anything else from the agent | Its response: the planner's analysis or question, or the implementer's `/do` report. |

An opened PR is attached to the **session** as an external URL labelled
`Pull Request`, extracted by the daemon from the `/do` report text - a
report with no PR link yields no external URL either; the daemon does not
attach it to the issue.

### Failure classification

| `<detail>` contains | Class | Do |
|---|---|---|
| `capacity failure`, `rate_limit` | provider capacity | Wait; do not resume this sweep. Two or more within about ten minutes of each other, the newest inside the implementer stale horizon = incident; older clusters are single failures. |
| `spawn … ENOENT`, `exited with code` **on two or more issues within about ten minutes of each other, the newest inside the implementer stale horizon** | daemon/host incident | Halt admissions, resume nothing, escalate to the daemon operator with the issue list and timestamps. Older matching failures are single failures. |
| `exited with code <n>` on one issue | crash **or** the `/do` budget/turn ceiling - Linear cannot tell them apart | Human decides: resume (a reply gives the run a fresh ceiling and spends again) or stop. |
| `permission`, `denied` | the session hit a harness gate | Human decides; usually a daemon config matter. |
| `is not configured` | a launcher is missing on the host | Daemon operator; nothing on this issue will run until fixed. |
| anything else (`exited on <signal>`, `exited without a result`, unknown text) | single failure | Human decides, as for `exited with code`. |

Two or more failures of one class on two or more issues within about ten
minutes of each other, the newest inside the implementer stale horizon, is an
incident whatever the class; older clusters are single failures.

## Reading session state from thread shape

Per issue, take the newest session thread and its last message:

| Last message in the thread | State | Counts as a slot |
|---|---|---|
| root only, no agent reply yet, younger than the stale horizon | busy (queued or running) | yes |
| a human reply, younger than the stale horizon | busy (a turn is queued or running) | yes |
| an agent response that asks something or reports a gate | waiting on a human | no |
| an agent response that is a completed report (planner analysis, `/do` report) | idle | no |
| an agent progress note - neither a question nor a completed report ("standing by on the researcher", "Phase 1 is now implementing") - younger than the stale horizon | busy (the run continues; only its durable output is visible) | yes |
| the same progress note **older** than the stale horizon | stalled - nothing survives a daemon restart past the horizon; treat as stale | no; report it |
| `… turn failed: …` | failed | no |
| `Stopped at your request …` | stopped | no |
| a `was interrupted` restart-recovery notice | interrupted - revive per the notice, with a human's yes | no |
| root or human reply **older** than the stale horizon with no agent reply | stale - the daemon may have restarted or the reply was dropped | no; report it - unless an older thread on the same issue is itself busy, in which case that one holds the slot |

Stale horizons come from `AGENTS.md` (`linear_agents.stale_hours`), else
implementer 6 hours, planner 2 hours; measure from the last message's
timestamp. The daemon emits a keepalive only when it has been silent for its
`KEEPALIVE_MS` (default 15 minutes), and that keepalive is ephemeral - so
silence in the thread is not evidence of death inside the horizon.

## What every action costs

- **Every turn shares one global cap.** The daemon runs at most
  `SESSION_CONCURRENCY` turns at once (default 5), counting new sessions and
  replies alike, planner and implementer alike. There is no per-agent cap.
- **FIFO by arrival among eligible turns, serialized per issue.** The daemon
  starts the oldest pending turn whose issue has nothing running or pending
  ahead of it; two turns on the same issue never overlap (a planner turn and
  an implementer turn on one issue queue behind each other and share one
  worktree). So send order is run order across issues, but a reply queued
  behind a running turn on its own issue waits for that issue while later
  turns on other issues start.
- **A queued turn never expires and cannot be reordered** from Linear. The
  only way out of the queue is Stop from the UI, which marks every pending
  turn of that session interrupted and aborts its running turn too - a
  human's action, session-wide, never partial.
- **A reply to a running session queues behind it** and takes a slot when it
  runs. A reply to an idle session takes a slot immediately.
- **Implementer replies sent while the daemon is down are lost**; planner
  replies are re-synthesized by the daemon's periodic reconcile poll, for
  sessions active within roughly the last six hours. If a reply produced nothing past the stale
  horizon, that is the first hypothesis.
- **An implementer resume spends again**: the resumed child gets a fresh
  `DO_MAX_TURNS` / `DO_MAX_BUDGET_USD` allowance.
- **Any daemon operation in flight (restart, config, update) pauses all turn
  claims** while webhooks keep queueing. A workspace where nothing starts for
  a while may be an operator mid-deploy, not a fault.

## Status and cleanup

- The daemon never changes an issue's workflow status, assignee, or labels.
- `/do` inside an implementer session moves the item's `completes` issues to
  the team's `In Review` before human handoff and moves merged-PR issues to
  `Done` at end-of-run hygiene, exactly per `.references/tracker-lifecycle.md`.
- Moving an issue to any `completed`-type status makes the daemon delete the
  issue's worktree and `agents/<identifier>` branch **only when the worktree
  is clean and every commit is on origin**; otherwise it retains them and
  says so ephemerally. A `canceled`-type status does nothing on the daemon -
  the worktree stays until an operator removes it.

## Fallback when the MCP lacks a tool

The Linear MCP exposes no agent-session or activity reads and no stop. When
a session's ephemeral activity or its external URLs are genuinely needed -
which the orchestrator's decisions are designed not to require - query the
Linear GraphQL API (`agentSession(id)` → `activities`, `externalUrls`) with a
`LINEAR_API_KEY` read from the environment - never pasted into the
conversation or written to Linear; without one, say so and decide from the
thread shape.
