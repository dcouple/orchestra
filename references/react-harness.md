# React quality harness

Set up only when the user asks or approves. Existing QA consumes declared
hooks through `qa-verification.md`; it does not install app instrumentation.

## Choose tools for the project

Inspect the repository's stack, supported runtime, CI, existing analyzers,
dependency policy, and testing conventions before proposing additions.

| Layer | Purpose | Enforcement |
|---|---|---|
| Existing lint rules | Maintain established checks | Keep blocking checks blocking |
| New static analysis | Find new classes of issues | Advisory until baseline is addressed |
| Render-count regression tests | Protect a specific deterministic behavior | Blocking in the normal test suite |
| Runtime hooks | Observe driven render/accessibility behavior | Evidence, not an automatic gate |

Possible tools include a compatible fast linter, a dead-code analyzer,
React-specific analysis, React `<Profiler>`, render instrumentation, and a
browser accessibility scanner. These are capabilities, not a required package
list. Before adoption, verify official documentation for the selected version,
runtime/native dependencies, license, telemetry, and CI integration.

- Follow the repo's lockfile, version, release-age, and install-safety rules.
- Keep incumbent rules unless a blocking equivalent demonstrably replaces them.
  Record rule-to-equivalent mappings and retained-rule reasons in the project's
  normal documentation location.
- Separate new advisory findings from violations of already-enforced rules.
  Do not silence existing gates to make setup green.
- Baseline new analyzer output before making it blocking. A deterministic
  regression test belongs in the blocking suite from the start.
- Keep advisory analyzers independent so one failed tool does not suppress
  the others. In GitHub Actions, this may require tolerance on each step as
  well as the advisory job.

## Runtime discovery contract

Orchestra probes these names in the app workspace's `package.json`:

- `perf:scan`: starts the documented dev stack with render instrumentation.
- `a11y:scan`: scans required rendered screens and writes a violations report.

If the project already uses other commands, expose small compatible wrappers
when adopting this contract; do not rename unrelated workflows. Static script
names such as `lint:ox`, `lint:ox:extra`, and `deadcode` are examples, not
requirements. Document commands, ports, credential references, and triggers in
the repository's agent/testing docs.

## Implement `perf:scan`

- Use the selected library's verified programmatic API so the existing QA
  driver can control the app; avoid a CLI that launches an unrelated browser.
- Gate the hook at the app entry behind a compile-time constant. It must be
  literally false in production regardless of a runtime environment setting.
- Emit rate-bounded, aggregated console evidence with this contract:

```js
console.info('[render-evidence]', JSON.stringify({
  t, window_ms, renders: [{name, count}]
}));
```

- Roughly one-second windows are a useful starting point. Keep reporting
  bounded and preserve the prefix/shape used by QA.
- Prove instrumentation absent from production both in emitted output and
  the bundler's module graph; use the project's bundler, not an assumed one.

A webpack-shaped example of the compile-time value is
`JSON.stringify(isProduction ? false : Boolean(process.env.REACT_SCAN))`,
with `isProduction` derived from the build mode. Adapt the mechanism to the
actual toolchain rather than relying on browser-visible environment variables.

## Implement `a11y:scan`

- Use a standalone runner compatible with the project's browser tooling.
  Document browser installation explicitly; do not hide it in CI setup.
- Cover the required public and authenticated screens. Retrieve designated
  test credentials through `testing-accounts.md`, never embed their values.
- Emit structured violations. Exit 0 for a completed advisory scan even
  when violations exist; fail on runner errors or incomplete required coverage.
- Wait on observable UI state, not bare timers or network-idle assumptions.
  For a transition without a response, waiting for the old node to detach may
  provide the needed signal.

## Render-count tests

Use React `<Profiler>` or the project's equivalent with a deterministic seed
test. A wrapper counts subtree commits, not an individual child's memo bailout.
For subscription churn, a useful probe is unrelated state change → no new
commit, relevant state change → the expected commit. Verify both controls and
document what the helper can and cannot measure.

## Validate and document

- Existing blocking checks still pass. New blocking equivalents and their
  mappings are verified; advisory tools report without masking later reports.
- Use isolated seeded violations to prove gate behavior. Creating a scratch
  PR, running paid CI, or deleting a remote branch needs appropriate scope;
  otherwise validate locally and report the untested hosted behavior.
- Drive a real journey under `perf:scan`, quote evidence, and verify a clean
  production build through both checks.
- Run `a11y:scan` across required screens and record its baseline and gaps.
- Run the render-count seed and any regression cases discovered during setup.
- Record when to use each capability: touched-source lint; advisory review
  for changed components; accessibility for changed screens; profiling for
  performance-sensitive flows; dead-code checks around moved/deleted exports.
- Save safe reports per `.references/artifact-storage.md`. Keep executable
  hooks, tests, and maintainer-facing source docs in the project; Grain does
  not replace code needed to run the harness.
