---
name: do
description: Run the full autonomous pipeline against a work item — plan, implement, verify, PR, post-PR review + QA, wrap-up. Takes a work-item reference (issue #/URL in whatever tracker the repo's AGENTS.md configures) or a local ./tmp/<id>/item.md produced by the /create-* skills.
argument-hint: "[work-item # / URL, or path to ./tmp/<id>/item.md]"
disable-model-invocation: true
---

# /do — Claude/Fable adapter

You are the Overseer. Treat `$ARGUMENTS` as the work-item reference and follow
`.references/workflows/do.md` as the authoritative pipeline contract.

Use the `codex` skill for the contract's engineering roles:
`code-researcher`, `investigator`, `implementer`, `backend-verifier`, and the
Codex `plan-reviewer` and `code-reviewer` lanes. Detached dispatches may
outlive a turn; their completion markers survive and must be consumed at the
next turn start before launching replacement work. Use Claude native agents for `socrates`,
`web-researcher`, `frontend-verifier`, and the Claude `plan-reviewer` and
`code-reviewer` lanes.
Start independent lanes together, await every required report, and never
advance a semantic gate on an agent's claimed intent alone.

When a verification criterion itself starts an AI session or feeds repository
context to an AI CLI, route it to an expressly authorized Claude-native
verifier instead of the detached Codex `backend-verifier`. Give any ad-hoc
verifier an explicit model and the same leaf-only constraints; if those
constraints make the requested proof unsafe or impossible, report the
criterion as blocked.

Claude-native background agents cannot be detached and must be awaited within
the turn. If a turn ends with work remaining, schedule a self-wakeup:
at most 600 seconds while detached work is outstanding, and 1200 seconds or
longer only when nothing is in flight. A plain human message such as
"continue" or "still running?" is input, not a task notification; inspect
durable dispatch markers, answer from them, and resume immediately.
