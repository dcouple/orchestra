# Linear agent daemon

An orchestra-only Node service that receives signed Linear agent-session
webhooks for a planner app and an implementer app, stores them in SQLite, and
runs each issue's agent turns (planner discussions and unattended `/do` runs)
in per-issue git worktrees, streaming progress back to Linear.

## Requirements

Node 22 (`engines`: `>=22 <23`) and pnpm 11 (`packageManager`: `pnpm@11.8.0`).
On a machine whose default Node is another major version, put a Node 22
install first on `PATH` before any `pnpm` command; native modules such as
`better-sqlite3` do not build otherwise.

## Local checks

Run from `daemon/`:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
for f in ops/provision.sh ops/daemonctl ops/wait-for-daemon-health.sh ops/claudex \
    ops/claudex-fable ops/proxy-accounts.sh ops/codex-provider-gate.sh ops/codex-live-setup.sh \
    ops/macos/provision.sh ops/macos/deploy.sh ops/macos/daemonctl ops/macos/daemon-site-lib.sh \
    ops/macos/run-daemon.sh ops/macos/run-cliproxyapi.sh ops/macos/run-cloudflared.sh \
    ops/macos/sim-context-probe.sh ops/macos/orchestra-sim test/fixtures/fake-sudo.sh; do
  bash -n "$f" || exit 1
done
```

`pnpm test` is hermetic: it uses loopback HTTP servers, temporary SQLite
databases, and temporary directories under `$TMPDIR`, needs no environment
variables, and makes no internet or Linear requests. With `CLIPROXY_BIN`
pointing at the pinned CLIProxyAPI binary, the proxy integration suite also
runs.

The browser suite is optional and needs Playwright MCP and Chrome:

```bash
PLAYWRIGHT_MCP_BIN="$PWD/node_modules/.bin/playwright-mcp" \
PLAYWRIGHT_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
BROWSER_E2E_OUTPUT_DIR="../tmp/browser-smoke" pnpm test:browser
```

## Run locally

Build, then start with both apps' secrets. `SESSIONS_ENABLED=0` gives an
ingress-only run:

```bash
pnpm build
WEBHOOK_BASE_URL=http://127.0.0.1:8787 \
PLANNER_WEBHOOK_SECRET=... \
PLANNER_LINEAR_CLIENT_ID=... \
PLANNER_LINEAR_CLIENT_SECRET=... \
IMPLEMENTER_WEBHOOK_SECRET=... \
IMPLEMENTER_LINEAR_CLIENT_ID=... \
IMPLEMENTER_LINEAR_CLIENT_SECRET=... \
SESSIONS_ENABLED=0 \
DB_PATH=./events.db \
node dist/index.js
```

The listener binds `127.0.0.1:8787`. In an ingress-only run with
`PLANNER_APP_ACTOR_ID` and `IMPLEMENTER_APP_ACTOR_ID` unset, the daemon makes
no outbound calls until a webhook arrives; a new session webhook triggers an
acknowledgement to Linear. Setting the actor IDs turns on session
reconciliation against the Linear API. With sessions on, also set
`TARGET_REPO_PATH` and `LINEAR_API_KEY`; the daemon then contacts Linear's API
and its MCP server (`LINEAR_MCP_URL`) and launches the configured harness.
`pnpm dev` runs the built daemon with `node --watch`. Every setting is in
[docs/daemon/configuration.md](../docs/daemon/configuration.md).

## Agent Farm harness

Set `PLANNER_HARNESS=agent-farm:<profile>` or
`IMPLEMENTER_HARNESS=agent-farm:<profile>` (for example
`agent-farm:greenfield/implementer`). Each turn runs:

```text
agent-farm inspect <profile> --directory <worktree>
agent-farm run <profile> --directory <worktree> --print-launch --message=<prompt> -- <native flags>
```

The daemon reads the profile's native harness (`agents.main.harness`), adds
the matching Claude or Codex flags, checks the printed bundle's
`manifest.json`, and spawns the printed `argv` in the printed `cwd` with the
daemon's filtered child environment plus Agent Farm's printed overrides. The
profile owns the model, effort, skills, instructions, and child agents.
Connections (Linear MCP, XcodeBuildMCP, and the Playwright launcher
`/usr/local/libexec/orchestra-agent-farm-browser`) come from the Agent Farm
workspace, which macOS provisioning installs from the Agent Farm workspace
profile under `ops/agent-farm/`. `AGENT_FARM_BIN` (default `agent-farm`)
names the executable.

## Operations

- [RUNBOOK.md](../RUNBOOK.md): update, rollback, restart, health.
- [docs/daemon/macos.md](../docs/daemon/macos.md): macOS provisioning.
- [docs/daemon/configuration.md](../docs/daemon/configuration.md): settings and harness routing.
- [docs/daemon/operations.md](../docs/daemon/operations.md): Linear apps, credentials, smokes, Linux.
- [docs/daemon/mcp-setup.md](../docs/daemon/mcp-setup.md): project MCP servers.
