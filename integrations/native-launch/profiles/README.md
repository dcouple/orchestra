# Workflow profiles

Install these profile YAML files into `~/.config/orchestra/profiles/` and the
sibling `../agents/` directories into `~/.config/orchestra/agents/`. The local
development Mac already has these definitions and their selected skills.

| Profile | Agent | Harness/model | Reasoning | Speed |
| --- | --- | --- | --- | --- |
| planner | planner | Claude Fable 5.1 | high | Native default |
| astra-planner | planner | Codex Astra | high | Native default |
| implementer | implementer | Codex Astra | medium | fast |
| codex-issue-creator | planner | Codex Astra | high | Native default |
| codex-implementer | implementer | Codex Astra | high | Native default |

The last two preserve the earlier entry-point names and model defaults while
using the complete agent graph.

```sh
orchestra run planner --workspace keycard --directory /absolute/path/to/repo
orchestra run astra-planner --workspace keycard --directory /absolute/path/to/repo
orchestra run implementer --workspace keycard --directory /absolute/path/to/repo
```

Omit `--directory` to use the current directory. Add `--explain` to inspect the
generated command without a model turn, or `--message 'your task'` to start
immediately. Otherwise the native TUI waits for input. `orchestra agent` remains
an alias for `orchestra run`. Model access and Fast eligibility depend on the
native account. Workspace MCP endpoints reuse native authentication.

## Definitions and instructions

```text
profiles/planner.yaml
agents/planner/agent.yaml
agents/planner/instructions.md
instructions/shared/evidence.md
skills/create-ticket/SKILL.md
workspaces/keycard.yaml
```

A profile references an agent (`agent: planner`) and may override its harness,
model, skills, connections, or child map. Model blocks replace the whole default
block, including effort and speed. Other supplied fields also replace the
corresponding agent field. Profile instructions append to agent instructions.

Agent YAML owns configuration; Markdown owns prose. Set
`instructions_file: instructions.md` relative to the YAML file, or use ordered
composition:

```yaml
instructions_files:
  - ../../instructions/shared/evidence.md
  - instructions.md
```

Create each referenced file before using this example. Missing files fail;
paths must stay inside the central configuration root. Only one of
`instructions`, `instructions_file`, or `instructions_files` may be supplied in
a definition. Legacy inline instructions and `agents/<name>.yaml` remain valid.
Defining both the legacy file and a directory agent with the same name fails.
Markdown is composed literally; Jinja variables, conditions, and includes are
not rendered. Each generated node includes an inspectable `instructions.md`;
editing source instructions changes the bundle hash.

## Workflow roles

These definitions were checked against the installed `dcouple/skills` snapshot
`5b0f704cd8eabff98d53e1a4a57f0acb76fc39aa`. They preserve the workflow's gates,
required models, and publication rules; they do not execute every role on every
run.

| Workflow step | Native role | Selected skill/reference |
| --- | --- | --- |
| Ticket intent/premise review | socrates | create-ticket/references/socrates.md |
| Implementation and fixes | worker | implementer |
| Implementation verification/review | implementation-reviewer | implementation-reviewer |
| Plan review | plan-reviewer | plan-reviewer |
| Repository exploration | codebase-explorer | codebase-explorer |
| External research | researcher | researcher, research-web |
| PR preparation | pr-preparer | prepare-pr |
| PR review | pr-reviewer | review |
| Browser/frontend and backend/end-to-end QA | qa | pr-test-automation |
| Fresh-context artifact review | cold-reader | cold-read |

Both planners declare Socrates. The implementer declares all ten roles.
Astra implementation children use Luna Max except QA, which uses Sol Medium.
Claude planner Socrates uses Fable High; Astra planner Socrates uses Luna Max.
`cold-reader` must start with fresh context, never a resumed PR-review thread.

The Astra workflow does not invoke Orchestra `/do`'s separate
`frontend-verifier` and `backend-verifier` roles. Its `qa` role handles those
verification surfaces through `pr-test-automation`. They are not missing
Astra dependencies. Astra performs the final parent review itself.

## Native generation and limits

Child bindings reference an agent and can override `description`, `harness`,
and the complete `model` block. `mode: native` generates Claude CLI definitions
or Codex role TOML registrations. `mode: process` (the legacy default) generates
a headless launcher and supports cross-harness children without native resume.

Workspace and parent connections flow into children. Children can add endpoints;
conflicting names fail. Native Claude children currently require the same
connections as the parent. Native children must use the parent's harness and
cannot declare further children in this version. Leaf instructions prohibit
further delegation, but invocation budgets and hard delegation restrictions are
not implemented.

Children receive exact bundled skill paths in their prompts, with supporting
files copied. This is not an isolated skill/tool catalog: native global/project
skills and tools can remain visible. Native follow-ups use the harness lifecycle.

## Installing skills elsewhere

Copy selected skill trees with all support files from
`dcouple/skills` at the revision above, under `parsa/.codex/skills/<name>/`, into
central `skills/<name>/`. `review` instead comes from
`parsa/.claude/skills/review/` and includes `CRITERIA.md`.
The development Mac records source paths in
`~/.config/orchestra/codex-profile-provenance.json`.
Set up the workspace endpoint and native login on each machine independently.
Keycard connectivity does not itself establish Grain connectivity.
