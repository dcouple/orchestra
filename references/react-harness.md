# The React harness — packages, layers, and how to set one up

One system for catching React hygiene defects — re-render storms, dead
code, accessibility breaks, perf anti-patterns — by machinery instead of
by users. This is the general reference: what the layers are, which
packages fill them, and the rules that make a first-time setup work.
Other documents stay lightweight and point here: `qa-verification.md`
§ React runtime hooks tells the QA drive how to *consume* the runtime
layer; this file is how a repo *gets* the harness. Set it up only when
the user asks or approves the offer — it's a repo capability decision.
First working implementation: bloomapi/bloom-mono PR #484 (copy the
shape, not the specifics).

## The layers — one system, different run-points

| Layer | Catches | Runs | Gate |
|---|---|---|---|
| **Fast lint core** | violations of rules the repo already enforces | CI, in the required job — every PR, always | **blocking** |
| **Incumbent linter** (kept) | resolver-dependent + custom-plugin rules the fast linter lacks | CI, required job | blocking (unchanged) |
| **Advisory lane** | net-new signal: perf/suspicious rules, dead code, React health review | CI, separate tolerant job — every PR, always | never blocks |
| **Render-count tests** | re-render regressions, deterministically | the normal test suites — every PR, always | **blocking from day one** |
| **Runtime hooks** | live render behavior; rendered-DOM a11y | invoked by an agent/human against the running app (QA drives, debugging) | evidence, not a gate |

Why the split run-points: everything static and deterministic runs
automatically on every PR — no one invokes it. The runtime hooks can't:
they need a booted app and a driver, so they run when something drives
the app — the QA pass on React-touching diffs (per `qa-verification.md`),
or a human profiling session. The render-count tests are the bridge:
the deterministic, always-run distillation of what the runtime layer
observes (a storm seen live via `perf:scan` becomes a red→green
render-count regression test when fixed).

## The packages

| Package | Layer / role | The advice that matters |
|---|---|---|
| `oxlint` | fast lint core + advisory extras | Rust-native, ~10–50× the incumbent's speed. Two configs: core (blocking) and advisory (extras) — zero rule overlap between them. **Check the lockfile's native-binding `engines` against CI's pinned Node before first push** — a binding one patch above the runtime fails every PR with "Cannot find module". |
| `eslint` (existing) | retained rules | Not replaced. Keeps import-resolver rules, workspace-boundary rules, custom plugins (react-native, house styles). Prune a rule **only** per the ratchet below. |
| `knip` | dead code (advisory) | Replaces abandoned tools (`unimported`) outright. Workspace-aware config; bound platform-split files (`.ios./.android.`) with `entry` overrides, never blanket ignores; `--reporter json` for artifacts. Its sharpest findings are **unlisted dependencies** that only resolve via hoisting. |
| `react-doctor` | React health review (advisory) | Use the official **new-issues-only** CI integration or nothing — a full-tree scan can't prove an issue is new; never substitute one. Pin the version, scope `directory` to the app workspace. Caveats before adopting: modified-MIT license (get sign-off) and bundled Sentry telemetry whose opt-out (`--no-telemetry`) the CI action may not expose. |
| `react-scan` | runtime render instrumentation (`perf:scan`) | Use the programmatic API (`scan()` + render callbacks — verify the pinned version's exports first); its CLI spawns its own browser and cannot serve a driven session. React ^16.8–^19. |
| `playwright` + `@axe-core/playwright` | runtime a11y (`a11y:scan`) | The library, not Playwright Test — the runner is a standalone Node script. Browser binaries are an explicit documented local install, never a CI side effect. |
| React `<Profiler>` (no package) | render-count tests | Built into React; the helper needs no dependency. |

Versions: exact pins, newest release older than the repo's release-age
gate, installed via the repo's dependency-safety path with lifecycle
scripts suppressed. Expect **transitives** to trip an age gate too —
resolve with minimal commented overrides, never allowlist edits.

## The governing principle: enforcement is a ratchet

- **Blocking never loosens.** No check, rule, or test that blocks today
  may be made advisory, weakened, or removed — not during setup, not
  when violations appear later. Prune a rule from the incumbent linter
  **only** when the blocking core enforces its equivalent, and record
  every decision — pruned (rule → equivalent), retained (rule → reason)
  — in a committed overlap doc the change's reviewer audits against both
  configs.
- **Net-new analyzer signal starts advisory** with its baseline recorded
  (advisory warning count, dead-code count, health score); each check
  flips to blocking as its own later change, after its baseline is
  cleaned.
- **Tests are not analyzer signal — they block from day one.** A test
  (the render-count seed, any regression test distilled from a runtime
  observation) encodes one specific already-true, deterministic behavior
  with no baseline to clean, so advisory-first doesn't apply; it enters
  the suite blocking like any other test.
- During setup, classify before enforcing: a violation of an
  *already-enforced* rule is a latent bug — fix it in the setup change;
  a rule the repo has **never** enforced whose violations exist goes
  into the advisory config at introduction (a pre-enforcement
  classification, not a downgrade — it was never blocking). Inline
  silencing is never the resolution for either case.

## Setting up the static lane

1. Core config = intersection of the fast linter's rule set with the
   rules already enforced at error level — nothing more; iterate until
   it exits 0 on the default branch; record wall-time before/after.
2. Advisory config = the net-new categories (perf, suspicious,
   react-perf identity-churn family). Separate file, no core overlap.
3. CI: the core is an ordinary step in the existing required job. The
   advisory analyzers get a **separately named job** with
   `continue-on-error: true` at the job level **and on every step** —
   sequential steps without per-step tolerance let one analyzer's
   failure suppress every later report.
4. knip + React Doctor per the package table; scripts under the
   convention names below.

## Setting up the runtime hooks

1. **`perf:scan`** — dev-only by construction: gate the instrumentation
   behind a compile-time constant the bundler substitutes (webpack
   `DefinePlugin` / Vite `define`), **literally false in every
   production build regardless of environment** (env vars aren't
   client-visible; HTML-injected globals can't be dead-code-eliminated).
   One flag-guarded hook at the app entry before the React root; emit
   **rate-bounded** evidence — aggregate per-component render counts
   into ~1s windows, one console line per window:
   `console.info('[render-evidence]', JSON.stringify({t, window_ms, renders:[{name,count},…]}))`
   — that prefix + shape is the contract QA greps for. Wire the script
   through the repo's own dev-stack orchestrator (resolved ports and
   all). Prove production-clean two ways: output grep **and** a
   production-stats module-graph assertion.
2. **`a11y:scan`** — standalone runner: launch chromium, scan the
   unauthenticated entry, log in (credentials default to the repo's
   documented dev/staging testing account; env overrides, not enables),
   scan the main screens; JSON violations report; exit 0 whatever the
   violation count — nonzero **only** for runner failure or incomplete
   required coverage (a silently skipped screen poisons evidence).
   Selector-keyed waits only — never `networkidle` (websocket apps never
   idle), never bare timers; when a load has no awaitable HTTP response
   (websocket commands), key on the previous state's node *detaching*.

## Concrete shapes (adapt names/paths; these are the load-bearing forms)

- Scripts (app workspace `package.json`):
  `"lint:ox": "oxlint --config .oxlintrc.json <src dirs>"` ·
  `"lint:ox:extra": "oxlint --config .oxlintrc.advisory.json <src dirs>"` ·
  `"deadcode": "knip"` (or a thin arg-normalizing wrapper) ·
  `"perf:scan": "REACT_SCAN=1 <the repo's dev-stack start command>"` ·
  `"a11y:scan": "node <app>/tools/a11y/scan.mjs"`.
- Advisory CI job (beside the required job, same setup steps):
  ```yaml
  static-analysis-advisory:
    continue-on-error: true
    steps:
      - {name: Oxlint (extra), run: pnpm lint:ox:extra, continue-on-error: true}
      - {name: Knip,           run: pnpm deadcode,      continue-on-error: true}
  ```
  The blocking core is one ordinary step (`run: pnpm lint:ox`) in the
  existing required job — no `continue-on-error`.
- React Doctor: the official action `millionco/react-doctor@v2` in its
  own workflow (`pull_request` + default-branch `push`), with
  `version:` pinned to the devDep and `directory:` scoped to the app
  workspace; advisory = omit the `blocking:` input.
- Production-clean assertion (webpack shape): build, then
  `! grep -ri "react-scan\|render-evidence" dist/` **and**
  `NODE_ENV=production <bundler> --mode=production --json > stats.json`
  + a node one-liner exiting nonzero if `node_modules/react-scan`
  appears in the stats.
- Compile-time flag (webpack shape): in `DefinePlugin`,
  `REACT_SCAN_ENABLED: JSON.stringify(isProduction ? false : Boolean(process.env.REACT_SCAN))`
  with `isProduction` derived from the build's own mode signal; entry
  hook `if (REACT_SCAN_ENABLED) { require('./devtools/reactScan') }`.

## The render-count helper

Ship a `<Profiler>`-based counter in the shared test utils with one
passing seed test, and document its semantics honestly: an external
Profiler wrapper counts commits when its subtree renders from the
parent and **cannot observe a child `memo` bailout** — it is the right
instrument for *self-driven* re-renders (store subscriptions: the
storm class). The seed proves the pattern: a test-local connected
probe; unrelated store dispatch → zero new commits; relevant dispatch →
exactly one (the positive control).

## When to run what — the triggers

The repo's agent docs must carry these (adapted to its script names), so
any agent working there knows the moments, not just the mechanics:

- Touching any frontend code → the blocking core lint, run as habitually
  as the incumbent linter.
- Changing components, hooks, selectors, or store wiring → also read the
  advisory lane's output for the touched files, and add a render-count
  test when the change is subscription- or memoization-sensitive.
- Changing rendered UI → run the a11y scan against the changed screens
  and compare with the recorded baseline.
- Investigating render performance, or verifying a perf-sensitive change
  in the running app → drive it under the perf hook and read the
  evidence records.
- Deleting or moving files/exports → the dead-code check before and
  after shows what actually became unused.

(The QA drive's own trigger — React-touching diffs probe and use the
runtime hooks — lives in `qa-verification.md`; these are the
inside-the-repo moments for developers and coding agents.)

## Script-name convention (the probe surface)

`lint:ox` · `lint:ox:extra` · `deadcode` · `perf:scan` · `a11y:scan` —
exact names in the app workspace's `package.json`; agents discover
capabilities by probing scripts, so the names are the API. Document
usage, ports, creds source, the evidence-line format, the browser
install one-liner, and the when-to-run triggers above in the repo's
agent docs.

## Validation — it must work the first time

- Core exits 0 on the default branch; incumbent still exits 0; overlap
  doc complete; wall-times recorded.
- **The probe proof**: a scratch draft PR seeding one violation per
  analyzer (a pruned-rule violation; an advisory-only violation; an
  unused export; a new React defect) — the blocking step must fail, the
  advisory job must report while staying green, the health review must
  comment only the new issue. Capture run URLs; close and delete the
  probe.
- Live drive: `perf:scan` up, one real journey driven, overlay +
  `[render-evidence]` lines quoted; production build clean both ways.
- `a11y:scan` covers every required screen with only the app running;
  seed test passes both assertions; baselines recorded in the PR with
  flip-to-blocking follow-ups named.
