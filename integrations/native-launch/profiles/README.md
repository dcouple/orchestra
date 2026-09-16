# Workflow profiles

The current launchable profiles live in `~/.config/orchestra/profiles/`:

| Profile | Harness | Model | Reasoning | Speed |
| --- | --- | --- | --- | --- |
| `planner` | Claude Code | `claude-fable-5-1` | high | Harness default |
| `astra-planner` | Codex | `gpt-6-astra` | high | Harness default |
| `implementer` | Codex | `gpt-6-astra` | medium | fast |

Both planners select `create-ticket` and `explain-visually`. The implementer
selects the existing `astra-ticket` workflow and its supporting skills.

```sh
orchestra run planner --workspace keycard --directory /absolute/path/to/repo
orchestra run astra-planner --workspace keycard --directory /absolute/path/to/repo
orchestra run implementer --workspace keycard --directory /absolute/path/to/repo
```

Add `--explain` to inspect the generated launch command without starting a model
turn. Add `--message 'your task'` to start immediately. Otherwise the native TUI
waits for input. Model availability and Fast eligibility depend on your account.

Model configuration is explicit:

```yaml
harness: codex
model:
  name: gpt-6-astra
  reasoning: medium
  speed: fast
```

Claude reasoning becomes `--effort`; Codex reasoning becomes
`model_reasoning_effort`. Codex `speed: fast` sets `service_tier="fast"`;
`speed: standard` sets `service_tier="default"`. Omitted speed keeps the native
default. Claude speed is not supported by this launcher yet.

## Profiles and agents

`agents/` owns complete agent definitions: default harness, model, effort,
skills, instructions, connections, and child bindings. `profiles/` contains
launchable references with optional overrides:

```yaml
# profiles/planner.yaml
agent: planner
```

```yaml
# agents/planner.yaml (excerpt)
harness: claude
model:
  name: claude-fable-5-1
  reasoning: high
skills: [create-ticket, explain-visually]
subagents:
  socrates:
    agent: socrates
    mode: native
```

The Astra planner references this same agent and overrides the harness, model,
and Socrates binding. Profile model blocks replace the entire default model
block; they never inherit an old speed or effort. Profile instructions append
to the agent's instructions. Other supplied fields replace the corresponding
agent field, including lists and child maps. Omitted fields retain agent defaults.
A referenced agent must exist; profiles do not inherit from other profiles.

The planner declares Socrates. The implementer declares Socrates, worker,
implementation-reviewer, plan-reviewer, codebase-explorer, researcher,
pr-preparer, pr-reviewer, and QA. Implementation children use Luna Max except
QA, which uses Sol Medium, matching the installed Astra workflow. Socrates uses
Fable High for the Claude planner and Luna Max for the Astra planner.

A child binding can override its agent's `description`, `harness`, and complete
`model` block. `mode: native` generates a native Claude CLI agent definition or
Codex role TOML registration. Each child prompt identifies its exact bundled
skill files, including support files, for the child to read. This is not a
security boundary or an isolated native skill catalog. Native global/project
skills and tools can remain available. Native follow-ups use the harness's
existing agent lifecycle.

Workspace connections and parent agent connections flow into children. Child
connections can add endpoints; conflicting names fail. Native Claude children
currently require the same connections as the parent. Native children must use
the parent's harness and cannot themselves declare children in this version.
Leaf-role instructions prohibit further delegation, but this is not a hard
runtime restriction. Invocation budgets and permission isolation are not yet
implemented.

`mode: process` (the legacy default) generates a headless child launcher and
supports cross-harness children. It does not provide native follow-up/resume.
Root profiles resolve from `profiles/` first, with `agents/` as a legacy fallback.
Existing standalone profiles and `orchestra agent` commands continue to work.

On another machine, copy these three profiles plus the sibling `../agents/`
YAML files into your central configuration directory and install the skills and
workspace described below. The local development Mac already has these files.

Native configuration references:
[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
and [Claude subagents](https://code.claude.com/docs/en/sub-agents).

## Existing Codex identities

These profiles match the `dcouple/skills` workflows at revision
`5b0f704cd8eabff98d53e1a4a57f0acb76fc39aa`:

- `codex-issue-creator`: `$create-ticket` plus its `explain-visually` dependency.
- `codex-implementer`: `$astra-ticket` and the planning, implementation, PR,
  review and QA skills listed in its profile.

Both use Codex with GPT-6 Astra, high reasoning effort. The implementation
workflow verifies the actual parent model and requires Luna Max workers and
Sol Medium QA. Those requirements remain in the original skill; the profile
uses native Codex subagents rather than headless generated dispatch scripts.
It must stop if required native model/delegation capabilities are unavailable.

The profiles and 17 shared skill trees are installed on the development Mac in
`~/.config/orchestra/{agents,skills}`. The local `keycard` workspace supplies the
previously authenticated gateway. Secrets are not present in these profiles.
`~/.config/orchestra/codex-profile-provenance.json` records the installed source
revision and path for every skill.

After building/installing the TypeScript CLI as described in the parent README (already installed on this Mac):

```sh
orchestra agent codex-issue-creator \
  --workspace keycard --directory /absolute/path/to/repo

orchestra agent codex-implementer \
  --workspace keycard --directory /absolute/path/to/repo \
  --message 'Use $astra-ticket for owner/repo#123'
```

Omit `--message` to wait in the native TUI. Replace the example issue identifier
with the intended work item. Omit `--workspace keycard` for no workspace
connection additions; existing native global MCP registrations can still appear.
Follow the parent README's Git exclusion guidance for generated bundles.

On another machine, copy these YAML files into the central `agents/` directory
and copy each listed skill directory, including all support files, from
`parsa/.codex/skills/<name>/` at the revision above into `skills/<name>/`.
The exception is `review`, which comes from `parsa/.claude/skills/review/` and
includes `CRITERIA.md`. The implementation profile explicitly selects that
bundled copy instead of relying on a separately installed Claude skill.
Set up the workspace endpoint and native login independently on that machine.

Both installed profiles successfully compiled with Keycard into separate bundles
in the same scratch repository. This verifies configuration and file packaging,
not an end-to-end issue publication or implementation run. Grain access depends
on the user's connected native tools/CLI; Keycard availability alone does not
establish Grain access.
