# Linear agent daemon

This orchestra-only Node 22 service receives signed Linear AgentSessionEvent webhooks for
the separate planner and implementer OAuth apps. It verifies each raw request, appends it
to SQLite, and acknowledges new sessions asynchronously with an ephemeral thought. Phase 1
does not invoke Claude or create worktrees.

## Local checks

Use pnpm 11.8 and Node 22.23 or compatible Node 22 releases:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
bash -n ops/provision.sh
```

The Vitest suite is hermetic: it uses loopback HTTP servers and temporary real SQLite
databases, requires no environment variables, and makes no internet or Linear requests.
Tests cover signature/timestamp rejection, real HTTP ingress, durable dedupe, route
isolation, OAuth token persistence, and ack-worker restart/idempotency contracts. The
deploy-time AC3 and AC5 checks require a provisioned VPS and registered Linear apps and
are documented in `ops/runbook.md`.

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
DB_PATH=./events.db \
node dist/index.js
```

The listener defaults to `127.0.0.1:8787`. Routes are `POST /webhook/planner`, `POST
/webhook/implementer`, and `GET /healthz`. `LINEAR_TOKEN` variables with the corresponding
app prefix are test-only static overrides and are ignored unless `DAEMON_TEST_MODE=1`;
production uses client credentials. Optional settings are `PORT`, `BIND_ADDR`,
`REPLAY_WINDOW_MS`, `LINEAR_GRAPHQL_URL`, and `LINEAR_TOKEN_URL`.

See `ops/runbook.md` for host provisioning, OAuth registration, credentials, hardening,
deployment, smoke tests, and recovery.
