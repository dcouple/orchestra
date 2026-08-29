# macOS daemon provisioning

This directory provisions the Linear webhook daemon and CLIProxyAPI on an
Apple Silicon Mac. Both are system LaunchDaemons running as a dedicated
administrator account and listening only on loopback; a locally-managed
Cloudflare Tunnel publishes the daemon at a hostname you own.

Everything that identifies one deployment - the public hostname, the service
account, the launchd label prefix - lives in a **site config**, not here.
Copy [`site.env.example`](site.env.example), fill it in, and keep the copy in
the consumer repo's docs (it holds no secrets). The provisioner installs it at
`/usr/local/etc/linear-agent-daemon/site.env`, and `daemonctl`, `deploy.sh`,
and the launchd runners read it from there. The `*.template` files are
rendered from it; nothing in this directory is installed verbatim except the
scripts.

Below, `<host>` is your SSH alias for the operator account on the Mac and
`<user>` is `DAEMON_SERVICE_USER` from the site config.

## Run from an operator checkout

From the repository root, copy the setup bundle and your site config, then
run the provisioner against the daemon source directory. The allocated TTY
lets it prompt for the operator's sudo password when no passwordless grant
is present:

```bash
rsync -a daemon/ops/macos/ <host>:~/daemon-macos-setup/
scp path/to/site.env <host>:~/daemon-macos-setup/site.env
ssh <host> 'test -d ~/orchestra-bootstrap/.git || git clone https://github.com/dcouple/orchestra.git ~/orchestra-bootstrap'
ssh <host> 'git -C ~/orchestra-bootstrap pull --ff-only'
ssh -t <host> 'bash ~/daemon-macos-setup/provision.sh --site ~/daemon-macos-setup/site.env ~/orchestra-bootstrap/daemon'
```

`--site` is required on the first run; afterwards the provisioner reads the
installed copy, and passing `--site` again replaces it (every service is
restarted when it changes). Inventory-only mode performs no mutation:

```bash
ssh -t <host> 'bash ~/daemon-macos-setup/provision.sh --dry-run ~/orchestra-bootstrap/daemon'
```

The provisioner installs a permanent, narrow sudoers rule
(`/etc/sudoers.d/linear-agent-daemon-services`) for the fixed `launchctl`
commands used by `daemonctl` and `deploy.sh`. It does not grant a
passwordless operator shell. After verification, remove the temporary broad
grant as the final privileged setup action. Unattended provisioning runs
still require that temporary passwordless grant.

## Human handoffs

Write the daemon environment file as the service user
(`$DAEMON_SERVICE_HOME/.config/linear-agent-daemon/env`, mode 0600). The
variables are the same as the Linux deployment's
(`docs/linear-agent-daemon-setup.md`, step 5) with macOS paths; `deploy.sh`
refuses to accept a deploy until it exists with `TARGET_REPO_PATH`,
`LINEAR_API_KEY`, `DO_PERMISSION_MODE`, and `DO_MAX_TURNS` set. Two settings
whose compiled-in defaults are Linux paths must be set explicitly:

```dotenv
CLIPROXY_ENV_FILE=<DAEMON_SERVICE_HOME>/.config/linear-agent-daemon/cliproxyapi.env
FABLE_MODELS_ENV_FILE=<DAEMON_SERVICE_HOME>/.config/linear-agent-daemon/fable-models.env
```

Without the first, the daemon passes health checks but fails live turns with
`proxy_env_unreadable`; without the second, every `FABLE_BIN` turn dies before
launch with "missing Fable model file". The Fable models file itself stays
operator-authored (see the runbook's "Enable and verify Fable routing").
Secrets never enter this repository.

### Simulator capability

The operator installs Xcode and an available iOS runtime, accepts the Xcode
license, and configures the `IOS_SIM_*` and `XCODEBUILD_MCP_BIN` keys listed in
the main setup guide. Provisioning installs the pinned XcodeBuildMCP and the
`orchestra-sim` wrapper; it inventories Xcode/runtime availability but does
not install either Apple component. Before setting `IOS_SIM_ENABLED=1`, run
`daemonctl sim-preflight --dry-run`, then `daemonctl sim-preflight` to ensure
one shut-down golden device, sweep unleased orphans, and prove the boot,
install, launch, screenshot, accessibility snapshot, and shutdown round trip.
For later maintenance, stop the daemon before running the mutating preflight.
While a running daemon reports the simulator capability available, preflight
only reports that the probe was skipped; it never touches the golden device.

Open an interactive login context as the service user for credentials and
identity:

```bash
ssh -t <host> 'sudo -u <user> -i'
daemonctl subscriptions add codex
claude
gh auth login
git config --global user.name '<bot display name>'
git config --global user.email '<bot email>'
```

The subscription command runs CLIProxyAPI's one-time `--codex-login
--no-browser` flow while logged in as the service user; launchd continues to
own the server process. Re-run the provisioner after all handoffs. A fully
converged second run reports every setting `already-correct`.

## Routine operation

A key-only SSH alias straight to the service user is the normal one-shot
operations path, and the target of the root `Makefile`'s `daemon-*` targets
(`make daemon-status DAEMON_SSH_HOST=<service-alias>`):

```bash
ssh <service-alias> '/usr/local/sbin/daemonctl status'
ssh -t <service-alias> '/usr/local/sbin/daemonctl reload --reason "operator deploy"'
```

Operators without that alias can use the password-prompting fallback (without
`-i`, which would re-concatenate the command):

```bash
ssh -t <host> 'sudo -u <user> /usr/local/sbin/daemonctl status'
ssh -t <host> 'sudo -u <user> /usr/local/sbin/daemonctl reload --reason "operator deploy"'
```

## Public ingress

The loopback daemon is exposed through a Cloudflare Tunnel at
`DAEMON_PUBLIC_HOSTNAME`. The hostname's zone must be on Cloudflare (any plan)
and show **Active** before the tunnel is created. Perform the interactive
handoff as the service user so the certificate and tunnel credentials land
in its home, then re-run the provisioner:

```bash
ssh -t <host> 'sudo -u <user> -i'
/opt/homebrew/bin/cloudflared tunnel login
/opt/homebrew/bin/cloudflared tunnel create <DAEMON_TUNNEL_NAME>
/opt/homebrew/bin/cloudflared tunnel route dns <DAEMON_TUNNEL_NAME> <DAEMON_PUBLIC_HOSTNAME>
exit
ssh -t <host> 'bash ~/daemon-macos-setup/provision.sh ~/orchestra-bootstrap/daemon'
```

The provisioner chooses the newest UUID-named credentials JSON, renders the
cloudflared config template, and starts `<prefix>.cloudflared`. Cloudflared is
a floating Homebrew formula, matching the other brew-managed packages; the
wrapper disables cloudflared's own updater. Do not use `cloudflared service
install`, which would create an unmanaged competing plist.

### Cutover order

When this host replaces an existing daemon, sequence the switch so the old
host keeps serving until the new one is proven:

1. Public health: `curl -fsS https://<DAEMON_PUBLIC_HOSTNAME>/healthz`
   returns `{"ok":true}` through the tunnel.
2. Stop the old daemon, checkpoint its SQLite WAL, and copy `events.db`,
   `artifacts/`, `repos/`, `worktrees/`, and `.cli-proxy-api/` into the
   service user's home (ownership must end up as the service user).
3. Set `WEBHOOK_BASE_URL=https://<DAEMON_PUBLIC_HOSTNAME>` in the env file
   and `daemonctl restart`.
4. Re-point both Linear OAuth apps' webhook URLs at the new hostname
   (`/webhook/planner`, `/webhook/implementer`).
5. Verify an end-to-end planner turn, then decommission or demote the old
   host (`SESSIONS_ENABLED=0` keeps it serving old artifact links only).

Keep the consumer repo's own dated runbook for the concrete hosts, zones, and
commands of a given migration.

## Security and deferred verification

Launchd has no equivalents for the Linux unit's systemd sandbox directives;
those controls are intentionally absent on this single-purpose machine. There
is no codex-live service. Reboot acceptance is deferred until the operator is
physically near the machine; `RunAtLoad` and `KeepAlive` provide the intended
no-login startup behavior but are not claimed as reboot evidence until that
test is performed.

### Simulator automation

The daemon enables XcodeBuildMCP's `session-management`, `simulator`, and
`ui-automation` workflows so leased turns expose both lifecycle and UI-driving tools.
Simulator automation runs from the system launchd domain, so the daemon remains
a LaunchDaemon. Run the mutating `daemonctl sim-preflight` before enabling the
capability, or while the daemon is stopped, to confirm the golden-device and
full simulator round trip without an interactive session. After a restart with
the capability available, the command is report-only and prints that the probe
was skipped so it cannot race the pool cloning the golden. If the pre-enable
probe fails with a session-binding error, log in once, re-run it, and record a
console session as a host requirement; that result reopens the LaunchAgent
design as a new item.
Classic automatic login is unavailable while FileVault is enabled, so it is
not configured.

### Supply-chain posture

The Claude, Codex, pnpm, and Homebrew installers are fetched over TLS without
checksum pinning, matching the Linux provisioner's existing production
posture. CLIProxyAPI is sha256- and version-pinned; GitHub CLI is
version-pinned.

Claude Code may store macOS credentials in the login Keychain. Verification
must include a Claude invocation from the LaunchDaemon context; if it cannot
read the login credential, resolve that handoff before claiming session health.
