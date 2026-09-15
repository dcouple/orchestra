# Omnigent integration

Launch native Claude Code or Codex conversations from any project, or load an
Orchestra planner/implementer bundle through Omnigent. Omnigent is an external
machine dependency; this directory contains the launcher and agent configuration.

## Install on a Mac

Install Python 3.9+ for this launcher, and `uv` and `tmux`. Install the tested
Omnigent release in a separate Python tool environment:

```sh
brew install uv tmux
uv tool install --python 3.12 'omnigent==0.13.0'
```

Install Claude Code and/or Codex and sign in using their own CLIs. The launcher
checks the Omnigent version before starting a session. To update the pin, change
`OMNIGENT_VERSION` in `launcher.py`, the installation command here, and rerun the
upstream checks and live checks below.

You can invoke `integrations/omnigent/bin/orchestra-omni` directly. To make it
available from other projects, run this once from a stable Orchestra checkout:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/integrations/omnigent/bin/orchestra-omni" "$HOME/.local/bin/orchestra-omni"
```

Ensure `~/.local/bin` and uv's tool directory are on PATH. `ln -s` deliberately
fails if an entry already exists; review that entry before replacing it. The
launcher follows its own symlink to find Orchestra. Keep that checkout available
for subsequent launches; a temporary PR worktree is useful for evaluation but
is not a permanent installation location.

```sh
orchestra-omni doctor
```

`doctor` checks executables and the runtime version. Authentication and service
connections are checked by the native CLIs and the live tests below. Native
wrappers require tmux on macOS; this integration has not been exercised on Linux
or Windows.

## Native conversations

```sh
cd /path/to/project
orchestra-omni run claude
orchestra-omni run codex
orchestra-omni run claude --message 'Explain the architecture of this project'
orchestra-omni run codex --message 'Inspect this repository and summarize its tests'
```

`run` invokes the dedicated `omni claude` / `omni codex` native terminal wrappers.
With no message, the TUI waits for input. `--message` supplies its initial message.
Claude receives `--use-native-config` to retain its existing authentication.
Codex uses Omnigent's normal native Codex configuration resolution. No permission
bypass flags are added; existing native settings still apply.

```sh
orchestra-omni run claude --project /path/to/another/worktree --model sonnet
orchestra-omni run codex --resume conv_abc123
orchestra-omni run claude --dry-run
```

Resume takes an **Omnigent conversation ID**, not a raw Claude/Codex session ID.
The launcher rejects a simultaneous starter message and resume; resume first and
then send the next message inside the session. It selects the local Omnigent
server explicitly. Omnigent manages its background host/server and terminal
processes; use Omnigent's own lifecycle commands to manage those processes.

## Configured agents and shared skills

```sh
orchestra-omni agent planner --harness claude --project /path/to/project
orchestra-omni agent implementer --harness codex --project /path/to/project
```

`agent` builds a snapshot and invokes `omni run <bundle>`. This is Omnigent's
configured-agent session interface, with the selected native harness executor.
It differs from the dedicated native-TUI entrypoint above. For a single initial
task, its option is explicitly called `--task`:

```sh
orchestra-omni agent planner --harness claude --task 'Investigate why this test fails'
```

Omnigent's generic `run -p` path is one-shot: it is not a guarantee of starting a
task and remaining in the native TUI. Use `run --message` when you want that
native interactive behavior. This initial integration keeps the two paths
explicit instead of emulating a session handoff between them.

| Agent | Claude skills | Codex skills |
|---|---|---|
| Planner | discussion, create-brief, investigate, codex | code-researcher, web-researcher, investigate, investigator, plan-reviewer |
| Implementer | do, investigate, codex, prepare-pull-request, postmortem | do, implementer, investigate, investigator, code-researcher, web-researcher, backend-verifier, frontend-verifier, plan-reviewer, code-reviewer, refactor-simple, refactor-deep |

Edit `agents/<name>/config.json` for the role, common settings, and tool
connections. Edit `agents/<name>/skills.json` to select canonical skills per
harness. These JSON manifests keep the launcher dependency-free. The generated
`config.yaml` uses JSON syntax, which is valid YAML, and the Omnigent agent-image
schema (`spec_version: 1`, `executor.config.harness`).

The builder copies the actual canonical skills, including their supporting
files. It also snapshots the shared `references/`, Claude agent definitions,
and the canonical skill trees as supporting material. Only selected skills go
in the bundle's active `skills/` directory; Claude specialist definitions are
included as plugin agents. In generated text, Orchestra-owned `.references/`,
`.claude/agents/`, `.claude/skills/`, and `.codex/skills/` paths resolve into that
snapshot. Canonical source files stay unchanged.

These are the production Orchestra workflows. In particular, `/do` includes
its full planning, delegation, PR, and verification pipeline. The launcher
neither changes those instructions nor makes a planner/implementer role a
permission boundary. Existing workflows can invoke native subagents or launch
Codex directly; `spawn: false` only disables Omnigent's unrestricted session
creation surface. It is not a universal delegation prohibition.

### Cache and reload

Bundles live under `~/.cache/orchestra/omnigent/<content-hash>/`. The hash covers
source content, configuration, skill selections, and the builder. Changes create
a new snapshot; older snapshots remain available to existing sessions. A
modified cached file causes an error instead of silent reuse.

```sh
orchestra-omni build planner --harness claude
orchestra-omni agent planner --harness claude --dry-run
```

`build` prints the bundle path and needs no Omnigent installation. `--dry-run`
prints the argument vector and working directory; in agent mode it also builds
the snapshot. Rebuilding and starting a fresh session applies configuration
changes. Resume preserves the existing conversation; it is not a supported
configuration reload mechanism in this adapter.

Set `ORCHESTRA_OMNI_CACHE` to relocate the cache. Cache paths must contain only
letters, digits, `/`, `_`, `-`, and `.` because the canonical workflows contain
shell examples with unquoted paths. The **target project path may contain spaces**.
Cached bundles contain absolute paths and are local-machine artifacts. There is
no automatic garbage collector; retain snapshots used by resumable sessions.

`skills: all` preserves host skills/settings in this experiment. On Claude-native,
a named host-skill allowlist is not enforced by Omnigent v0.13.0; `skills: none`
also alters Claude setting sources. Selected bundles therefore do not provide
strict isolation from skills already installed on the machine or in a project.

## Repository instructions and references

The launcher starts from `--project` (or the current directory) and writes no
configuration into that project. Repository `AGENTS.md`, `CLAUDE.md`, and local
references remain owned by the project, independently of agent selection.
Claude reads its normal `CLAUDE.md` entrypoint; a project can use `@AGENTS.md` there
to include shared repository instructions. Codex uses its normal repository
instruction discovery. The launcher does not create or replace either file.

The bundle's `support/references/` contains Orchestra workflow documentation;
it is distinct from a project's own application references. Native filesystem
permissions still govern access to the cache. If a harness requests permission
to read it, grant only the access needed for that session.

## MCP connections

Native `run` sessions use the harness's existing MCP configuration. For configured
agents, pass a JSON map of Omnigent MCP connections; repeat `--tools` for multiple
files. Duplicate names are rejected.

```sh
orchestra-omni agent planner --harness claude \
  --tools /path/to/orchestra/integrations/omnigent/connections/langfuse-docs.json
```

The included connection uses the public Langfuse documentation MCP and requires
no credentials. It searches documentation; it does not export traces or read
private session history.

`connections/keycard.json` demonstrates Omnigent's HTTP MCP transport with a
Keycard gateway URL and an access token supplied through environment references.
Keep real secrets outside Orchestra and pass them to the process that resolves
the agent configuration. The builder leaves `${VAR}` references unexpanded.
A long-running Omnigent host may have a different environment from the invoking
shell; verify actual runner credential availability.

The token must be issued for your gateway and grants. This connection does not
perform OAuth login or refresh. For an interactive first trial, configure the
Keycard gateway directly in Claude, authenticate in `/mcp`, then launch
`orchestra-omni run claude`. Follow [Keycard's gateway guide](https://docs.keycard.ai/admin/unified-access-gateway/).
Use one route per gateway during testing, and select allowed tools using the
actual tool names returned by your gateway. The example has no invented tool
names or configured private account.

## Langfuse tracing

Tracing is installed in the native harness, below Omnigent. The launcher does
not treat environment variables as instrumentation or change your global plugins.
For Claude, install the official hook plugin:

```sh
claude plugin marketplace add langfuse/Claude-Observability-Plugin
claude plugin install langfuse-observability@langfuse-observability
```

In Claude, run `/plugin configure langfuse-observability@langfuse-observability`
and set the project's public key, secret key, and regional base URL. Restart
sessions so hook changes load. Follow the [official plugin instructions](https://github.com/langfuse/claude-observability-plugin),
including its uv/Python prerequisite.

Codex has a separate [official Langfuse plugin](https://langfuse.com/integrations/developer-tools/codex).
Follow its version, hook-enablement, credentials, and `TRACE_TO_LANGFUSE` setup
requirements. Omnigent's Codex native wrapper creates a session-specific Codex
home, so plugin availability and hooks must be verified in that environment.
Neither harness's exporter has been exercised through this integration yet.

The exporter records native sessions. Omnigent conversation IDs and native
session IDs are not assumed equal. Cross-process child tracing and supervisor
spans need an explicit correlation integration. Private history queries need a
separate authenticated [Langfuse data MCP](https://langfuse.com/docs/api-and-data-platform/features/mcp-server)
connection with the appropriate project scope and read-tool selection.

## Verification

Local tests (Python standard library only):

```sh
python3 -m unittest discover -s integrations/omnigent/tests -v
```

Full upstream loader/validator checks, without model calls or service credentials:

```sh
uv run --no-project --python 3.12 --with 'omnigent==0.13.0' \
  python integrations/omnigent/tests/check_upstream.py
```

The PR's validation covers all four agent/harness bundles, shared reference
resolution, immutable snapshots, argument forwarding, the symlinked launcher,
and a target directory containing spaces. It does not establish live native
runtime behavior. Before treating the integration as ready for routine use:

- Launch both native TUIs; send a message; exit and resume the Omnigent session.
- Load each configured bundle and confirm selected skills and repository instructions.
- Make a public documentation MCP call through Omnigent's bridge.
- Verify a completed turn and tool call in Langfuse for each harness.
- Authenticate Keycard, invoke an allowed read tool, and test credential renewal.

The reviewed runtime is [Omnigent v0.13.0](https://github.com/omnigent-ai/omnigent/releases/tag/v0.13.0).
Relevant implementation references: [native CLI entrypoints](https://github.com/omnigent-ai/omnigent/blob/v0.13.0/omnigent/cli_native.py),
[agent-image parser](https://github.com/omnigent-ai/omnigent/blob/v0.13.0/omnigent/spec/parser.py),
[Claude skill filtering](https://github.com/omnigent-ai/omnigent/blob/v0.13.0/omnigent/inner/bundle_skills.py),
and [Codex skill population](https://github.com/omnigent-ai/omnigent/blob/v0.13.0/omnigent/inner/codex_executor.py).
