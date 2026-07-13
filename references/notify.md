# Notify — repo-agnostic, two-way run notifications

A "reach the operator" hook for long autonomous runs: push a notification to
their phone at a gate or on completion, and — when a gate needs a decision —
**wait for their reply from the phone** before proceeding. Several runs may be
in flight at once, so every message must be self-explanatory at a glance. Zero
setup required: unconfigured → every notify/ask step is a silent no-op and the
run is unaffected.

## Where the config comes from (never the skill)

Notification targets are **repo configuration** — operator- and
project-specific. Read them from the consumer repo's `AGENTS.md`
`Run notifications` section (fall back to `CLAUDE.md`/`README`); nothing found
→ notifying and asking are disabled, silently. Never prompt for them or invent
them.

A project opts in:

```
## Run notifications
notify:       https://ntfy.sh/<publish-topic>   # push → your phone
notify_reply: https://ntfy.sh/<reply-topic>     # your phone → the run (optional; enables two-way)
```

`ntfy.sh` is the default: no account, mobile app, and it is **two-way** — the
app both receives (subscribe to `<publish-topic>`) and sends (publish to
`<reply-topic>` by tapping a notification action button or typing a reply).
The topics are low-sensitivity channel names, not secrets — still keep them in
repo config, and put nothing secret/PHI in messages.

## Message format — assume many runs, glanceable in one second

Every message carries **which run, which stage, what, and why**, with real
visual hierarchy (ntfy renders Markdown when you send `Markdown: yes`, and
shows the `Title` as a bold heading). Structure:

- **Title** (`Title:` header): `[<item-id>] <stage> — <one-line what>`, e.g.
  `[onboarding-revamp] Phase 4 / verify — staging DDL needed`. The bracketed
  id is what disambiguates concurrent runs at a glance.
- **Body** (Markdown, blank line between each point — never a wall of text):
  - **What** it wants, in one bold line.
  - **Why** now / what's blocked, one line.
  - **The exact thing** (the DDL, the command, the decision) in a fenced block
    or on its own line.
  - **How to answer** (the action buttons, or "reply starting with
    `<item-id>`").
- **Priority** (`Priority:` header): `urgent` for a blocking gate, `default`
  for completion, `low` for FYI.
- **Tags** (`Tags:` header): a leading emoji for instant type-recognition —
  `warning` (gate), `octagonal_sign` (hard stop), `white_check_mark` (done).

Push example (best-effort — a notify failure is swallowed, never fails the run):

```bash
[ -n "$NOTIFY" ] && curl -fsS -m 10 \
  -H "Title: [$ID] $STAGE — $WHAT" \
  -H "Priority: urgent" -H "Tags: warning" -H "Markdown: yes" \
  -d $'**Needs your call:** apply this staging DDL?\n\nBlocks: Phase 4 verify (lapse-release leg).\n\n```\nALTER TABLE ... ADD COLUMN ... ;\n```\n\nTap **Approve**/**Deny**, or reply starting with `'"$ID"'`.' \
  "$NOTIFY" >/dev/null 2>&1 || true
```

Completion / stop are one-liners at `default`/`urgent` priority with the PR or
"where to look" link. Never notify on green-tier progress.

## Two-way: ask, then wait for the phone

When a gate needs a **decision** and `notify_reply` is configured, don't defer
blindly — ask and wait:

1. **Ask.** Push the message above with **action buttons** that publish the
   answer (tagged with `<item-id>`) back to the reply topic, so one tap
   answers even across concurrent runs:

   ```bash
   -H "Actions: http, Approve, $NOTIFY_REPLY, method=POST, body=$ID approve; http, Deny, $NOTIFY_REPLY, method=POST, body=$ID deny"
   ```

   Free-form typed replies work too, as long as they **start with `<item-id>`**
   (tell the user this in the body) so the run can pick out its own answer.

2. **Wait.** Subscribe to the reply topic and block until a message for this
   `<item-id>` arrives (or a long timeout). Cleanest in this harness: a
   WebSocket monitor on `wss://ntfy.sh/<reply-topic>/ws` (each reply is one
   event); or a background poll that exits on the answer:

   ```bash
   SINCE=$(date +%s)
   until curl -fsS "$NOTIFY_REPLY/json?since=$SINCE&poll=1" 2>/dev/null \
         | grep -F "$ID " ; do sleep 20; done
   ```

   Waiting is cheap — schedule a self-wakeup so other independent work (or the
   next phase) proceeds while this gate waits, rather than freezing the whole
   run on one blocked action.

3. **Act on the reply.** Follow the decision. **Production execution is the one
   thing a reply can never authorize** (see the /do action tiers): even an
   "approve" for a production mutation means "prepare it and hand me the exact
   command," never "run it." A reply *can* authorize a staging/reversible
   action or pick a path.

If two-way isn't configured, or no reply lands within the timeout, fall back to
the tier default: capture the action to a file + Deploy note, push a one-way
FYI, and continue the rest of the run best-effort. The run never freezes
forever on a missing human.
