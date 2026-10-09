# Mac Mini GUI handoffs

These are the only GUI/browser steps. Complete them at the Mini or through
an already-working remote desktop session, then run each read-back check from
the MacBook.

## Allow full disk access for remote users

In System Settings → General → Sharing, open the Remote Login detail view
and enable **Allow full disk access for remote users**.

Verify:

```bash
ssh <mini-alias> 'ls ~/Documents'
```

The command must exit successfully without a TCC denial.

## Enable Remote Management (conditional)

Do this only if `apply.sh` reports `remote-desktop pending-human`. In System
Settings → General → Sharing, enable **Remote Management**. Set access to
**Only these users** and add the admin user. Leave **Anyone may request
permission to control screen** off and **VNC viewers may control screen with
password** off.

Verify, substituting the Mini's LAN or Tailscale address:

```bash
ssh <mini-alias> 'pgrep -x ARDAgent'
ssh <mini-alias> 'dscl . -read /Users/$(id -un) naprivs'
nc -z <mini-address> 5900
```

The first command must print an ARDAgent PID. The second must print a nonzero
privilege mask other than `-2147483648` (or the global `ARD_AllLocalUsers`
preference must be `1`), and the port check must succeed. Then connect with
the macOS Screen Sharing app and confirm that the screen renders and accepts
input.

## Authenticate Tailscale (conditional)

Do this when `apply.sh` reports `tailscale-auth pending-human`: open the URL
printed by `tailscale up`, sign into the intended tailnet, and approve the
Mini.

Verify on the Mini:

```bash
ssh <mini-alias> '/opt/homebrew/bin/tailscale status'
```

## Turn off Pane's GUI login item

Do this when `apply.sh` reports `pane-gui-login-item-off pending-human`. In
the Pane GUI app on the Mini, open Settings and turn off **Start Pane when
you log in**, then quit Pane (Cmd-Q). If `pane-workspaces-on` is pending,
turn Workspaces on in the same session before quitting.

Verify:

```bash
ssh <mini-alias> 'plutil -extract autoStartOnBoot raw -o - ~/.pane/config.json'
ssh <mini-alias> 'plutil -extract workspaces.enabled raw -o - ~/.pane/config.json'
ssh <mini-alias> 'pgrep -fx /Applications/Pane.app/Contents/MacOS/Pane || echo gui-not-running'
```

These must print `false`, `true`, and `gui-not-running`.

## Store agent credentials in owner-only files

Do this when `apply.sh` reports `pane-agent-credentials pending-human`. It
lists what is missing. Run each login as the operator over an SSH TTY, not
in the GUI, so nothing lands in the login Keychain.

Claude: run `setup-token`, then paste the printed token at the silent
prompt:

```bash
ssh -t <mini-alias> '~/.local/bin/claude setup-token'
ssh -t <mini-alias> 'mkdir -p ~/.config/pane-headless && chmod 700 ~/.config/pane-headless && umask 077 && read -rs "token?Token: " && printf "CLAUDE_CODE_OAUTH_TOKEN=%s\n" "$token" > ~/.config/pane-headless/env'
```

GitHub CLI:

```bash
ssh -t <mini-alias> 'gh auth login --hostname github.com --git-protocol https --insecure-storage'
```

Codex: add `cli_auth_credentials_store = "file"` to `~/.codex/config.toml`
above its first `[table]` header, then log in:

```bash
ssh -t <mini-alias> 'codex login --device-auth'
```

Verify from SSH (no Keychain access there, the same as at boot):

```bash
ssh <mini-alias> 'set -a; . ~/.config/pane-headless/env; set +a; ~/.local/bin/claude auth status'
ssh <mini-alias> 'gh auth status'
ssh <mini-alias> 'codex login status'
ssh <mini-alias> 'stat -f %Lp ~/.config/pane-headless/env'
```

Claude, gh, and Codex must each report a logged-in account,
and the mode must be `600`.
