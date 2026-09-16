# Configuration files

The central authoring directory is `~/.config/orchestra/`:

```text
profiles/
  planner.yaml                 CLI entry point: agent: planner
  astra-planner.yaml           CLI entry point: agent: astra-planner
  implementer.yaml             CLI entry point: agent: implementer
agents/
  planner.md                   Agent configuration + instruction body
  astra-planner.md
  implementer.md
  astra-socrates.md            Child agent, selected by a parent definition
skills/
  create-ticket/
    SKILL.md                   Shared skill description + workflow instructions
    metadata/
      codex.yaml               Codex UI metadata and invocation policy
    references/
      intent-handoff.md        Supporting guidance
      socrates.md              Shared premise-review rubric
workspaces/
  keycard.yaml                 Workspace MCP connections
instructions/                  Optional shared instruction includes
backups/                       Local migration backups, not active definitions
```

## Profiles

Each YAML file contains only `agent: <name>`. Profiles are launchable entry
points; they do not override model settings, tools, instructions, or children.
`orchestra run NAME` launches the complete identity. `orchestra load NAME` loads
only its selected top-level skills into the native user skill directory.

## Agents

Each Markdown filename is the agent identifier. YAML frontmatter defines the
harness, model/effort, description, skills, connections, and child bindings. The
Markdown body contains its instructions. Shared instruction files may be
prepended with `instructions_files`. Actual agents live here whether they are
used as entry points, children, or both. A reference document such as
`skills/create-ticket/references/socrates.md` is a reusable rubric, not another
agent definition.

## Skills

`SKILL.md` frontmatter provides the skill name and description; its body defines
the workflow. Supporting documents remain in `references/`; executable helpers
and assets keep their own appropriate directories. Agent definitions select
skills by directory name.

`metadata/codex.yaml` contains the existing Codex-native metadata schema:

```yaml
interface:
  display_name: Create Ticket
  short_description: Preserve intent and outcomes in tickets and Grain
  default_prompt: Use $create-ticket to capture intent and outcomes.
policy:
  allow_implicit_invocation: true
```

These settings describe how Codex presents and invokes the skill. They do not
declare child agents. The launcher preserves their bytes when translating the
filename; it does not reinterpret policy or infer a Claude equivalent.

## Source files versus native output

| Authoring file | Generated Codex skill | Generated Claude skill |
| --- | --- | --- |
| SKILL.md | SKILL.md, unchanged | SKILL.md, unchanged |
| metadata/codex.yaml | agents/openai.yaml | Omitted |
| references and other support files | Preserved | Preserved |

The generated `agents/openai.yaml` name is Codex's native convention. It will
still appear inside generated bundles; it is not part of the central authoring
layout. Imported skills with that native filename remain supported. A skill
containing both metadata filenames fails rather than choosing one silently.

Session bundles copy the translated files under the destination repository's
`.orchestra/generated/`. User-level `load` builds a native layout for normalized
skills under `~/.cache/orchestra/user-skill-layouts/`, using file links to the
central sources, and links that layout into the native user skills directory.
Existing file edits remain live. After adding/removing files or renaming a
metadata path, unload all profiles sharing that skill and load them again.
Unloading removes owned user-skill links, not source files or cached layouts.

Native global installs should use `orchestra load`, rather than directly copying
the authoring directory, so the required metadata filename is generated.

## Workspaces and repositories

Workspace YAML supplies named MCP connections. Repository `AGENTS.md`,
`CLAUDE.md`, and repository references remain repository-owned; the central
agent definitions do not replace them. Secrets and native OAuth credentials
remain outside these authoring files.
