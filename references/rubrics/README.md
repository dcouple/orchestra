# Verification rubrics

One rubric per change surface. `/do`'s verify stage picks the rubric matching
the change type (see `../verification-methods.md`) and includes it in the
verifier's dispatch alongside the item's `AC#` criteria.

How to read a rubric:

- Apply each item to the relevant surface and supported environment. State
  why an item is inapplicable; do not invent a datastore, queue, browser, or
  deployment mechanism just to satisfy an example.
- Every item is **binary** - it passes only on the named observable evidence,
  never on a judgment or an assertion.
- **[blocker]** items gate the verify stage; unlabeled items are reported but
  don't block.
- "Known failure modes" list what has actually bitten on this surface -
  check them even when no AC mentions them.

How rubrics grow: from postmortems and review misses, not speculation. When
a `/postmortem` names a failure a rubric item would have caught, add that one
item when it would materially change verification. Keep the checklist short
and evidence-based; save safe proof per `../artifact-storage.md`.
