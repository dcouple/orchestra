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
bash -n ops/provision.sh ops/claudex
```

The Vitest suite is hermetic: it uses loopback HTTP servers and temporary real SQLite
databases, requires no environment variables, and makes no internet or Linear requests.
Tests cover phase-1 ingress plus durable planner queues, real temporary git worktrees, and a
fake stream-json Claude executable. They require no network, Linear credentials, or Claude
account. Real Linear/Claude/systemd acceptance remains a deploy-time gate in `ops/runbook.md`.

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

Planner sessions default on. `TARGET_REPO_PATH` and `LINEAR_API_KEY` are required when
enabled. Optional session settings are `WORKTREES_ROOT` (defaults beside the database),
`CLAUDE_BIN` (default `claudex`, whitespace-split for a command prefix; set `claude`
explicitly for Anthropic-backed local development),
`CLAUDE_PERMISSION_MODE` (`bypassPermissions`), `CLAUDE_MAX_TURNS` (100),
`DO_PERMISSION_MODE` (`bypassPermissions`; production rejects every other value),
`DO_MAX_TURNS` (300), `DO_MAX_BUDGET_USD` (optional positive number),
`SESSION_CONCURRENCY` (2), `KEEPALIVE_MS` (900000), `ATTACHMENTS_ENABLED` (1), and
`ATTACHMENT_HOSTS` (`uploads.linear.app`). Set `SESSIONS_ENABLED=0` for ingress-only runs.
Set `NTFY_URL` to an ntfy topic URL (e.g. `https://ntfy.sh/<topic>`) to push a one-way
notification whenever an agent posts a terminal response or error — errors post at high
priority. Unset means no notifications. A public ntfy topic is readable by anyone who knows
its name; the notification body carries the agent's reply text, so pick an unguessable topic
and never put secrets in issues if you use one.

See `ops/runbook.md` for host provisioning, OAuth registration, credentials, hardening,
deployment, smoke tests, and recovery.
