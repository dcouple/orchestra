# Runbook

Routine procedures for the supported production path: the Linear agent daemon
on macOS. Deep procedures live in [docs/daemon/](docs/daemon/).

## What runs where

- One Apple Silicon Mac runs three system LaunchDaemons as a dedicated
  service account: the daemon (`<prefix>.linear-agent-daemon`, loopback
  `127.0.0.1:8787`), CLIProxyAPI (`<prefix>.cliproxyapi`, loopback
  `127.0.0.1:8317`), and a Cloudflare Tunnel (`<prefix>.cloudflared`) that
  publishes the daemon at `https://<daemon-host>`.
- The deployment's identity (hostname, service account, launchd prefix,
  source repo URL) comes from `site.env`, kept in the consumer repo's docs and
  installed at `/usr/local/etc/linear-agent-daemon/site.env`.
- The daemon runs from `<service home>/linear-agent-daemon`, deployed from
  the persistent checkout `<service home>/orchestra-source`.
- Nothing deploys automatically (CI only checks docs): an operator runs
  every provision, update, and restart.

## Access

Use a key-only SSH alias straight to the service account. `daemonctl` lives
in `/usr/local/sbin` and runs as that account:

```bash
ssh <service-alias> '/usr/local/sbin/daemonctl status'
ssh -t <service-alias> '/usr/local/sbin/daemonctl reload --reason "operator deploy"'
```

The root `Makefile` wraps the same commands (macOS only):

```bash
make daemon-status DAEMON_SSH_HOST=<service-alias>     # also daemon-sessions, daemon-top
make daemon-restart DAEMON_SSH_HOST=<service-alias>    # also daemon-hard-restart
make daemon-reload DAEMON_SSH_HOST=<service-alias>     # daemon-update is an alias
make daemon-config DAEMON_SSH_HOST=<service-alias> PLANNER=claude IMPLEMENTER=claudex
make daemon-subscriptions DAEMON_SSH_HOST=<service-alias> ARGS='list'
```

`ARGS` appends extra arguments to any target (for example
`ARGS='--dry-run'` or `ARGS='--reason "rotate key"'`).

## Provision

First install, after changing `site.env`, or whenever `deploy.sh` reports
`needs-provision` (exit 78): follow [docs/daemon/macos.md](docs/daemon/macos.md).

## Update

1. Merge to `main`, then fast-forward the persistent checkout:

   ```bash
   ssh <service-alias> 'git -C ~/orchestra-source pull --ff-only'
   ```

   `daemonctl status --refresh` fetches and reports
   `revision.reconciliation`: `remote_ahead_pull_required`,
   `checkout_ahead_reload_required`, or `current`.
2. Dry-run, then reload:

   ```bash
   ssh <service-alias> '/usr/local/sbin/daemonctl reload --dry-run'
   ssh -t <service-alias> '/usr/local/sbin/daemonctl reload --reason "deploy <sha>"'
   ```

`reload` never fetches. It requires a clean checkout with an HTTPS origin
whose `HEAD` is a fast-forward descendant of the accepted commit, and does
nothing when that commit is already deployed and accepted. It then deploys
`HEAD` from a detached worktree through `/usr/local/sbin/deploy.sh`, which:

- exits 78 (`needs-provision: <path>`) if any root-owned script, plist, or
  wrapper differs from the new commit; rerun the provisioner;
- rsyncs the source, runs `pnpm install --frozen-lockfile`, `pnpm build`, and
  `pnpm prune --prod`;
- exits 3 (`pending-human`) if the env file lacks `TARGET_REPO_PATH`,
  `LINEAR_API_KEY`, `DO_PERMISSION_MODE`, or `DO_MAX_TURNS`, or CLIProxyAPI
  does not serve `gpt-5.6-sol`;
- restarts the daemon, writes `deployed-commit`, waits for health, then
  writes `accepted-commit`.

Markers live in `<service home>/.local/state/linear-agent-operations/`.
Active turns are interrupted at the restart and resume on startup; webhooks
keep arriving.

## Rollback

A failed reload rolls back automatically: it deploys the previous accepted
commit and reports `reload failed; rollback accepted`. If the rollback also
fails health, the operation is `blocked`; fix the named stage, then run
`daemonctl operation retry <id>` (or `operation cancel <id>`).

To roll back a release that deployed cleanly, revert it on `main`, pull, and
reload. `reload` only moves forward, so a revert commit is the rollback.

## Restart

```bash
ssh -t <service-alias> '/usr/local/sbin/daemonctl restart --reason "<why>"'
ssh -t <service-alias> '/usr/local/sbin/daemonctl restart --hard'
```

`restart` kickstarts the daemon and health-checks it; interrupted turns
resume. `restart --hard` asks for `HARD-RESTART` (or `--yes`) and leaves
interrupted turns for human review. Restart the Mac itself only with the
host wrapper in [machines/mac-mini](machines/mac-mini/README.md).

## Health

```bash
ssh <service-alias> 'curl -fsS http://127.0.0.1:8787/healthz'
curl -fsS https://<daemon-host>/healthz
ssh <service-alias> '/usr/local/sbin/daemonctl top'
```

Health returns `{"ok":true,"sim":{...}}`. Acceptance (used by `restart`,
`reload`, and `config`) requires `launchctl print` to show
`state = running` and `/healthz` to report `ok: true` within 30 one-second
attempts. `daemonctl status` adds `service.state`, the revision markers,
pending operations, and Codex version drift.

## Database and migrations

The database is `<service home>/events.db` (SQLite, WAL). Schema changes
apply automatically when the daemon starts and are additive (new tables and
columns); there are no down-migrations and no automatic backups. Before a
risky update, back it up as the service account:

```bash
ssh <service-alias> 'sqlite3 ~/events.db ".backup $HOME/events-$(date -u +%Y%m%dT%H%M%SZ).db"'
```

## Config and secrets

| File | Owner and mode | Holds |
|---|---|---|
| `/usr/local/etc/linear-agent-daemon/site.env` | root, 0644 | Deployment identity, no secrets |
| `<service home>/.config/linear-agent-daemon/env` | service account, 0600 | Daemon settings and Linear secrets |
| `<service home>/.config/linear-agent-daemon/cliproxyapi.env` | service account, 0600 | `CLIPROXY_API_KEY`, `CLIPROXY_MANAGEMENT_KEY` |
| `<service home>/.config/linear-agent-daemon/cliproxyapi.yaml` | service account, 0600 | Generated proxy config |
| `<service home>/.cli-proxy-api/` | service account, 0700 | Subscription OAuth credentials |

Change harnesses with `daemonctl config` (it backs up the env file and
restores it if health fails); edit other settings in the env file, then
`daemonctl restart`. Variables: [docs/daemon/configuration.md](docs/daemon/configuration.md).
Project MCP secrets: [docs/daemon/mcp-setup.md](docs/daemon/mcp-setup.md).
Credentials and rotation: [credential inventory](docs/daemon/operations.md#credential-inventory).
Subscription accounts: `daemonctl subscriptions list|add|remove|reauth`.

## Logs and recovery

Logs are in `<service home>/Library/Logs/` (`linear-agent-daemon.log`,
`cliproxyapi.log`, `cloudflared.log`). Error events and recovery steps:
[docs/daemon/operations.md](docs/daemon/operations.md#logs-and-recovery).

## Host

The Mac itself (power, SSH, Tailscale, updates, heartbeat) is in
[machines/mac-mini/README.md](machines/mac-mini/README.md).

## Skill releases

Merge skill changes to `main`. Each consumer repo runs its `update-skills`
script, which syncs this repo's `main` and opens (or updates) a
`chore/orchestra-sync` PR there; merging that PR releases the skills to the
consumer. To roll back, revert on `main` and run the consumer sync again.

## Linux

A Linux/systemd deployment exists but is unverified: see
[docs/daemon/operations.md](docs/daemon/operations.md#linux-legacy-unverified).
