## Step 3: Verify

Prove every command-shaped verification criterion - the `codex` skill role
`backend-verifier` for tests/scripts. **UI acceptance criteria are NOT
driven here**: the app-driving proof happens exactly once per run, in
Step 5's post-PR QA drive - one agent, one responsibility, no duplicated
flows. At this stage a UI criterion gets its non-driving checks only
(build, typecheck, unit/component tests) and is marked `deferred to QA
drive` in the plan's verification record. Verification that must spawn
an AI session or feed repo context to an AI CLI routes to the matching Codex
role. Any ad-hoc verifier dispatched outside the named agents carries an
explicit model and the leaf-agent line (you are a sub-agent; never spawn
agents or invoke agent CLIs - `claude`, `codex exec`, or any equivalent).
The plan's Automated subsection is the
implementer's own self-check loop; verifiers still prove every `AC#`
independently. Include the change type's rubric from
`.references/rubrics/` in each verifier dispatch (see
`.references/verification-methods.md`); its blocker items gate alongside
the ACs. Quoted evidence on every pass; nothing is assumed. Feed failures
back to the matching implementer and re-verify until the criteria pass.
**Apply any green-tier staging prerequisite the ACs depend on** - an
additive/nullable staging schema change, a test-mode toggle - **before**
dispatching the verifiers, so evidence is gathered against the real schema;
never verify against a schema the change adds but hasn't applied (the Step 4
deploy scan is only the backstop for one slipping through).

Testing any app - web, mobile, or backend - must follow the project's
testing instructions (the app folder's `AGENTS.md`/testing docs). If a
verifier reports it has no testing instructions for the app, or can't test
for lack of credentials, environment, or tooling, don't invent commands,
credentials, or product state. Record the exact unavailable criteria and
continue all independent verification and the rest of the pipeline; surface
the gap as a verification/QA prerequisite in the PR and wrap-up. Missing UI
tooling alone follows Step 0's temporary-Playwright fallback and is not a
reason to stop the run. When verification needs the running app, apply Step
0's `AGENTS.md`-sourced launch rule and stop what the pipeline started. A
service the verification needs alive runs detached (nohup + pidfile under
`./tmp/<id>/`) so its lifetime is owned by the run rather than a tool
timeout - a reaped server poisons the next boot with orphans. Tear down
the recorded pids explicitly, and when freeing ports kill only pids
enumerated before the next launch.

An implementer touching a mobile surface may use `orchestra-sim acquire` to
check its work and must `orchestra-sim release <udid>` when finished. Mobile
UI acceptance criteria are deferred to the single QA drive like web UI ACs.

**Done when**: every runnable `AC#` and rubric blocker has quoted evidence;
anything genuinely unavailable after the prescribed best-effort attempt is
explicitly recorded for the human and does not silently disappear or halt
unrelated work.
