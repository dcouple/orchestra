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
configuration, idle-aware restart and checkout reload, safe status/running-turn and
compute views, and interactive subscription maintenance. Normal mutations persist one
operation and stop new turn claims while signed webhooks continue to be stored and
acknowledged. A root-owned request file authorizes the privileged executor; SQLite alone
never authorizes root work. `daemonctl restart --hard` is the only path that may interrupt
turns, requires explicit confirmation, and never requeues them.

The root repository `Makefile` forwards the same commands over GCE SSH; it contains no
deployment logic. Its local transport builds an argv vector and uses Python `shlex` parsing
and quoting so operator values remain daemonctl arguments rather than local or remote shell
syntax. The operator alone fetches, reviews, and fast-forwards the persistent HTTPS checkout;
`daemonctl reload` never fetches or runs candidate validation. It deploys that exact clean
checkout commit through the existing provisioner, records deployed and accepted markers
around health acceptance, and rolls back to the prior accepted commit on failure.
`daemonctl update` remains a compatibility alias. See `ops/runbook.md` for pending/blocked
recovery, revision reconciliation, and the human-only production smoke procedure.

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
    { "path": "item.md", "contentBase64": "IyBJdGVtCg==" },
    { "path": "refs/explainer.html", "contentBase64": "PGgxPkV4cGxhaW5lcjwvaDE+" }
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
`PLANNER_HARNESS` and `IMPLEMENTER_HARNESS` (independent `claude | claudex`
preferences, both default `claude`),
`CLAUDE_BIN` (default `claude`, whitespace-split for a command prefix),
`CLAUDEX_BIN` (optional, whitespace-split; required for a direct `claudex`
preference and for Sol fallback — point it at the provisioned `claudex` wrapper),
`CLAUDEX_ENV` (optional JSON string map of
extra child env for `CLAUDEX_BIN`; requires `CLAUDEX_BIN`),
`FABLE_BIN` (optional; normally the installed `ops/claudex-fable` launcher),
`CLIPROXY_ENV_FILE`, `CLIPROXY_URL`, `PROVIDER_PROBE_INTERVAL_MS`,
`PROVIDER_STATE_STALE_MS`, and `PROVIDER_INITIAL_PROBE_TIMEOUT_MS`,
`CLAUDE_PERMISSION_MODE` (`bypassPermissions`), `CLAUDE_MAX_TURNS` (100),
`BASH_DEFAULT_TIMEOUT_MS` (900000) and `BASH_MAX_TIMEOUT_MS` (900000),
`LINEAR_MCP_MONITOR_INTERVAL_MS` (60000) and
`LINEAR_MCP_MONITOR_TIMEOUT_MS` (10000),
`DO_PERMISSION_MODE` (`bypassPermissions`; production rejects every other value),
`DO_MAX_TURNS` (300), `DO_MAX_BUDGET_USD` (optional positive number),
`SESSION_CONCURRENCY` (2), `KEEPALIVE_MS` (900000), `ATTACHMENTS_ENABLED` (1), and
`ATTACHMENT_HOSTS` (`uploads.linear.app`). Set `SESSIONS_ENABLED=0` for ingress-only runs.
For a new role session, `claude` prefers the Fable launcher and retains readiness routing
plus the one-shot structured capacity fallback to Claudex/GPT-Sol; `claudex` starts
Claudex/GPT-Sol immediately without probing Fable. The resolved harness and session ID are
persisted together, so later prompts, restarts, fix rounds, and preference changes continue
on the established harness. Missing `CLAUDEX_BIN` fails a selected Claudex session closed;
it never starts a replacement Claude session.

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

On startup, a stale running turn is automatically resumed exactly once only when it has a
persisted Claude session and no unresolved tool call. The old turn remains interrupted and a
deterministically keyed continuation resumes the same session. An unresolved tool boundary,
missing Claude session, explicit user stop, or recorded hard restart requires human review;
the daemon never guesses whether an external action completed. Routine `daemonctl` config,
restart, and reload operations still drain running turns before mutation. Daemon-owned
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

Browser verification is opt-in with `BROWSER_ENABLED=1` and remains off by
default. `PLAYWRIGHT_MCP_BIN` defaults to `/usr/local/bin/playwright-mcp`,
`PLAYWRIGHT_CHROME_BIN` to `/usr/bin/google-chrome`, and
`BROWSER_ATTEMPT_TIMEOUT_MS` to four hours. A fresh `/do` turn starts with
Linear MCP only and a private request file. After `/do` loads the authoritative
item, browser-required work writes the marker and returns the internal relaunch
sentinel; the daemon persists the browser run id and resumes the same session
with official Playwright MCP. Each execution gets isolated `state/` and
retained `evidence/` roots. MCP/Chrome/target failures are classified and fail
browser proof; non-browser, planner, reviewer, and backend paths never attach
Playwright.
Set `NTFY_URL` to an ntfy topic URL (e.g. `https://ntfy.sh/<topic>`) to push a one-way
notification whenever an agent posts a terminal response or error — errors post at high
priority. Unset means no notifications. A public ntfy topic is readable by anyone who knows
its name; the notification body carries the agent's reply text, so pick an unguessable topic
and never put secrets in issues if you use one.

See `ops/runbook.md` for host provisioning, OAuth registration, credentials, hardening,
deployment, smoke tests, and recovery.
