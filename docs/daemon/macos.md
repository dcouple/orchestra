# macOS daemon provisioning

`daemon/ops/macos/` provisions the Linear webhook daemon and CLIProxyAPI on an
Apple Silicon Mac. Both are system LaunchDaemons running as a dedicated
administrator account and listening only on loopback; a locally managed
Cloudflare Tunnel publishes the daemon at a hostname you own. Routine
operation is in [RUNBOOK.md](../../RUNBOOK.md).

Everything that identifies one deployment (the public hostname, the service
account, the launchd label prefix) lives in a **site config**. Copy
[`site.env.example`](../../daemon/ops/macos/site.env.example), fill it in,
and keep the copy in the consumer repo's docs (it holds no secrets). The
provisioner installs it at `/usr/local/etc/linear-agent-daemon/site.env`,
where `daemonctl`, `deploy.sh`, and the launchd runners read it. The
`*.template` files are rendered from it; nothing in that directory is
installed verbatim except the scripts.

Below, `<host>` is your SSH alias for the operator account on the Mac and
`<user>` is `DAEMON_SERVICE_USER` from the site config. The host itself is
prepared by [machines/mac-mini](../../machines/mac-mini/README.md) (Homebrew
is a prerequisite).

## Run from an operator checkout

From the repository root, copy the setup bundle and your site config, then
run the provisioner against the daemon source directory. Run it as the
operator **without** a `sudo` prefix: it calls sudo itself (the allocated TTY
lets it prompt), Homebrew refuses to run as root, and the script rejects
EUID 0.

```bash
rsync -a daemon/ops/macos/ <host>:~/daemon-macos-setup/
scp path/to/site.env <host>:~/daemon-macos-setup/site.env
ssh <host> 'test -d ~/orchestra-bootstrap/.git || git clone https://github.com/dcouple/orchestra.git ~/orchestra-bootstrap'
ssh <host> 'git -C ~/orchestra-bootstrap pull --ff-only'
ssh -t <host> 'bash ~/daemon-macos-setup/provision.sh --site ~/daemon-macos-setup/site.env ~/orchestra-bootstrap/daemon'
```

`--site` is required on the first run; afterwards the provisioner reads the
installed copy, and passing `--site` again replaces it (every service
restarts when it changes). Inventory-only mode performs no mutation:

```bash
ssh -t <host> 'bash ~/daemon-macos-setup/provision.sh --dry-run ~/orchestra-bootstrap/daemon'
```

The provisioner:

- creates the service account, its home layout, and the persistent HTTPS
  checkout `<service home>/orchestra-source` used by `daemonctl reload`;
- installs node@22, pinned pnpm, gh, CLIProxyAPI (version and SHA-256
  pinned), Claude Code, the managed Codex, Playwright MCP, XcodeBuildMCP,
  Chrome, and cloudflared;
- generates the CLIProxyAPI keys and config;
- installs the scripts under `/usr/local/sbin`, the LaunchDaemon plists, and a
  narrow sudoers rule (`/etc/sudoers.d/linear-agent-daemon-services`) for the
  fixed `launchctl` commands `daemonctl` and `deploy.sh` use;
- deploys the daemon with `deploy.sh`, runs the Codex provider gate once a
  Codex credential is enrolled, and then installs Agent Farm.

It prints a summary where every row is `already-correct`, `applied`,
`would-apply`, or `pending-human: <what to do>`. Unattended runs need a
temporary passwordless sudo grant; remove it as the final privileged setup
action.

### Agent Farm

Only the `agent-farm:<profile>` harness needs Agent Farm. The provisioner
pins `@greenfieldco/agent-farm@0.2.0`, installs it with `pnpm add --global`
for the service account (`~/.pnpm/bin/agent-farm`), installs the bundled
Greenfield plugin into `~/.config/agent-farm`, writes the `cliproxy` provider
in `~/.config/agent-farm/settings.json`, and places the managed workspace
(from the Agent Farm workspace profile under `daemon/ops/agent-farm/`) and the
browser launcher `/usr/local/libexec/orchestra-agent-farm-browser`. Core
provisioning also installs the `/usr/local/bin/agent-farm` wrapper (root:wheel,
0755), which forwards to the service account's executable.

If the pinned package cannot be installed, the summary records
`agent-farm-cli pending-release: @greenfieldco/agent-farm@0.2.0 not installable`
and the dependent rows as `pending-release`, and provisioning still exits 0;
rerun it once the package is available. `deploy.sh` reports
`needs-provision` when the wrapper drifts.

## Human handoffs

Write the daemon env file as the service user
(`<service home>/.config/linear-agent-daemon/env`, mode 0600) using
[configuration.md](configuration.md). On macOS set `CLIPROXY_ENV_FILE`,
`FABLE_MODELS_ENV_FILE`, and `PLAYWRIGHT_CHROME_BIN` explicitly; their
defaults are Linux paths. `deploy.sh` refuses to accept a deploy (exit 3,
`pending-human`) until the env file sets `TARGET_REPO_PATH`,
`LINEAR_API_KEY`, `DO_PERMISSION_MODE`, and `DO_MAX_TURNS`, and CLIProxyAPI
serves `gpt-5.6-sol` (skipped when `SESSIONS_ENABLED=0`).

Open an interactive login as the service user for credentials and identity:

```bash
ssh -t <host> 'sudo -u <user> -i'
daemonctl subscriptions add codex
claude
gh auth login
git config --global user.name '<bot display name>'
git config --global user.email '<bot email>'
```

`subscriptions add` runs CLIProxyAPI's one-time `--codex-login --no-browser`
flow as the service user; launchd keeps owning the server process. Claude
Code may keep its credential in the login Keychain; confirm a Claude turn
works from the LaunchDaemon context. Repository and credential details are in
[operations.md](operations.md#planner-credentials-and-repository). Re-run the
provisioner after the handoffs; a converged run reports every row
`already-correct`.

## Public ingress

The loopback daemon is published through a Cloudflare Tunnel at
`DAEMON_PUBLIC_HOSTNAME`. The hostname's zone must be on Cloudflare and show
**Active** before you create the tunnel. Do the handoff as the service user so
the certificate and tunnel credentials land in its home, then re-run the
provisioner:

```bash
ssh -t <host> 'sudo -u <user> -i'
/opt/homebrew/bin/cloudflared tunnel login
/opt/homebrew/bin/cloudflared tunnel create <DAEMON_TUNNEL_NAME>
/opt/homebrew/bin/cloudflared tunnel route dns <DAEMON_TUNNEL_NAME> <DAEMON_PUBLIC_HOSTNAME>
exit
ssh -t <host> 'bash ~/daemon-macos-setup/provision.sh ~/orchestra-bootstrap/daemon'
```

The provisioner picks the newest UUID-named credentials JSON, renders the
cloudflared config, and starts `<prefix>.cloudflared`. Use this managed plist
rather than `cloudflared service install`.

### Cutover order

When this host replaces an existing daemon, keep the old host serving until
the new one is proven:

1. Public health: `curl -fsS https://<DAEMON_PUBLIC_HOSTNAME>/healthz` returns
   `{"ok":true,"sim":{...}}` through the tunnel.
2. Stop the old daemon, checkpoint its SQLite WAL, and copy `events.db`,
   `artifacts/`, `repos/`, `worktrees/`, and `.cli-proxy-api/` into the
   service user's home, owned by the service user.
3. Set `WEBHOOK_BASE_URL=https://<DAEMON_PUBLIC_HOSTNAME>` in the env file and
   run `daemonctl restart`.
4. Point both Linear apps' webhook URLs at the new hostname
   (`/webhook/planner`, `/webhook/implementer`).
5. Verify an end-to-end planner turn, then decommission the old host or keep
   it with `SESSIONS_ENABLED=0` to serve existing artifact links.

## Simulator capability

The operator installs Xcode and an available iOS runtime and accepts the
Xcode license; provisioning installs the pinned XcodeBuildMCP and the
`orchestra-sim` wrapper and reports Xcode and runtime availability. The daemon
enables XcodeBuildMCP's `session-management`, `simulator`, and
`ui-automation` workflows and runs from the system launchd domain, with no
console session.

Before setting `IOS_SIM_ENABLED=1` (keys in
[configuration.md](configuration.md#linear-mcp-browser-simulator-artifacts-notifications)),
run `daemonctl sim-preflight --dry-run`, then `daemonctl sim-preflight`. It
ensures one shut-down golden device, sweeps unleased orphans, and proves the
boot, install, launch, screenshot, accessibility snapshot, and shutdown round
trip. While a running daemon reports the capability available, preflight only
reports `probe=skipped` and leaves the golden device alone; stop the daemon to
run the mutating preflight during maintenance. After a host restart, run the
probe before any GUI login. If it fails with a session-binding error, log in
once, re-run it, and record a console session as a host requirement.

## Boot behavior

`RunAtLoad` and `KeepAlive` start the three services with no console login.
`run-cliproxyapi.sh` and `run-daemon.sh` first wait for DNS (up to
`DAEMON_NETWORK_WAIT_SECONDS`, default 120, then start anyway) so the proxy's
startup model-catalog fetch succeeds. After a reboot,
`grep 'startup model refresh' ~/Library/Logs/cliproxyapi.log` in the service
user's home reads `completed`.
