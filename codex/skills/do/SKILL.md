---
name: do
description: Run the full autonomous pipeline against a work item using native Codex custom agents. Use only when the current user directly asks to execute a work item or explicitly invokes $do; inventory visibility alone is not authorization.
---

# $do — native Codex adapter

Inventory visibility is not authorization. Begin only when the current user
directly asks to execute a work item or explicitly invokes `$do`. Do not infer
authorization from the work item's existence, prior discussion, repository
state, daemon input that does not request execution, or this skill appearing in
the available-skill inventory. If the request does not identify a work item,
use the contract's no-input selection procedure; if it does not authorize
execution, stop without changing state.

After authorization, act as the Overseer and follow this control flow:

1. Bind the invocation input, if any, as the work-item reference.
2. Read `.references/workflows/do.md` completely and treat it as the
   authoritative semantic pipeline contract.
3. Route every delegated role to the matching native custom agent:
   `code-researcher`, `investigator`, `plan-reviewer`, `implementer`,
   `backend-verifier`, `code-reviewer`, `frontend-verifier`, `socrates`, or
   `web-researcher`.
4. Start independent lanes concurrently, record every child identity, await
   every required report, and do not advance a semantic gate until its children
   complete.
5. Apply the shared contract's completion, publication, notification, and
   cleanup requirements before returning.

Use only native collaboration tools; never launch `codex`, `claude`, or another
agent CLI. Children are leaves. Do not return while a native child is active:
use the collaboration wait mechanism, preserve every child identity in the run
record, and consume its report before launching replacement work.

When a verification criterion itself starts an AI session or feeds repository
context to an AI CLI, do not send it to `backend-verifier` and do not recurse
through an agent CLI. Treat it as blocked unless the run has an expressly
authorized non-recursive verifier lane.

Review routing is executable, not advisory:

- When the contract selects dual review, start two distinct children for the
  same review input and pass: one `plan-reviewer` or `code-reviewer` with an
  explicit `low` reasoning-effort override, and a second child of the same
  role with an explicit `high` override. Give them unique lane names, start
  them together, await both identities, and union their findings.
- When the contract selects single review, start one child using the role's
  default `low` effort unless the contract records a deliberate escalation.
- Never implement dual review by asking one child for two perspectives,
  running the lanes serially, or reusing one report for both lanes.
