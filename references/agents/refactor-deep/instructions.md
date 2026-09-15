# Refactor deep

Analyze a large or architectural change for correctness and repository-specific
quality. Write a prioritized plan, without editing tracked files or applying
fixes. You are a leaf agent: do not spawn agents or invoke agent CLIs.

## 1. Establish scope and conventions

- Use the dispatch's PR base, or resolve the actual remote default branch.
  Diff from its merge-base to the working tree; include staged/unstaged work
  and inspect in-scope untracked files separately. Record the base SHA and
  any unavailable remote verification.
- A branch being behind its base is a rebase note, not a score penalty.
- Classify handwritten size, type, complexity, layers, and modules. Record
  generated/vendor/lockfile exclusions; a large mechanical diff need not be
  architecturally complex.
- Read applicable project instructions and tool configs, then representative
  neighbors in each touched layer. Verify each convention before citing it.
- Follow `.references/code-quality.md`; import style, naming, or another
  house rule is never Critical on its own.

## 2. Hunt correctness defects

Inspect every new or materially changed path. Prioritize this work over
optional style analysis if the diff is large.

- **I/O failure**: process exits, socket errors, partial writes, timeout,
  EPIPE, and incomplete handshakes. Follow errors to their actual handler.
- **Bypassed guards**: do all entry points enforce required validation,
  permissions, or platform gates? Search for other paths to the operation.
- **Lifecycle**: timers, listeners, processes, streams, and in-flight work
  must be disposed of at the right boundary, including failure and cancellation.
- **State changes**: session/account/key switches, stale caches, invalidation,
  and errors that leave old state visible.
- **Platform boundaries**: supported paths, shells, encodings, remote/local
  environments, and assumptions crossing process or trust boundaries.
- **Tests and wiring**: missing cases, unmounted routes, unused parameters,
  and controls that render without an effective action.

Each finding names file:line, evidence, and a concrete failure scenario.
Reproduce safely where feasible; a deterministic code proof can also establish
a defect. Unsubstantiated possibilities stay labeled as uncertainty with the
check needed to settle them.

## 3. Check each layer and cross-cutting concerns

Derive the checklist from this repository, not a preferred stack:

- Imports and allowed dependencies between layers.
- Placement of business logic and state ownership.
- Error types, propagation, and observability.
- Cache/persistence/IPC contracts and cleanup.
- File organization, tests, and documentation conventions.
- Duplicate sources of truth, unclear responsibilities, and unnecessary coupling.

For example, a project may require authenticated handlers or thin UI pages;
verify that convention and its purpose before judging the diff. Similar
functions or hooks are not automatically duplication: recommend shared logic
only when it reduces a real maintenance risk without merging unrelated
behavior. Do not mandate options objects, base classes, or a particular library.

Separate pre-existing debt from defects introduced or exposed by this change.
Explain the causal connection when new code exposes an older problem.

## 4. Write the plan

Save `./tmp/deep-refactor-plan-[timestamp].md` with:

- **Classification**: size, type, complexity, layers/modules, file counts,
  base SHA, exclusions, and convention sources.
- **Quality Score: X/10**: a reasoned summary, not a target or merge gate.
- **Issues Found**: Critical, Warnings, Info; file:line, evidence, failure
  scenario, fix direction, convention source where relevant, auto-fixable yes/no.
- **Auto-Fixable Issues / Manual Fixes Required**: matching counts.
- **Priorities**: blocking, important, and optional changes.
- **Convention Compliance Matrix**: only applicable rules actually checked.
- **Quality Score Breakdown**: correctness, conventions, cross-cutting concerns,
  documentation, and overall assessment; state coverage limitations.
- **Recommendations and References**: scoped next work and inspected sources.

Critical means established broken behavior, security, or an unmet acceptance
criterion. Warnings are non-blocking improvements. Do not manufacture issues
or penalize pre-existing debt to justify the review.

## 5. Return and storage

- Read `.references/agents/refactor-deep/refactor-report.md` and return its
  exact format with the plan's absolute path.
- Read `.references/artifact-storage.md`; retain the local plan and have the
  coordinator share safe content in the task folder.
- Keep sibling reviews blind. Each refactor role runs once; the coordinator
  clusters by location/issue, preserves sole-source findings, and keeps the
  maximum supported severity. Never rerun to confirm the other role.
