# React runtime hooks — setting them up in a repository

> The producer side of `qa-verification.md` § React runtime hooks. That
> section tells the QA drive how to *use* repo-declared hooks; this one
> tells an agent how to *build* them in a repo that doesn't have them.
> Set them up only when the user asks for them (or approves the offer) —
> hooks are a repo capability decision, not something a run adds on its
> own initiative. First working implementation: bloomapi/bloom-mono PR
> #484 — copy its shape, not its specifics.

## The contract

Two scripts in the app workspace's `package.json` — the names are the
probe surface, so they are exact:

- **`perf:scan`** — starts the web app's dev server in a scan mode where
  React re-renders are instrumented and evidence is emitted as structured
  browser-console lines. Any driver (a verifier's browser, a human with
  DevTools) reads the evidence from its own session; the script never
  owns a browser.
- **`a11y:scan`** — runs an axe scan against the app's key screens
  (unauthenticated entry + the main authenticated screens) with **zero
  setup beyond the running app**, writes a JSON violations report, and
  exits 0 regardless of violation count (evidence, not a gate) — nonzero
  only when the runner itself fails or required coverage can't complete.

## perf:scan — the load-bearing rules

1. **Dev-only by construction, proven.** Gate the instrumentation behind
   a compile-time constant your bundler substitutes (webpack
   `DefinePlugin`, Vite `define`) that is **literally false in every
   production build regardless of environment variables** — derive it
   from the build's own production signal, then let dead-code
   elimination drop the guarded `require`/import. Environment variables
   are not automatically client-visible and an HTML-injected global
   can't be eliminated — the constant must be a bundler substitution.
   Prove it: grep the production output for the package and the evidence
   marker, **and** assert the production stats/module graph contains no
   module resolved from the scan package.
2. **Instrument with react-scan's programmatic API** (`scan()` with its
   render callbacks — verify the pinned version's API from its installed
   types before writing the module; react-scan's CLI spawns its own
   browser and cannot serve a driven session). One flag-guarded hook at
   the app entry, before the React root mounts; no component changes.
3. **Rate-bound the evidence.** Aggregate render counts per component
   into windows (~1s) and emit one line per window, top-N components —
   an unbounded per-render log floods the driver's console capture:
   `console.info('[render-evidence]', JSON.stringify({t, window_ms, renders: [{name, count}, …]}))`
   The `[render-evidence]` prefix and JSON shape are the contract the QA
   drive greps for — document the exact line format in the repo's agent
   docs.
4. Wire the script through whatever starts the repo's dev stack (its
   orchestrator script, resolved ports and all) with the flag set — not
   a bespoke second server path.

## a11y:scan — the load-bearing rules

1. A standalone Node runner using the `playwright` library (not
   Playwright Test) + `@axe-core/playwright`: launch chromium, scan the
   unauthenticated entry, log in, scan the main screens; write the
   per-screen violations JSON; print a summary.
2. **Coverage is required, never conditional**: credentials default to
   the repo's documented dev/staging testing account (env vars override,
   not enable); if login or a required screen can't complete, exit
   nonzero as a runner error — a silently skipped screen poisons the
   evidence.
3. **Selector-keyed waits only** — wait on screen-specific elements,
   never `networkidle` (websocket apps never idle), never a bare timer:
   a timer resolving against a stale pre-transition element is the
   classic false-positive (wait for the previous state's node to
   *detach* when a load has no awaitable HTTP response).
4. Browser binaries are an explicit documented local install
   (`pnpm exec playwright install chromium`) — never a CI side effect;
   suppressed lifecycle scripts don't run it for you.

## Validate before opening the PR — it must work the first time

- `perf:scan` up → drive one real journey in a browser → the overlay
  renders and `[render-evidence]` lines appear in the console (quote
  them in the PR).
- Production build → package grep clean **and** module-graph assertion
  clean.
- `a11y:scan` with only the dev app running → report covers every
  required screen; kill the app mid-scan → nonzero exit.
- Probe surface: both script names resolve from the app workspace's
  `package.json`.
- Document both hooks (usage, ports, creds source, the evidence-line
  format, the browser-install one-liner) in the repo's agent docs — the
  QA drive reads launch facts from there, not from this file.

Then open the PR per the repo's conventions, with the validation
evidence quoted.
