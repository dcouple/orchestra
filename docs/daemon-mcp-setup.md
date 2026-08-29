# Daemon MCP servers — setup, secrets, and tokens

How to give daemon-run agents a project's MCP tools, and how the secrets those
tools need are minted, stored, delivered, rotated, and revoked. Read this when
a consumer repo wants its agents to reach a service (PostHog, Sentry, Notion,
GitHub, …) from an unattended daemon turn.

The contract in one line: **the consumer repo owns the tool list, the
deployment owns the secrets, the daemon lets them meet** — and the daemon's
deny-list has the final word.

## 1. The model

```
consumer repo (worktree)         deployment env file (0600)        daemon · per turn            claude -p child
.mcp.json                        POSTHOG_API_KEY=…                 --settings: enable project    merges .mcp.json +
  posthog: { url, headers:       MCP_ENV_PASSTHROUGH=POSTHOG_…       MCP servers                 --mcp-config; expands
  Bearer ${POSTHOG_API_KEY} }                                      childEnv: allow-list +        ${VAR} from child env;
                                                                     passthrough → deny-list     name clash → --mcp-config
```

| Who | Owns | Never holds |
|---|---|---|
| Consumer repo | `.mcp.json` — server names, URLs, commands, `${VAR}` placeholders | any secret value |
| Deployment (service account's env file) | secret values + the `MCP_ENV_PASSTHROUGH` name list | tool definitions |
| Daemon (orchestra code) | pre-approval (`enableAllProjectMcpServers`), env passthrough, deny-list, the injected `linear` server | knowledge of any specific tool |

Behavioural facts that shape every step below (verified against Claude Code
2.1.2xx; re-verify on a CLI major upgrade):

- The child's cwd `.mcp.json` and the daemon's `--mcp-config` **merge**. On a
  server-name clash the `--mcp-config` entry wins **whole** — so a consumer's
  header-less `linear` entry is harmlessly overridden by the daemon's
  bearer-authenticated one.
- `${VAR}` and `${VAR:-default}` expand in `url`, `headers`, `env`, `args`,
  `command` from the **child process env**. An unset var leaves the literal
  text and the server fails to connect — it does not fall back.
- Headless turns cannot complete OAuth. Every remote server needs a **static
  bearer token**; OAuth-only hosted servers are unusable from the daemon.
- Every value that reaches the child is visible to the agent's `Bash` in a
  prompt-injectable turn. Treat each token as **agent-visible**: same trust
  class as `GH_TOKEN` and `LINEAR_API_KEY`.

## 2. Consumer repo: declare the servers

Edit the repo's checked-in `.mcp.json`. The file is the whole tool list; the
daemon does not read, copy, or merge it, and does not scope it per role —
**every entry loads in every daemon turn.**

```json
{
  "mcpServers": {
    "posthog": {
      "type": "http",
      "url": "https://mcp.posthog.com/mcp",
      "headers": { "Authorization": "Bearer ${POSTHOG_API_KEY}" }
    },
    "sentry": {
      "type": "http",
      "url": "https://mcp.sentry.dev/mcp",
      "headers": { "Authorization": "Bearer ${SENTRY_TOKEN}" }
    },
    "notion": {
      "command": "notion-mcp-server",
      "env": { "NOTION_TOKEN": "${NOTION_TOKEN}" }
    }
  }
}
```

Rules:

1. **No secret values, ever.** Placeholders only. A committed token is a
   revoke-and-rotate incident, not a cleanup.
2. **Bearer auth, not OAuth.** If a hosted server only offers OAuth, use its
   local/self-hosted stdio equivalent (Notion: `@notionhq/notion-mcp-server`).
3. **stdio servers must be pre-installed** for the daemon's service account
   (`npm i -g …` or a pinned binary on its `PATH`). A `pnpm dlx` / `npx -y`
   entry downloads on every turn, slowly, and fails offline — replace it with an
   installed binary before deploying.
4. **Trim dev-only entries** (`playwright`, `xcodebuildmcp`, IDE helpers) or
   accept that they start on the host every turn. The daemon injects its own
   `playwright` on browser turns; a project one is redundant.
5. **Placeholder names are plain env identifiers** (`[A-Za-z_][A-Za-z0-9_]*`)
   and must not collide with the reserved names in §4.
6. Keep `linear` out, or leave it header-less for local dev — either way the
   daemon's injected entry wins.

Land this PR in the consumer repo **before** the daemon build that honours
`.mcp.json` is deployed there; otherwise whatever the file contains today loads
in every turn from the first deploy.

## 3. Secrets and tokens: mint, store, deliver

### 3.1 Mint — least privilege, per service, revocable

For each `${VAR}` in `.mcp.json`:

- Create a **dedicated bot/service token** for the daemon — never a personal
  token, never one shared with a human workflow.
- **Read-only** wherever the tool allows; scope to the projects/orgs the agents
  actually need. Remember the agent's Bash can `curl` with it.
- Note the **revocation path** (which dashboard, which API) before you use it —
  you'll need it in a hurry if a turn is prompt-injected.
- Prefer tokens with an **expiry** where the service supports it, and calendar
  the rotation.

### 3.2 Store — secret manager is the source of truth

The env file on the host is a *delivery* location, not the record of truth.
Store every daemon MCP token in the org's secret manager (the same store
`.references/testing-accounts.md` uses), one secret per token:

- **Name:** `DAEMON_MCP_<SERVICE>` (e.g. `DAEMON_MCP_POSTHOG`), matching the
  env-var name used in `.mcp.json` in the `<SERVICE>` part. Add `_<DEPLOYMENT>`
  when more than one daemon deployment exists.
- **Payload:** the raw token value only (no JSON), so it can be rendered
  straight into `KEY=value`.
- **Labels/metadata:** service, scope granted, owner, created date, rotation
  due date.

```bash
printf '%s' '<token>' | gcloud secrets create DAEMON_MCP_POSTHOG \
  --data-file=- --project <project>
# rotation = a new version, never an edit:
printf '%s' '<new token>' | gcloud secrets versions add DAEMON_MCP_POSTHOG --data-file=- --project <project>
```

The consumer repo documents **only the pointer** — the secret name and the
env-var it maps to — in its daemon docs (see §6), never the value.

### 3.3 Deliver — the deployment env file

On the host, as the daemon's service account (never as your operator user),
add to the daemon env file — `~/.config/linear-agent-daemon/env` on macOS,
`/etc/linear-agent-daemon/env` on Linux; **mode 0600, owned by the service
account**:

```dotenv
# Project MCP secrets (values from the secret manager: DAEMON_MCP_<SERVICE>)
POSTHOG_API_KEY=phx_…
SENTRY_TOKEN=sntrys_…
NOTION_TOKEN=ntn_…
MCP_ENV_PASSTHROUGH=POSTHOG_API_KEY,SENTRY_TOKEN,NOTION_TOKEN
```

- `MCP_ENV_PASSTHROUGH` is a comma-separated list of **names**; each name must
  also be set in the same file. A listed-but-unset name is silently absent from
  the child (the server then fails to connect) — it is not a startup error.
- Render values from the secret manager rather than pasting from a chat or
  ticket, e.g. `gcloud secrets versions access latest --secret DAEMON_MCP_POSTHOG --project <project>`
  in an interactive session as the service account. Never `echo` a value into
  a shell history that is not the service account's.
- Restart with the repo's wrappers (`daemonctl restart` on the host; for a
  host restart on macOS use the `mini-restart`-style wrapper,
  never plain `reboot`).

## 4. What the daemon refuses (reserved names)

`loadConfig` fails at startup — the daemon does not come up — if
`MCP_ENV_PASSTHROUGH` names any of:

| Class | Names | Why |
|---|---|---|
| Denied child secrets | `*_WEBHOOK_SECRET`, `*_LINEAR_CLIENT_SECRET`, `*_LINEAR_TOKEN`, `*_OAUTH_TOKEN`, `OAUTH_*`, `CLIPROXY_MANAGEMENT_KEY`, `ARTIFACT_TOKEN` | daemon-management secrets; the deny-list strips them from every child regardless of config |
| Daemon-owned | `LINEAR_API_KEY`, `CLIPROXY_API_KEY`, `ARTIFACT_HOST_TOKEN`, `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS` | the daemon sets these itself; passthrough may not widen where they come from |
| Malformed | anything not matching `[A-Za-z_][A-Za-z0-9_]*` | not an env identifier |

The message names the key: `MCP_ENV_PASSTHROUGH must not name PLANNER_WEBHOOK_SECRET (denied child secret)`.
Don't work around it by renaming a management secret — pick a token that is
meant to be agent-visible.

## 5. Verify before trusting a real issue

**Startup:** `daemonctl status` (or the host's log) shows the daemon up; a
rejected name shows the `MCP_ENV_PASSTHROUGH …` error instead.

**Smoke test from the daemon's context** — as the service account, in a
checkout of the consumer repo, with the same launcher the daemon uses:

```bash
printf '{"enableAllProjectMcpServers":true}' > /tmp/mcp-settings.json
printf '{"mcpServers":{}}' > /tmp/mcp-empty.json
set -a; . ~/.config/linear-agent-daemon/env; set +a
$CLAUDE_BIN -p "List every MCP tool name you have, one per line, grouped by server. Call nothing." \
  --output-format stream-json --verbose \
  --settings /tmp/mcp-settings.json --mcp-config /tmp/mcp-empty.json \
  --permission-mode bypassPermissions --max-turns 3 \
  | tee /tmp/mcp-probe.jsonl | grep -o '"mcp__[a-z0-9_]*__' | sort | uniq -c
grep -o '"mcp_servers":\[[^]]*\]' /tmp/mcp-probe.jsonl | head -1
rm -f /tmp/mcp-probe.jsonl
```

Pass: every server in `.mcp.json` shows `"status":"connected"` in the init
event and has tools listed. A `failed` server is almost always the token path
(wrong var name in `MCP_ENV_PASSTHROUGH`, var unset, header format the
service doesn't accept). Then run one real daemon turn and confirm the agent's
tool inventory — and that `linear` tools still succeed.

## 6. Record it — the credential inventory

Every token gets a row in the deployment's credential inventory (the
orchestra runbook's table for daemon-level credentials; the consumer repo's
daemon docs for project MCP tokens):

| Credential | Secret-manager name | Env var | Scope | Owner | Rotation / revocation |
|---|---|---|---|---|---|
| PostHog MCP bot token | `DAEMON_MCP_POSTHOG` | `POSTHOG_API_KEY` | read-only, project X | <team> | new secret version → update env file → `daemonctl restart`; revoke in PostHog › Personal API keys |

Without this row the token is untracked: nobody knows to rotate it, and an
incident response starts with "which tokens can the agent see?".

## 7. Rotate and revoke

- **Rotate:** mint new → `gcloud secrets versions add …` → update the env
  file value → `daemonctl restart` → smoke test (§5) → revoke the old token
  at the service. Rotation never touches the consumer repo.
- **Revoke in an incident:** revoke at the service first (that is what stops
  the agent), then remove the name from `MCP_ENV_PASSTHROUGH` and the value
  from the env file, restart, and note it in the inventory. Turns in flight
  keep their already-spawned env until they end.
- **Remove a tool:** delete its entry from `.mcp.json` (consumer PR), then
  drop the var from the env file and the list, restart, revoke the token.

## 8. Adding a tool later — the checklist

1. Consumer PR: add the `.mcp.json` entry with `${NEW_VAR}` (§2).
2. Mint a least-privilege bot token (§3.1); store as `DAEMON_MCP_<SERVICE>` (§3.2).
3. On the host, as the service account: add `NEW_VAR=…` and append `NEW_VAR`
   to `MCP_ENV_PASSTHROUGH` (§3.3); `daemonctl restart`.
4. Smoke test (§5); confirm one real turn lists `mcp__<server>__*`.
5. Inventory row (§6).

No orchestra change at any step.
