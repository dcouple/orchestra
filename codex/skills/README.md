# Orchestra Codex skills

This directory is a one-way mirror of `codex/skills/` in
[dcouple/orchestra](https://github.com/dcouple/orchestra). Any edit made in a
consumer repo is overwritten by the next sync PR. Change skills in orchestra.

## Entrypoints

[`backend-verifier`](backend-verifier/SKILL.md) [`code-researcher`](code-researcher/SKILL.md) [`code-reviewer`](code-reviewer/SKILL.md) [`codex-security-scan`](codex-security-scan/SKILL.md) [`do`](do/SKILL.md) [`frontend-verifier`](frontend-verifier/SKILL.md) [`implementer`](implementer/SKILL.md) [`investigate`](investigate/SKILL.md) [`investigator`](investigator/SKILL.md) [`plan-reviewer`](plan-reviewer/SKILL.md) [`refactor-deep`](refactor-deep/SKILL.md) [`refactor-simple`](refactor-simple/SKILL.md) [`web-researcher`](web-researcher/SKILL.md)

`do/SKILL.md` routes to stage contracts under `do/references/`. Load
execution boundaries once, then the current stage and its conditional references.
Skill frontmatter and role instructions define this harness's routing; the
Claude and Codex entrypoints retain their own dispatch and QA procedures.
