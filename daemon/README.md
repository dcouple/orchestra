# Linear agent daemon

This orchestra-only Node 22 service receives signed Linear AgentSessionEvent webhooks for
the separate planner and implementer OAuth apps. It verifies each raw request, appends it
to SQLite, acknowledges new sessions asynchronously, and runs bloom-planner discussions in
per-issue git worktrees. Planner turns stream Claude progress to Linear, persist terminal
activities for retry, and resume the stored Claude session on follow-up prompts. Implementer
assignments run a fresh, unattended literal `/do <identifier>` turn in the same issue worktree,
durably attach an opened PR to the Linear session, and clean up clean worktrees after completed
Issue webhooks. Follow-up replies to an implementer session resume its stored Claude session
the same way planner prompts do, so a human can answer an implementer's question mid-stream.
Dirty worktrees are retained and reported to the session.

## Local checks

Use pnpm 11.8 and Node 22.23 or compatible Node 22 releases:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
PLAYWRIGHT_MCP_BIN="$PWD/node_modules/.bin/playwright-mcp" \
PLAYWRIGHT_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
BROWSER_E2E_OUTPUT_DIR="../tmp/browser-smoke" pnpm test:browser
pnpm test:browser-contract
bash -n ops/provision.sh ops/daemonctl ops/wait-for-daemon-health.sh ops/claudex ops/claudex-fable ops/proxy-accounts.sh ops/codex-provider-gate.sh
```

The Vitest suite is hermetic: it uses loopback HTTP servers and temporary real SQLite
databases, requires no environment variables, and makes no internet or Linear requests.
Tests cover phase-1 ingress plus durable planner queues, real temporary git worktrees, and a
fake stream-json Claude executable. They require no network, Linear credentials, or Claude
account. When `CLIPROXY_BIN` points to the pinned CLIProxyAPI binary, the proxy integration
suite additionally checks aliases, credential management, hot-loading, disabling, and log
redaction. Real account, Linear, Claude, and systemd acceptance remains a deploy-time gate in
`ops/runbook.md`.

## Host operations

`sudo daemonctl --help` is the production control surface. It provides narrow harness
configuration, immediate restart and checkout reload, safe status/running-turn and
compute views, and interactive subscription maintenance. Normal mutations persist one
operation and stop new turn claims while signed webhooks continue to be stored and
acknowledged. Accepted operations execute immediately; a service restart interrupts active
turns and startup resumes them automatically. A root-owned request file authorizes the
privileged executor; SQLite alone never authorizes root work. `daemonctl restart --hard`
requires explicit confirmation and remains the deliberate no-resume path.

The root repository `Makefile` forwards the same commands over GCE SSH; it contains no
deployment logic. Its local transport builds an argv vector and uses Python `shlex` parsing
and quoting so operator values remain daemonctl arguments rather than local or remote shell
syntax. The operator alone fetches, reviews, and fast-forwards the persistent HTTPS checkout;
`daemonctl reload` never fetches or runs candidate validation. It deploys that exact clean
checkout commit through the existing provisioner, records deployed and accepted markers
around health acceptance, and rolls back to the prior accepted commit on failure.
`daemonctl update` remains a compatibility alias. See `ops/runbook.md` for failed/blocked
recovery, revision reconciliation, and the human-only production smoke procedure.

On Apple Silicon macOS, `ops/macos/provision.sh` also installs Agent Farm for
the site-configured service user. `ops/macos/agent-farm-provision.sh` pins CLI
version `0.1.1` and runs `pnpm add --global @dcouple/agent-farm@0.1.1`, using
the same service-user installation as Playwright MCP and XcodeBuildMCP. The
executable is `~/.pnpm/bin/agent-farm`; an existing executable and matching
`~/.pnpm/agent-farm-version` marker count as converged. That version must be
published on npm before provisioning. Updating the CLI or bundled plugin
requires changing the version pin. Generated session bundles remain in place.

Provisioning obtains the installed package path from
`pnpm list --global --depth 0 --json`, including pnpm 11's isolated global
package directory, and runs `agent-farm plugin install <package>/plugins/dcouple
--config-root <service-home>/.config/agent-farm` with stdin closed. That explicit
config root is the service user's reusable library, including the shipped
`profiles/planner.yaml` and `profiles/implementer.yaml`, agents, and skills.
The plugin installer preserves modified local files by failing on conflicts.
Readback checks the receipt, every installed plugin checksum, and both profile
definitions. It does not mount skills globally or launch a harness.

The provisioner's `--dry-run --site <site.env>` inventories Agent Farm without
installing it. Its summary records `agent-farm-cli`, `agent-farm-plugin`, and
`agent-farm-profiles` as `would-apply`, `applied`, or `already-correct`. The
`provision_agent_farm_workspace` hook in `ops/macos/agent-farm-provision.sh`
records `pending-item-5: workspace placement` and writes nothing until the
daemon harness work supplies its workspace file and idempotent placement.
Workspace connections and daemon child-process ownership are defined by that
work, independently of installation.

## Run locally

Build first, then provide both apps' webhook and client credentials:

```bash
pnpm build
PLANNER_WEBHOOK_SECRET=... \
PLANNER_LINEAR_CLIENT_ID=... \
PLANNER_LINEAR_CLIENT_SECRET=... \
IMPLEMENTER_WEBHOOK_SECRET=... \
IMPLEMENTER_LINEAR_CLIENT_ID=... \
IMPLEMENTER_LINEAR_CLIENT_SECRET=... \
TARGET_REPO_PATH=/var/lib/linear-agent-daemon/repos/bloom-mono \
LINEAR_API_KEY=... \
DB_PATH=./events.db \
node dist/index.js
```

The listener defaults to `127.0.0.1:8787`. Routes are `POST /webhook/planner`, `POST
/webhook/implementer`, and `GET /healthz`. `LINEAR_TOKEN` variables with the corresponding
app prefix are test-only static overrides and are ignored unless `DAEMON_TEST_MODE=1`;
production uses client credentials. Optional settings are `PORT`, `BIND_ADDR`,
`REPLAY_WINDOW_MS`, `LINEAR_GRAPHQL_URL`, and `LINEAR_TOKEN_URL`.

Set `ARTIFACT_TOKEN` to enable artifact hosting. An authenticated `POST /a` creates a
bundle with a server-generated id; authenticated `PUT /a/<id>` atomically replaces an
existing bundle. Both accept a JSON manifest whose file contents are base64 encoded:

```json
{
  "files": [
    { "path": "brief.html", "contentBase64": "PCFkb2N0eXBlIGh0bWw+" },
    { "path": "refs/hellosign.html", "contentBase64": "PGgxPlN1Yi1yZXBvcnQ8L2gxPg==" }
  ]
}
```

Writes require `Authorization: Bearer <ARTIFACT_TOKEN>`. `GET /a/<id>/` is an
unauthenticated, self-contained viewer; `GET /a/<id>/index.json` returns the live version's
file paths as a no-cache JSON array, and `GET /a/<id>/<path>` serves raw files. The name
`index.json` is reserved at the bundle root. Nothing above the unguessable `/a/<id>/` URL
enumerates bundles. `ARTIFACTS_DIR` defaults to an `artifacts` directory beside the database,
and `ARTIFACT_MAX_BODY_BYTES` defaults to 32 MiB. Provisioning creates the default directory
under `/var/lib/linear-agent-daemon`, outside the deployed application tree, so content
survives provision and deploy reruns. It is not backed up yet; loss of the VM disk loses
stored bundles.

Configuring `ARTIFACT_TOKEN` also exposes the same value as `ARTIFACT_HOST_TOKEN` to every
spawned session, activating the artifact-host publish branch.

Planner sessions default on. `TARGET_REPO_PATH` and `LINEAR_API_KEY` are required when
enabled. Optional session settings are `WORKTREES_ROOT` (defaults beside the database),
`PLANNER_HARNESS` (`claude | claudex`) and `IMPLEMENTER_HARNESS`
(`claude | claudex | codex`), both defaulting to `claude`,
`CLAUDE_BIN` (default `claude`, whitespace-split for a command prefix),
`CODEX_BIN` (default `codex`, whitespace-split) and `CODEX_MODEL` (default
`gpt-6-astra`) for the `codex` harness,
`CLAUDEX_BIN` (optional, whitespace-split; required for a direct `claudex`
preference and for Sol fallback - point it at the provisioned `claudex` wrapper),
`CLAUDEX_ENV` (optional JSON string map of
extra child env for `CLAUDEX_BIN`; requires `CLAUDEX_BIN`),
`FABLE_BIN` (optional; normally the installed `ops/claudex-fable` launcher),
`CLIPROXY_ENV_FILE`, `CLIPROXY_URL`, `PROVIDER_PROBE_INTERVAL_MS`,
`PROVIDER_STATE_STALE_MS`, and `PROVIDER_INITIAL_PROBE_TIMEOUT_MS`,
`CLAUDE_PERMISSION_MODE` (`bypassPermissions`), `CLAUDE_MAX_TURNS` (100),
`BASH_DEFAULT_TIMEOUT_MS` (900000) and `BASH_MAX_TIMEOUT_MS` (900000),
`MCP_ENV_PASSTHROUGH` (optional comma-separated project MCP environment names),
`LINEAR_MCP_MONITOR_INTERVAL_MS` (60000) and
`LINEAR_MCP_MONITOR_TIMEOUT_MS` (10000),
`DO_PERMISSION_MODE` (`bypassPermissions`; production rejects every other value),
`DO_MAX_TURNS` (300), `DO_MAX_BUDGET_USD` (optional positive number),
`SESSION_CONCURRENCY` (5), `KEEPALIVE_MS` (900000), `ATTACHMENTS_ENABLED` (1), and
`ATTACHMENT_HOSTS` (`uploads.linear.app`). Set `SESSIONS_ENABLED=0` for ingress-only runs.
For a new role session, `claude` prefers the Fable launcher and retains readiness routing
plus the one-shot structured capacity fallback to Claudex/GPT-Sol; `claudex` starts
Claudex/GPT-Sol immediately without probing Fable; `codex` runs the native Codex CLI
(`codex exec --json`) on `CODEX_MODEL` with approvals and the sandbox bypassed, so the
implementer starts a new item with `$astra-ticket <issue>` and resumes the same thread for
later prompts. Codex turns carry the same Linear MCP server (`-c mcp_servers.linear.*`,
the key by env reference) but no daemon tool hooks, turn cap, or budget cap. The resolved
harness and session ID are persisted together, so later prompts, restarts, fix rounds, and
preference changes continue on the established harness. Missing `CLAUDEX_BIN` fails a
selected Claudex session closed; it never starts a replacement Claude session.

Immediately before each turn, the daemon reads only `CLIPROXY_API_KEY` from
`CLIPROXY_ENV_FILE` and passes that value plus the two Bash timeout settings to the selected
child. This picks up key rotation without restarting the daemon and keeps the management key
out of child environments. Do not add `cliproxyapi.env` as a systemd `EnvironmentFile`: it
also contains `CLIPROXY_MANAGEMENT_KEY`. For standalone use outside a daemon turn, the
installed `claudex` and `claudex-fable` wrappers preserve an already supplied API key or parse
only `CLIPROXY_API_KEY` from the configured proxy file; an unreadable file or missing key
fails nonzero without printing a credential. Both Bash timeout values must be positive, and
the maximum must be at least the default. The independent Codex dispatch watchdogs remain
900 seconds for ephemeral roles and 2700 seconds for implementers.
`MCP_ENV_PASSTHROUGH` names extend the child allow-list; the secret deny-list
still runs last, and denied or daemon-owned names fail startup.

On startup, every stale running turn with a persisted Claude session is automatically resumed
exactly once, including turns interrupted at an unresolved tool boundary. That continuation
explicitly directs the agent to verify external effects before re-running the tool. If a
detached Codex dispatch is still in flight, the parent waits for its completion marker; a
deadline-plus-grace fallback resumes it if the marker never appears. Missing Claude sessions,
explicit user stops, and recorded hard restarts still require human review. Routine
`daemonctl` config, restart, and reload operations execute immediately. Coherent pre-mutation
or rolled-back failures park terminally as `failed` with a `recoveryCommand`; only an
incoherent deployment remains `blocked` and holds claims. Daemon-owned
`PreToolUse`, `PostToolUse`, and `PostToolUseFailure` hooks enforce those boundaries:
`PreToolUse` must durably record the turn, tool-use ID, and bounded tool name before execution,
and exits nonzero to block the tool if that record fails. The post hooks mark the boundary
completed without storing tool inputs or results. Structured `shutdown` records contain only
the signal, recovery or hard-restart policy, and safe summaries of running turns.

When sessions are enabled, the Linear MCP monitor performs an authenticated
connect/`listTools`/close probe at `LINEAR_MCP_MONITOR_INTERVAL_MS`, bounded by
`LINEAR_MCP_MONITOR_TIMEOUT_MS`. Its `linear_mcp_probe` structured records contain state,
previous state, transition status, consecutive failure/retry count, duration, and a normalized
error category/code. They never contain the Linear token, request headers, raw response
bodies, or returned tool schemas. Ordinary monitor failures are observability evidence, do
not fail an active turn, and retry at the next interval. A `cleanup_timeout` disables further
monitor probes until the daemon restarts so unresolved client or transport resources cannot
accumulate. Active turns separately emit bounded `linear_mcp_turn_init`,
`linear_mcp_tool_result`, and `linear_mcp_turn_close` records; close classification is exactly
`turn_completed`, `runner_failed`, or `daemon_shutdown`.

Browser verification is enabled by default; set `BROWSER_ENABLED=0` to opt
out. `PLAYWRIGHT_MCP_BIN` defaults to `/usr/local/bin/playwright-mcp`,
`PLAYWRIGHT_CHROME_BIN` to `/usr/bin/google-chrome`, and
`BROWSER_ATTEMPT_TIMEOUT_MS` to four hours. A fresh `/do` turn starts with
Linear MCP only and a private request file. After `/do` loads the authoritative
item, browser-required work writes the marker and returns the internal relaunch
sentinel; the daemon persists the browser run id and resumes the same session
with official Playwright MCP. Each execution gets isolated `state/` and
retained `evidence/` roots. MCP/Chrome/target failures are classified and fail
browser proof; missing Playwright MCP or Chrome prerequisites fail closed with
typed errors. Non-browser, planner, reviewer, and backend paths never attach
Playwright.
Set `NTFY_URL` to an ntfy topic URL (e.g. `https://ntfy.sh/<topic>`) to push a one-way
notification whenever an agent posts a terminal response or error - errors post at high
priority. Unset means no notifications. A public ntfy topic is readable by anyone who knows
its name; the notification body carries the agent's reply text, so pick an unguessable topic
and never put secrets in issues if you use one.

See `ops/runbook.md` for host provisioning, OAuth registration, credentials, hardening,
deployment, smoke tests, and recovery.

## Agent Farm profile harness

Set each app independently:

```dotenv
PLANNER_HARNESS=agent-farm:planner
IMPLEMENTER_HARNESS=agent-farm:implementer
AGENT_FARM_BIN=agent-farm
```

`AGENT_FARM_BIN` names one executable, including an absolute path with spaces;
its default is `agent-farm`. On the macOS service account the provisioned binary
is `~/.pnpm/bin/agent-farm`, which is on the daemon child PATH. Existing sessions
keep their assigned `agent-farm:<profile>` value when app settings change. The
profile owns the model, effort, skills, instructions, and child agents. A new
implementer turn sends the issue identifier to that profile.

Every turn first calls `agent-farm inspect <profile> --workspace bloom-mono` to
read `agents.main.harness`, then prepares the launch:

```text
agent-farm run <profile> --directory <worktree> --workspace bloom-mono --print-launch --message=<prompt> -- <native flags>
```

Claude flags are `-p --output-format stream-json --verbose`, optional
`--resume <session>`, `--settings <hooks-and-MCP-approval-settings.json>`,
`--permission-mode`, `--max-turns`, and optional `--max-budget-usd`. Codex flags
are `exec --json`, or `exec resume --json <thread>`. Agent Farm places them
before the message and supplies its profile's model and execution settings.
The daemon checks `nodes.main.harness` in the printed bundle's `manifest.json`
against the inspected harness, then selects the existing Claude or Codex stream
parser. It uses the prepared model for Codex usage reporting.

The daemon spawns the complete printed `argv` unchanged, including any wrapper
and prefix arguments, with the printed `cwd`. The environment is the existing
filtered daemon child environment followed by Agent Farm's printed `env`
overrides, so printed values win on collisions. Printed overrides are not
filtered a second time; `CODEX_HOME` and `AGENT_FARM_NATIVE_CODEX_HOME` survive.
`LINEAR_API_KEY`, `CLIPROXY_API_KEY`, and `GH_TOKEN` are supplied only through the
child environment. Preparation output is never logged. The daemon owns piped
stdout/stderr, detached process groups, abort, streaming progress, and capacity
classification, including during launch preparation. No daemon per-turn MCP
JSON is constructed or written for this harness. Claude turn settings still
carry tool hooks. Agent Farm's generated MCP bundle retains strict MCP mode.

The integration workspace is named `bloom-mono`. This exact YAML belongs in
`~/.config/agent-farm/workspaces/bloom-mono.yaml` for the daemon service account;
its tracked template is `ops/agent-farm/bloom-mono.yaml`. The target repository's
workspace guidance lives in bloomapi/bloom-mono and must be maintained there.
The daemon passes `--workspace bloom-mono` explicitly because strict MCP mode
does not inherit globally installed connections.

```yaml
connections:
  linear:
    type: mcp
    url: https://mcp.linear.app/mcp
    auth: bearer_env
    env_var: LINEAR_API_KEY
  xcodebuildmcp:
    type: mcp
    command: /usr/local/bin/xcodebuildmcp
    args: [mcp]
    env:
      DEVELOPER_DIR: /Applications/Xcode.app/Contents/Developer
      XCODEBUILDMCP_ENABLED_WORKFLOWS: session-management,simulator,ui-automation
    env_vars: [ORCHESTRA_SIM_CONTEXT]
  playwright:
    type: mcp
    command: /usr/local/libexec/orchestra-agent-farm-browser
    env_vars:
      - ORCHESTRA_BROWSER_RUN_ID
      - ORCHESTRA_BROWSER_ATTEMPT_ID
      - ORCHESTRA_BROWSER_STATE_DIR
      - ORCHESTRA_BROWSER_EVIDENCE_DIR
      - ORCHESTRA_BROWSER_SOCKET_ALIAS
      - ORCHESTRA_BROWSER_MCP_BIN
      - ORCHESTRA_BROWSER_CHROME_BIN
```

The macOS provisioner installs this managed workspace with mode 0640 and checks
its bytes and both profiles with `inspect --workspace bloom-mono`. It installs
`ops/agent-farm-browser.sh` as `/usr/local/libexec/orchestra-agent-farm-browser`
with mode 0755 and reads it back. Dry run inspects only; unrelated workspace
files are preserved and symlink destinations are rejected. This completes the
workspace placement hook introduced in orchestra PR #207.

The browser launcher receives attempt state, evidence directory, and socket
alias through `ORCHESTRA_BROWSER_*`. The daemon also supplies its configured
Playwright and Chrome binaries through that namespace. It exports the socket
alias as `TMPDIR`, `TEMP`, `TMP`, and `PWTEST_SOCKETS_DIR`, then execs
playwright-mcp with the existing isolated, headless, file-output flags. Before
browser attachment the launcher exits because no attempt is present; the
existing browser request and relaunch handshake attaches it when required.
Simulator configuration is static, with the same `mcp` argument and enabled
workflows as the existing runner; its per-turn context remains an env reference.
Agent Farm registers these connections as `orchestra_linear`,
`orchestra_xcodebuildmcp`, and `orchestra_playwright`. Both parsers recognize the
Linear registration when reporting tool results and Claude initialization.

Install an Agent Farm release containing agent-farm PRs #17 and #18 before
selecting this harness. Ignore `.agent-farm/generated/` in bloom-mono. Actual
provider targeting and stable Codex resume across plugin updates remain plan
items 7 and 8. Fable readiness and its fallback routing continue to apply to
the existing harnesses.
