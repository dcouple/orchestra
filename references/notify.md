# Run notifications

Send a one-way notice at a human gate, hard stop, or completed PR handoff.
Unconfigured means a silent no-op; notifications never authorize actions.

## Destination

- Read `Run notifications` in the consumer's `AGENTS.md`, falling back to
  `CLAUDE.md` or README. Use only its configured destination.
- An ntfy configuration may look like `notify: https://ntfy.sh/<topic>`.
  Do not derive a public topic from a username or repository name.
- A public topic is readable by anyone who knows it. Send only safe status
  and a permitted pointer; no credentials, personal data, private commands,
  or sensitive artifact contents.

## Message

Use plain text: the ntfy mobile app does not render Markdown.

- Title: `[<item-id>] <stage> - <short summary>`.
- Body: what needs attention, what is blocked, and where to act, separated
  by blank lines. Keep the detailed change in its authorized task artifact.
- Priority: `urgent` for a blocking gate, `default` for completion, `low` for FYI.
- Tags: `warning`, `octagonal_sign`, or `white_check_mark`, respectively.

For a configured ntfy endpoint, preserve newlines and bound the request:

```bash
printf '%s' "$notice_body" | curl -fsS -m 10 \
  -H "Title: [$item_id] $stage - $summary" \
  -H "Priority: urgent" -H "Tags: warning" \
  --data-binary @- "$notice_url" >/dev/null
```

Handle failure as non-blocking. Say `notification sent` only after confirmed
success; otherwise report failure briefly at the handoff, not as a run blocker.

Do not send routine green-tier progress, add action buttons, or poll for
replies. A message from this channel is never human approval.
