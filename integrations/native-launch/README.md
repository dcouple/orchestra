# Orchestra native launcher (TypeScript prototype)

This bounded prototype compiles a local agent definition and optional workspace into a static bundle, then opens the native Claude Code or Codex terminal in your chosen directory. It requires neither Omnigent nor tmux. It is separate from the earlier `orchestra-omni` experiment.

## Try it locally

Install Node 22.15+ on macOS/Linux, pnpm 11, and Claude Code and/or Codex. Sign into the native harness. Build from the Orchestra checkout:

```sh
pnpm --dir integrations/native-launch install --frozen-lockfile
pnpm --dir integrations/native-launch build
```

The compiled CLI is `integrations/native-launch/dist/cli.js`. This Mac has an `orchestra` symlink in `~/.local/bin`; elsewhere use `node integrations/native-launch/dist/cli.js` in place of `orchestra`. No Python or uv is required. From the checkout:

```sh
# Claude planner proof, with a prebuilt Codex worker child:
orchestra agent planner \
  --config-root integrations/native-launch/examples \
  --workspace public --directory /absolute/path/to/your/repo

# Codex worker proof in the same repository:
orchestra agent worker \
  --config-root integrations/native-launch/examples \
  --workspace public --directory /absolute/path/to/your/repo \
  --message 'Use worker-proof and report its marker.'
```

The examples are smoke-test agents, not the full Orchestra planner/implementer workflows. Without `--message`, the native TUI waits for input. With a message it starts a turn. `--exec` selects native noninteractive execution; MCP calls may require approval unavailable in that mode. This prototype does not bypass native permissions.

Use `--build` to generate and print the bundle path, or `--explain` to generate it and inspect the launch command without starting a model. Omit `--workspace` for an agent without workspace connections. `--config-root` defaults to `~/.config/orchestra`.

## Configuration

```text
~/.config/orchestra/
  profiles/planner.yaml
  agents/planner/agent.yaml
  agents/planner/instructions.md
  agents/worker/agent.yaml
  agents/worker/instructions.md
  skills/planner-proof/SKILL.md
  skills/worker-proof/SKILL.md
  workspaces/my-project.yaml
```

Each agent selects `harness`, a `model` block (`name`, optional `reasoning` and Codex `speed`), `instructions_file` (Markdown), local `skills`, inline `connections`, and a `subagents` map. Profiles reference an agent with optional overrides. Legacy scalar models plus `reasoning_effort` and alias-to-name child maps remain supported. See the runnable [examples](examples/agents/planner.yaml). Workspace files currently accept only inline `connections`:

```yaml
connections:
  keycard:
    type: mcp
    auth: native
    url: https://YOUR-GATEWAY/mcp
```

Each child inherits workspace and parent connections and adds its own agent connections. A conflicting connection name fails rather than silently changing its endpoint. Profiles may override agent defaults; child bindings may override description, harness, and model. Remote inheritance and secret bindings are future resolver work; unsupported fields fail explicitly.

Skill directories must be real local directories, including supporting files. The prototype copies them verbatim; it does not resolve external repositories, render templates, translate metadata, or rewrite existing workflow dispatch paths.

## Keycard login

Use your gateway's MCP Access URL in the workspace above. Authenticate once through each native harness you intend to use, in its normal home:

```sh
codex mcp add orchestra_keycard --url https://YOUR-GATEWAY/mcp
# If already registered, or if the initial flow did not complete:
codex mcp login orchestra_keycard
```

For Claude, the existing PR helper supports registration and native login:

```sh
orchestra-omni connections add keycard --url https://YOUR-GATEWAY/mcp
orchestra-omni connections login keycard --harness claude
```

That helper is only setup tooling; the launch commands above open native TUIs directly. Existing conflicting registrations must be resolved deliberately. Never place OAuth token payloads in YAML or skills. Browser consent can be required for individual upstream services. Immediate saved-login reuse is verified on both harnesses; expiry/refresh is not yet verified.

## Generated files and coexistence

Bundles live under the destination's `.orchestra/generated/<agent>-<workspace>-<hash>/`. Identical inputs reuse a bundle; changes create another. The main agent and all transitive child configurations are generated together. Native children use generated Claude CLI definitions or Codex role TOML files. Process children launch through bundled `dispatch/<alias>` scripts. Both retain the destination working directory. There is no separate agent scheduler.

Repository `AGENTS.md`, `.claude`, and `.codex` files are not replaced. Existing global and repository skills remain visible. Add `/.orchestra/generated/` to the destination repository's local Git exclude file before use; automatic exclusion/cleanup is not implemented.

Claude receives a generated plugin and strict MCP configuration. Codex receives a separate mutable home under `~/.cache/orchestra/native-proof/`, with selected skills and references to its normal native configuration/auth files. Codex still inherits existing user-level MCP servers. Native UI changes to linked settings may affect the normal native configuration. This is not a security or tool-isolation boundary.

## Status and next implementation

See [verification evidence](VERIFICATION.md). The next production work is the central resolver, full workflow dependency packaging, broader native subagent metadata translation, and approval behavior for unattended children. Native conversation resume associations, OAuth renewal, cleanup, account rotation, tracing and daemon integration are not implemented by this prototype. Do not deploy it as a daemon launcher yet.

The compiler and native runtime are separate TypeScript modules, so a future daemon adapter can reuse configuration generation without owning a TUI. Generated child runtimes are standalone Node modules with no YAML dependency. The main process uses Node `execve` to hand the terminal, signals and exit status directly to the native harness. Windows is not supported.

Run the checks:

```sh
pnpm --dir integrations/native-launch typecheck
pnpm --dir integrations/native-launch test
```

## Agent-backed workflow profiles

Launch `planner`, `astra-planner`, or `implementer` with `orchestra run NAME`.
Profiles reference complete definitions in the central `agents/` directory;
model and harness defaults live in those agent files. See
[profiles and native child roles](profiles/README.md) for configuration,
installation, overrides, and current native-delegation limits.
