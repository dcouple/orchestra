# macOS daemon provisioning

This directory provisions the Linear webhook daemon and CLIProxyAPI on an
Apple Silicon Mac mini. Both are system LaunchDaemons running as the dedicated
`linearagent` administrator account and listening only on loopback. The Linux
deployment remains independent and unchanged.

## Run from an operator checkout

The first run requires temporary passwordless sudo, as described in
`machines/mac-mini/README.md`. From the repository root, copy the setup bundle
and run it with the daemon source directory:

```bash
rsync -a daemon/ops/macos/ mini:~/daemon-macos-setup/
ssh mini 'test -d ~/orchestra-bootstrap/.git || git clone https://github.com/dcouple/orchestra.git ~/orchestra-bootstrap'
ssh mini 'git -C ~/orchestra-bootstrap pull --ff-only'
ssh mini 'bash ~/daemon-macos-setup/provision.sh ~/orchestra-bootstrap/daemon'
```

Inventory-only mode performs no mutation:

```bash
ssh mini 'bash ~/daemon-macos-setup/provision.sh --dry-run ~/orchestra-bootstrap/daemon'
```

The provisioner installs a permanent, narrow sudoers rule for the fixed
`launchctl` commands used by `daemonctl` and `deploy.sh`. It does not grant a
passwordless operator shell. After verification, remove the temporary broad
grant as the final privileged setup action.

## Human handoffs

Copy the VM environment file over SSH, then rewrite its path-valued settings
for the mini. Secrets must never enter this repository:

```bash
gcloud compute ssh linear-agent --project=bloom-agents --zone=us-central1-a \
  --command='sudo cat /etc/linear-agent-daemon/env' \
  | ssh mini 'sudo -u linearagent tee /Users/linearagent/.config/linear-agent-daemon/env >/dev/null && sudo chmod 0600 /Users/linearagent/.config/linear-agent-daemon/env'
ssh mini 'sudo -u linearagent sed -i "" \
  -e "s|/var/lib/linear-agent-daemon|/Users/linearagent|g" \
  -e "s|/etc/linear-agent-daemon/cliproxyapi.env|/Users/linearagent/.config/linear-agent-daemon/cliproxyapi.env|g" \
  /Users/linearagent/.config/linear-agent-daemon/env'
```

Open an interactive `linearagent` login context for credentials and identity:

```bash
ssh -t mini 'sudo -u linearagent -i'
daemonctl subscriptions add codex
claude
gh auth login
git config --global user.name 'Linear Agent'
git config --global user.email 'bloom-agent@example.com'
```

The subscription command runs CLIProxyAPI's one-time `--codex-login
--no-browser` flow while logged in as `linearagent`; launchd continues to own
the server process. Re-run the provisioner after all handoffs. A fully
converged second run reports every setting `already-correct`.

Normal operation also runs as the service user:

```bash
ssh mini 'sudo -u linearagent -i daemonctl status'
ssh mini 'sudo -u linearagent -i daemonctl reload --reason "operator deploy"'
```

## Security and deferred verification

Launchd has no equivalents for the Linux unit's systemd sandbox directives;
those controls are intentionally absent on this single-purpose machine. There
is no public ingress in phase 1 and no codex-live service. Reboot acceptance
(P1.AC5) is deferred until the operator is physically near the mini; `RunAtLoad`
and `KeepAlive` provide the intended no-login startup behavior but are not
claimed as reboot evidence until that test is performed.

### Supply-chain posture

The Claude, Codex, pnpm, and Homebrew installers are fetched over TLS without
checksum pinning, matching the VM provisioner's existing production posture.
CLIProxyAPI is sha256- and version-pinned; GitHub CLI is version-pinned.

Claude Code may store macOS credentials in the login Keychain. Verification
must include a Claude invocation from the LaunchDaemon context; if it cannot
read the login credential, resolve that handoff before claiming session health.
