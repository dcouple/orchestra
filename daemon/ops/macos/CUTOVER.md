# Mac mini ingress and cutover

This runbook moves new webhook ownership to the Mac mini while the existing VM
continues to serve pre-migration `linear-agent.bloomapi.com/a/...` links. Keep a
timestamped transcript in `tmp/154/refs/cutover-log.md`. Do not begin tunnel
work until the gate below passes. Steps marked `[HUMAN]` require dashboard or
interactive authentication; steps marked `[RUN]` are copy-paste commands.

## Gate — Cloudflare zone is Active

1. `[HUMAN]` In Cloudflare, confirm the free-plan root zone `blmapp.com` is
   **Active**. In Namecheap, confirm the Cloudflare nameservers are installed
   and auto-renew is enabled. Confirm `metabase.blmapp.com` and its
   `_acme-challenge` CNAME were copied as DNS-only (grey-cloud); do not proxy
   either record.
2. `[RUN]` Confirm public DNS before creating the tunnel:

   ```bash
   dig NS blmapp.com @1.1.1.1
   dig +short metabase.blmapp.com @1.1.1.1 | grep -Fx 136.68.246.84
   ```

Stop if the nameservers are not Cloudflare nameservers or the Metabase address
does not match.

## A — Create and route the locally-managed tunnel

1. `[HUMAN]` Authenticate in an interactive `linearagent` login, create the
   tunnel, and route the new hostname. Complete the browser login prompted by
   the first command.

   ```bash
   ssh -t mini 'sudo -u linearagent -i'
   /opt/homebrew/bin/cloudflared tunnel login
   /opt/homebrew/bin/cloudflared tunnel create linear-agent
   /opt/homebrew/bin/cloudflared tunnel route dns linear-agent linear-agent.blmapp.com
   exit
   ```

2. `[HUMAN]` In Cloudflare DNS, confirm `linear-agent.blmapp.com` is proxied
   (orange-cloud). Leave the two pre-existing Metabase records DNS-only.

## B — Render config and start ingress

1. `[RUN]` Re-run the idempotent provisioner. It derives the tunnel ID from the
   newest `/Users/linearagent/.cloudflared/*.json`, renders mode `0600` config,
   and bootstraps the custom LaunchDaemon.

   ```bash
   rsync -a daemon/ops/macos/ mini:~/daemon-macos-setup/
   ssh mini 'git -C ~/orchestra-bootstrap pull --ff-only'
   ssh mini 'bash ~/daemon-macos-setup/provision.sh ~/orchestra-bootstrap/daemon'
   ssh mini 'sudo launchctl print system/com.dcouple.cloudflared >/dev/null && sudo -u linearagent grep -E "^(tunnel|credentials-file):" /Users/linearagent/.cloudflared/config.yml'
   ```

## C — Prove public ingress before changing ownership

1. `[RUN]` Both requests must return JSON containing `"ok":true`:

   ```bash
   curl -fsS https://linear-agent.blmapp.com/healthz | grep -F '"ok":true'
   edge_ip=$(dig +short linear-agent.blmapp.com @1.1.1.1 | grep -E '^[0-9.]+$' | head -1)
   test -n "$edge_ip"
   curl -fsS --resolve "linear-agent.blmapp.com:443:$edge_ip" https://linear-agent.blmapp.com/healthz | grep -F '"ok":true'
   ```

Stop if either request fails.

## D — Take a consistent archive-VM snapshot and restore it on the mini

From the first command below until step F completes, the VM daemon must stay
stopped. Caddy returns failures, so Linear retains and retries deliveries. Old
artifact links are unavailable for these few minutes. Do not restart the VM
daemon early.

1. `[RUN]` As an archive-bridge migration operation, stop the VM writer,
   checkpoint SQLite, and verify it remains down:

   ```bash
   gcloud compute ssh linear-agent --project=bloom-agents --zone=us-central1-a \
     --command='sudo systemctl stop linear-agent-daemon && sudo sqlite3 /var/lib/linear-agent-daemon/events.db "PRAGMA wal_checkpoint(TRUNCATE);" && test "$(systemctl is-active linear-agent-daemon)" = inactive'
   ```

2. `[RUN]` Quiesce both mini processes before overwriting their working state.
   Cloudflared remains running.

   ```bash
   ssh mini 'sudo launchctl bootout system/com.dcouple.linear-agent-daemon 2>/dev/null || true; sudo launchctl bootout system/com.dcouple.cliproxyapi 2>/dev/null || true; ! sudo launchctl print system/com.dcouple.linear-agent-daemon >/dev/null 2>&1; ! sudo launchctl print system/com.dcouple.cliproxyapi >/dev/null 2>&1'
   ssh mini 'sudo -u linearagent find /Users/linearagent/.cli-proxy-api -mindepth 1 -delete'
   ```

3. `[RUN]` Stream the durable payload over SSH. `.cli-proxy-api/` is replaced
   wholesale; only Claude and Codex credential files are imported, preserving
   the mini-managed `settings.json` and `config.toml`.

   ```bash
   gcloud compute ssh linear-agent --project=bloom-agents --zone=us-central1-a \
     --command='cd /var/lib/linear-agent-daemon && sudo bash -c '\''set -- events.db artifacts repos worktrees .cli-proxy-api; for path in events.db-wal events.db-shm .claude/.credentials.json .codex/auth.json; do test ! -e "$path" || set -- "$@" "$path"; done; tar -czf - "$@"'\''' \
     | ssh mini 'sudo -u linearagent tar -C /Users/linearagent -xzf -'
   ```

4. `[RUN]` Verify ownership, the compatibility symlink, and one copied
   worktree's path-bound Git metadata:

   ```bash
   ssh mini 'test "$(readlink /private/var/lib/linear-agent-daemon)" = /Users/linearagent && test "$(stat -f %Su:%Sg -h /private/var/lib/linear-agent-daemon)" = root:wheel'
   ssh mini 'test -z "$(find /Users/linearagent/events.db /Users/linearagent/artifacts /Users/linearagent/repos /Users/linearagent/worktrees /Users/linearagent/.cli-proxy-api ! -user linearagent -print -quit)"'
   ssh mini 'sudo -u linearagent bash -c '\''git_file=$(find /Users/linearagent/worktrees -type f -name .git -print -quit); test -n "$git_file"; worktree=${git_file%/.git}; gitdir=$(sed -n "s/^gitdir: //p" "$git_file"); case "$gitdir" in /var/lib/linear-agent-daemon/*) ;; *) exit 1;; esac; test -d "$gitdir"; git -C "$worktree" rev-parse --git-dir >/dev/null'\'''
   ```

5. `[RUN]` Bootstrap proxy first, daemon second, verify loopback health, then
   re-run provisioning so the provider gate qualifies the copied credentials:

   ```bash
   ssh mini 'sudo launchctl bootstrap system /Library/LaunchDaemons/com.dcouple.cliproxyapi.plist && sudo launchctl bootstrap system /Library/LaunchDaemons/com.dcouple.linear-agent-daemon.plist && sudo /usr/local/sbin/wait-for-daemon-health.sh http://127.0.0.1:8787/healthz'
   ssh mini 'bash ~/daemon-macos-setup/provision.sh ~/orchestra-bootstrap/daemon'
   ssh mini 'sudo -u linearagent test -s /Users/linearagent/.codex/config.toml; key=$(sudo -u linearagent sed -n "s/^CLIPROXY_API_KEY=//p" /Users/linearagent/.config/linear-agent-daemon/cliproxyapi.env); test -n "$key"; curl -fsS --connect-timeout 2 --max-time 10 -H "Authorization: Bearer $key" http://127.0.0.1:8317/v1/models | python3 -c '\''import json,sys; raise SystemExit(0 if any(x.get("id")=="gpt-5.6-sol" for x in json.load(sys.stdin).get("data",[])) else 1)'\'''
   ```

   Stop here if the provisioner summary reports `provider-gate pending-human`
   or the direct qualification readback fails. Step E must not begin until the
   summary reports `provider-gate already-correct` and the proxy exposes
   `gpt-5.6-sol`.

## E — Re-point the mini's published base URL

1. `[RUN]` Require exactly one existing setting, replace it, restart the mini
   daemon, and verify both local and public health:

   ```bash
   ssh mini 'env_file=/Users/linearagent/.config/linear-agent-daemon/env; test "$(sudo -u linearagent grep -c "^WEBHOOK_BASE_URL=" "$env_file")" = 1; sudo -u linearagent sed -i "" "s|^WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=https://linear-agent.blmapp.com|" "$env_file"; sudo launchctl kickstart -k system/com.dcouple.linear-agent-daemon; sudo /usr/local/sbin/wait-for-daemon-health.sh http://127.0.0.1:8787/healthz; sudo -u linearagent grep -Fx WEBHOOK_BASE_URL=https://linear-agent.blmapp.com "$env_file"'
   curl -fsS https://linear-agent.blmapp.com/healthz | grep -F '"ok":true'
   ```

## F — Transfer webhook ownership

1. `[HUMAN]` Only after steps C and E pass, edit both Linear OAuth apps without
   changing their signing secrets:

   - Planner webhook: `https://linear-agent.blmapp.com/webhook/planner`
   - Implementer webhook: `https://linear-agent.blmapp.com/webhook/implementer`

   Record the re-point time in `tmp/154/refs/cutover-log.md` and confirm both
   dashboard values before continuing. Linear retries accumulated deliveries
   to the mini after the registrations move.

## F2 — Restore the VM archive bridge

1. `[RUN]` Restart the VM daemon and prove both archive services are active:

   ```bash
   gcloud compute ssh linear-agent --project=bloom-agents --zone=us-central1-a \
     --command='sudo systemctl start linear-agent-daemon && systemctl is-active linear-agent-daemon caddy'
   curl -fsS https://linear-agent.bloomapi.com/a/xchrBcdNsG9mTRdq29vShQ/index.json | shasum -a 256
   shasum -a 256 tmp/154/index.json
   ```

The two hashes must match.

## G — Acceptance readbacks

1. `[HUMAN]` Assign the planner to a throwaway Linear issue and wait for its
   delivery to complete.
2. `[RUN]` Confirm the mini received and persisted the new event:

   ```bash
   ssh mini 'tail -50 /Users/linearagent/Library/Logs/linear-agent-daemon.log'
   ssh mini 'sudo -u linearagent sqlite3 /Users/linearagent/events.db "select delivery_id, app, action, received_at from events order by id desc limit 3"'
   ```

3. `[RUN]` Repeat DNS, ingress, and archive-bridge VM service-state
   acceptance:

   ```bash
   dig NS blmapp.com @1.1.1.1
   dig +short metabase.blmapp.com @1.1.1.1 | grep -Fx 136.68.246.84
   curl -fsS https://linear-agent.blmapp.com/healthz | grep -F '"ok":true'
   curl -fsS https://linear-agent.bloomapi.com/a/xchrBcdNsG9mTRdq29vShQ/index.json | shasum -a 256
   gcloud compute ssh linear-agent --project=bloom-agents --zone=us-central1-a --command='systemctl is-active linear-agent-daemon caddy'
   ```

4. `[RUN]` Using the recorded re-point time, verify the archive-bridge VM did
   not process webhook deliveries after ownership moved:

   ```bash
   repoint_time='REPLACE_WITH_RECORDED_ISO_8601_TIME'
   gcloud compute ssh linear-agent --project=bloom-agents --zone=us-central1-a \
     --command="sudo journalctl -u linear-agent-daemon --since '$repoint_time' --no-pager | grep -E 'webhook|delivery' || true"
   ```

The final command must print no webhook delivery lines. The VM and its
`bloomapi.com` DNS/Caddy path remain in place as the old-artifact archive
bridge; the mini is the sole webhook owner and publishes new links under
`linear-agent.blmapp.com`.
