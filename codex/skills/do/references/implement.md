## Step 2: Implement

Every implementation dispatch goes to the Codex `implementer` role at effort
`low` (later fix rounds resume the same Codex session). **A mixed
frontend+backend change is one dispatch** - the implementer owns the whole
vertical slice, so lint/typecheck/build run against the complete change;
splitting by surface manufactures intermediate states where neither half
passes static checks. Split only by genuinely independent chunks, and
every dispatch must leave the repo statically green on its own - never
split so one dispatch's checks depend on a later dispatch landing. Give
each the plan alone - it is self-sufficient, carrying the item's intent,
so the implementer never opens the brief. Resolve blockers yourself from
the plan and `refs/`;
apply the Autonomy & safety tiers - a red-tier action gets captured, noted,
and notified, and the run continues; only a red gate that blocks everything
stops it.

**Bulk fan-outs** (many similar sub-agent dispatches - translations,
codemods, per-file transforms):

- Give every dispatch a machine-verifiable completion contract and audit
  the whole batch with a script after each wave - a dispatch's exit status
  or "DONE" claim is never evidence. Expect a silent-failure tail on large
  inputs; plan one repair wave.
- Each dispatch commits its own output the moment it succeeds. Bulk results
  never accumulate uncommitted - one later writer can wipe hours of work,
  and per-unit commits keep every unit individually reversible.
- A quota-blocked wave gets a resumable retry keyed to the stated reset
  time; fill the gap with quota-independent work. Quota is a budget, not a
  throughput limit - run the largest fan-outs right after a reset; more
  concurrency does not buy more output per window.
