## Autonomy & safety (read first)

This run is meant to finish unattended - started at night, reviewed in the
morning. These rules make that safe:

- **A phase or step boundary is not a turn boundary, and neither is a
  dispatch.** Chain straight into the next step while work is ready, and never
  end a turn with work outstanding. Every detached Codex dispatch is awaited
  inside the turn that launched it: poll its completion marker until the report
  lands or its deadline passes, then act on it. Codex dispatches still launch
  detached when the harness requires it so a lost process cannot orphan them,
  but
  detaching is not licence to yield - **nothing resumes a turn that ends
  itself.** If a turn dies for an external reason - budget ceiling, crash,
  daemon restart - recovery comes from the run's durable state, not from a
  scheduled wakeup: `plan-<n>.md` and its `phase_complete` flag record where
  you were, and the next turn picks up from there. Idle-waiting on a human
  nudge is a pipeline bug.
- **A plain human message mid-run - "continue", "still running?", "does it
  work?" - is genuine input, never a task notification.** Inspect the dispatch
  markers and durable outputs, answer from them, and resume immediately.
- **Action tiers decide what you may do alone. Resolve uncertainty with a
  read-only check of the target and scope; if it remains material, ask.**
  - **Green - do it unattended:** code, tests, docs, new files, and
    **staging** schema changes that are *both* additive/nullable *and*
    reversible (a new nullable column or new table you could drop with no data
    loss) - anything self-undoing. Apply it without asking and note the
    production counterpart in Deploy notes.
  - **Red - explicit human approval required:** **anything touching
    production** - the production database, production config, real users, or
    money; **anything irreversible** or that affects production users; and any
    staging change that isn't cleanly reversible. Assume this is a live
    production app: if a **production database** would be touched, it is red,
    always. Execute a red action only after the human explicitly approves the
    exact action, target, and scope in the active session. General, stale,
    inferred, or notification-channel approval does not count. Without
    approval, capture the exact change under `./tmp/<id>/`, record it in Deploy
    notes, notify the human, and continue independent work.
- **A red action that blocks *downstream work in this run* is a review gate.**
  Don't barrel into work that depends on it and emit broken or blocked output.
  Notify with full context, stop that dependent line of work, and carry on with
  anything independent - the human reviews and clears it at the machine. A red
  action that blocks *only itself* is captured, noted, and the run continues
  past it.
- **Only fully stop for a red gate that blocks *everything*** (access the run
  can't proceed without, a genuine ambiguity in intent). Notify, say exactly
  what you need, and wait.

**Notify** per `.references/notify.md` - **one-way**: inform the human,
don't wait for a phone reply. Target comes from repo config (default a per-operator
`ntfy.sh/<gh-username>-dcouple-orchestra`; silent no-op if unreachable), and
after each send you tell the user in chat where it went. Messages are plain
text - the app doesn't render Markdown - titled `[item] stage - why` so
concurrent runs stay legible. Fire at: a red gate (deferred or blocking), a
hard stop, and run completion - never on green-tier progress.
