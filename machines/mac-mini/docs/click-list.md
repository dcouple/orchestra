# Mac Mini GUI handoffs

These are the only GUI/browser steps. Complete them at the Mini or through
an already-working remote desktop session, then run each read-back check from
the MacBook.

## Allow full disk access for remote users

In System Settings → General → Sharing, open the Remote Login detail view
and enable **Allow full disk access for remote users**.

Verify:

```bash
ssh mini 'ls ~/Documents'
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
ssh mini 'pgrep -x ARDAgent'
ssh mini 'dscl . -read /Users/$(id -un) naprivs'
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
ssh mini '/opt/homebrew/bin/tailscale status'
```
