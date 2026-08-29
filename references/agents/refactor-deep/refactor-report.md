# Refactor Report — agent output format

> Returned **in-conversation** by `refactor-simple` or `refactor-deep` to the Overseer — the
> full plan is also written to `./tmp/<name>-refactor-plan-<timestamp>.md`. Runs once per
> role per run, after implementation and before the final review loop and QA drive. The Overseer merges the two
> reports itself (cluster by file:line + issue; **max severity, never average**; sole-source
> findings kept; tag by source) — never re-dispatch a role to "confirm" the other.
> **Your final message IS the report: begin with the counts.** Every line is a count, a
> finding with `file:line`, or a check you ran — no preamble, no process narration.

---

**Plan:** `<absolute path of the plan file written>`
**Diff base:** merge-base with `<$BASE>` at `<sha>`, to working tree · `<N>` hand-written files / `<M>` lines (`<K>` generated/lockfile excluded)
**Conventions from:** `<guidance files and exemplars read>`
**Counts:** Critical: `<n>` · Warning: `<n>` · Info: `<n>` (pre-existing: `<n>`) · Auto-fixable: `<n>` · Manual: `<n>`
**Quality score:** `<x>/10`

## Critical  *(must fix before merge)*
- **C-1** — `<what>` · `<file:line>` · `<fix>` · convention: `<source file | "correctness">` · auto-fixable: `<yes/no>`
  - **Failure:** `<concrete way this breaks>` — reproduced: `<yes/no>`   *(required for correctness findings)*

## Warning  *(should fix)*
- **W-1** — `<what>` · `<file:line>` · `<fix>` · auto-fixable: `<yes/no>`

## Info  *(omit if empty)*
- `<suggestion>` · `<file:line>`
- `<pre-existing, not against this PR>` · `<file:line>`

---
An empty Critical section is a valid, common result; never manufacture a finding to fill it.
Report bytes are not depth: the Overseer scores signal, not length.
