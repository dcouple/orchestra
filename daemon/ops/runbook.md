# Linear agent daemon provisioning and operations

Provisioning and OAuth registration are human-controlled deploy gates. Do not run this
runbook from an automated agent. Real Linear, Claude Code through CLIProxyAPI, and systemd
acceptance is not closed until the live smoke checks below are captured.

## Routine operations control

Use the host-native command for routine work; from an orchestra checkout, the corresponding
`make daemon-*` targets are thin wrappers around the same command.

```bash
sudo daemonctl status
sudo daemonctl sessions
sudo daemonctl top
sudo daemonctl config --planner claude --implementer claudex --dry-run
sudo daemonctl restart --dry-run
sudo daemonctl reload --dry-run
sudo daemonctl subscriptions list
```

Normal config, restart, and reload requests drain durable `running` turns, block all new
claims, and leave webhook ingestion active. Status reports the pending type, safe reason,
request time, target ref/commit, drain stage, and last outcome. Equivalent restarts converge.
An operation that cannot prove acceptance or a safe rollback becomes `blocked`; queued work
stays held. Correct the named stage, then use `sudo daemonctl operation retry <id>`. Cancel is
allowed only before mutation or after verified rollback.

`sudo daemonctl restart --hard` prints the affected app, issue identifier, runtime, state,
and elapsed time, then requires `HARD-RESTART`. It terminates those turns through normal
startup interruption reconciliation and does not enqueue continuations.

For an unplanned daemon restart, startup resumes a stale turn exactly once only when the
database contains its Claude session ID and no open tool call. The interrupted row remains
auditable and a deterministic `restart-resume:<turn-id>` source key identifies the same-session
continuation. If an external tool call is still open, the session ID is missing, the user
explicitly stopped the turn, or a hard-restart intent exists, the turn is never automatically
resumed. Startup posts one human-required activity for stale unresolved, missing-session, and
hard-restart cases; explicit user stops retain their normal stop acknowledgement. Review the
worktree and any external side effects before prompting or assigning again; never treat an
unresolved tool call as safe to replay. Daemon-owned `PreToolUse`, `PostToolUse`, and
`PostToolUseFailure` hooks make this fail closed: the pre hook durably records the turn,
tool-use ID, and bounded tool name before execution, and blocks the tool if that write fails;
the post hooks mark it completed without retaining inputs or results. The structured
`shutdown` record includes the signal, `recover` or `hard_restart` policy, and safe running-turn
summaries only.

Reloads use `/opt/orchestra-source`, whose `origin` must be HTTPS. The operator fetches,
reviews, and fast-forwards this persistent checkout before running `sudo daemonctl reload`;
the command itself never fetches, pulls, or runs candidate code as a validator. Its clean
`HEAD` must be a fast-forward descendant of
`/var/lib/linear-agent-operations/accepted-commit`. The executor revalidates the exact staged
SHA after draining and provisions it from a detached worktree. Each operation worktree is
authorized by atomic root-owned metadata outside the checkout; retries repair only an exact
owned registration, while foreign or mismatched paths block without being removed. The executor
records `deployed-commit` after
the service becomes active, and advances `accepted-commit` only after loopback health
acceptance. A failed deployment provisions the previous accepted commit before claims can
resume. `sudo daemonctl status` compares the running, accepted, checkout, and cached remote
tracking revisions without network access; use `status --refresh` for an explicit HTTPS
fetch. `daemonctl update` remains a compatibility alias for `reload` and accepts no ref.

For a human production smoke, run the three read-only commands first, dry-run every mutator,
then use disposable turns/accounts to prove idle restart, busy drain and ingestion, config
rollback, reload old/new commit reporting, hard-restart consequences, and subscription
remove/reauth. Capture only redacted output. Direct `systemctl`, `sqlite3`, provisioner, and
proxy helper commands below remain recovery tools, not the routine path.

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
LINEAR_MCP_MONITOR_INTERVAL_MS=60000
LINEAR_MCP_MONITOR_TIMEOUT_MS=10000
SESSIONS_ENABLED=1
TARGET_REPO_PATH=/var/lib/linear-agent-daemon/repos/bloom-mono
WORKTREES_ROOT=/var/lib/linear-agent-daemon/worktrees
LINEAR_API_KEY=...
PLANNER_HARNESS=claude
IMPLEMENTER_HARNESS=claude
CLAUDE_BIN=/var/lib/linear-agent-daemon/.local/bin/claude
FABLE_BIN=/var/lib/linear-agent-daemon/.local/bin/claudex-fable
# Direct Claudex route for sessions assigned to Sol (ops/claudex is installed by
# provision.sh and carries the proxy env itself, so CLAUDEX_ENV is normally absent):
CLAUDEX_BIN=/var/lib/linear-agent-daemon/.local/bin/claudex
# CLAUDEX_ENV optionally supplies extra child env as a JSON string map when CLAUDEX_BIN
# points at a bare claude binary instead of the wrapper; it requires CLAUDEX_BIN:
# CLAUDEX_ENV={"ANTHROPIC_BASE_URL":"http://127.0.0.1:8317","ANTHROPIC_AUTH_TOKEN":"..."}
CLAUDE_PERMISSION_MODE=bypassPermissions
CLAUDE_MAX_TURNS=100
BASH_DEFAULT_TIMEOUT_MS=900000
BASH_MAX_TIMEOUT_MS=900000
DO_PERMISSION_MODE=bypassPermissions
DO_MAX_TURNS=300
# DO_MAX_BUDGET_USD=50
SESSION_CONCURRENCY=6
KEEPALIVE_MS=900000
ATTACHMENTS_ENABLED=1
ATTACHMENT_HOSTS=uploads.linear.app
# NTFY_URL=https://ntfy.sh/<unguessable-topic>

# Langfuse Cloud via Claude Code native OpenTelemetry tracing
CLAUDE_CODE_ENABLE_TELEMETRY=1
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
OTEL_TRACES_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=https://us.cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64(pk-lf-…:sk-lf-…)>"
OTEL_METRICS_EXPORTER=none
OTEL_LOGS_EXPORTER=none
OTEL_LOG_USER_PROMPTS=1
OTEL_LOG_ASSISTANT_RESPONSES=1
```

The harness settings are independent and accept only `claude` or `claudex`; both default
to `claude`. Use `claudex` to send new sessions for that role directly to GPT-Sol without a
Fable readiness probe. Readiness and cooldown affect only the first assignment. Once a
Linear session is created, its Fable/Claude or Sol/Claudex route is sticky across prompts,
marker resumes, and daemon restarts. Capacity, authentication, or transport failure ends
that turn without launching the other harness; switching harnesses requires a new Linear
session. If a selected launcher is absent, the turn fails closed and the route stays intact.

`BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` are positive millisecond values passed to
every Claude, Claudex, and Fable turn. The maximum must be greater than or equal to the
default; both default to 900000 (15 minutes), which permits the six-minute acceptance check
below. These settings do not change the separate 900-second ephemeral and 2700-second
implementer Codex dispatch watchdogs.

The daemon reads only `CLIPROXY_API_KEY` from `CLIPROXY_ENV_FILE` immediately before each
turn, so rotation is visible without a daemon restart. Do not copy either proxy key into the
main env file and do not add `/etc/linear-agent-daemon/cliproxyapi.env` as a systemd
`EnvironmentFile`; that file also holds `CLIPROXY_MANAGEMENT_KEY`. The standalone `claudex`
and `claudex-fable` wrappers preserve a caller-supplied API key. When none is supplied they
parse only `CLIPROXY_API_KEY` from `CLIPROXY_ENV_FILE`, and fail nonzero with a redacted
message if the file or key is unavailable.

With sessions enabled, `LINEAR_MCP_MONITOR_INTERVAL_MS` defaults to 60000 and
`LINEAR_MCP_MONITOR_TIMEOUT_MS` defaults to 10000. The monitor runs bounded authenticated
connect, `listTools`, and close probes independently of active turns. An ordinary failed probe
is logged and retried at the next interval; it does not fail a turn by itself. A
`cleanup_timeout` instead blocks all subsequent monitor probes until the daemon restarts,
preventing unresolved client or transport resources from accumulating. Per-turn MCP use emits
bounded `linear_mcp_turn_init`, `linear_mcp_tool_result`, and `linear_mcp_turn_close` records.
The close classification is exactly `turn_completed`, `runner_failed`, or `daemon_shutdown`.

Langfuse's OTLP endpoint ingests traces only. Keep metrics and logs explicitly disabled;
otherwise exporter defaults can repeatedly send unsupported signals to Langfuse's 404/400
endpoints. `OTEL_EXPORTER_OTLP_HEADERS` is secret material: keep it only in the mode-0600
env file, never in argv or logs. The daemon keeps the upstream endpoint and header inside
its process and gives each turn only a random loopback capability and W3C context. Blanket
tool-content/detail export remains off. The relay selectively enriches only native Agent
tool spans with the daemon-captured delegated prompt/report; unrelated tool content and
selected-account identity are not exported. Claude Code v2.1.214 or newer is required.

One persisted trace covers the entire Linear planner or implementer session. Each prompt or
marker resume is one `orchestra.turn` child with a distinct span ID. The session root is
emitted once, after issue completion, marker ingestion, every Claude Agent enrichment has
settled or reached its 30-second degraded deadline, and no turn is executing. Parent token
values use `orchestra.canonical_tokens.*` metadata; provider generation usage remains only
on native leaf generations. A degraded root explicitly sets both completeness flags false.

### Codex telemetry

Provisioning pins the real Codex binary at `/opt/pnpm/bin/codex` and idempotently installs
the authoritative `/usr/local/bin/codex` wrapper. The provider gate continues to own Codex
routing configuration; provisioning does not write a static `[otel]` section. For a valid
daemon dispatch the wrapper validates the owner/report/capability, mints the dispatch span
ID before launch, and gives native Codex only the capability endpoint and rewritten parent.
It writes a credential-free atomic `.otel.json` sidecar beside the prompt/report/log/done
artifacts. Non-daemon invocations pass through unchanged.

Dispatch basenames are `<role>-<epoch>-<pid>-<sequence>`; the wrapper preserves a
hyphenated role by removing all three numeric suffixes. The sidecar deadline is 2700
seconds only for `implementer` and 900 seconds for every ephemeral role. For daemon
dispatches, common/traces/logs/metrics OTel endpoint, header, and protocol overrides,
ambient trace state/baggage, proxy credentials, and selected-account variables are removed
before the real Codex starts. TERM, INT, HUP, QUIT, ALRM, watchdog expiry, and ordinary
exit are forwarded to and reap the real child before atomically replacing `running` with a
terminal sidecar.

The capability remains valid for 3600 seconds even after the orchestrator turn exits: 4096
requests, 256 MiB cumulative, 8 MiB/request, 8 active requests per capability, and 32 active
globally. Marker ingestion sorts one provider conversation by start/end time and converts
cumulative Codex totals to deltas. Resume gaps, stale/out-of-order evidence, and fresh-ID
collisions remain auditable but contribute no canonical tokens and do not advance a
checkpoint. Native descendants may arrive before their late completed parent.

The relay retains a bounded cross-request span graph so native Agent spans and descendant
LLM spans exported in different batches settle together. Exact protobuf re-encoding is the
safety test for mutation: malformed gzip/protobuf or a future wire field that cannot be
preserved is forwarded byte-for-byte with its original content encoding. Requests reserve
count, concurrency, and streamed byte budgets before asynchronous work; decoded buffering
is capped at 32 MiB per capability and 128 MiB globally.

Completed-root delivery is intentionally at most once. A stale pre-send lease is retryable,
but restart/timeout/connection loss after `sending` becomes terminal `delivery_unknown` and
is never replayed automatically because Langfuse v4 can duplicate same-span-ID ingestion.
This may lose telemetry in an ambiguous case, but it cannot duplicate totals or block the
functional outcome and cleanup.

### Phase-4 production deploy and live proof (operator only)

Do not run these steps from an implementation or verification agent. On the daemon host,
the operator backs up the SQLite file, deploys the daemon package/wrapper, verifies the CLI
minimum, then restarts the service:

```bash
sudo systemctl stop linear-agent-daemon
sudo install -o linear-daemon -g linear-daemon -m 0600 \
  /var/lib/linear-agent-daemon/events.db \
  /var/lib/linear-agent-daemon/events.db.pre-phase4
sudo DAEMON_HOST=linear-agent.example.com daemon/ops/provision.sh daemon
sudo -u linear-daemon -H /var/lib/linear-agent-daemon/.local/bin/claude --version
sudo -u linear-daemon -H /opt/pnpm/bin/codex --version
sudo systemctl restart linear-agent-daemon
sudo systemctl is-active linear-agent-daemon
```

The Claude version must be at least `2.1.214`. Complete one scratch issue with two user
turns, one Claude Agent invocation, overlapping fresh/resumed Codex dispatches, a daemon
restart between turns, and one dispatch that finishes after its parent turn. After moving
the issue to a completed state, inspect only metadata from SQLite:

```bash
sudo sqlite3 -header -column /var/lib/linear-agent-daemon/events.db \
  "select linear_session_id,trace_id,root_span_id,started_at,completed_at,runtime,profile from sessions where issue_identifier='ORCH-PHASE4-SMOKE';"
sudo sqlite3 -header -column /var/lib/linear-agent-daemon/events.db \
  "select id,turn_span_id,started_at,execution_finished_at,status from turns where linear_session_id='<scratch-session>' order by id;"
sudo sqlite3 -header -column /var/lib/linear-agent-daemon/events.db \
  "select source,role,enrichment_state,usage_classification,delta_total_tokens from agent_invocations where linear_session_id='<scratch-session>' order by started_at,id;"
sudo sqlite3 -header -column /var/lib/linear-agent-daemon/events.db \
  "select state,attempts,send_started_at,acknowledged_at,last_error from telemetry_outbox where session_id='<scratch-session>';"
```

Use a root-owned mode-0600 curl config containing the Langfuse read authorization; never put
that header in argv or shell history. Query the trace ID above through the region's Langfuse
API and confirm one root, distinct turn spans, exactly one row per real delegation, real
overlap, canonical totals, and nested native detail. Capture redacted child-env/argv/journal
evidence and search it for authorization material, proxy keys, OAuth data, emails, raw
account filenames, and foreign `TRACEPARENT`; every search must be empty. Finally replay the
capability only in the scratch environment after expiry and over budget to confirm 404/413,
and inject one selected-route failure to confirm the persisted route never changes.

The daemon requests 30-day client-credentials app tokens with
`read,write,app:assignable,app:mentionable,admin` and persists their expiry in SQLite. It
reacquires on expiry or an API 401. Rotate a client secret in Linear, update the matching
host value, restart, and verify an ack; rotation invalidates that app's existing tokens.
Revoke the app installation in Linear to cut off access immediately.

### Post-provision checklist

- [ ] Confirm `PLANNER_APP_ACTOR_ID` and `IMPLEMENTER_APP_ACTOR_ID` are both
  populated in `/etc/linear-agent-daemon/env`. Confirm bulk `agentSessions` is scoped to
  the calling app actor and pages as expected; otherwise retain both IDs so the delegated
  issue → `issue.agentSessions` fallback can resolve real session IDs.
- [ ] Attempt the `admin`-scope grant for both apps and run the
  `webhooks/updateWebhook` client-credentials confirmation. Linear currently rejects this
  scope (observed live 2026-07). If it still rejects the scope, stop this gate and file
  **`webhook-reconcile-fallback` — "Decide and implement the webhook re-enable path when
  Linear rejects the `admin` scope on client_credentials tokens"**; record AC6 as blocked,
  not failed.
- [ ] After restart, inspect one full reconcile interval and confirm zero
  `reconcile_sessions_skipped_missing_app_actor_id` events:
  `journalctl -u linear-agent-daemon --since -2min | grep -c reconcile_sessions_skipped_missing_app_actor_id`
  must print `0`.
- [ ] Only if the admin-scope gate succeeded, inspect one full reconcile interval and
  confirm `reconcile_webhook` for both apps and zero `reconcile_webhook_failed` events.
- [ ] Capture one prompted webhook and the same activity through GraphQL; verify
  `webhook agentActivity.id == GraphQL AgentActivity.id`.

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
the main daemon env file or configure that proxy file as a systemd `EnvironmentFile`. The
daemon parses the API key alone for each turn and never passes the management key to children.

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
# Confirm exactly one nonempty API-key assignment without printing its value.
sudo awk -F= '
  /^[[:space:]]*(export[[:space:]]+)?CLIPROXY_API_KEY[[:space:]]*=/ {
    count++; value=$0; sub(/^[^=]*=/, "", value); if (value !~ /^[[:space:]]*$/) nonempty++
  }
  END { print "cliproxy_api_key_assignments=" count, "nonempty=" nonempty;
        exit !(count == 1 && nonempty == 1) }
' /etc/linear-agent-daemon/cliproxyapi.env
sudo systemctl show linear-agent-daemon -p EnvironmentFiles --value
```

Expected: the daemon env is `600 linear-daemon linear-daemon`; proxy secret/config files are
`640 root linear-daemon`; ports 8317 and 8787 listen on `127.0.0.1` only; Caddy listens on
443; password authentication is `no`; all three services are active; the redacted assignment
check reports `cliproxy_api_key_assignments=1 nonempty=1`; and the daemon unit lists only
`/etc/linear-agent-daemon/env`, never `cliproxyapi.env`. Verify the proxy's
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

Inspect Linear MCP health without printing the token or connector response. Each record is
bounded to state and timing metadata:

```bash
sudo journalctl -u linear-agent-daemon --since '-30 min' -o cat |
  grep -E '"event":"linear_mcp_(probe|turn_init|tool_result|turn_close)"' |
  tail -n 50
```

Healthy records show `state:"healthy"`, attempt duration, zero consecutive failures, and a
transition flag. Failures add only a normalized `errorCategory`/`errorCode` plus consecutive
failure and retry counts. If `errorCode` is `cleanup_timeout`, stop probing manually and
restart the daemon after investigating; the monitor intentionally remains blocked until that
restart. Turn-close records classify the outcome as `turn_completed`, `runner_failed`, or
`daemon_shutdown`. The output must not contain `Authorization`, `Bearer`, the Linear API key,
raw response bodies, tool inputs/results, or MCP tool schemas.

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
sudo -u linear-daemon -H sh -c '
  . /etc/linear-agent-daemon/cliproxyapi.env
  printf "header = \"Authorization: Bearer %s\"\n" "$CLIPROXY_MANAGEMENT_KEY" |
    curl -fsS -K - http://127.0.0.1:8787/healthz
' | python3 -m json.tool
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
  grep -E 'session_profile_assigned|provider_state_changed|provider_failure_classified|profile_launcher_unconfigured'
sudo -u linear-daemon -H sh -c '
  . /etc/linear-agent-daemon/cliproxyapi.env
  printf "header = \"Authorization: Bearer %s\"\n" "$CLIPROXY_MANAGEMENT_KEY" |
    curl -fsS -K - http://127.0.0.1:8787/healthz
' | python3 -m json.tool
```

The public health response is only `{ "ok": true }`; provider details require the management-key
header used above. Those journal and authorized-health commands are the supporting AC6 schema/redaction evidence; verify
they contain no key, token, or account email. For AC7, temporarily put a `gpt-*` alias in one
`FABLE_*_MODEL` entry and run `claudex-fable -p test`: it must exit nonzero naming that
variable before sending a model request. Restore the confirmed mapping afterward. Legacy
rows with a NULL profile intentionally route as Sol and log `legacy_session_profile_defaulted`.

Preserve the automated host evidence for the fixture-drivable criteria as well:

```bash
cd /opt/linear-agent-daemon
pnpm vitest run test/sessions.test.ts -t 'persists Fable for planner and implementer|probes readiness' # AC1, AC3
pnpm vitest run test/sessions.test.ts -t 'reopens SQLite|child-restart'                                # AC4
pnpm vitest run test/sessions.test.ts -t 'keeps Fable sticky|selected pool|launcher is unconfigured' # sticky-route AC
pnpm vitest run test/server.test.ts test/sessions.test.ts -t 'keeps provider health private|probes readiness' # AC6
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
denial, widen only the named directive and record that deliberate change. Recorded
widenings: browser engines (agent screen recordings) SIGSYS'd building their process
sandboxes, so the unit now allows `@sandbox unshare setns` (needs systemd >= 255; the
host runs 255) and scopes `RestrictNamespaces` to the namespace kinds browsers use
instead of banning all of them. Direct HTTP MCP
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

## Runtime-reliability acceptance (operator only)

Use disposable planner/implementer sessions and capture only issue identifiers, numeric turn
IDs, states, reasons, and durations. Do not paste prompts, raw activities, environment values,
or database files into the deploy record.

First, ask a disposable daemon-managed session to run one Bash command that waits 360 seconds
and then prints a fixed non-secret sentinel. Confirm the turn completes without a two-minute
reap and that its elapsed time is at least six minutes:

```bash
sudo sqlite3 -header -column /var/lib/linear-agent-daemon/events.db \
  "select t.id,s.issue_identifier,t.status,
          round((t.finished_at-t.started_at)/1000.0,1) elapsed_seconds
   from turns t join sessions s on s.linear_session_id=t.linear_session_id
   order by t.id desc limit 10;"
```

For safe-boundary recovery, start another disposable turn, wait until its Claude session ID is
persisted, and choose a moment with no open tool call. Record the numeric turn ID, restart the
service directly to simulate an unplanned daemon restart, and verify exactly one same-session
continuation:

```bash
sudo sqlite3 -header -column /var/lib/linear-agent-daemon/events.db \
  "select t.id,s.issue_identifier,
          case when s.claude_session_id is null then 0 else 1 end has_session,
          exists(select 1 from turn_tool_calls c
                 where c.turn_id=t.id and c.state='open') has_open_tool
   from turns t join sessions s on s.linear_session_id=t.linear_session_id
   where t.status='running';"
# Continue only for a disposable row showing has_session=1 and has_open_tool=0.
sudo systemctl restart linear-agent-daemon
sudo sqlite3 -header -column /var/lib/linear-agent-daemon/events.db \
  "select id,source_key,status from turns
   where source_key like 'restart-resume:%' order by id desc limit 10;"
```

The old turn must be `interrupted`; one pending/running/done row must have
`source_key=restart-resume:<old-turn-id>` and resume the stored Claude session. A later restart
must not create a second row with that source key.

Next, start a disposable turn whose external Bash tool remains active long enough to observe
an open `turn_tool_calls` row. That open row is the durable `PreToolUse` boundary and must
exist before the external command begins; if the pre-execution write fails, the hook blocks
the tool. Restart the service only after the row appears:

```bash
sudo sqlite3 -header -column /var/lib/linear-agent-daemon/events.db \
  "select c.turn_id,s.issue_identifier,c.tool_name,c.state
   from turn_tool_calls c
   join turns t on t.id=c.turn_id
   join sessions s on s.linear_session_id=t.linear_session_id
   where c.state='open' order by c.opened_at desc;"
sudo systemctl restart linear-agent-daemon
sudo sqlite3 -header -column /var/lib/linear-agent-daemon/events.db \
  "select t.id,t.status,t.source_key,
          exists(select 1 from turns r
                 where r.source_key='restart-resume:' || t.id) auto_resumed
   from turns t where t.status='interrupted' order by t.id desc limit 10;"
```

That interrupted turn must show `auto_resumed=0`, and Linear must receive the human-review
activity explaining that an external tool may have been in flight. Inspect the external
system and worktree before continuing; do not repeat the action merely to make the test green.
Do not induce a production database failure to test the blocking path; retain the automated
hook failure test as that evidence.

Finally, start one more disposable active turn and exercise the explicit hard path:

```bash
sudo daemonctl sessions
sudo daemonctl restart --hard --yes
sudo sqlite3 -header -column /var/lib/linear-agent-daemon/events.db \
  "select t.id,t.status,t.source_key,
          exists(select 1 from turns r
                 where r.source_key='restart-resume:' || t.id) auto_resumed
   from turns t where t.status='interrupted' order by t.id desc limit 10;"
```

The hard-restarted turn must remain unqueued with `auto_resumed=0` and a human-review
activity. After all three cases, inspect the bounded shutdown, recovery, and Linear MCP
records:

```bash
sudo journalctl -u linear-agent-daemon --since '-30 min' -o cat |
  grep -E '"event":"(shutdown|linear_mcp_(probe|turn_init|tool_result|turn_close))"|restart.*(resum|human|required)' |
  tail -n 100
```

Preserve records showing the recovery outcome; shutdown signal, policy, and safe running-turn
summaries; per-turn MCP close classification; and monitor state, retry count, duration, and
normalized error fields. A monitor `cleanup_timeout` must be followed by no additional probe
attempt until daemon restart. Reject the evidence if it includes authorization headers,
tokens, prompts, raw MCP responses, tool inputs/results, or tool schemas.

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
| `ARTIFACT_TOKEN` | 2 / `linear-daemon` | env, `0600` | Artifact-host writes; exposed to spawned sessions as `ARTIFACT_HOST_TOKEN` | Replace env, restart |
| Langfuse OTLP authorization header | 2 / `linear-daemon` | env, `0600` | One Langfuse Cloud project | Rotate project keys, replace env, restart |

Install founder subscription OAuth only through the documented interactive proxy flow; never
copy raw token values or unrelated personal credentials onto the host. All other credentials
are installed only in their owning phase. Install the Langfuse OTLP authorization header only
when telemetry is enabled, and keep it in the mode-`0600` daemon env file.

## Browser verification rollout and rollback

Provisioning reads the exact `@playwright/mcp` version from `package.json`,
installs that global package, and maintains `/usr/local/bin/playwright-mcp`.
After deploying the additive SQLite migration, set `BROWSER_ENABLED=1`, restart
the service, and run this mandatory human-owned hardened-host smoke (the
implementation pipeline must not execute production actions):

```bash
sudo systemctl restart linear-agent-daemon
sudo systemd-run --wait --collect --pipe \
  --uid=linear-daemon --gid=linear-daemon \
  --property=PrivateTmp=yes \
  --property=ProtectSystem=strict \
  --property=ReadWritePaths=/var/lib/linear-agent-daemon \
  --setenv=HOME=/var/lib/linear-agent-daemon \
  --setenv=PLAYWRIGHT_MCP_BIN=/usr/local/bin/playwright-mcp \
  --setenv=PLAYWRIGHT_CHROME_BIN=/usr/bin/google-chrome \
  --setenv=BROWSER_E2E_OUTPUT_DIR=/var/lib/linear-agent-daemon/artifacts/browser-smoke/$(date -u +%Y%m%dT%H%M%SZ) \
  /usr/bin/node /opt/linear-agent-daemon/ops/browser-smoke.mjs
```

The fixture binds only to `127.0.0.1:0`; MCP uses stdio and exposes no network
listener. Record the zero exit status, completed manifest, removed `state/`,
and absence of MCP/Chrome descendants. To roll back, set `BROWSER_ENABLED=0`
and restart. The additive columns and retained evidence may remain; existing
Linear routing and non-browser sessions continue unchanged.

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
