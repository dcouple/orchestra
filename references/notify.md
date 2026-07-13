# Notify — repo-agnostic run notifications

A best-effort "ping the human" hook for long autonomous runs, so a human
gate or a finished run reaches the operator's phone instead of waiting to be
noticed. Zero setup required: when nothing is configured, notifying is a
silent no-op and the run is unaffected.

## Where the target comes from (never the skill)

The notification target is **repo configuration, not skill code** — it is
operator- and project-specific. Read it, in order, from:

1. The consumer repo's `AGENTS.md` — a `Run notifications` section naming the
   target (see the shape below).
2. Failing that, `CLAUDE.md` or `README` if either carries the same section.
3. Nothing found → notifying is disabled. Do not prompt for it, do not invent
   one; just skip every notify step silently.

A project opts in by adding to its `AGENTS.md`:

```
## Run notifications
notify: https://ntfy.sh/<your-topic>   # any ntfy topic URL; subscribe to
# <your-topic> in the ntfy mobile app to receive these. Public channel —
# treat the topic as low-sensitivity, put nothing secret in messages.
```

Any endpoint that accepts a plain-text POST body works; `ntfy.sh` is the
default because it needs no account and has a mobile app. The topic is a
low-sensitivity channel name, not a secret — but still keep it in repo config,
not in the synced skills.

## How to send (always best-effort)

One line, wrapped so it can never fail the run — a notify failure (offline,
bad URL, missing tool) is swallowed, logged in passing, and ignored:

```bash
# $NOTIFY resolved from the repo config above; empty → skip entirely
[ -n "$NOTIFY" ] && curl -fsS -m 10 -H "Title: <short title>" \
  -d "<message>" "$NOTIFY" >/dev/null 2>&1 || true
```

Messages carry the *why* and a link the operator can act on from a phone,
and never carry secrets, tokens, or PHI:

- Blocked: `[<item>] Blocked: <what it needs> — <PR/issue URL>`
- Done:    `[<item>] Done: PR ready for review — <PR URL>`
- Stopped: `[<item>] Stopped: <hard blocker> — <where to look>`

## When to fire it

Callers decide; typically: a red-tier gate the run defers on, run completion,
and a hard stop. Never fire on green-tier autonomous progress — the point is
to pull the human in only when they are actually needed.
