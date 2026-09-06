## Step 4: PR

The PR is an artifact, not the finish line - open it once the work
verifies, then improve it in place (Step 5). All commit/PR prep lives here:

- **Build gate first**: discover the project's own build/typecheck/lint
  workflow (`package.json` scripts, Makefile, CI config - ask the repo,
  don't assume) and run it. Failures are must-fix before the PR opens.
- **Deploy notes scan**: scan the run's diff for schema/migrations, env
  vars/secrets, infra/CI, new third-party dependencies, and one-time
  scripts/backfills, then **split each finding by tier and act on it**
  (Autonomy & safety). A finding's **green-tier half** - an additive/nullable,
  reversible change on a non-production environment you can reach (e.g. the
  staging DB) - **must be applied before the verification that depends on it**:
  a staging column the tests read is a Step 3 prerequisite applied at
  implement/verify time, not a Step 4 discovery. This scan is the **backstop** -
  if it is the first to catch an unapplied green change, apply it **and re-run
  the affected verification**, since Step 3 finished before this scan and any
  evidence gathered against the missing schema is void. Its **red-tier half** -
  production, irreversible, or secrets - you **capture as a deploy note and do
  not apply without explicit human approval**. Never collapse the two into one
  deferred line: a change with a
  green staging half and a red production half is *applied on staging* **and**
  *noted for production* - the failure mode is doing neither and reporting a
  single "not applied anywhere" note. Flag any finding that **blocks
  verification/QA** - a *staging/test* resource the run gathers evidence against
  (a staging column the tests read, a test-mode key the QA pass needs) - as a
  **prerequisite**, distinct from deploy-time actions. A **production** change
  is never a verification prerequisite: verification runs against non-prod, so
  an unapplied prod migration is a deploy action, not a blocker.
- Commit selectively (only this run's files, never `git add -A`; secret-scan
  the staged diff), message style `type: short imperative summary`. Rebase
  onto the origin default branch; push (`--force-with-lease` on rewrites).
- Open the PR: typed title; write the body following this skill's
  `references/pr-body.md` - its section spine (Summary/What-Why-How, Visual
  overview, User journeys, Verification, Manual tests, QA results, Deploy
  notes, Residual risks), its body-state / comment-proof split, and its
  pre-open checklist are binding. The **Visual overview** is required - its
  only omission is the recorded `Visual overview: none - <reason>` line:
  user-visible changes lead with the before-state and the diagram at open -
  **after-shots land with the QA drive's first body update, minutes after
  open** (the pre-open Visual overview says so explicitly:
  `After-shots: landing with the QA drive`); anything already captured hosts
  on the rolling assets prerelease per Step 5's evidence rule, filenames
  keyed to the work item id. If the best-effort browser drive remains
  unavailable after its retry, replace that pending line with
  `After-shots: unavailable - left to human: <environment reason>` and carry
  the same gap into QA results; an unavailable browser must not leave the PR
  body pretending evidence is still about to arrive;
  flow-/boundary-/lifecycle-shaped changes lead with the before → after
  diagram per the `excalidraw-pr-diagrams` skill - and for a change with
  **no user-visible surface**, the diagram lands with the QA drive's first
  body update instead of blocking PR open: open with
  `Visual overview: diagram landing with the first body update`, author the
  diagram while the post-PR lanes run, and embed it before the QA results
  close; the
  **User journeys** section carries both a journey map and - for branching
  flows - a fork map cross-tagged into the Manual tests; the deploy-notes
  scan above feeds the **Deploy notes** section. Follow
  `.references/tracker-lifecycle.md` for provider closing lines. After `gh pr
  create`, **YOU MUST** retrieve the persisted body, verify and repair the
  expected closing-line set, and read it back before leaving Step 4.
