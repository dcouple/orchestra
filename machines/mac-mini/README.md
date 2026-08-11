# Headless Mac Mini

This directory is the versioned source of truth for the always-on Mac Mini.
It installs the command-line Tailscale system daemon, tmux, SSH hardening,
power/session settings, Screen Sharing, and a tunnel-gated Cloud Logging
heartbeat. It is orchestra-only and is not copied by either sync script.

## Safety rules

- Keep FileVault enabled and automatic login disabled.
- Keep automatic macOS update installs disabled; run `bin/mini-update`
  deliberately instead. Automatic downloads are not changed.
- Never run plain `reboot` on the Mini. Use `bin/mini-restart`; use
  `bin/mini-update` for OS updates that may restart it.
- Enter the FileVault credential only at the interactive SSH TTY prompt.
  Never put it in an argument, environment variable, file, keychain, plist,
  shell history, or script.

## Human bootstrap

Before running the scripts:

1. On the Mini, enable System Settings → General → Sharing → Remote Login.
2. Install the MacBook's SSH public key for `tylerbrown` and prove that
   `ssh -o BatchMode=yes mini true` succeeds.
3. Have a Tailscale account ready. Start and authenticate Tailscale on the
   MacBook so it can verify the remote tailnet path later.
4. Temporarily allow passwordless sudo for setup. On the Mini, use `visudo`
   to create `/etc/sudoers.d/orchestra-setup` containing:

   ```text
   tylerbrown ALL=(ALL) NOPASSWD: ALL
   ```

   Give it mode 0440 and confirm `sudo -n true`. This broad, temporary grant
   is required only while the pipeline applies and verifies the machine.
5. Complete each applicable item in [docs/click-list.md](docs/click-list.md).

The Overseer removes `/etc/sudoers.d/orchestra-setup` as its final sudo
action and verifies that `sudo -n true` fails again. Do not leave the grant
installed unless the human explicitly decides to keep it.

## Apply

Run monitoring setup first from the MacBook; it creates the least-privilege
service account and securely copies its key to the Mini:

```bash
machines/mac-mini/gcp/setup-monitoring.sh
```

Preview its GCP and remote-key decisions without creating or installing
anything:

```bash
machines/mac-mini/gcp/setup-monitoring.sh --dry-run
```

Then run the machine setup from a checkout on the Mini:

```bash
ssh -t mini 'cd /path/to/orchestra && machines/mac-mini/apply.sh'
```

`apply.sh --dry-run` performs the same state inventory but makes no package,
file, setting, or service changes:

```bash
ssh mini 'cd /path/to/orchestra && machines/mac-mini/apply.sh --dry-run'
```

If `tailscale up` prints a URL, open it and approve the Mini. If Screen
Sharing cannot be enabled through launchd, use the conditional click-list
step. Re-run `apply.sh` after completing handoffs; an already configured
machine reports every item as `already-correct`.

## Verify and operate

Use the commands in [docs/click-list.md](docs/click-list.md), then verify the
effective daemon and power state:

```bash
ssh mini 'sudo sshd -T | grep -i passwordauthentication'
ssh mini 'sudo launchctl print system/com.tailscale.tailscaled'
ssh mini 'pmset -g custom'
ssh mini 'sudo defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates'
ssh mini 'tailscale status'
ssh mini 'command -v tmux'
```

The apply script manages a root-owned `/etc/zshenv` block that exposes
`/opt/homebrew/bin` to interactive and non-interactive zsh sessions for all
users. The final command above must print `/opt/homebrew/bin/tmux`; no user
dotfiles are modified.

Safe operations are run from the MacBook:

```bash
machines/mac-mini/bin/mini-restart
machines/mac-mini/bin/mini-update
```

Both allocate a TTY and let `fdesetup` prompt directly. They do not read or
store the FileVault credential themselves.

## Layout

- `apply.sh` — idempotent Mini configuration.
- `bin/` — MacBook restart/update wrappers and the installed heartbeat.
- `launchd/` — system heartbeat LaunchDaemon.
- `gcp/` — idempotent Cloud Logging/Monitoring provisioning.
- `docs/click-list.md` — GUI handoffs and their read-back checks.
