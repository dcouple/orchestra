# Mac Mini GUI handoffs

These are the only GUI/browser steps. Complete them at the Mini or through
an already-working Screen Sharing session, then run each read-back check from
the MacBook.

## Allow full disk access for remote users

In System Settings → General → Sharing, open the Remote Login detail view
and enable **Allow full disk access for remote users**.

Verify:

```bash
ssh mini 'ls ~/Documents'
```

The command must exit successfully without a TCC denial.

## Enable Screen Sharing (conditional)

Do this only if `apply.sh` reports `screen-sharing pending-human`. In System
Settings → General → Sharing, enable **Screen Sharing** and allow the intended
user access.

Verify, substituting the Mini's LAN or Tailscale address:

```bash
nc -z <mini-address> 5900
```

Then connect with the macOS Screen Sharing app and confirm that the screen
renders and accepts input.

## Authenticate Tailscale (conditional)

Do this when `apply.sh` reports `tailscale-auth pending-human`: open the URL
printed by `tailscale up`, sign into the intended tailnet, and approve the
Mini.

Verify on the Mini:

```bash
ssh mini '/opt/homebrew/bin/tailscale status'
```
