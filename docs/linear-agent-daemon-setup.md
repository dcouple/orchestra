# Linear agent daemon — Linux setup guide

This guide takes you from a fresh Linux host to working `bloom-planner` /
`bloom-implementer` agents in a Linear workspace. It is the practical
end-to-end path; `daemon/ops/runbook.md` remains the authority on host
hardening, credential handling, and the deploy-gate evidence checklist —
this document links into it rather than replacing it.

The daemon receives signed Linear webhooks, runs Claude Code sessions in
per-issue git worktrees on a target repository, and streams progress back
to Linear as agent activities. Assigning **bloom-planner** to an issue
opens a resumable planning discussion; assigning **bloom-implementer**
runs `/do` unattended to an opened pull request. Follow-up replies to
either agent resume the same Claude session.

## What you need before starting

- A Linux host: Ubuntu 24.04, 2+ vCPU / 8+ GB RAM (4 vCPU / 16 GB is
  comfortable for two concurrent sessions), 50 GB disk. Any provider
  works; nothing here is provider-specific.
- A DNS hostname you control (e.g. `linear-agent.example.com`) pointed at
  the host's public IP **before** provisioning — Caddy requests its TLS
  certificate on first boot.
- Admin access to the Linear workspace where the agents will live.
- A GitHub bot identity with a fine-grained PAT scoped to the target
  repository (contents + pull-requests write).
- An OpenAI account with Codex access (ChatGPT Plus/Pro) for both the
  `claudex` proxy and standalone Codex CLI lanes. The provisioner installs
  Claude Code as the harness; it does not require Anthropic authentication.
- A target repository that meets the requirements in
  [Target repository requirements](#target-repository-requirements).

## 1. Provision the host

Create the admin user, harden SSH, copy the `daemon/` directory to the
host, and run the idempotent provisioner as root:

```bash
cd daemon
sudo DAEMON_HOST=linear-agent.example.com ops/provision.sh "$PWD"
```

This installs Node 22, pnpm, git, the GitHub and Codex CLIs, the Claude
Code harness, pinned CLIProxyAPI, a real `claudex` executable, Caddy (TLS
termination, 1 MB body cap, loopback-only proxy to the daemon), UFW (SSH +
HTTPS only), the dedicated low-privilege `linear-daemon` user, and both
systemd units. Follow the **Host and DNS**
and **Host checks** sections of `daemon/ops/runbook.md` for the SSH
hardening steps and post-provision verification commands.

## 2. Register the two Linear OAuth apps

In Linear: **Settings → API → OAuth applications**, create two
applications named `bloom-planner` and `bloom-implementer`. The creation
form has no scopes field — scopes are requested by the daemon at token
time, not configured on the app.

For **both** apps:

- **Client credentials**: toggle ON. Without it the daemon cannot obtain
  tokens at all.
- **Webhooks**: toggle ON.
- **Webhook URL**: `https://<your-hostname>/webhook/planner` for the
  planner, `https://<your-hostname>/webhook/implementer` for the
  implementer.
- Under **App events**, check **Agent session events**.
- **Redirect URIs**: the client-credentials flow never uses one; if the
  form requires a value, `https://<your-hostname>/oauth/callback` is a
  fine placeholder.
- **Public**: off.

For **bloom-implementer only**, additionally check **Issues** under
**Data change events** — that webhook is how the daemon learns an issue
was completed so it can clean up the worktree and branch.

After saving each app, record three values: the **client ID**, the
**client secret**, and the **webhook signing secret** (`lin_wh_…`).

Finally, create an API key (**Settings → Security & access → API keys**)
for `LINEAR_API_KEY`. Spawned agent sessions use it for the Linear MCP
server, so ticket edits made by agents are attributed to the key's owner
— prefer a dedicated service/bot account over a personal key.

**Scope note (observed live, 2026-07):** Linear rejects the `admin` scope
on client-credentials token requests. The daemon detects this and retries
without it. The only lost capability is automatic webhook re-enablement
at startup — if Linear ever disables a webhook after repeated delivery
failures, re-enable it manually in the app's settings page.

## 3. Target repository requirements

The repository the agents work on must have:

1. **The dcouple skill system synced in** (`.claude/`, `.codex/`,
   `.references/`), via the consumer repo's normal `update-skills` flow.
2. **A `Work-item tracking` section in `AGENTS.md` pointing at Linear**,
   so `/do` and the planning skills can pull and update the issue. The
   daemon injects a `linear` MCP server (authorized by `LINEAR_API_KEY`)
   into every session. Example section:

   ```markdown
   ## Work-item tracking

   The workflow skills (`/create-plan`, `/create-epic`, `/do`) create
   work-item artifacts locally under `./tmp/<id>/`. `./tmp/` is scratch —
   never commit it.

   ```yaml
   tracker: linear
   ```

   > Work items live in Linear; identifiers look like `ENG-123`. Pull the
   > work item (description + comments) and update it via the `linear`
   > MCP tools configured in the session; if MCP is unavailable, use the
   > Linear GraphQL API authenticated with the `LINEAR_API_KEY`
   > environment variable. At publish, item.md is the issue description;
   > refs/ files ride as marker-delimited comments. At wrap-up, post the
   > wrapup as a comment and link the PR.
   ```

3. **A test/verify flow the host can run.** Whatever the repo's
   `AGENTS.md` commands need (databases, emulators, env vars) must work
   headlessly on this host. Browser-driven and device-driven acceptance
   criteria cannot be auto-verified here and stay with human QA on the
   PR.

Clone the repository over HTTPS as the service user (see the **Planner
credentials and repository** section of the runbook for the credential
install flow):

```bash
sudo -u linear-daemon -H git clone https://github.com/<owner>/<repo>.git \
  /var/lib/linear-agent-daemon/repos/<repo>
```

## 4. Install agent credentials

All four credentials belong to the `linear-daemon` user and must be bot
identities, never personal ones. The runbook's **Planner credentials and
repository** and **Credential inventory** sections give the exact
commands; the checklist is:

1. Bot git identity + GitHub fine-grained PAT (HTTPS credential store,
   mode 600), verified with a dry-run push and one disposable draft PR.
2. CLIProxyAPI's one-time OpenAI Codex OAuth completed as `linear-daemon`
   with `--codex-login --no-browser`; credentials must appear under
   `/var/lib/linear-agent-daemon/.cli-proxy-api/`.
3. `claudex` verified with a trivial `-p` turn that returns through
   GPT-5.6 Sol. No Anthropic login is installed on this host.
4. The standalone `codex` CLI authenticated and verified with
   `codex exec --version`.
5. The Linear API key — only ever in the env file below.

The runbook's **Planner credentials and repository** section contains the
exact OAuth, model-list, and `claudex` smoke commands.

## 5. Configure and start

Write `/etc/linear-agent-daemon/env` (owner `linear-daemon`, mode 600):

```dotenv
PORT=8787
BIND_ADDR=127.0.0.1
DB_PATH=/var/lib/linear-agent-daemon/events.db
WEBHOOK_BASE_URL=https://linear-agent.example.com

PLANNER_WEBHOOK_SECRET=...
PLANNER_LINEAR_CLIENT_ID=...
PLANNER_LINEAR_CLIENT_SECRET=...
IMPLEMENTER_WEBHOOK_SECRET=...
IMPLEMENTER_LINEAR_CLIENT_ID=...
IMPLEMENTER_LINEAR_CLIENT_SECRET=...
LINEAR_API_KEY=...

SESSIONS_ENABLED=1
TARGET_REPO_PATH=/var/lib/linear-agent-daemon/repos/<repo>
WORKTREES_ROOT=/var/lib/linear-agent-daemon/worktrees
CLAUDE_BIN=/var/lib/linear-agent-daemon/.local/bin/claudex
CLAUDE_PERMISSION_MODE=bypassPermissions
CLAUDE_MAX_TURNS=100
DO_PERMISSION_MODE=bypassPermissions
DO_MAX_TURNS=300
DO_MAX_BUDGET_USD=20
SESSION_CONCURRENCY=2
KEEPALIVE_MS=900000
ATTACHMENTS_ENABLED=1
ATTACHMENT_HOSTS=uploads.linear.app

# Optional: one-way push notification (ntfy) whenever an agent posts a
# terminal response or error. Subscribe to the topic in the ntfy app.
# Public topics are readable by anyone who knows the name — make it
# unguessable.
#NTFY_URL=https://ntfy.sh/<unguessable-topic>
```

Start with a conservative `DO_MAX_BUDGET_USD`; raise it once you trust
the flow. Then:

```bash
sudo systemctl restart linear-agent-daemon
journalctl -u linear-agent-daemon -f
```

## 6. Staged smoke test

Prove each layer before enabling the next; the runbook's smoke sections
have the exact SQL/GraphQL evidence queries.

1. **Ingress** (`SESSIONS_ENABLED=0` if you want to isolate it):
   `curl https://<hostname>/healthz` returns `{"ok":true}` externally.
   Assign bloom-planner to a throwaway issue; the log shows a `webhook`
   event and the issue shows the "picked up — starting work" ack within
   10 seconds. `kill -9` the daemon; systemd restarts it with events
   intact.
2. **Planner**: a full planning turn streams thoughts into the session
   and ends in a response. Reply — the same Claude session and worktree
   resume. Restart the service between turns and reply again; resume
   still works.
3. **Implementer**: assign a small, plan-ready issue. `/do` runs
   unattended on branch `agents/<identifier>`, opens a PR, and the PR
   appears on the session. Reply to an implementer question — the session
   resumes. Move the issue to a `completed` state; the worktree and
   branch are cleaned up (dirty worktrees are retained and reported).
4. If `NTFY_URL` is set, each terminal response/error arrives as a phone
   notification.

## Known limitations

- **Webhook re-enable is manual** (admin scope unavailable — see the
  scope note above).
- **Implementer replies sent while the daemon is down are not replayed**
  by startup reconciliation; planner replies are. Re-send the reply after
  the daemon is back up.
- **Verification is headless**: tests, builds, and scripts run; browser
  and mobile acceptance criteria fall to human QA on the PR.
- Sessions run with `bypassPermissions` inside worktrees on this host —
  treat the machine as an untrusted-automation zone: dedicated bot
  credentials only, nothing else valuable on the box, and branch
  protection on the target repo's default branch as the backstop.

## Local development variant (macOS)

The daemon also runs on a Mac for development: build with `pnpm build`,
run with the same env via a wrapper script, and expose the listener with
an ngrok static domain (`ngrok http 8787 --url=<domain>`) used as
`WEBHOOK_BASE_URL` and in the Linear webhook URLs. Claude Code on macOS
stores credentials in the Keychain and requires `USER` in the child
environment — the daemon passes it. Tunnel-URL changes require editing
both Linear apps' webhook URLs, which is why a static domain is worth
the free signup.
