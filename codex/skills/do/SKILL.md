---
name: do
description: Run the full autonomous pipeline against a work item - plan, implement, verify, PR, post-PR review + QA, and wrap-up.
argument-hint: "[work-item # / URL, or path to ./tmp/<id>/brief.html]"
disable-model-invocation: true
---

# /do - Codex entrypoint

## Work item: $ARGUMENTS

Run the canonical `/do` pipeline defined in
`.claude/skills/do/SKILL.md` for this work item. Read that file completely
before starting and follow its safety, artifact, verification, PR, and wrap-up
contracts.

This file is the Codex-specific entrypoint; the pipeline contract intentionally
has one canonical source so the Claude and Codex commands stay in lockstep.

When adapting the pipeline to this Codex session:

- Execute the orchestration in this session and use the Codex role skills in
  `codex/skills/` for research, implementation, verification, and review.
- Run a single Codex review/implementation lane. Do not use Claude's Agent
  tool or dispatch a Claude reviewer.
- Keep the same work-item artifacts, acceptance-criteria evidence, selective
  commit, rebase, PR-body, QA, and wrap-up requirements from the canonical
  skill.
- Treat the canonical skill's Claude-only app-driving verifier as unavailable
  unless an equivalent Codex/browser capability is explicitly available; mark
  that evidence honestly as deferred or unverified rather than claiming it
  passed.
- Preserve the canonical skill's action tiers: never perform production or
  irreversible actions, and surface any required human action explicitly.

If the canonical skill refers to a Claude-only dispatch mechanism, perform the
same phase directly in this session or with the matching Codex role skill,
while preserving its inputs, outputs, and evidence requirements.
