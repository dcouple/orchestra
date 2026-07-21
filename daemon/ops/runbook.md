# Linear agent daemon provisioning and operations

Provisioning and OAuth registration are human-controlled deploy gates. Do not run this
runbook from an automated agent. Real Linear, Claude Code through CLIProxyAPI, and systemd
acceptance is not closed until the live smoke checks below are captured.

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
bash -n ops/provision.sh ops/claudex ops/claudex-fable
sudo DAEMON_HOST=linear-agent.example.com ops/provision.sh "$PWD"
```

It installs Node 22, pnpm 11.8, Git, pinned GitHub CLI, Codex CLI, and CLIProxyAPI releases,
the Claude Code harness, a real `claudex` executable, Caddy, UFW, the dedicated
`linear-daemon` user, and the daemon/proxy systemd units. It also installs the `sqlite3` CLI
used by the smoke checks. It deploys with
`pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod`. Caddy terminates TLS,
enforces a 1 MB request-body cap, and proxies only to the daemon's loopback listener.

Supply-chain note: the provisioner keeps the vendor-supported `curl | bash` bootstrap paths
for NodeSource and pnpm so the script remains runnable on a clean host. Before production
use, fetch the scripts once, review and pin their checksums in your deployment notes where
practical, and rely on the pinned pnpm version plus `pnpm install --frozen-lockfile` for the
application dependency graph. Caddy packages are installed from the signed Cloudsmith apt
repository. CLIProxyAPI is pinned by release and SHA-256 for both supported architectures.
The Claude native installer is another vendor `curl | bash` path: review and checksum the
downloaded installer before production provisioning when practical.

The default firewall permits only SSH and HTTPS. Linear currently publishes these webhook
source IPs: `35.231.147.226`, `35.243.134.228`, `34.140.253.14`, `34.38.87.206`,
`34.134.222.122`, and `35.222.25.142`. Check the current Linear webhook documentation
before optionally replacing the broad `ufw allow 443/tcp` rule with per-IP rules. Caddy's
certificate issuance and external health checks also need consideration before restricting
port 443.

## Register the two OAuth apps

In Linear, create `bloom-planner` and `bloom-implementer` separately. For each app:

1. Enable client-credentials tokens; use `actor=app`. A workspace admin must authorize
   the installation. The daemon requests scopes
   `read,write,app:assignable,app:mentionable,admin` at token time; Linear currently
   rejects the `admin` scope on client_credentials (observed live 2026-07) and the daemon
   automatically retries without it. Without `admin`, startup webhook re-enable is
   unavailable — re-enable a disabled webhook manually in the app's settings.
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
WEBHOOK_BASE_URL=https://linear-agent.example.com
PLANNER_WEBHOOK_SECRET=...
PLANNER_LINEAR_CLIENT_ID=...
PLANNER_LINEAR_CLIENT_SECRET=...
PLANNER_APP_ACTOR_ID=...
IMPLEMENTER_WEBHOOK_SECRET=...
IMPLEMENTER_LINEAR_CLIENT_ID=...
IMPLEMENTER_LINEAR_CLIENT_SECRET=...
IMPLEMENTER_APP_ACTOR_ID=...
RECONCILE_INTERVAL_MS=60000
RECONCILE_REQUEST_TIMEOUT_MS=10000
SESSIONS_ENABLED=1
TARGET_REPO_PATH=/var/lib/linear-agent-daemon/repos/bloom-mono
WORKTREES_ROOT=/var/lib/linear-agent-daemon/worktrees
LINEAR_API_KEY=...
CLAUDE_BIN=/var/lib/linear-agent-daemon/.local/bin/claude
# Capacity fallback: a validated Claude usage/rate-limit failure retries once through
# the Claudex proxy wrapper (ops/claudex, installed by provision.sh; it carries the
# proxy env itself, so CLAUDEX_ENV is not needed with it):
CLAUDEX_BIN=/var/lib/linear-agent-daemon/.local/bin/claudex
# CLAUDEX_ENV optionally supplies extra child env as a JSON string map when CLAUDEX_BIN
# points at a bare claude binary instead of the wrapper; it requires CLAUDEX_BIN:
# CLAUDEX_ENV={"ANTHROPIC_BASE_URL":"http://127.0.0.1:8317","ANTHROPIC_AUTH_TOKEN":"..."}
CLAUDE_PERMISSION_MODE=bypassPermissions
CLAUDE_MAX_TURNS=100
DO_PERMISSION_MODE=bypassPermissions
DO_MAX_TURNS=300
# DO_MAX_BUDGET_USD=50
SESSION_CONCURRENCY=6
KEEPALIVE_MS=900000
ATTACHMENTS_ENABLED=1
ATTACHMENT_HOSTS=uploads.linear.app
# NTFY_URL=https://ntfy.sh/<unguessable-topic>
```

The daemon requests 30-day client-credentials app tokens with
`read,write,app:assignable,app:mentionable,admin` and persists their expiry in SQLite. It
reacquires on expiry or an API 401. Rotate a client secret in Linear, update the matching
host value, restart, and verify an ack; rotation invalidates that app's existing tokens.
Revoke the app installation in Linear to cut off access immediately.

Deploy-gate confirmations before relying on startup reconciliation in production:

```bash
# Confirm bulk agentSessions is scoped to the calling app actor and pages as expected.
# If it is not, keep PLANNER_APP_ACTOR_ID / IMPLEMENTER_APP_ACTOR_ID populated so the
# delegate issue -> issue.agentSessions fallback can resolve real session IDs.
# If either APP_ACTOR_ID is missing, startup reconciliation still re-enables webhooks but
# skips session-discovery synthesis for that app to avoid importing foreign sessions.

# Confirm the added admin scope authorizes webhooks/updateWebhook under client_credentials
# and does not force token-invalidating re-consent beyond the planned app reinstall.

# Capture one prompted webhook and the same activity through GraphQL; verify
# webhook agentActivity.id == GraphQL AgentActivity.id.
```

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
The `read -s` flow keeps the token out of shell history and process argv. The provisioner
installs the Claude Code harness but does not authenticate it directly with Anthropic.
Instead, it creates a loopback-only CLIProxyAPI service and a `claudex` executable that
routes the harness and every subagent through GPT-5.6 Sol via the Codex OAuth pool. The main
loop uses high reasoning; Claude model pins map to low, medium, or xhigh proxy aliases, and
Claude Code compacts against a 250k context budget. Separate local API and management keys
are generated once in `/etc/linear-agent-daemon/cliproxyapi.env`; do not copy either key into
the main daemon env file.

Enroll both founders in both provider pools as `linear-daemon`. On a headless host, open each
printed URL on another device and paste the callback URL or authorization code as prompted.
The helper prints only a redacted pool summary. Re-running `add` is an intentional re-login
and leaves one current pool record for that identity; use `--dry-run` before checking the
flow:

```bash
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh add codex --dry-run
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh add codex
# Repeat the preceding command for the second founder.
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh add claude
# Repeat the preceding command for the second founder.
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh list
sudo systemctl restart cliproxyapi
sudo -u linear-daemon -H /var/lib/linear-agent-daemon/.local/bin/claudex \
  -p "Reply with exactly: claudex works."
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/codex-provider-gate.sh
sudo systemctl restart linear-agent-daemon
```

The Claude enrollment is viable only after one real provider-native request completes
through an enrolled Claude credential. Choose a Claude-provider model from the proxy catalog,
then record the redacted management counters before and after this Messages-protocol probe:

```bash
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh list
read -r -p 'Claude provider model ID from /v1/models: ' CLAUDE_MODEL
sudo -u linear-daemon -H env CLAUDE_MODEL="$CLAUDE_MODEL" bash -c '
  . /etc/linear-agent-daemon/cliproxyapi.env
  python3 -c "import json,os; print(json.dumps({\"model\":os.environ[\"CLAUDE_MODEL\"],\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: claude pool works.\"}]}))" \
    | curl -fsS -K <(printf "header = \"x-api-key: %s\"\nheader = \"anthropic-version: 2023-06-01\"\nheader = \"content-type: application/json\"\n" "$CLIPROXY_API_KEY") \
      --data-binary @- http://127.0.0.1:8317/v1/messages'
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh list
unset CLAUDE_MODEL
```

If Anthropic rejects subscription OAuth, disable/remove the Claude
credentials, record the probe as failed, and leave Phase 2 on Sol; do not claim the Claude
half of AC1. The `claudex` command must return exactly `claudex works.` and the provider gate
must print `PASS`. A warning that claude.ai connectors
are disabled is expected because the local proxy token replaces Claude authentication for
that process. Confirm that `git remote -v` is HTTPS. The target repository must contain its
own `AGENTS.md` work-item tracker configuration; the daemon guarantees `/do` runs on its
required non-default `agents/<identifier>` branch.

Authenticate GitHub and the standalone Codex CLI for the service user, then verify them from
the systemd user context. Use only the repository-scoped bot token.
`GH_TOKEN`/`GITHUB_TOKEN` may instead be placed in the mode-0600 env file and is passed to
`/do` without webhook/OAuth secrets.

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
cd /opt/linear-agent-daemon && bash -n ops/provision.sh ops/claudex ops/claudex-fable ops/proxy-accounts.sh ops/codex-provider-gate.sh
sudo systemd-analyze verify \
  /etc/systemd/system/cliproxyapi.service \
  /etc/systemd/system/linear-agent-daemon.service
sudo caddy validate --config /etc/caddy/Caddyfile
sudo ufw status verbose
sshd -T | grep -i passwordauthentication
sudo stat -c '%a %U %G' \
  /etc/linear-agent-daemon/env \
  /etc/linear-agent-daemon/cliproxyapi.env \
  /etc/linear-agent-daemon/cliproxyapi.yaml
sudo ss -ltnp | grep -E ':(443|8317|8787) '
systemctl status cliproxyapi linear-agent-daemon caddy
```

Expected: the daemon env is `600 linear-daemon linear-daemon`; proxy secret/config files are
`640 root linear-daemon`; ports 8317 and 8787 listen on `127.0.0.1` only; Caddy listens on
443; password authentication is `no`; and all three services are active. Verify the proxy's
model inventory without exposing its key in process argv:

```bash
sudo -u linear-daemon -H sh -c '. /etc/linear-agent-daemon/cliproxyapi.env
  printf "header = \\"Authorization: Bearer %s\\"\\n" "${CLIPROXY_API_KEY}" \
    | curl -fsS -K - http://127.0.0.1:8317/v1/models \
    | python3 -m json.tool' | grep -F 'gpt-5.6-sol'
```

The inventory should include `gpt-5.6-sol` plus the `-low`, `-medium`, and `-xhigh`
aliases. An empty `data` array means the Codex OAuth flow did not complete for
`linear-daemon`.

Check the credential pool only through the redacting management helper:

```bash
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh list
```

Each record includes only name, email, provider, disabled, failed, and recent request
counters. It must show two enabled Codex and two enabled Claude identities after enrollment.
Never paste raw credential files into logs or artifacts.

The SQLite database is secret material because it stores raw webhook payloads and OAuth
access tokens. Keep `/var/lib/linear-agent-daemon` owned by `linear-daemon:linear-daemon`
with mode `0750`, keep `events.db*` files unreadable by other users, and do not copy them
into support bundles or PR artifacts. Encrypt backups, retain them only as long as needed
for audit/debugging, and test restore with SQLite's backup mechanism rather than copying a
live database file directly.

## Deploy-gate smoke evidence

### Phase 1 multi-account evidence

Capture command output in the private deploy record after redacting account names and email
addresses. These are human red-tier checks because they use founder subscription accounts.

AC1 — aliases, two identities in each pool, and no credential-value logging:

```bash
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh list
sudo journalctl -u cliproxyapi --since today --no-pager
```

AC2 — record `recent_requests` before and after six independent Sol conversations; successful
counters must increase for at least two enabled Codex identities:

```bash
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh list
for run in 1 2 3 4 5 6; do
  sudo -u linear-daemon -H /var/lib/linear-agent-daemon/.local/bin/claudex \
    -p "Reply with exactly: routing-${run}."
done
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh list
```

AC3 — the gate exercises a tool call, streaming output, detached marker pickup, and
`resume --last` through the host-pinned Codex CLI:

```bash
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/codex-provider-gate.sh
```

AC4 — verify the 168-hour config and continue both protocol conversations. Record the same
credential's counter increment on each continuation. The Codex continuation is part of the
gate; this command makes and resumes a Claude-protocol conversation:

```bash
grep -F 'session-affinity-ttl: "168h"' /etc/linear-agent-daemon/cliproxyapi.yaml
sudo -u linear-daemon -H sh -c '
  result="$(claudex -p --output-format json "Reply with exactly: affinity-start.")"
  session="$(printf "%s" "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)[\"session_id\"])")"
  claudex --resume "$session" -p "Reply with exactly: affinity-resume."'
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/codex-provider-gate.sh
```

There is no finite maximum daemon session lifetime, so the literal “TTL longer than maximum
lifecycle” wording remains unmet. The 168-hour value exceeds observed runs; expiry affects
provider-side affinity/cache cost, while both harnesses retain local resume state. Record
human acceptance or require the criterion to be reworded. If Claude-protocol counters do not
expose affinity, record that evidence limitation rather than passing it silently.

AC5 — choose one enabled Codex filename from the redacted list, disable it through the body
form, run a new conversation, verify only another enabled identity increments, then re-enable
the credential:

```bash
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh list
read -r -p 'Codex credential filename to disable: ' ACCOUNT_FILE
sudo -u linear-daemon -H bash -c '
  set -euo pipefail
  account_file="$1"
  account_body="$(mktemp)"
  . /etc/linear-agent-daemon/cliproxyapi.env
  set_account_status() {
    python3 -c '\''import json,sys; print(json.dumps({"name":sys.argv[1],"disabled":sys.argv[2] == "true"}))'\'' \
      "$account_file" "$1" > "$account_body"
    printf "header = \"Authorization: Bearer %s\"\n" "$CLIPROXY_MANAGEMENT_KEY" \
      | curl -fsS -K - -H "Content-Type: application/json" -X PATCH \
        --data-binary "@$account_body" http://127.0.0.1:8317/v0/management/auth-files/status
  }
  account_disabled=0
  cleanup() {
    status=$?
    if (( account_disabled )); then set_account_status false || true; fi
    rm -f "$account_body"
    return "$status"
  }
  trap cleanup EXIT
  account_disabled=1
  set_account_status true
  /var/lib/linear-agent-daemon/.local/bin/claudex -p "Reply with exactly: failover-ok."
  /opt/linear-agent-daemon/ops/proxy-accounts.sh list
  set_account_status false
  account_disabled=0
' gate-account-status "$ACCOUNT_FILE"
unset ACCOUNT_FILE
```

AC6 — onboarding needs no daemon code change; dry-run twice for identical output, perform the
interactive login, and observe hot-loading in the list without restarting the proxy:

```bash
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh add codex --dry-run
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh add codex --dry-run
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh add codex
sudo -u linear-daemon -H /opt/linear-agent-daemon/ops/proxy-accounts.sh list
```

AC7 — the passing gate above installs the provider. A dead-port run must name the failed gate,
exit nonzero, and remove only a gate-marked target; use a disposable target for this proof:

```bash
sudo -u linear-daemon -H bash -c '
  set -eu
  gate_tmp="$(mktemp -d)"
  trap '\''rm -rf "$gate_tmp"'\'' EXIT
  target="$gate_tmp/config.toml"
  printf "%s\n" "# managed by codex-provider-gate.sh — removed on gate failure" > "$target"
  set +e
  PROXY_URL=http://127.0.0.1:1 TARGET_CONFIG="$target" \
    /opt/linear-agent-daemon/ops/codex-provider-gate.sh
  gate_status=$?
  set -e
  test "$gate_status" -ne 0
  test ! -e "$target"
'
```

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
about 1 minute, 1 hour, and 6 hours and may disable repeated failures. On restart, confirm
the daemon re-enables each app webhook; use the app settings only as the manual fallback.

## Enable and verify Fable routing

Fable remains disabled until the enrolled Claude accounts expose confirmed real Anthropic
model IDs. Enroll the accounts with `cliproxyapi --claude-login`, then inspect the catalog:

```bash
. /etc/linear-agent-daemon/cliproxyapi.env
printf 'header = "Authorization: Bearer %s"\n' "$CLIPROXY_API_KEY" |
  curl -fsS -K - http://127.0.0.1:8317/v1/models |
  python3 -m json.tool | grep '"id": "claude-'
```

If no usable `claude-*` model completes a request, leave `FABLE_BIN` unset and report Phase
2 AC2 unmet. Otherwise author the mapping only after that request succeeds:

```bash
sudo install -o root -g linear-daemon -m 0640 /dev/null /etc/linear-agent-daemon/fable-models.env
sudoedit /etc/linear-agent-daemon/fable-models.env
# FABLE_MAIN_MODEL=claude-<confirmed-main>
# FABLE_HAIKU_MODEL=claude-<confirmed-haiku>
# FABLE_SONNET_MODEL=claude-<confirmed-sonnet>
# FABLE_OPUS_MODEL=claude-<confirmed-opus>
# FABLE_FABLE_MODEL=claude-<confirmed-fable>
sudo sh -c 'printf "\nFABLE_BIN=/var/lib/linear-agent-daemon/.local/bin/claudex-fable\n" >> /etc/linear-agent-daemon/env'
sudo systemctl restart linear-agent-daemon
curl -fsS http://127.0.0.1:8787/healthz | python3 -m json.tool
```

The health response must show `providers.claude.status` as `ready` before a new Fable
session is created (AC1/AC3). For AC2, create one Fable workflow, complete one Claude-side
request and one detached `codex exec -m gpt-5.6-sol` role, then preserve the model catalog,
management counters, and redacted proxy journal proving Claude and Codex used their
respective pools. For AC4, record the session profile and Claude ID, restart, prompt again,
and verify both remain unchanged:

```bash
sudo sqlite3 /var/lib/linear-agent-daemon/events.db \
  'select linear_session_id,profile,claude_session_id from sessions order by last_seen_at desc limit 5;'
sudo systemctl restart linear-agent-daemon
sudo journalctl -u linear-agent-daemon --since '-10 min' -o cat |
  grep -E 'session_profile_assigned|provider_state_changed|provider_failure_classified|profile_fallback|profile_launcher_unconfigured'
curl -fsS http://127.0.0.1:8787/healthz | python3 -m json.tool
```

Those journal and health commands are the supporting AC6 schema/redaction evidence; verify
they contain no key, token, or account email. For AC7, temporarily put a `gpt-*` alias in one
`FABLE_*_MODEL` entry and run `claudex-fable -p test`: it must exit nonzero naming that
variable before sending a model request. Restore the confirmed mapping afterward. Legacy
rows with a NULL profile intentionally route as Sol and log `legacy_session_profile_defaulted`.

Preserve the automated host evidence for the fixture-drivable criteria as well:

```bash
cd /opt/linear-agent-daemon
pnpm vitest run test/sessions.test.ts -t 'persists Fable for planner and implementer|probes readiness' # AC1, AC3
pnpm vitest run test/sessions.test.ts -t 'reopens SQLite|child-restart'                                # AC4
pnpm vitest run test/sessions.test.ts -t 'falls back once|launcher is unconfigured'                   # AC5, AC7
pnpm vitest run test/server.test.ts test/sessions.test.ts -t 'reports durable|probes readiness'        # AC6
```

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

## Android emulator smoke

Android enablement is opt-in during provisioning because it downloads large SDK artifacts
and depends on KVM availability:

```bash
sudo INSTALL_ANDROID=1 ANDROID_API_LEVEL=35 ANDROID_AVD_NAME=linear-smoke \
  DAEMON_HOST=linear-agent.example.com ops/provision.sh "$PWD"
```

The provisioner installs Android command-line tools, accepts SDK licenses for the
`linear-daemon` user, installs platform-tools/emulator/a Google APIs x86_64 system image,
creates a fresh AVD, and adds the service user to `kvm` when `/dev/kvm` exists. If KVM is
absent, the smoke script falls back to `-no-accel`; treat that as a capacity warning.

Live boot/install/launch/screenshot is a red deploy gate and must be run by a human on the
VPS, twice to prove idempotency:

```bash
sudo -u linear-daemon -H env \
  ANDROID_SDK_ROOT=/opt/android-sdk \
  ANDROID_AVD_NAME=linear-smoke \
  ANDROID_PACKAGE_NAME=com.example.app \
  ANDROID_SCREENSHOT_PATH=/var/lib/linear-agent-daemon/android-smoke.png \
  /opt/linear-agent-daemon/ops/android-smoke.sh /path/to/app.apk
sudo -u linear-daemon -H test -s /var/lib/linear-agent-daemon/android-smoke.png
```

Record whether KVM was used, the APK/package tested, both exit codes, and the screenshot
artifact path. Do not run the emulator smoke from an automated implementation agent.

## Credential inventory

| Credential | Phase / owner | Path and mode | Scope | Rotation or revocation |
|---|---|---|---|---|
| Two webhook secrets | 1 / `linear-daemon` | env, `0600` | Verify one app route each | Rotate in each app, update env, restart |
| Two OAuth client IDs/secrets | 1 / `linear-daemon` | env, `0600` | Agent scopes only | Rotate secret or revoke app; update and restart |
| SQLite event/token database | 1 / `linear-daemon` | `/var/lib/linear-agent-daemon/events.db*`, `0600`/dir `0750` | Raw payloads and OAuth access tokens | Encrypt backups; delete per retention; revoke OAuth apps if exposed |
| Bot git/gh identity + HTTPS credential | 2–3 / `linear-daemon` | `~/.gitconfig`, `~/.git-credentials` or env, `0600` | One repository, least privilege | Revoke PAT/App token and replace |
| Standalone Codex provider selection | 3 / `linear-daemon` | `~/.codex/config.toml`, `0600` | Loopback Responses provider; no token stored | Rerun gate; failed gate removes only its marked config |
| CLIProxyAPI Codex OAuth pool | 2 / `linear-daemon` | `~/.cli-proxy-api/codex-*.json`, `0600` | Both founders' ChatGPT/Codex subscriptions | Revoke OpenAI authorization, rerun `proxy-accounts.sh add codex` |
| CLIProxyAPI Claude OAuth pool | 2 / `linear-daemon` | provider-reported files under `~/.cli-proxy-api/`, `0600` | Both founders' Claude subscriptions, subject to viability probe | Revoke Anthropic authorization, rerun `proxy-accounts.sh add claude` |
| CLIProxyAPI local API + management keys | 2 / root + `linear-daemon` group | `/etc/linear-agent-daemon/cliproxyapi.env` and generated `.yaml`, `0640` | Loopback proxy and loopback management API only | Stop services, replace both env values, rerun provisioner, restart |
| `LINEAR_API_KEY` for spawned sessions | 2 / `linear-daemon` | env, `0600` | Scoped bot access | Revoke in Linear, replace env |

Install founder subscription OAuth only through the documented interactive proxy flow; never
copy raw token values or unrelated personal credentials onto the host. All other credentials
are installed only in their owning phase.

## Logs and recovery

```bash
journalctl -u linear-agent-daemon -f
journalctl -u cliproxyapi --since today
journalctl -u caddy --since today
```

The daemon orders itself after CLIProxyAPI and wants it started, but does not stop when the
proxy briefly restarts. This keeps webhook ingestion online; any in-flight Claude turn that
fails during the outage is recorded normally and can be resumed after the proxy recovers.

Logs contain delivery/session/issue IDs but no raw webhook bodies or tokens. Back up
`/var/lib/linear-agent-daemon/events.db` using SQLite's backup mechanism. The service uses
WAL and `Restart=always`; investigate named `ack_failed`, `terminal_activity_delivery_failed`,
and `session_turn_unhandled` errors. Inspect `turns` rows in `failed`/`interrupted` and
`turn_activities` rows in `failed`; preserve the durable activity ID when retrying so Linear
can accept duplicate IDs idempotently. Also investigate `external_url_delivery_failed`,
`cleanup_failed`, and `cleanup_notification_failed` without manually changing turn status.
