# Review Report (Code + Security) - agent output format

> Returned **in-conversation** by the Code Reviewer to the Overseer - **not a file**.
> Runs in the post-PR review loop, on the first phase's diff of a multi-phase item, and as scoped fix reads. Under `/do`, every invocation is one of three zone-derived, run-global units - a pre-QA pass, a fix read, or the reserved pass - with ceilings per `.references/zones.md`'s dial table; phase boundaries, PR creation, QA, and a changed HEAD never reset them. Must-Fix items loop back to Implement only while a unit remains to cover the fix (`/prepare-pull-request` has its own cap). The security review is mandatory: security findings live in
> Must Fix / Should Fix with a `(security)` tag, data-loss findings with a `(data)` tag - never a separate section, so they
> always count toward the loop's Must-Fix gate. Final outcome folds into `wrapup.md`.
> **Your final message IS the report: begin with the verdict.** Every line is a verdict,
> a finding with `file:line`, or a check you ran - no preamble, no process narration,
> no closing summary.

---

**Verdict:** `<Approve | Request changes>` - `<one-line rationale>`
**Counts:** Must Fix: `<n>` (security: `<m>`, data: `<d>`) · Should Fix: `<n>` · unit `<pre-QA pass k/<ceiling> | fix read j/<ceiling> | reserved pass>` · range `<sha>..<sha> | whole PR>` · checklist `<complete | see section>`

## Must Fix  *(blocks merge; loop back to Implement)*
- **MF-1** `(security)` - `<what>` · `<file:line>` · `<fix>` · violates `<D# / AC# | "new issue">`
  - **Evidence:** `<concrete code, test, trace, or command output>` - `<why it proves the finding>`
  - **Failure scenario:** `<concrete way this breaks in production>`   *(required for correctness/security findings)*
- **MF-2** - `<what>` · `<file:line>` · `<fix>` · violates `<…>`
  - **Evidence:** `<artifact>` - `<why it proves the finding>`

## Should Fix  *(important, non-blocking)*
- **SF-1** - `<what>` · `<file:line>` · `<fix>`
  - **Evidence:** `<artifact>` - `<why it supports the finding>`

## Nice to Have  *(omit section if empty)*
- `<nit or thought>`

## Praise  *(omit section if empty)*
- `<what the diff got right - specific, so it survives the fix loop>`

## ⚠️ Cannot verify  *(omit if empty)*
- `<requirements you couldn't verify from the diff alone, and what the Overseer should check>`

## System checklist  *(required every unit - one line each; an `n/a` is contradicted when code of that class is present in the reviewed range, not by a filename)*
- concurrent writers / ordering: `<n/a: reason | ok: artifact | finding MF-n/SF-n>`
- crash between write and ack: `<…>`
- file-backed state (lock, fsync): `<…>`
- scheduled / deferred work fires: `<…>`
- authz on every read path: `<…>`
- guards config can widen: `<…>`

---
**What a Code Reviewer checks:** correctness vs the plan & item intent · security
(authz, input validation, injection, secrets, unsafe deserialization) - tag findings
`(security)` · missing error handling & edge cases · unneeded complexity /
over-engineering · adequate tests · clear naming · does the diff actually fulfill the
intent (not just the task list) · house rules per `code-quality.md` (discovered from this repo, source cited, never Must Fix alone) · the six system invariants (System checklist section, mandatory every unit). Every finding cites `file:line`.
Every checkable finding at every severity names the concrete artifact inspected and
explains the inference; unsupported claims belong under Cannot verify with the evidence
needed to settle them.

**Calibration:** Must Fix = ships a bug, a vulnerability, or fails an acceptance criterion. Should Fix = materially better code, but mergeable without it. Everything else is Nice to Have - don't inflate severity. **Severity follows consequence class, never diff size or fix size.** A finding whose Evidence line names a concrete path or state in any of these classes is Must Fix, always: (1) **data loss or corruption** - lost, duplicated, reordered, or skipped writes or events; non-idempotent redelivery; unlocked or un-fsynced file-backed state - tag `(data)`; (2) **security** - injection, secrets in code or logs, unsafe deserialization, and any safety guard, allowlist, or recipient/scope constraint that an env var, config value, or flag default can widen - tag `(security)`; (3) **authorization** - any read or write path reachable without the access check its siblings apply - tag `(security)`. Should Fix is not a legal tier for these classes: substantiate the finding as Must Fix, or place it under Cannot verify with the evidence that would settle it.

**Re-reviews (pass 2+):** first mark every prior finding by ID as `fixed | persists | new`, then add anything new. Don't re-litigate what's fixed. **Scoped units (a fix read or the reserved pass):** the dispatch names a commit range; review that diff alone - mark each prior ID, report only defects introduced by or still present in the range, still answer the System checklist for the range, state the range in Counts, and do not re-review the whole PR.
