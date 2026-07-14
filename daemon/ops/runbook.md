# Linear agent daemon provisioning and operations

Provisioning and OAuth registration are human-controlled deploy gates. Do not run this
runbook from an automated agent. Phase 1 does not close AC3 or AC5 until the live smoke
checks below are captured.

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

It installs Node 22, pnpm 11.8, Caddy, UFW, the dedicated `linear-daemon` user, and the
systemd unit. It also installs the `sqlite3` CLI used by the smoke checks. It deploys with
`pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod`. Caddy terminates TLS,
enforces a 1 MB request-body cap, and proxies only to the daemon's loopback listener.

Supply-chain note: the provisioner keeps the vendor-supported `curl | bash` bootstrap paths
for NodeSource and pnpm so the script remains runnable on a clean host. Before production
use, fetch the scripts once, review and pin their checksums in your deployment notes where
practical, and rely on the pinned pnpm version plus `pnpm install --frozen-lockfile` for the
application dependency graph. Caddy packages are installed from the signed Cloudsmith apt
repository.

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
```

The daemon requests 30-day client-credentials app tokens and persists their expiry in
SQLite. It reacquires on expiry or an API 401. Rotate a client secret in Linear, update the
matching host value, restart, and verify an ack; rotation invalidates that app's existing
tokens. Revoke the app installation in Linear to cut off access immediately.

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

## Credential inventory

| Credential | Phase / owner | Path and mode | Scope | Rotation or revocation |
|---|---|---|---|---|
| Two webhook secrets | 1 / `linear-daemon` | env, `0600` | Verify one app route each | Rotate in each app, update env, restart |
| Two OAuth client IDs/secrets | 1 / `linear-daemon` | env, `0600` | Agent scopes only | Rotate secret or revoke app; update and restart |
| SQLite event/token database | 1 / `linear-daemon` | `/var/lib/linear-agent-daemon/events.db*`, `0600`/dir `0750` | Raw payloads and OAuth access tokens | Encrypt backups; delete per retention; revoke OAuth apps if exposed |
| Bot git identity + repo deploy key | 2–3 / `linear-daemon` | `~/.gitconfig`, `~/.ssh`, `0600` key | One repository, least privilege | Revoke deploy key and replace |
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
WAL and `Restart=always`; investigate named `ack_failed` errors and manually confirm any
late reconciled activity.
