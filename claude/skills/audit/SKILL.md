---
name: audit
description: Adversarial audit of a plan, spec, code change, process/skill change, or document that converges in 2-3 rounds. Use when the user asks to audit, stress-test, or "make sure nothing important comes back" on any artifact - a build plan, a completed code change, a strategy doc, a pipeline rule change - in or outside a codebase. Triages first: a sketch gets co-written into a spec (against ground truth) before it is audited, instead of a doomed serial audit loop.
---

# /audit - find everything real, converge fast

Born from a session where auditing an under-specified plan took 8 serial rounds.
The defects were all present from day one; the process discovered them five at a
time. Revised after a second session showed the other common failure: a change made in
one place while the same rule stayed in force in other copies of it. This skill
front-loads coverage so the same value lands in 2-3 rounds. Never trade honesty
for convergence: a clean verdict must be earned, and if a verification round finds
important issues, you fix and run another. Fast convergence comes from process
(triage, parallelism, verified fixes, ID-tracked findings), never from lowering
the bar.

## Effort

Auditors, the fix agent, and verifiers run at full reasoning effort in fresh
context. Never dispatch an auditor at low effort: the defects that matter most are the
ones a skim misses. If the budget only allows low-effort auditors,
say so and label the audit "shallow".

## Phase 0 - Triage the target (ALWAYS first, before any auditing)

Classify what you've been asked to audit:

1. **Completed code change** (diff, PR, merged commits) → auditable. Go to Phase 1.
2. **Build-ready plan/spec** → auditable. Go to Phase 1.
3. **Sketch / simple plan** → NOT auditable yet. See "The sketch response" below.
4. **Process, policy, or skill change** (a pipeline rule, a prompt, a SKILL.md, a
   runbook, a config default) → auditable once it is a spec (test 2 vs 3 applies).
   Its surfaces are listed under Phase 1.
5. **Other artifact** (strategy doc, analysis, contract, message) → auditable;
   adapt evidence sources.

**The builder test** separates 2 from 3: could a competent builder implement this
without guessing? Spot-check for these tells of a sketch:
- Names concepts but not exact functions/tables/endpoints/files it integrates with.
- Claims about existing systems that were never verified against them ("we'll use
  X for Y" where X was never read).
- Unstated failure behavior (fail-open vs fail-closed, what happens on stale
  data, crash mid-operation, retries, duplicates).
- No keys/idempotency/timing/identity decisions (who sends, as whom, when,
  deduped how).
- Numbers asserted without a source.
- For a process/skill change: names the rule to change but not the file and the
  current text; does not say who executes the new rule, when it triggers, what it
  costs per run, or what evidence proves it was followed.

If ≥2-3 of these hit, it's a sketch.

**The sketch response:** do not audit a sketch. Auditing prose-level plans
produces serialized findings forever - every vague claim hides several defects
that only surface one round at a time. Instead:
1. Say so in one line: "This is a sketch, not a spec. Auditing it now would burn
   rounds finding what specification would surface for free."
2. **Co-write the build-level spec yourself, now** - do not stop and offer. Dispatch
   a spec-writer with the ground-truth locations and the rule below (verify every
   claim while writing; quote current text with file:line). The user asked for an
   audit; the spec is the first half of delivering it. Only stop first if the
   sketch hides a decision that is genuinely the user's (see the Phase 0 gap list).
3. Enumerate the spec-gap list the writer must close, specific to THIS target,
   grouped by area.
4. Then audit the finished spec (Phase 1).

**Also in Phase 0:** name the ground-truth sources available - code, live DB/data,
repo history, prior audit data, external docs, the web. For a process/skill
change the ground truth is the run history: PR bodies, postmortems, dispatch logs,
transcripts, and the current text of every file that states the rule. If none are
reachable, say so and label the audit "consistency-only" (it can catch
contradictions, not factual wrongness). Every finding in later phases must cite
its ground truth.

**Find the canonical copy and the sync path before anything else.** Ask: where
does this artifact really live, how does it reach the places it is used, and what
overwrites what? (A local copy that an hourly job hard-resets from a repo is not
the place to edit.) Record the answer in the audit output; a fix written to the
wrong copy is a fix that vanishes.

## Phase 1 - One WIDE parallel round (never serial narrow rounds)

- **Enumerate the surfaces** the target touches and list them explicitly in your
  output. For a code change: correctness, integration/blast radius, data
  lifecycle, failure modes, security, test-evidence. For a plan: each subsystem it
  integrates with, plus timing/scheduling, identity/permissions, data lifecycle,
  observability, rollout/rollback. For a process/skill change: ground-truth
  verification of every quoted rule; loop mechanics, cost, and convergence (walk
  every branch of the new rules end to end, count dispatches and rounds, hunt for
  unbounded loops and for formulas that hit zero or go negative at the edges);
  whether the rule would actually have caught the real misses that motivated it
  (map each recorded miss to the exact sentence that catches it; an unmapped miss
  is a finding); failure modes and operations (what runs when the executor
  crashes, hits a rate limit, or is duplicated; where the new state lives across
  restarts); rollout and sync.
- **Always add a duplicates-and-mirrors auditor** (or fold it into ground truth):
  grep the whole corpus for every other statement of each rule, value, or contract
  the target changes - mirrors for other agents, reference templates, README and
  WORKFLOW text, tests that assert the old shape, scripts coupled to it. Every
  untouched occurrence is a finding: two rules in force is the single most common
  defect in rule changes. For code, the same auditor covers other call sites,
  copies, generated files, and fixtures.
- **Always add one coherence auditor** over the whole artifact (contradictions,
  orphaned statements, claims other sections invalidate, terminology drift,
  amendment layering, open questions that the ground truth could answer).
- **Fan out auditors in parallel, one per surface, in a single message.** Scale
  to stakes: 2-3 for small targets, 5-8 for large ones (or self-audit serially
  only when the target is trivial or the user asked for a quick pass).
- **Every auditor's brief must contain:**
  - The target path, the ground-truth locations, and the canonical/sync answer
    from Phase 0.
  - VERIFY-THEN-ATTACK: first verify the target's claims in your surface against
    ground truth (unverified claims are the #1 defect source), then hunt for new
    issues.
  - Both failure directions: **bypass** (the thing silently fails to do its job
    for some real subset of cases) and **breakage** (it damages something that
    already works).
  - A boundary check, derived for THIS target rather than copied from a list.
    For each stateful mechanism the target touches, ask what happens at its
    edges: two actors at once; a stop halfway through a multi-step operation;
    a restart or resume; a value that config, environment, or flags can change;
    a path that reads without the check that guards writes; a formula or limit
    at its minimum and maximum inputs; another copy of the same thing somewhere
    else. Write the resulting items down and answer each as `n/a | ok |
    finding` with a one-line reason. An `n/a` that the target's own file list
    contradicts is a finding.
  - Evidence required per finding: file:line, query result, data sample, or
    citation. No evidence = not a finding.
  - A concrete failure scenario per finding (real inputs → wrong outcome), a
    severity, and a one-line fix.
  - An honest verdict line: "IMPORTANT FINDINGS EXIST" or "NOTHING IMPORTANT
    REMAINS (only nitpicks)", where important = wrong/missing user-facing
    behavior, breaks something existing, ops incident, or invalidates a step.
  - A "verified fine - do not re-open" list, and a separate **OPEN** list for
    claims the auditor could neither confirm nor refute (with what would settle
    each). OPEN is not a finding and not a pass.
  - Do not manufacture findings to look useful; do not rubber-stamp. A clean
    verdict honestly earned is a welcome outcome.
- Prefer quantified checks over opinions: when a claim is countable (coverage %,
  volume, staleness, dispatches per run), count it from the data. When the target
  is a rule change, replay the recorded runs that motivated it under the new rules
  and report what would have changed, at what cost.

## Phase 2 - Fix and VERIFY in the same round

- **Consolidate into one findings file with stable IDs** (H1.., M1.., L1..),
  deduped across auditors, ranked by severity, with the verified-fine and OPEN
  lists carried along. This file is the handoff to the fix agent and the
  checklist for Phase 3; without IDs, verification re-litigates instead of
  checking.
- **Every fix must itself be verified against ground truth before it's written
  down.** In the origin session ~a third of later findings were bugs in earlier
  unverified fixes (a dedupe key that suppressed a required send; a retention
  rule that deleted opt-outs). A fix written as confident prose is just the next
  round's finding. If you can't verify a fix cheaply, mark it OPEN, don't dress
  it as settled.
- **For a rule change, every fix is an edit, not prose.** Each edit names the
  file, quotes the current text verbatim with file:line (preserving quotes and
  line wraps so a paste-replace is unambiguous and unique), and gives the new
  text as final wording. A failure behavior or compliance field that exists only
  as a sentence in the spec, with no edit that lands it, is unresolved.
- **Resolve every open question the ground truth can answer.** An open question
  that a file settles is a finding against the spec, not a question.
- **Rewrite the artifact clean.** Never stack amendment/override layers - layers
  breed contradictions and force future auditors to do archaeology. The output
  of Phase 2 is a single coherent updated artifact plus a changelog mapping every
  finding ID to what changed (or why not).

## Phase 3 - Exit check (one verification round)

- Run a second, smaller parallel round: each auditor takes the findings file and
  the changelog, verifies each fix in its surface against ground truth (not
  against the changelog's claim), re-runs the duplicates-and-mirrors grep on the
  rewritten artifact, then makes a limited fresh attack.
- **Convergence guards:**
  - When findings shift from design-level to mechanism-level (things a builder
    with tests, a dry-run, or a shadow mode would hit in the first hour), STOP
    paper-auditing and say so: recommend the empirical verifier (tests, shadow
    mode, staging, a pilot, or for a rule change: one instrumented run) as the
    next auditor. Paper review has diminishing returns; reality is the better
    critic for mechanisms.
  - Soft cap: 3 rounds. Not converged by round 3 = the target needs
    restructuring or a real spec rewrite, not more auditing. Say that plainly
    instead of scheduling round 4.
  - The cap never overrides honesty: if round 2 found important issues, fix them
    (verified) and run round 3. Convergence is achieved by the process, not by
    declaring victory.

## Reporting (every round)

- Lead with the verdict and what changed since last round, with counts (findings
  by severity, resolved, still open).
- Ranked findings: title, severity, evidence, failure scenario, fix.
- A "verified fine - do not re-open" list, so later rounds don't re-litigate, and
  the OPEN list with what would settle each item.
- Where the clean artifact, the findings file, and the changelog live.
- Plain language for the reader; no jargon walls; explain what each finding
  means in consequences ("customers would get X wrongly"), not just mechanics.
- Close with the recommended next verifier (another round, tests, shadow mode, an
  instrumented run, or "ship it") and, for a rule change, the exact rollout path
  from Phase 0 (which repo, which branch, what syncs it, when in-flight runs pick
  it up).
