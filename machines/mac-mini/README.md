# Headless Mac Mini

This directory is the versioned source of truth for the always-on Mac Mini.
It installs the command-line Tailscale system daemon, tmux, SSH hardening,
power/session settings, Remote Management (ARD), a tunnel-gated Cloud
Logging heartbeat, and headless Pane at boot (no login needed). It is orchestra-only and is not copied by either sync script.

## Safety rules

- Keep FileVault disabled and automatic login disabled. FileVault off is
  what lets a power-loss or smart-plug boot come all the way up unattended;
  automatic login stays off because the daemons run in the system launchd
  domain and a console session interferes with simulator automation.
  `apply.sh` refuses to run while FileVault is on; disable it once with
  `ssh -t <mini-alias> 'sudo fdesetup disable'` and wait for `sudo fdesetup status`
  to report Off before restarting.
- Keep automatic macOS update installs disabled; run `bin/mini-update`
  deliberately instead. Automatic downloads are not changed.
- Restart with `bin/mini-restart` (clean `shutdown -r` plus a return wait)
  and update with `bin/mini-update`; both refuse to run while FileVault is on.
- Never run the Pane GUI app while the headless Pane LaunchDaemon runs: both
  would use `~/.pane`. Keep Pane's "Start Pane when you log in" off and use
  the [handoff](#pane-gui-handoff) below.
- `pmset autorestart 1` is set, so cutting and restoring power (a smart plug
  on the Mini's cord) boots it without a button press. Treat that as the
  last resort after SSH is unreachable, not as a routine restart.

## Human bootstrap

Before running the scripts:

1. On the Mini, enable System Settings → General → Sharing → Remote Login.
2. Install the MacBook's SSH public key for `<operator>` and prove that
   `ssh -o BatchMode=yes <mini-alias> true` succeeds.
3. Have a Tailscale account ready. Start and authenticate Tailscale on the
   MacBook so it can verify the remote tailnet path later.
4. Temporarily allow passwordless sudo for setup. On the Mini, use `visudo`
   to create `/etc/sudoers.d/orchestra-setup` containing:

   ```text
   <operator> ALL=(ALL) NOPASSWD: ALL
   ```

   Give it mode 0440 and confirm `sudo -n true`. This broad, temporary grant
   is required only while the pipeline applies and verifies the machine.
5. Complete each applicable item in [docs/click-list.md](docs/click-list.md).

After `apply.sh` (and the daemon provisioning in
[docs/daemon/macos.md](../../docs/daemon/macos.md)) succeeds, the operator
removes `/etc/sudoers.d/orchestra-setup` and confirms that `sudo -n true`
fails again.

## Apply

Run monitoring setup first from the MacBook; it creates a least-privilege
GCP service account in `<gcp-project>` and copies its key to the Mini. The
project is set in the script; pass the alert email as an argument and the
SSH host as `MINI_HOST`:

```bash
MINI_HOST=<mini-alias> machines/mac-mini/gcp/setup-monitoring.sh <alert-email>
```

Preview its GCP and remote-key decisions without creating or installing
anything:

```bash
MINI_HOST=<mini-alias> machines/mac-mini/gcp/setup-monitoring.sh --dry-run <alert-email>
```

Then sync this directory to the Mini and run the machine setup there - the
Mini needs no repo checkout of its own:

```bash
rsync -a --delete machines/mac-mini/ <mini-alias>:mac-mini-setup/
ssh -t <mini-alias> 'bash ~/mac-mini-setup/apply.sh'
```

`apply.sh --dry-run` performs the same state inventory but makes no package,
file, setting, or service changes:

```bash
ssh <mini-alias> 'bash ~/mac-mini-setup/apply.sh --dry-run'
```

Re-sync before every run so the Mini always executes the committed version.

If `tailscale up` prints a URL, open it and approve the Mini. If Remote
Management cannot be enabled through `kickstart`, use the conditional
click-list step. Re-run `apply.sh` after completing handoffs; an already configured
machine reports every item as `already-correct`.

## Verify and operate

Use the commands in [docs/click-list.md](docs/click-list.md), then verify the
effective daemon and power state:

```bash
ssh <mini-alias> 'sudo sshd -T | grep -i passwordauthentication'
ssh <mini-alias> 'sudo launchctl print system/com.tailscale.tailscaled'
ssh <mini-alias> 'pmset -g custom'
ssh <mini-alias> 'sudo defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates'
ssh <mini-alias> 'tailscale status'
ssh <mini-alias> 'command -v tmux'
ssh <mini-alias> 'pgrep -x ARDAgent'
ssh <mini-alias> 'dscl . -read /Users/$(id -un) naprivs'
nc -z <mini-address> 5900
ssh <mini-alias> 'sudo launchctl print system/com.dcouple.pane-headless | grep "state ="'
runpane workspace <mini-machine> exec -- hostname
```

The Pane check must print `state = running`, and the last command (run from
the MacBook) must print the Mini's hostname. Pane can't reach the login
Keychain at boot because nobody has logged in. Agent credentials come from
owner-only files instead (see
[docs/click-list.md](docs/click-list.md#store-agent-credentials-in-owner-only-files)).
After changing them, restart the daemon:
`ssh -t <mini-alias> 'sudo launchctl kickstart -k system/com.dcouple.pane-headless'`.

The apply script manages a root-owned `/etc/zshenv` block that exposes
`/opt/homebrew/bin` to interactive and non-interactive zsh sessions for all
users. The `command -v tmux` check above must print `/opt/homebrew/bin/tmux`;
no user dotfiles are modified.

Safe operations are run from the MacBook (`MINI_HOST=<mini-alias>` selects
the SSH host):

```bash
machines/mac-mini/bin/mini-restart
machines/mac-mini/bin/mini-update
```

Both allocate a TTY for `sudo` and verify FileVault is off before acting.

### Pane GUI handoff

Pane runs as a LaunchDaemon (`com.dcouple.pane-headless`) as the operator,
with `~/.pane`. Its log is `~/Library/Logs/pane-headless.log`. To use the
Pane GUI app through Screen Sharing, stop the daemon first, and start it
again after quitting the app:

```bash
ssh -t <mini-alias> 'sudo launchctl bootout system/com.dcouple.pane-headless'
# open Pane in the GUI session, work, then quit it (Cmd-Q)
ssh -t <mini-alias> 'sudo launchctl bootstrap system /Library/LaunchDaemons/com.dcouple.pane-headless.plist'
```

`apply.sh` refuses to start the daemon while the GUI app runs
(`pane-headless pending-human`).

After a restart, run the daemon's simulator probe before any GUI login; see
[Simulator capability](../../docs/daemon/macos.md#simulator-capability).

## Layout

- `apply.sh` - idempotent Mini configuration.
- `bin/` - MacBook restart/update wrappers, the installed heartbeat, and the
  headless Pane launcher.
- `launchd/` - system heartbeat and headless Pane LaunchDaemons (the Pane
  plist is rendered with the operator's name and home).
- `gcp/` - idempotent Cloud Logging/Monitoring provisioning.
- `docs/click-list.md` - GUI handoffs and their read-back checks.
