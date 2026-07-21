# Wrap-Up Report — format

> Produced by `/do` at the end. Saved as `./tmp/<id>/wrapup.md` and posted to the PR.
> This is `/do`'s self-report and the human's starting point for PR review — it folds
> in the **final** review outcome (individual review passes are not persisted).

---
```yaml
---
type: wrap-up-report
item: <id>
pr: <url or #>
---
```

# Wrap-Up Report — `<item>`

## What was built
`<summary of the change, tied back to the item's intent>`

## Verification evidence
`<what was run / driven and the result vs each acceptance criterion.`
`Text/log evidence, plus QA screenshots where captured.>`

## Review outcome
`<final state after the review loop — "Must Fix: 0 · passes used: k/<cap>" — and the`
`QA pass: manual tests executed vs left to the human. Note any`
`Should Fix / Nice to Have items intentionally deferred, and why — the same`
`survivors live as inline PR comments; this is the summary, not a second list.>`

## Human action required
`<This is what the user-facing report leads with. Split by owner, ordered`
`blocking-first — never a flat undifferentiated list where the load-bearing`
`item hides mid-way.>`
- **⛔ Blocks verification / QA (prerequisite):** `<a STAGING / TEST resource the tests or QA pass still need — a staging column not yet added, a test-mode key or sandbox access — or "none". NOT production DDL: prod is a deploy action (below), and verification runs against non-prod, so an unapplied prod migration never blocks verification.>`
- **⛔ You must do (deploy / external):** `<red-tier deploy actions + external unblocks, each with the exact command / toggle / env-var name, or "none">`
- **✅ Done for you (applied in-run):** `<green-tier actions the run already took — e.g. staging DDL applied + verified — so the human doesn't redo them, or "none">`

## Residual risks / follow-ups
- `<genuine risks or future work items — NOT actions; actions go in the block above>`

## Dial record
```yaml
zone: <0-3>            # from the item (or Overseer-classified, noted)
lanes: <dual | single-codex>
requested_lanes: <dual | single — omit unless runtime fallback occurred>
effective_lanes: <single-codex — omit unless runtime fallback occurred>
runtime_fallback: <claude -> claudex — omit unless runtime fallback occurred>
fallback_cause: <daemon-classified cause — omit unless runtime fallback occurred>
passes: {plan: <used>/<cap>, post_pr: <used>/<cap>}
findings: {plan: {pass1: {codex: <n>, claude: <n>}, later: {codex: <n>, claude: <n>}},
           post_pr: {pass1: {codex: <n>, claude: <n>}, later: {codex: <n>, claude: <n>}}}
verifiers: {frontend: <ran|skipped>, qa_pass: <ran|trimmed|skipped>}
qa_findings: <n>
wall_clock: <h:mm, run start to wrap-up — script the session transcript JSONL (first event → now), scanning every session of a resumed/compacted run; dispatch output mtimes / commit times / PR createdAt are the fallback only when no transcript is readable; never estimated from memory — the postmortem re-derives this and a mismatch is a finding>
deviations: <none | "escalated <z>→<z-1>: reason">
pr_size: {files_changed: <n>, additions: <n>, deletions: <n>}  # gh pr view --json changedFiles,additions,deletions
tokens:                # per source; "unknown" is honest, a guess is not
  codex: {total: <n>, by_role: {implementer: <n>, plan_reviewer: <n>, code_reviewer: <n>, ...}}
                       # summed from each dispatch's "CODEX <role>: … · tokens <n>" line
  claude_subagents: <n | unknown>   # from the harness's task-completion summaries
  overseer: <n | unknown>           # main session, when the harness exposes it
  total: <n — sum of the known>
spend_ratio: <tokens.total ÷ (additions + deletions), 1 decimal — append " (lower bound)"
              whenever any token source above is unknown: a partial total presented as the
              true cost poisons the tuning data with falsely cheap runs>
agents:                # one row per role actually dispatched
  - {role: <role>, model: <model>, effort: <effort | thinking>, dispatches: <n>,
     wall_clock: <m:ss | unknown>, tokens: <n | unknown>}
```

## Deltas vs plan
`<only where the final diff diverges from the plan's Files-changed table — or "none".`
`The full file list lives in the plan and the PR diff; don't repeat it here.>`
