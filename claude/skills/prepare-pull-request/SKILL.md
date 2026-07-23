---
name: prepare-pull-request
description: Take ad-hoc changes made in-session (outside /do) to a pull request — gate them through Socrates (right approach?) and the PR reviewers (correct?), then commit, push, and open the PR in the repo's standard format. /do handles its own PR prep; this skill is for everything else.
argument-hint: "[optional: issue # to close, or extra context for the PR body]"
disable-model-invocation: true
---

# Prepare Pull Request — Claude adapter

Treat `$ARGUMENTS` as tracker or pull-request context. Follow
`.references/workflows/prepare-pull-request.md` as the authoritative semantic
contract.

Run the Claude native `socrates` gate first. Then start the Claude
`code-reviewer` and detached Codex `code-reviewer` lanes together and await
both reports. Preserve the detached pickup lifecycle across turns. Use the
shared PR body and Socratic gate assets under
`.references/workflows/formats-and-assets/`.
