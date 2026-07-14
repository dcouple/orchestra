# Notify — repo-agnostic run notifications (one-way)

A "reach the operator" hook for long autonomous runs: push a notification to
their phone at a human gate, a hard stop, or on completion, so a run that
needs attention is noticed instead of silently waiting. **One-way** — the run
informs, the human comes to the machine to act. Nothing arriving over the
channel can authorize an action: an open `ntfy.sh` topic is unauthenticated,
so anyone who knew it could inject a fake "approve".

Zero setup required: unconfigured → every notify step is a silent no-op.

## Where the target comes from

Read the target from the consumer repo's `AGENTS.md` `Run notifications`
section (fall back to `CLAUDE.md`/`README`):

```
## Run notifications
notify: https://ntfy.sh/<your-topic>
```

If none is set, default to `https://ntfy.sh/<gh-username>-dcouple-orchestra` —
resolve `<gh-username>` from `gh api user --jq .login`. The per-operator prefix
keeps operators who share an org from cross-notifying each other (a shared
`dcouple-orchestra` topic delivers everyone's gates to everyone). `ntfy.sh`
needs no account and has a mobile app (subscribe to the topic there). The topic
is a
low-sensitivity channel name, **but a public topic is readable by anyone who
knows it** — so a project that wants its gate messages private sets its own
topic in `AGENTS.md`, and **no message ever carries a secret, token, or PHI**
(only what a shoulder-surfer could already see: item id, stage, and the shape
of the change).

## Message format — plain text, glanceable across concurrent runs

The ntfy **mobile app does not render Markdown** (bold/fences show as literal
`**` and backticks), so write **plain text** and let the `Title` and line
breaks carry the hierarchy. Several runs may ping the same phone, so the
bracketed id in the title is what disambiguates at a glance.

- **Title** (`Title:` header): `[<item-id>] <stage> — <one-line what>`, e.g.
  `[onboarding-revamp] Phase 4 / verify — staging DDL needed`.
- **Body** (plain text, a blank line between each point — never a wall):
  - what it needs, one line;
  - why now / what's blocked, one line;
  - the exact thing (the DDL / command / decision) on its own line;
  - where to act (the PR/branch, or "resume this run").
- **Priority** (`Priority:` header): `urgent` for a blocking gate, `default`
  for completion, `low` for FYI.
- **Tags** (`Tags:` header): a leading emoji for instant type-recognition —
  `warning` (gate), `octagonal_sign` (hard stop), `white_check_mark` (done).

Send best-effort — a notify failure (offline, bad URL) is swallowed and never
fails the run. Use `--data-binary` so newlines survive (`--data`/`-d` strips
them):

```bash
NOTIFY="${NOTIFY:-https://ntfy.sh/$(gh api user --jq .login)-dcouple-orchestra}"
printf '%s' "$BODY" | curl -fsS -m 10 \
  -H "Title: [$ID] $STAGE — $WHAT" \
  -H "Priority: urgent" -H "Tags: warning" \
  --data-binary @- "$NOTIFY" >/dev/null 2>&1 || true
```

**After every send, say so in chat** — a one-line utility note so the operator
knows where to look:

> ntfy sent to `<channel>` — check at https://ntfy.sh/`<channel>` (browser) or
> subscribe to `<channel>` in the ntfy app.

(where `<channel>` is the topic name, e.g. `parsakhaz-dcouple-orchestra`.)

where `$BODY` is plain text with real newlines, e.g.

```
Needs you: apply this staging DDL, then resume.

Blocks: Phase 4 verify (lapse-release leg).

ALTER TABLE welcome_surveys ADD COLUMN foo STRING(MAX);

Run: bloomapi/bloom-mono @ onboarding-overhaul
```

## When to fire it

- **A red gate** the run is deferring or is stopped on — one-way, with the
  full context above (the human reads it and comes to the machine).
- **A hard stop** — the run can't proceed and needs the human.
- **Completion** — PR ready for review.

Never fire on green-tier progress. No action buttons, no reply polling while
notifications are one-way — informing only.
