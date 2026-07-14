# Linear agent daemon provisioning and operations

Provisioning and OAuth registration are human-controlled deploy gates. Do not run this
runbook from an automated agent. Real Linear, Claude, and systemd acceptance is not closed
until the live smoke checks below are captured.

## Host and DNS

Use a Hetzner AX41-NVMe-class dedicated server with Ubuntu 24.04. Its bare-metal KVM is
needed by phase 4. A GCP N2/C2 Intel VM with nested virtualization enabled is the fallback.
Create an `A`/`AAAA` record such as `linear-agent.example.com` before provisioning.

Create a named administrator account with its SSH public key. Before closing the original
session, open a second key-authenticated session and then harden SSH:

```bash
sudoedit /etc/ssh/sshd_config.d/99-linear-daemon.conf
# PasswordAuthentication no
# KbdInteractiveAuthentication no
# PermitRootLogin no
sudo sshd -t && sudo systemctl reload ssh
sshd -T | grep -Ei 'passwordauthentication|kbdinteractiveauthentication|permitrootlogin'
```

Copy this `daemon/` directory to the host, then run the idempotent provisioner as root:

```bash
cd daemon
bash -n ops/provision.sh
sudo DAEMON_HOST=linear-agent.example.com ops/provision.sh "$PWD"
```

It installs Node 22, pnpm 11.8, Git, pinned GitHub CLI and Codex CLI releases, Claude Code, Caddy, UFW, the dedicated `linear-daemon` user, and the
systemd unit. It also installs the `sqlite3` CLI used by the smoke checks. It deploys with
`pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod`. Caddy terminates TLS,
enforces a 1 MB request-body cap, and proxies only to the daemon's loopback listener.

Supply-chain note: the provisioner keeps the vendor-supported `curl | bash` bootstrap paths
for NodeSource and pnpm so the script remains runnable on a clean host. Before production
use, fetch the scripts once, review and pin their checksums in your deployment notes where
practical, and rely on the pinned pnpm version plus `pnpm install --frozen-lockfile` for the
application dependency graph. Caddy packages are installed from the signed Cloudsmith apt
repository. The Claude native installer is another vendor `curl | bash` path: review and
checksum the downloaded installer before production provisioning when practical.

The default firewall permits only SSH and HTTPS. Linear currently publishes these webhook
source IPs: `35.231.147.226`, `35.243.134.228`, `34.140.253.14`, `34.38.87.206`,
`34.134.222.122`, and `35.222.25.142`. Check the current Linear webhook documentation
before optionally replacing the broad `ufw allow 443/tcp` rule with per-IP rules. Caddy's
certificate issuance and external health checks also need consideration before restricting
port 443.

## Register the two OAuth apps

In Linear, create `bloom-planner` and `bloom-implementer` separately. For each app:

1. Enable client-credentials tokens and request comma-separated scopes
   `read,write,app:assignable,app:mentionable`; use `actor=app`. A workspace admin must
   authorize the installation. Never request `admin` with an app actor.
2. Enable webhooks, select **Agent session events**, and use respectively
   `https://linear-agent.example.com/webhook/planner` or `/webhook/implementer`.
   On bloom-implementer also enable the **Issues** category. If Linear requires a separate
   webhook subscription, point it at the same implementer route with the same signing secret;
   the daemon dispatches by payload `type`.
3. Record the client ID, client secret, and webhook signing secret directly in the host env
   file. Do not put credentials in shell history or the repository.

```bash
sudoedit /etc/linear-agent-daemon/env
sudo chown linear-daemon:linear-daemon /etc/linear-agent-daemon/env
sudo chmod 600 /etc/linear-agent-daemon/env
sudo systemctl restart linear-agent-daemon
```

The file must contain:

```dotenv
PORT=8787
BIND_ADDR=127.0.0.1
DB_PATH=/var/lib/linear-agent-daemon/events.db
PLANNER_WEBHOOK_SECRET=...
PLANNER_LINEAR_CLIENT_ID=...
PLANNER_LINEAR_CLIENT_SECRET=...
IMPLEMENTER_WEBHOOK_SECRET=...
IMPLEMENTER_LINEAR_CLIENT_ID=...
IMPLEMENTER_LINEAR_CLIENT_SECRET=...
SESSIONS_ENABLED=1
TARGET_REPO_PATH=/var/lib/linear-agent-daemon/repos/bloom-mono
WORKTREES_ROOT=/var/lib/linear-agent-daemon/worktrees
LINEAR_API_KEY=...
CLAUDE_BIN=/var/lib/linear-agent-daemon/.local/bin/claude
CLAUDE_PERMISSION_MODE=bypassPermissions
CLAUDE_MAX_TURNS=100
DO_PERMISSION_MODE=bypassPermissions
DO_MAX_TURNS=300
# DO_MAX_BUDGET_USD=50
SESSION_CONCURRENCY=2
KEEPALIVE_MS=900000
ATTACHMENTS_ENABLED=1
ATTACHMENT_HOSTS=uploads.linear.app
```

The daemon requests 30-day client-credentials app tokens and persists their expiry in
SQLite. It reacquires on expiry or an API 401. Rotate a client secret in Linear, update the
matching host value, restart, and verify an ack; rotation invalidates that app's existing
tokens. Revoke the app installation in Linear to cut off access immediately.

## Planner credentials and repository

Install only a dedicated bot identity. Clone over HTTPS; never configure an SSH remote:

```bash
sudo -u linear-daemon -H git config --global user.name bloom-agent
sudo -u linear-daemon -H git config --global user.email bloom-agent@example.com
sudo -u linear-daemon -H git config --global credential.helper store
sudo -u linear-daemon -H bash
read -rsp "GitHub fine-grained PAT: " GITHUB_PAT; printf "\n"
umask 077
printf "https://x-access-token:%s@github.com\n" "$GITHUB_PAT" > "$HOME/.git-credentials"
unset GITHUB_PAT
exit
sudo -u linear-daemon -H git clone https://github.com/dcouple/bloom-mono.git /var/lib/linear-agent-daemon/repos/bloom-mono
sudo chmod 600 /var/lib/linear-agent-daemon/.git-credentials
```

Use a fine-grained PAT or GitHub App installation token limited to the target repository.
The `read -s` flow keeps the token out of shell history and process argv. Install the
dedicated Anthropic credential as `linear-daemon` using the current Claude Code headless
authentication procedure, and put the scoped `LINEAR_API_KEY` only in the mode-0600 env
file. Confirm `sudo -u linear-daemon -H claude --version` and that `git remote -v` is HTTPS.
The target repository must contain its own `AGENTS.md` work-item tracker configuration; the
daemon guarantees `/do` runs on its required non-default `agents/<identifier>` branch.

Authenticate GitHub and Codex for the service user, then verify them from the systemd user
context. Use only the repository-scoped bot token. `GH_TOKEN`/`GITHUB_TOKEN` may instead be
placed in the mode-0600 env file and is passed to `/do` without webhook/OAuth secrets.

```bash
sudo -u linear-daemon -H gh auth login --git-protocol https
sudo -u linear-daemon -H gh auth status
sudo -u linear-daemon -H codex exec --version
sudo -u linear-daemon -H git -C /var/lib/linear-agent-daemon/repos/bloom-mono push --dry-run origin HEAD
# Human red-tier gate: push a disposable branch, create a draft PR with gh, then close it.
sudo -u linear-daemon -H gh pr create --repo dcouple/bloom-mono --draft --fill --head <disposable-branch>
```

## Host checks

```bash
cd /opt/linear-agent-daemon && bash -n ops/provision.sh
sudo systemd-analyze verify /etc/systemd/system/linear-agent-daemon.service
sudo caddy validate --config /etc/caddy/Caddyfile
sudo ufw status verbose
sshd -T | grep -i passwordauthentication
sudo stat -c '%a %U %G' /etc/linear-agent-daemon/env
sudo ss -ltnp | grep -E ':(443|8787) '
systemctl status linear-agent-daemon caddy
```

Expected: env mode/owner `600 linear-daemon linear-daemon`, port 8787 on `127.0.0.1`
only, Caddy on 443, password authentication `no`, and both services active.

The SQLite database is secret material because it stores raw webhook payloads and OAuth
access tokens. Keep `/var/lib/linear-agent-daemon` owned by `linear-daemon:linear-daemon`
with mode `0750`, keep `events.db*` files unreadable by other users, and do not copy them
into support bundles or PR artifacts. Encrypt backups, retain them only as long as needed
for audit/debugging, and test restore with SQLite's backup mechanism rather than copying a
live database file directly.

## Deploy-gate smoke evidence

External HTTPS health:

```bash
curl -fsS -w '\n%{http_code} %{time_total}\n' https://linear-agent.example.com/healthz
```

For **AC3**, assign bloom-planner to a real test issue, then find the stored session ID and
webhook receipt timestamp:

```bash
sudo sqlite3 /var/lib/linear-agent-daemon/events.db \
  "select agent_session_id, datetime(received_at / 1000, 'unixepoch') from events order by id desc limit 1;"
```

Query that session's activities through Linear GraphQL with a token authorized for the test
workspace:

```bash
SESSION_ID="paste-agent-session-id-here"
curl -fsS https://api.linear.app/graphql \
  -H "Authorization: Bearer ${LINEAR_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"query":"query AgentSessionActivities($id: String!) { agentSession(id: $id) { id activities { nodes { id createdAt ephemeral content { __typename ... on AgentActivityThoughtContent { type body } } } } } }","variables":{"id":"'"${SESSION_ID}"'"}}'
```

Preserve the response showing exactly one ephemeral `thought` with body `picked up — starting
work`, the same session ID, and creation within 10 seconds of the stored receipt timestamp.

For **AC5**, first receive an event, then prove persistence and automatic restart:

```bash
sudo sqlite3 /var/lib/linear-agent-daemon/events.db 'select count(*) from events;'
pid=$(systemctl show -p MainPID --value linear-agent-daemon)
sudo kill -9 "$pid"
sleep 4
systemctl is-active linear-agent-daemon
sudo sqlite3 /var/lib/linear-agent-daemon/events.db 'select count(*) from events;'
curl -fsS https://linear-agent.example.com/healthz
```

Capture one live AgentSessionEvent payload from a temporary redacted diagnostic (never log
raw payloads permanently) and verify the tolerant parser's fields. Trigger a webhook retry
and confirm Linear reuses `Linear-Delivery`; record the two delivery IDs. Linear retries at
about 1 minute, 1 hour, and 6 hours and may disable repeated failures, so re-enable a
disabled webhook manually in the app settings.

## Planner-session smoke

Assign bloom-planner to a test issue. Within ten seconds, confirm the ack and session-start
thought; then verify the worktree branch includes the issue identifier and the turn ends in
a response. Reply on the Linear thread and confirm the same Claude session and worktree are
used. Run a long prompt and verify thought/action gaps stay under 20 minutes. Finally restart
the service between turns, reply again, and confirm resume still uses state under the pinned
`HOME=/var/lib/linear-agent-daemon`:

```bash
sudo sqlite3 /var/lib/linear-agent-daemon/events.db \
  "select linear_session_id,issue_identifier,worktree_path,branch,claude_session_id,status from sessions order by last_seen_at desc;"
sudo sqlite3 /var/lib/linear-agent-daemon/events.db \
  "select id,linear_session_id,kind,status,error from turns order by id desc limit 20;"
sudo systemctl restart linear-agent-daemon
sudo journalctl -u linear-agent-daemon -f
```

Capture a redacted `prompted` payload and attachment node shape. Confirm Git and Claude can
spawn under `SystemCallFilter=@system-service`; if the journal proves a specific syscall
denial, widen only the named directive and record that deliberate change. Direct HTTP MCP
configuration is primary; `mcp-remote` with a bearer header is the fallback for an older
Claude build that cannot use direct HTTP MCP configuration.

## Implementer smoke

Assign bloom-implementer to a plan-ready test issue. Confirm the session contains no
elicitation/human-input request, `/do` starts on `agents/<identifier>`, a PR is created, and
the PR appears in session external URLs. Confirm the final `/do` text matches PR extraction.
Move the issue to a workflow state whose stable type is `completed`; verify the Issues
webhook arrives and both worktree and local branch disappear. Repeat with an uncommitted
file and verify the worktree remains and a thought names its path. Confirm the full flow
under systemd hardening.

```bash
sudo sqlite3 /var/lib/linear-agent-daemon/events.db \
  "select linear_session_id,label,url,status,error from session_external_urls order by id desc limit 10;"
sudo sqlite3 /var/lib/linear-agent-daemon/events.db \
  "select issue_identifier,status,attempts,error from cleanup_jobs order by id desc limit 10;"
```

## Credential inventory

| Credential | Phase / owner | Path and mode | Scope | Rotation or revocation |
|---|---|---|---|---|
| Two webhook secrets | 1 / `linear-daemon` | env, `0600` | Verify one app route each | Rotate in each app, update env, restart |
| Two OAuth client IDs/secrets | 1 / `linear-daemon` | env, `0600` | Agent scopes only | Rotate secret or revoke app; update and restart |
| SQLite event/token database | 1 / `linear-daemon` | `/var/lib/linear-agent-daemon/events.db*`, `0600`/dir `0750` | Raw payloads and OAuth access tokens | Encrypt backups; delete per retention; revoke OAuth apps if exposed |
| Bot git/gh identity + HTTPS credential | 2–3 / `linear-daemon` | `~/.gitconfig`, `~/.git-credentials` or env, `0600` | One repository, least privilege | Revoke PAT/App token and replace |
| Codex authentication | 3 / `linear-daemon` | provider config under service HOME, `0600` | Dedicated bot project | Revoke provider token, replace |
| `LINEAR_API_KEY` for spawned sessions | 2 / `linear-daemon` | env, `0600` | Scoped bot access | Revoke in Linear, replace env |
| Anthropic authentication | 2 / `linear-daemon` | provider config, `0600` | Dedicated bot billing/project | Revoke provider token, replace |

Never install personal credentials on the host. The latter three credentials are inventory
only in phase 1 and are not installed until their owning phases.

## Logs and recovery

```bash
journalctl -u linear-agent-daemon -f
journalctl -u caddy --since today
```

Logs contain delivery/session/issue IDs but no raw webhook bodies or tokens. Back up
`/var/lib/linear-agent-daemon/events.db` using SQLite's backup mechanism. The service uses
WAL and `Restart=always`; investigate named `ack_failed`, `terminal_activity_delivery_failed`,
and `session_turn_unhandled` errors. Inspect `turns` rows in `failed`/`interrupted` and
`turn_activities` rows in `failed`; preserve the durable activity ID when retrying so Linear
can accept duplicate IDs idempotently. Also investigate `external_url_delivery_failed`,
`cleanup_failed`, and `cleanup_notification_failed` without manually changing turn status.
