# Daemon operations: deep procedures

One-time setup and less frequent procedures for the Linear agent daemon.
Routine update, rollback, restart, and health checks are in
[RUNBOOK.md](../../RUNBOOK.md); settings are in
[configuration.md](configuration.md); macOS provisioning is in
[macos.md](macos.md).

Commands below run as the service account in an interactive login
(`ssh -t <host> 'sudo -u <user> -i'`, see [macos.md](macos.md)). `<service
home>` is `DAEMON_SERVICE_HOME` from the site config. Capture only redacted
output: never paste tokens, raw credential files, prompts, or database files
into a record.

## Register the Linear OAuth apps

In Linear (**Settings → API → OAuth applications**) create two applications,
`<planner-app>` and `<implementer-app>`. For each:

1. Turn on **Client credentials** (`actor=app`); a workspace admin authorizes
   the installation. The daemon requests
   `read,write,app:assignable,app:mentionable` at token time; the app form has
   no scopes field.
2. Turn on **Webhooks** with URL `https://<daemon-host>/webhook/planner` or
   `https://<daemon-host>/webhook/implementer`, and check **Agent session
   events** under App events.
3. Check **Issues** under Data change events on both apps. Completed-issue
   events drive worktree cleanup; the daemon consumes only these two
   categories.
4. Leave **Public** off. If the form requires a redirect URI, any
   `https://<daemon-host>/...` value works; client credentials never use it.
5. Record the client ID, client secret, and webhook signing secret straight
   into the env file as `PLANNER_*` / `IMPLEMENTER_*` values
   ([configuration.md](configuration.md#listener-and-linear-apps)), and set
   both `*_APP_ACTOR_ID` values so reconciliation can discover sessions.

Create a Linear API key for a dedicated bot account (**Settings → Security &
access → API keys**) and set it as `LINEAR_API_KEY`; agent edits made through
the Linear MCP server are attributed to that account.

App tokens last 30 days, persist in SQLite, and are reacquired on expiry or a
401. To rotate a client secret, rotate it in Linear, update the env file, and
restart; revoking the app installation cuts access immediately. If Linear
disables a webhook after repeated delivery failures, it emails workspace
admins; an admin re-enables it in the app's settings. Meanwhile
reconciliation recovers sessions and activities within one sweep.

## Planner credentials and repository

Use a dedicated bot identity and HTTPS remotes only:

```bash
git config --global user.name '<bot display name>'
git config --global user.email '<bot email>'
git config --global credential.helper store
read -rsp "GitHub fine-grained PAT: " GITHUB_PAT; printf "\n"
( umask 077; printf "https://x-access-token:%s@github.com\n" "$GITHUB_PAT" > "$HOME/.git-credentials" )
unset GITHUB_PAT
git clone https://github.com/<owner>/<consumer-repo>.git ~/repos/<consumer-repo>
gh auth login --git-protocol https
gh auth status
```

Scope the PAT (or a GitHub App token) to the target repository with contents
and pull-request write. Set `TARGET_REPO_PATH` to the clone. `GH_TOKEN` or
`GITHUB_TOKEN` may instead go in the env file. Verify with
`git -C ~/repos/<consumer-repo> push --dry-run origin HEAD` and one disposable
draft PR.

## Subscription pool and provider gate

CLIProxyAPI routes Claude Code and every subagent through GPT-5.6 Sol on the
Codex OAuth pool (main loop at high effort; `-low`, `-medium`, and `-xhigh`
aliases for pinned models). Manage the pool with `daemonctl`:

```bash
daemonctl subscriptions list
daemonctl subscriptions add codex --dry-run
daemonctl subscriptions add codex        # repeat per account
daemonctl subscriptions add claude       # repeat per account
daemonctl subscriptions reauth codex <selector>
daemonctl subscriptions remove <selector> --yes
```

`add` runs the provider's `--no-browser` login; open the printed URL on
another device. Re-running `add` re-logs that identity. `list` prints only
redacted fields. New credentials hot-load without a proxy restart.

Verify the chain:

```bash
CLIPROXY_ENV_FILE=~/.config/linear-agent-daemon/cliproxyapi.env ~/.local/bin/claudex -p "Reply with exactly: claudex works."
```

The model catalog must include `gpt-5.6-sol` and its three aliases; an empty
list means the Codex login did not complete. A Claude credential counts as
usable only after one real Messages request through the proxy succeeds with a
`claude-*` model from `/v1/models`.

Provisioning runs `codex-provider-gate.sh` once an enabled Codex credential
exists. On `PASS` it installs the standalone Codex provider config in
`~/.codex/config.toml` and records the qualified Codex version, which
`daemonctl status` compares with the running version (`codex.state`:
`qualified`, `drifted`, `never_qualified`, or `unavailable`). The managed
Codex self-updates, so `drifted` is expected after an update; rerun
provisioning to re-qualify it.

## Fable routing

Fable stays off until enrolled Claude accounts serve confirmed `claude-*`
models. List them:

```bash
. ~/.config/linear-agent-daemon/cliproxyapi.env
printf 'header = "Authorization: Bearer %s"\n' "$CLIPROXY_API_KEY" |
  curl -fsS -K - http://127.0.0.1:8317/v1/models | python3 -m json.tool | grep '"id": "claude-'
```

After a request through one of them succeeds, write
`~/.config/linear-agent-daemon/fable-models.env` with `FABLE_MAIN_MODEL`,
`FABLE_HAIKU_MODEL`, `FABLE_SONNET_MODEL`, `FABLE_OPUS_MODEL`, and
`FABLE_FABLE_MODEL`, each a `claude-*` model from the catalog. Then set
`FABLE_BIN=<service home>/.local/bin/claudex-fable` and `FABLE_MODELS_ENV_FILE`
in the env file and restart. Provider readiness is visible with the
management key:

```bash
. ~/.config/linear-agent-daemon/cliproxyapi.env
printf 'header = "Authorization: Bearer %s"\n' "$CLIPROXY_MANAGEMENT_KEY" |
  curl -fsS -K - http://127.0.0.1:8787/healthz | python3 -m json.tool
```

`providers.claude.status` must be `ready` before new sessions route to Fable.
A session's route is fixed at creation; sessions stored without a profile
route as Sol.

## Telemetry

Claude Code native OpenTelemetry traces can go to Langfuse Cloud. Add to the
env file:

```dotenv
CLAUDE_CODE_ENABLE_TELEMETRY=1
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
OTEL_TRACES_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=https://us.cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64(public-key:secret-key)>"
OTEL_METRICS_EXPORTER=none
OTEL_LOGS_EXPORTER=none
OTEL_LOG_USER_PROMPTS=1
OTEL_LOG_ASSISTANT_RESPONSES=1
```

Langfuse ingests traces only, so keep metrics and logs off. The header is a
secret and stays in the 0600 env file. The daemon keeps the upstream endpoint
and header in its own process and gives each turn a loopback relay
capability. One trace covers a whole Linear session, with one
`orchestra.turn` span per prompt or resume; the session root is emitted once
after the issue completes and every enrichment settles (or its 30-second
deadline passes). Requires Claude Code 2.1.214 or newer.

The `/usr/local/bin/codex` wrapper instruments daemon Codex dispatches: it
mints the dispatch span, strips inherited telemetry and proxy credentials
before the real Codex starts, forwards signals to it, and writes a
credential-free `.otel.json` sidecar beside the dispatch artifacts.
Non-daemon invocations pass through unchanged.

## Smokes

Run these against throwaway issues after provisioning or a risky change.

1. **Ingress**: `curl -fsS https://<daemon-host>/healthz` returns
   `{"ok":true,"sim":{...}}`. Assign `<planner-app>` to an issue; the log
   shows a `webhook` event and the issue shows the "picked up - starting work"
   thought within 10 seconds.
2. **Planner**: the turn streams thoughts and ends in a response. Reply; the
   same session and worktree resume. Restart the daemon between turns and
   reply again.
3. **Implementer**: assign `<implementer-app>` to a plan-ready issue. `/do`
   runs unattended on `agents/<identifier>`, opens a PR, and the PR appears
   on the session. Move the issue to a `completed` state: a clean worktree
   and its branch are removed, while a dirty worktree or one with unpushed
   commits is kept and named in a thought.

Evidence queries (as the service account):

```bash
sqlite3 ~/events.db "select linear_session_id,issue_identifier,worktree_path,branch,status from sessions order by last_seen_at desc limit 10;"
sqlite3 ~/events.db "select id,linear_session_id,kind,status,error from turns order by id desc limit 20;"
sqlite3 ~/events.db "select issue_identifier,status,attempts,error from cleanup_jobs order by id desc limit 10;"
```

## Browser verification rollout and rollback

Provisioning installs the exact `@playwright/mcp` version pinned in
`daemon/package.json` and maintains `/usr/local/bin/playwright-mcp`. Run the
browser smoke as the service account after a change to the browser stack:

```bash
cd ~/linear-agent-daemon
PLAYWRIGHT_MCP_BIN=/usr/local/bin/playwright-mcp \
PLAYWRIGHT_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
BROWSER_E2E_OUTPUT_DIR=~/artifacts/browser-smoke/$(date -u +%Y%m%dT%H%M%SZ) \
/opt/homebrew/opt/node@22/bin/node ops/browser-smoke.mjs
```

It must exit 0 with a completed manifest and leave no MCP or Chrome
processes. To roll back, set `BROWSER_ENABLED=0` and restart; non-browser
sessions are unaffected.

## Credential inventory

Paths are for macOS (`~` is the service home); Linux equivalents live in
`/etc/linear-agent-daemon/` and `/var/lib/linear-agent-daemon/`.

| Credential | Location | Scope | Rotation or revocation |
|---|---|---|---|
| Webhook signing secrets (2) | env file, 0600 | Verify one app route each | Rotate in the app, update env, restart |
| OAuth client IDs and secrets (2) | env file, 0600 | Agent scopes | Rotate or revoke the app; update env, restart |
| SQLite database | `~/events.db*`, 0600 | Raw payloads and OAuth access tokens | Back up with SQLite's backup command; revoke the apps if exposed |
| Bot git and gh identity | `~/.gitconfig`, `~/.git-credentials` (0600), or `GH_TOKEN` in env | One repository | Revoke the PAT or app token and replace |
| Codex provider selection | `~/.codex/config.toml` | Loopback provider, no token | Rerun provisioning (gate) |
| CLIProxyAPI subscription OAuth | `~/.cli-proxy-api/` | Enrolled Codex and Claude subscriptions | Revoke at the provider, `daemonctl subscriptions reauth` or `add` |
| CLIProxyAPI API and management keys | `~/.config/linear-agent-daemon/cliproxyapi.env` and `.yaml` | Loopback proxy and management API | Replace both values, rerun provisioning |
| `LINEAR_API_KEY` | env file | Bot account | Revoke in Linear, replace, restart |
| `ARTIFACT_TOKEN` | env file | Artifact writes; exposed to sessions as `ARTIFACT_HOST_TOKEN` | Replace, restart |
| Langfuse OTLP header | env file | One Langfuse project | Rotate project keys, replace, restart |
| Project MCP tokens | env file | Per [mcp-setup.md](mcp-setup.md) | Per [mcp-setup.md](mcp-setup.md#7-rotate-and-revoke) |

Install subscription OAuth only through `daemonctl subscriptions`; never copy
raw token files onto the host.

## Logs and recovery

On macOS the logs are `~/Library/Logs/linear-agent-daemon.log`,
`cliproxyapi.log`, and `cloudflared.log`; on Linux use
`journalctl -u linear-agent-daemon` (and `cliproxyapi`, `caddy`,
`codex-live`). Logs carry delivery, session, and issue IDs but no webhook
bodies or tokens.

Investigate `ack_failed`, `terminal_activity_delivery_failed`,
`session_turn_unhandled`, `external_url_delivery_failed`, `cleanup_failed`,
and `cleanup_notification_failed`. Inspect `turns` rows in `failed` or
`interrupted` and `turn_activities` rows in `failed`; when retrying, keep the
durable activity ID so Linear accepts the duplicate idempotently. Do not edit
turn status by hand.

Filter Linear MCP health without printing tokens:

```bash
grep -E '"event":"linear_mcp_(probe|turn_init|tool_result|turn_close)"' ~/Library/Logs/linear-agent-daemon.log | tail -n 50
```

After a `cleanup_timeout`, investigate and then restart the daemon; the
monitor stays paused until then. The daemon does not stop when CLIProxyAPI
restarts: webhook ingestion continues, and a turn that fails during a proxy
outage is recorded and can be resumed.

## Linux (legacy, unverified)

Unverified; a fresh bootstrap fails at the first `daemonctl reload`.
`reload` requires the `accepted-commit` marker, and `provision.sh` writes it
only when it restarts the daemon (the env file is populated) from a git
checkout whose commit exists in `/opt/orchestra-source`. On a new host,
rerun the provisioner after populating the env file.

Provision an Ubuntu 24.04 host from an orchestra git checkout, with a DNS
name already pointing at it:

```bash
cd <orchestra-checkout>/daemon
sudo DAEMON_HOST=<daemon-host> ops/provision.sh "$PWD"
```

It installs Node 22, pnpm 11.8, gh, CLIProxyAPI, Claude Code, the managed
Codex (`/opt/codex-live/bin/codex`, behind the `/usr/local/bin/codex`
wrapper), Chrome, Caddy (TLS, 32MB request-body cap, reverse proxy to
`127.0.0.1:8787`), and UFW (SSH and 443 only). It creates the `linear-daemon`
user, deploys to `/opt/linear-agent-daemon`, clones `/opt/orchestra-source`,
and installs the units `linear-agent-daemon`, `cliproxyapi`, `codex-live`,
`linear-agent-operation.service`, and `linear-agent-operation.path`.
`INSTALL_ANDROID=1` adds the Android SDK and an emulator image.

Paths: env `/etc/linear-agent-daemon/env` (0600 linear-daemon), proxy files
`/etc/linear-agent-daemon/cliproxyapi.env` and `.yaml` (0640
root:linear-daemon), state `/var/lib/linear-agent-daemon`, markers and
operation requests `/var/lib/linear-agent-operations`.

`daemonctl` needs root: `sudo daemonctl status|sessions|top|config|restart|reload|subscriptions|operation`.
Mutations write a root-owned request file that the operation unit executes;
`reload` provisions the checkout's `HEAD` from a detached worktree and rolls
back to the accepted commit on failure. The Makefile targets do not apply.

### Codex live (voice) session

Linux hosts only. A second Codex home (`~/.codex-live`, direct ChatGPT
credentials, instructions from `daemon/ops/codex-live-AGENTS.md`, workspace
`~/live`) runs as the `codex-live` unit and shares the managed Codex binary.
Provisioning installs Codex when it is missing or older than
`CODEX_LIVE_MIN_VERSION` in `provision.sh`; the install self-updates, so
raising the floor is the only lever. Enable it once the account (with MFA)
has logged in:

```bash
sudo runuser -u linear-daemon -- env HOME=/var/lib/linear-agent-daemon \
  CODEX_HOME=/var/lib/linear-agent-daemon/.codex-live \
  /opt/codex-live/bin/codex login --device-auth
sudo systemctl enable --now codex-live
sudo daemonctl live status
sudo daemonctl live pair     # single-use code for the Codex app
```

`daemonctl live status|pair|restart|stop|logs` operates it; enrolment errors
are in `~/.codex-live/app-server-daemon/app-server.stderr.log`. Roll back with
`sudo systemctl disable --now codex-live`; nothing else reads its home.

### Android emulator smoke

Linux hosts provisioned with `INSTALL_ANDROID=1`. Run twice to prove
idempotency and record whether KVM was used:

```bash
sudo -u linear-daemon -H env ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_AVD_NAME=linear-smoke \
  ANDROID_PACKAGE_NAME=<package> ANDROID_SCREENSHOT_PATH=/var/lib/linear-agent-daemon/android-smoke.png \
  /opt/linear-agent-daemon/ops/android-smoke.sh /path/to/app.apk
```
