# Daemon configuration

The daemon reads its settings from the environment at startup
(`daemon/src/config.ts`). On macOS the env file is
`<DAEMON_SERVICE_HOME>/.config/linear-agent-daemon/env`; on Linux it is
`/etc/linear-agent-daemon/env`. Both are mode 0600 and owned by the service
account. Restart the daemon after editing (`daemonctl restart`, see
[RUNBOOK.md](../../RUNBOOK.md#restart)).

Defaults that name `/var/lib/linear-agent-daemon` also work on macOS:
provisioning links `/private/var/lib/linear-agent-daemon` to the service
account's home.

## Environment reference

### Listener and Linear apps

"Required" is `yes` when the daemon refuses to start without it, `macOS deploy` when `deploy.sh` refuses to deploy a sessions-enabled env file without it, and `macOS` when the default is a Linux path that macOS must override.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `WEBHOOK_BASE_URL` | yes (unless `DAEMON_TEST_MODE=1`) | none | Public HTTPS origin, for example `https://<daemon-host>`. Used for artifact URLs. |
| `PORT` | no | `8787` | Listener port. |
| `BIND_ADDR` | no | `127.0.0.1` | Listener address. |
| `DB_PATH` | no | `/var/lib/linear-agent-daemon/events.db` | SQLite database. `artifacts/`, `worktrees/`, and `dispatch-quarantine/` default beside it. |
| `REPLAY_WINDOW_MS` | no | `60000` | Accepted webhook timestamp skew. |
| `PLANNER_WEBHOOK_SECRET`, `IMPLEMENTER_WEBHOOK_SECRET` | yes | none | Webhook signing secret of each Linear app. |
| `PLANNER_LINEAR_CLIENT_ID`, `PLANNER_LINEAR_CLIENT_SECRET`, `IMPLEMENTER_LINEAR_CLIENT_ID`, `IMPLEMENTER_LINEAR_CLIENT_SECRET` | yes | none | Client-credentials OAuth for each app. |
| `PLANNER_APP_ACTOR_ID`, `IMPLEMENTER_APP_ACTOR_ID` | no | none | App actor IDs. Reconciliation discovers sessions only for apps with an ID set; otherwise it logs `reconcile_sessions_skipped_missing_app_actor_id`. |
| `LINEAR_GRAPHQL_URL` | no | `https://api.linear.app/graphql` | Linear API. |
| `LINEAR_TOKEN_URL` | no | `https://api.linear.app/oauth/token` | Linear OAuth token endpoint. |
| `RECONCILE_INTERVAL_MS` | no | `60000` | Reconciliation sweep interval. |
| `RECONCILE_REQUEST_TIMEOUT_MS` | no | `10000` | Per-request timeout during reconciliation. |
| `RECONCILE_SESSION_MAX_AGE_MS` | no | `21600000` | Planner sessions seen within this window get prompt catch-up polling. |
| `DAEMON_TEST_MODE` | no | unset | `1` enables test-only behavior: static `PLANNER_LINEAR_TOKEN` / `IMPLEMENTER_LINEAR_TOKEN`, a default `WEBHOOK_BASE_URL`, and non-bypass `DO_PERMISSION_MODE`. |

The daemon requests app tokens with scopes
`read,write,app:assignable,app:mentionable` and persists them with their
expiry in SQLite.

### Sessions and harnesses

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `SESSIONS_ENABLED` | no | `1` | `0` runs ingress only: no sessions, no Linear MCP monitor, no provider probes, no cleanup. |
| `TARGET_REPO_PATH` | when sessions are on | none | Clone of the consumer repository the agents work on. |
| `LINEAR_API_KEY` | when sessions are on | none | Key for the Linear MCP server in every session. |
| `WORKTREES_ROOT` | no | `<DB dir>/worktrees` | Per-issue worktrees. |
| `PLANNER_HARNESS` | no | `claude` | `claude`, `claudex`, or `agent-farm:<profile>`. |
| `IMPLEMENTER_HARNESS` | no | `claude` | `claude`, `claudex`, `codex`, or `agent-farm:<profile>`. |
| `CLAUDE_BIN` | no | `claude` | Claude Code command (whitespace-split). |
| `CLAUDEX_BIN` | for Sol routes | none | The provisioned `claudex` wrapper (`<service home>/.local/bin/claudex`). Required for the `claudex` harness and the capacity fallback. |
| `CLAUDEX_ENV` | no | none | JSON string map of extra child env for `CLAUDEX_BIN`; requires `CLAUDEX_BIN`. |
| `FABLE_BIN` | no | none | The provisioned `claudex-fable` wrapper. Set it only after authoring the Fable model file (see [operations](operations.md#fable-routing)). |
| `FABLE_MODELS_ENV_FILE` | macOS | `/etc/linear-agent-daemon/fable-models.env` | Read by `claudex-fable`. On macOS set it to `<service home>/.config/linear-agent-daemon/fable-models.env`. |
| `CODEX_BIN` | no | `codex` | Codex command for the `codex` harness. |
| `CODEX_MODEL` | no | `gpt-6-astra` | Model for the `codex` harness. |
| `AGENT_FARM_BIN` | no | `agent-farm` | Agent Farm executable for `agent-farm:<profile>`. |
| `CLIPROXY_ENV_FILE` | macOS | `/etc/linear-agent-daemon/cliproxyapi.env` | Proxy env file; the daemon reads only `CLIPROXY_API_KEY` from it before each turn. On macOS set it to `<service home>/.config/linear-agent-daemon/cliproxyapi.env`. |
| `CLIPROXY_URL` | no | `http://127.0.0.1:8317` | CLIProxyAPI origin. |
| `PROVIDER_PROBE_INTERVAL_MS` | no | `60000` | Fable readiness probe interval. |
| `PROVIDER_STATE_STALE_MS` | no | 5 x probe interval | Age after which readiness counts as stale. |
| `PROVIDER_INITIAL_PROBE_TIMEOUT_MS` | no | `5000` | Startup wait for the first probe. |
| `CLAUDE_PERMISSION_MODE` | no | `bypassPermissions` | Planner permission mode. |
| `CLAUDE_MAX_TURNS` | no | `100` | Planner turn cap. |
| `DO_PERMISSION_MODE` | macOS deploy | `bypassPermissions` | Implementer permission mode; outside test mode only `bypassPermissions` is accepted. |
| `DO_MAX_TURNS` | macOS deploy | `300` | Implementer turn cap. |
| `DO_MAX_BUDGET_USD` | no | none | Positive implementer budget cap. |
| `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS` | no | `900000` each | Bash tool timeouts passed to every Claude-family turn; max must be at least the default. |
| `SESSION_CONCURRENCY` | no | `5` | Concurrent sessions. |
| `KEEPALIVE_MS` | no | `900000` | Progress keepalive interval for long turns. |
| `ATTACHMENTS_ENABLED` | no | `1` | Download Linear attachments for planner turns and implementer resumes. |
| `ATTACHMENT_HOSTS` | no | `uploads.linear.app` | Comma-separated allowed attachment hosts. |
| `MCP_ENV_PASSTHROUGH` | no | none | Comma-separated env names passed to project MCP servers ([mcp-setup.md](mcp-setup.md)). |
| `DISPATCH_QUARANTINE_DIR` | no | `<DB dir>/dispatch-quarantine` | Destination for old Codex dispatch bundles. |
| `DISPATCH_QUARANTINE_AGE_MS` | no | `86400000` | Age after which an ingested or orphaned dispatch bundle moves to quarantine. |
| `DISPATCH_RESUME_GRACE_MS` | no | `600000` | Grace after a detached dispatch deadline before recovery resumes the parent. |
| `GH_TOKEN`, `GITHUB_TOKEN` | no | none | Repository-scoped bot token passed to sessions. |

### Linear MCP, browser, simulator, artifacts, notifications

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `LINEAR_MCP_URL` | no | `https://mcp.linear.app/mcp` | Linear MCP server for sessions and the monitor. |
| `LINEAR_MCP_MONITOR_INTERVAL_MS` | no | `60000` | Monitor probe interval. |
| `LINEAR_MCP_MONITOR_TIMEOUT_MS` | no | `10000` | Monitor probe timeout. |
| `BROWSER_ENABLED` | no | `1` | Browser verification capability. |
| `PLAYWRIGHT_MCP_BIN` | no | `/usr/local/bin/playwright-mcp` | Playwright MCP executable (provisioned on both platforms). |
| `PLAYWRIGHT_CHROME_BIN` | macOS | `/usr/bin/google-chrome` | Chrome executable. On macOS set it to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. |
| `BROWSER_ATTEMPT_TIMEOUT_MS` | no | `14400000` | Browser attempt timeout. |
| `IOS_SIM_ENABLED` | no | `0` | iOS simulator capability (macOS). |
| `IOS_SIM_RUNTIME`, `IOS_SIM_DEVICE_TYPE` | when simulator is on | none | Runtime and device type name or identifier, for example `"iOS 26.5"`, `"iPhone 17"`. |
| `IOS_SIM_MAX_CONCURRENT` | no | `2` | Simultaneous leases. |
| `IOS_SIM_IDLE_TIMEOUT_MS` | no | `900000` | Idle lease reaping threshold. |
| `IOS_SIM_REAPER_INTERVAL_MS` | no | `60000` | Reaper interval. |
| `IOS_SIM_DEVELOPER_DIR` | no | `/Applications/Xcode.app/Contents/Developer` | Xcode developer directory. |
| `IOS_SIM_SIMCTL_BIN` | no | `xcrun simctl` | simctl command. |
| `XCODEBUILD_MCP_BIN` | no | `/usr/local/bin/xcodebuildmcp` | XcodeBuildMCP executable. |
| `ARTIFACT_TOKEN` | no | none | Enables artifact hosting and is exposed to sessions as `ARTIFACT_HOST_TOKEN`. |
| `ARTIFACTS_DIR` | no | `<DB dir>/artifacts` | Artifact bundle storage. |
| `ARTIFACT_MAX_BODY_BYTES` | no | `33554432` | Maximum artifact upload. |
| `NTFY_URL` | no | none | ntfy topic URL for terminal response and error notifications. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, plus `..._HEADERS` | no | none | Enables the trace relay ([operations](operations.md#telemetry)). |

## Routes

`POST /webhook/planner`, `POST /webhook/implementer`, and `GET /healthz`.
Health returns `{"ok":true,"sim":{...}}`; a request authorized with the
CLIProxyAPI management key also gets provider readiness. With
`ARTIFACT_TOKEN` set, `POST /a` creates a bundle and `PUT /a/<id>` replaces
one (both take `Authorization: Bearer <ARTIFACT_TOKEN>` and a JSON manifest
of `{"files":[{"path","contentBase64"}]}`); `GET /a/<id>/` renders the
bundle, `GET /a/<id>/index.json` lists its files, and `GET /a/<id>/<path>`
serves one. With the simulator capability on, sessions lease devices through
`/sim/leases`.

## Harness routing

The harness applies when a role session is first created; the resolved
harness and session ID are persisted, so later prompts, restarts, fix rounds,
and configuration changes continue on the established harness.

- `claude` prefers the Fable launcher (`FABLE_BIN`) when readiness is healthy
  and falls back once to Claudex/GPT-Sol on a validated capacity error.
- `claudex` starts Claudex/GPT-Sol directly without probing Fable. A missing
  `CLAUDEX_BIN` fails the session closed.
- `codex` (implementer only) runs `codex exec --json` on `CODEX_MODEL` with
  approvals and sandbox bypassed; a new item starts with
  `$astra-ticket <issue>` and later prompts resume the same thread. The
  service account needs the `astra-ticket` skill and the skills it reads
  (`simple-plan`, `create-ticket`, `prepare-pr`, `pr-test-automation`,
  `review`).
  Codex turns receive the Linear MCP server through `-c mcp_servers.*`
  overrides and run without daemon tool hooks, turn cap, or budget cap.
- `agent-farm:<profile>` runs an Agent Farm profile (see
  [daemon/README.md](../../daemon/README.md#agent-farm-harness)).
  `daemonctl config` refuses to select it unless `AGENT_FARM_BIN` resolves
  on the daemon PATH and passes `--help`.

Change harnesses with `daemonctl config --planner <harness> --implementer
<harness>`; it backs up the env file, restarts, health-checks, and restores
the backup on failure.

## Target repository requirements

The repository at `TARGET_REPO_PATH` needs:

1. The dcouple skill system synced in (`.claude/`, `.codex/`,
   `.references/`) through the consumer's `update-skills` flow.
2. A `Work-item tracking` section in its `AGENTS.md` with `tracker: linear`,
   `linear_team: <team key>`, and `artifact_host: https://<daemon-host>`,
   plus instructions to read and update issues through the `linear` MCP
   tools (or the GraphQL API with `LINEAR_API_KEY`).
3. A test and verify flow that runs headlessly on the host. Browser criteria
   use the Playwright capability; iOS criteria use leased simulators on
   prepared macOS hosts, with scheme, bundle ID, and test accounts in the
   consumer `AGENTS.md`.
4. An HTTPS remote. `/do` runs on the non-default branch
   `agents/<identifier>`.

Project MCP servers come from the repository's checked-in `.mcp.json`; see
[mcp-setup.md](mcp-setup.md).

## Linear MCP monitor

With sessions on, the monitor runs an authenticated connect, `listTools`,
and close probe every `LINEAR_MCP_MONITOR_INTERVAL_MS`, bounded by
`LINEAR_MCP_MONITOR_TIMEOUT_MS`. `linear_mcp_probe` records carry state,
transition, failure and retry counts, duration, and a normalized error
category and code. A failed probe does not fail a turn and retries at the
next interval. A `cleanup_timeout` stops further probes until the daemon
restarts. Active turns emit `linear_mcp_turn_init`, `linear_mcp_tool_result`,
and `linear_mcp_turn_close`; close classification is `turn_completed`,
`runner_failed`, or `daemon_shutdown`.

## Browser verification

Enabled by default. A fresh `/do` turn starts with Linear MCP only; when the
work item needs a browser, the daemon records a browser run and resumes the
same session with Playwright MCP, giving each attempt isolated `state/` and
retained `evidence/` directories. Missing Playwright MCP or Chrome fails
browser proof with a typed error. Set `BROWSER_ENABLED=0` and restart to
turn it off.

## Restart recovery

On startup, each interrupted turn with a persisted session resumes once in
the same session, and the continuation tells the agent to verify external
effects before re-running a tool. A detached Codex dispatch still in flight
resumes the parent when its completion marker appears, or after its deadline
plus `DISPATCH_RESUME_GRACE_MS`. Turns without a stored session, explicit
user stops, and `daemonctl restart --hard` get a human-review activity
instead. Reconciliation replays planner replies sent while the daemon was
down; implementer replies sent during downtime must be sent again.

## Notifications

Set `NTFY_URL` (for example `https://ntfy.sh/<topic>`) to push a
notification whenever an agent posts a terminal response or error; errors
post at high priority.
