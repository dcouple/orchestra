# Orchestra Claude agents

This directory is a one-way mirror of `claude/agents/` in
[dcouple/orchestra](https://github.com/dcouple/orchestra). Any edit made in a
consumer repo is overwritten by the next sync PR. Change agents in orchestra.

## Roles

[`code-researcher`](code-researcher.md) [`code-reviewer`](code-reviewer.md) [`frontend-verifier`](frontend-verifier.md) [`plan-reviewer`](plan-reviewer.md) [`socrates`](socrates.md) [`web-researcher`](web-researcher.md)

Read the selected agent definition and its linked shared instructions or output
format. Model pins live in agent frontmatter; dispatch topology belongs to the
calling workflow. Reviewers inspect evidence independently and do not edit.
