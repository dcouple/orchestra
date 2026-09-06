## Step 1: Plan

Read the item's `zone:` and derive this run's dials from the table in
`.references/zones.md` - record zone and effective dials in `plan.md`'s
frontmatter. Zones 0–1 run the full lane (dossier, cap 3); zones 2–3 run
light (no dossier, cap 1). Zone 0 defaults to dual review; zones 1–3 default
to the single Codex lane. An explicit `review_lanes: dual | single` in the item metadata
outranks the zone's lane dial, and an explicit
`frontend_verifier: true | false` outranks the zone's verifier dial - both
are the human's settings, made at capture or edited later as item metadata
on the tracker (Step 0's pull picks up tracker edits); record
`frontend_verifier` and `ios_testing` (`optional` when absent) in `plan.md`'s frontmatter alongside the lanes. You may escalate the effective zone one notch toward 0 with the
reason recorded in `plan.md`'s frontmatter; never de-escalate - that's the
human's call at capture, or the table's via postmortem evidence. Item
missing a zone → classify it yourself from stakes and downstream
consequences, record the reasoning in the frontmatter, and proceed.
Multi-phase items (two or more entries in the metadata's `phases` list) keep
full machinery and cap 3 while their lanes follow the same zone rule.

If the daemon's prompt contains a runtime-fallback context line, record
`requested_lanes`, `effective_lanes`, `runtime_fallback`, and `fallback_cause`
in `plan.md` frontmatter. Regardless of a dual request, the effective review
topology for the rest of that run is single/Codex-only.

Full lane: dispatch the `codex` skill, role `code-researcher`, to map the
territory the plan builds on - critical codebase anchors, patterns to
reuse, load-bearing gotchas, exact `file:line` evidence for every claim.
When the item leans on an external library, framework, or API the repo
alone can't answer, dispatch the `web-researcher` sub-agent in parallel -
its cited findings (URL + why + the critical insight) go into the dossier
too. Save the combined findings as `./tmp/<id>/refs/research-dossier.md` -
the researchers report in-conversation; you persist the dossier.
Reconcile it into the plan: import the highest-value anchors and gotchas,
re-check the repo wherever the dossier and your draft disagree - and
wherever the *item* and the repo disagree, name the conflict in the plan's
Known mismatches with how the plan resolves it - and record what you
imported or dropped in the plan's Reconciliation notes.

Research beyond that as the item actually needs - you judge. A change
touching an environment listed in `.references/known-issues/` (e.g.
Windows-runner CI) reads the matching page at plan time and carries it
into the implementer dispatch. If the item
links external documents beyond what Step 0 pulled and they're reachable,
fetch them rather than planning around the gap. Then write
`./tmp/<id>/plan.md` following this skill's `references/implementation-plan.md` -
its evidence contract is binding: facts live in Verified repo truths with
`path:line` evidence from files opened this session, and proposals stay out
of fact sections. Write Goal & invariants from the item's intent; reconcile
dossier gotchas into Known gotchas and web-researcher citations into
External references. When genuinely uncertain about a requirement or design
detail, never decide by silent assumption - name it in the plan's Open
questions and proceed on the least-committal reading. Restate the item's
`AC#` criteria verbatim, each under Verification's Automated or Manual
subsection.

Resolve design alternatives from the item's constraints and repository evidence.
Use an available `arena` skill only when independent candidates would resolve
material uncertainty and its cost is warranted. Record the decision in the
plan; missing optional skills do not block planning.

Then run the review
loop - this run's effective review lanes per the dials above (zone 0:
Codex + Claude in parallel; zones 1–3: Codex alone; `review_lanes:` override
honored in either direction, including on a multi-phase item) - findings
fixed into the plan - until you're satisfied. A dual-lane pass dispatches
both lanes in a single message - the Claude reviewer via the Agent tool,
the Codex reviewer as a detached dispatch per the codex skill - then awaits
the Agent-tool sub-agent within the turn and picks up the Codex report from its
marker; running one lane to completion before
starting the other serializes the pass and doubles its wall-clock.
When the reviewers disagree, adjudicate it yourself. Use sub-agents to help
you understand what is true when needed.
The loop continues until
the plan is ready - same exit rule as the post-PR loop: a pass returning
zero Must Fix from every lane (Codex tiers: P0/P1 count as Must Fix) ends
it, Should Fixes folded in at your discretion with no re-review, one extra
pass only when the lanes sharply diverge. Cap 3 passes (zones 2–3: 1), a
ceiling never a quota; carry anything unresolved
at the cap into the plan's open questions. Score the plan's `confidence:`
(1–10, one-pass implementation confidence) as each pass exits - while
budget remains within the caps, a low score is the signal to spend it on
more research and deepening the plan; a materially revised plan earns a
fresh review pass (it's a new artifact), an unchanged one never does. The
score recorded after the last pass is final.
Never a reason to stop the run.

A plan that pins a dependency the repo's install gates will refuse without
human approval (a release-age allowlist, a license gate) surfaces that
approval request in a notify at plan-exit - never as a blocking gate the
implement wave discovers.

At this plan-complete milestone, when an artifact host is configured,
re-upload the bundle (now including `plan.md`) using the artifact-host
step in `.references/publish-work-item.md`.
