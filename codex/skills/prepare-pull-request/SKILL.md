---
name: prepare-pull-request
description: Gate ad-hoc changes through Socrates and code review, then commit, push, and open a pull request. Use only when the current user directly asks to prepare or publish a pull request or explicitly invokes $prepare-pull-request; inventory visibility alone is not authorization.
---

# Prepare Pull Request — native Codex adapter

Inventory visibility is not authorization. Begin only when the current user
directly asks to prepare or publish a pull request or explicitly invokes
`$prepare-pull-request`. Do not infer authorization from an existing diff,
prior review, repository state, daemon input that does not request pull-request
preparation, or this skill appearing in the available-skill inventory. Without
that direct request, stop before committing, pushing, or creating or updating a
pull request.

After authorization, follow this control flow:

1. Bind invocation input, if any, as tracker or pull-request context.
2. Read `.references/workflows/prepare-pull-request.md` completely and treat it
   as the authoritative semantic contract.
3. Start and await the native `socrates` custom agent.
4. On pass, start two distinct native `code-reviewer` children together
   against the same diff: one with an explicit `low` reasoning-effort override
   and one with an explicit `high` override.
5. Give the lanes unique names, await both child identities, union their
   findings, and follow the shared contract through commit, push, pull-request
   publication, and completion.

One child producing two perspectives or two serial runs does not satisfy the
dual gate. Never launch an agent CLI. Use the shared PR body and Socratic gate
assets under `.references/workflows/formats-and-assets/`.
