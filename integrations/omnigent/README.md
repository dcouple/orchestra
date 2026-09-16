# Omnigent integration

For the new direct native-TUI direction, see the [native launch prototype](../native-launch/README.md).
It selects an agent and optional workspace without an Omnigent runtime. This
directory retains the earlier adoption experiment and native MCP setup helper.

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
The local planner and implementer use `os_env.sandbox.type: none`, matching
Omnigent's dedicated native launcher. They add no Omnigent OS sandbox; the native
harness's permission settings still apply. With v0.13.0 on this Mac, `auto`
prevented Claude from reading Omnigent's generated `claude-settings.json`.
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

Store named, non-secret endpoints once per machine in
`~/.config/orchestra/connections.json`. The registry example is
[`connections/registry.example.json`](connections/registry.example.json).
Use the gateway's **MCP Access URL**, not its application ID or console URL:

```sh
orchestra-omni connections add keycard --url 'YOUR_HTTPS_MCP_ACCESS_URL'
orchestra-omni connections login keycard --harness claude
orchestra-omni connections login keycard --harness codex
orchestra-omni connections check keycard --harness codex
orchestra-omni agent planner --harness claude --connection keycard
orchestra-omni agent implementer --harness codex --connection keycard
orchestra-omni run codex --connection keycard
```

`add` writes only endpoint metadata. `login` explicitly registers the server as
`orchestra_keycard` in the selected harness's persistent user configuration and
hands the terminal to its native OAuth flow. Complete the browser login when
prompted. Claude uses `claude mcp login`; Codex automatically attempts OAuth on
first `mcp add`, and subsequent wrapper logins use `codex mcp login`. If Codex's
initial discovery does not start authentication, retry the login command.
Each harness logs in separately; planner and implementer share that harness's
login. Keycard controls the account's tool grants.

Run login from an ordinary terminal before starting Omnigent. Credentials stay
in the native CLI's credential store: Claude uses its native macOS Keychain/file
storage; Codex uses its configured OAuth keyring/file store under its durable
configuration. The wrapper does not read, copy, export, or implement refresh for
tokens. Omnigent manages the temporary Codex home; real Keycard login persistence
and refresh through that home still require live verification.

`check` verifies the effective registration's endpoint, transport and settings.
It does **not** prove authentication or successful tool access. Startup checks
selected registrations and fails on missing or conflicting settings, without
opening a browser. To prove access, ask the agent to call an allowed read tool.
Native inspection can contact the gateway. No credentials belong in the registry,
agent definitions, bundle snapshots, or command-line arguments; query parameters,
embedded credentials, custom headers, and unsupported fields are rejected.

To select connections by default, edit an agent's `config.json`:

```json
"connections": ["keycard"]
```

The checked-in agents start with an empty list. Repeat `--connection` to add
other names; duplicates are errors. Use `--connections-file /absolute/path.json`
on connection commands, builds and launches to select another registry.
`connections list` displays the non-secret registry. Changing an existing endpoint
requires `connections add ... --replace`; this changes the registry only. A
conflicting native registration is never overwritten automatically: inspect and
remove that specific server using the native CLI, then repeat wrapper login.

This release uses **persistent native user registration**. Registered servers can
appear in ordinary native sessions and in agents that do not select them. An
agent's connection list declares requirements, not an access-control boundary.
Bundles record selected endpoint definitions, but native configuration is
separate and can change. An old bundle or resumed conversation does not freeze
native endpoints, credentials or permissions. Start a fresh session after changes.

A public smoke test needs no Keycard credentials:

```sh
orchestra-omni connections add docs_smoke --url https://langfuse.com/api/mcp --auth none
orchestra-omni connections login docs_smoke --harness claude
orchestra-omni connections login docs_smoke --harness codex
orchestra-omni agent planner --harness claude --connection docs_smoke
```

Ask it to call `orchestra_docs_smoke`'s `getLangfuseOverview` tool once. This public
server provides documentation; it does not export traces or read private sessions.
The public registration is installed on the development machine for local trials.

### Experimental Omnigent bridge

`--tools` still accepts Omnigent JSON tool maps, including the legacy examples in
`connections/langfuse-docs.json` and `connections/keycard.json`. With v0.13.0,
configured Claude and Codex runners discovered the public MCP tools but did not
expose them through their active bridge. Use named native connections for these
harnesses. The wrapper rejects a selected native connection also supplied through
`--tools` under the same name or exact endpoint. Existing unrelated native MCP
registrations are retained; avoid separately registering the same gateway twice.

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

Automated validation covers all four agent/harness bundles, shared reference
resolution, immutable snapshots, argument forwarding, the symlinked launcher,
and a target directory containing spaces. Local live checks also opened both
native TUIs, completed a native Claude turn, and completed configured planner and
implementer turns on Claude and an implementer turn on Codex. The configured
implementer exposes its namespaced skills; `/do` retains its manual-only metadata
and is not advertised for model invocation. Public `getLangfuseOverview` calls succeeded through native registrations in
configured Claude and Codex sessions. Registry and adapter tests cover conflicts,
credential-output redaction, login delegation, and connection selection. The MCP
bridge limitation above was reproduced on both harnesses. Before treating the integration as ready for routine use:

- Launch both native TUIs; send a message; exit and resume the Omnigent session.
- Load each configured bundle and confirm selected skills and repository instructions.
- Make an allowed Keycard read call through each native harness.
- Verify a completed turn and tool call in Langfuse for each harness.
- Authenticate Keycard, invoke an allowed read tool, and test credential renewal.

The reviewed runtime is [Omnigent v0.13.0](https://github.com/omnigent-ai/omnigent/releases/tag/v0.13.0).
Relevant implementation references: [native CLI entrypoints](https://github.com/omnigent-ai/omnigent/blob/v0.13.0/omnigent/cli_native.py),
[agent-image parser](https://github.com/omnigent-ai/omnigent/blob/v0.13.0/omnigent/spec/parser.py),
[Claude skill filtering](https://github.com/omnigent-ai/omnigent/blob/v0.13.0/omnigent/inner/bundle_skills.py),
and [Codex skill population](https://github.com/omnigent-ai/omnigent/blob/v0.13.0/omnigent/inner/codex_executor.py).
