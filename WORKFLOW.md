# The workflow

A dual-harness development workflow. Claude Code is the orchestrating
harness: Fable makes the judgment calls and dispatches sub-agents; Codex
(GPT-5.6) runs the engineering-heavy roles.

The whole system at a glance:

![Orchestra workflow map](docs/workflow-map.png)

_Source: [docs/workflow-map.excalidraw](docs/workflow-map.excalidraw)_

The flow separates *clarity*, *capture*, and *execution*:

1. **`/discussion`** — clarify, understand, figure out. General-purpose: it
   dispatches the code-researcher / `web-researcher` for questions and the
   investigator (with `frontend-verifier` for reproduction) when the topic is a
   defect. It produces clarity plus a dated decision log
   (`./tmp/discussions/`) that the `/create-*` drafting step reads — never
   deliverables.
2. **`/create-plan` · `/create-epic`** — capture skills invoked by the user or
   by the model when a conversation converges. Each turns what the conversation
   established into a lean work item at `./tmp/<id>/item.md` (Feature Ticket, Epic Spec, or Bug
   Report, raw sources in `./tmp/<id>/refs/`) with verification criteria,
   then **publishes** it wherever the project's `AGENTS.md` `Work-item
   tracking` section says (GitHub issues, Linear, anything the repo
   documents; the local `./tmp/<id>/` copy is the working truth). A repo
   with no publishing instructions stays local-only — the item lives in
   `./tmp/<id>/` and the skill says so. `/create-plan` runs the
   investigator itself if the root cause isn't already established. Before
   publish, every draft passes the **Socratic gate**: the `socrates`
   sub-agent takes an adversarial position on the item's premise (needed at
   all? root cause or symptom? simpler path? right shape? the whole of it?)
   and the user's answers — distilled into the item's `## Justification`
   section — travel with the published item. Intensity scales with the item:
   straightforward drafts fast-pass with 0–2 questions; epics always get the
   full challenge.
3. **`/do <item ref or path>`** — the autonomous pipeline: pull the work
   item's artifacts into `./tmp/<id>/` (fetched per the project
   `AGENTS.md`'s `Work-item tracking` instructions — e.g. harvested from a
   GitHub issue's artifact comments — or read from `./tmp/<id>/` when the
   repo configures no tracker) →
   zone-derived dials (`references/zones.md`) → plan + review loop (full lane backed by
   a research dossier, every plan under the evidence contract) → implement →
   verify → build gate + deploy-notes scan + PR → post-PR review loop + QA
   pass over the PR's manual tests → wrap-up, with the wrap-up posted as a
   PR comment at the end. Deliberately high-level:
   the Overseer applies the item's zone (escalating one notch at most), how much research a plan needs, and when
   each review loop has converged.
4. **`/prepare-pull-request`** — the exit ramp for ad-hoc changes made in a
   session *outside* `/do` (which handles its own PR prep). It retrofits
   the pipeline's gates before anything goes up: the Overseer materializes
   an `intent.md` + diff under `./tmp/pr-<branch>/`, Socrates challenges
   the approach in PR mode (sunk cost is not a defense; diff-vs-intent
   fidelity joins the attack lines), both code reviewers gate correctness
   (union Must-Fix, cap 3 passes), then build gate → commit → PR in the
   repo's documented format.
5. **`/postmortem`** — when a result falls short, root-cause it in *our
   system* (skill/agent/template), not just the code.

## Model routing

This table is the single source of truth for model routing — the guides and
skills point here; update it first when routing changes, and update `/do`'s
**Sub-agents** paragraph in the same commit: this file is not synced to
consumer repos, so the skills' restatement is what actually executes.

| Role | Runs on | Notes |
| --- | --- | --- |
| Overseer (conducts `/do`, all judgment) | main session — Fable | |
| Web research | Claude `web-researcher` — Sonnet | |
| App-driving QA (one run, post-PR: UI ACs + Manual tests, journey captures) | Claude `frontend-verifier` — Sonnet | also reproduces failures for /discussion & /create-plan |
| Verify backend (tests/scripts) | **Codex** GPT-5.6 `low` | |
| Explore codebase | **Codex** GPT-5.6 `low` | Claude `code-researcher` (Sonnet) as backup |
| Reproduce & root-cause | **Codex** GPT-5.6 `low` | |
| Write the diff — all surfaces, one dispatch per vertical slice | **Codex** GPT-5.6 `medium` | fix rounds resume the same session; repo statically green after every dispatch |
| Challenge the draft work item (Socratic gate) | Claude `socrates` — Fable | always invoked by both `/create-*` skills; self-calibrates — fast-passes straightforward drafts, full challenge for epics/unargued items |
| Review the plan | **two parallel reviewers** (zone 3: Codex alone): Codex GPT-5.6 `low` + Claude `plan-reviewer` (Opus) | Must-Fix gate = union of both |
| Review the diff + security | **two parallel reviewers** (zone 3: Codex alone): Codex GPT-5.6 `low` + Claude `code-reviewer` (Opus) | Must-Fix gate = union of both |

Every Codex role is dispatched by the **`codex` skill**
(`claude/skills/codex/`), the one place that knows the `codex exec`
mechanics per role — model, effort, session mode (`--yolo` for every role;
reviewers/researchers ephemeral and no-edit by charter; implementer
persistent with `resume --last` across fix rounds), output capture, and
status-line parsing.

Review loops exit when **no Must Fix remains from either reviewer** — a
Codex report tiered P0–P3 maps rather than reformats (P0/P1 ≡ Must Fix,
P2 ≡ Should Fix, P3 ≡ Nice to Have). Caps are ceilings, never quotas: a
zero-Must-Fix pass ends the loop even with Should Fixes open (the Overseer
applies those at its discretion, no re-review), and the only other trigger
for an extra pass is the two lanes sharply diverging. When reviewers disagree,
the Overseer adjudicates directly, using sub-agents to understand what is true
when needed. The Overseer flags anything left unresolved at a cap in the
wrap-up. Codex efforts are defaults — `medium` for the
implementer, `low` for every other role; the dispatcher may raise a
reviewer to `medium` or `high` rarely, when the zone warrants it (zone 0
or an epic), with the reason stated in the dispatch — never above `high`. `/do` and
`/prepare-pull-request` are user-invoked only (`disable-model-invocation`). The two
`/create-*` capture skills are model-invocable at convergence, with publish still gated by
their alignment pause.

## Where formats live (single copy each — no duplicates to drift)

- **`references/`** (synced to `.references/` in each consumer repo —
  harness-neutral) — anything referenced by more than
  one skill, or by any agent: the shared blocks (`verification-criteria.md`,
  `verification-methods.md`, `rubrics/` — per-surface verification rubrics,
  `code-quality.md` — the reviewers' house-rules rubric, `qa-verification.md`
  — the QA pass's external-evidence discipline, `system-analysis.md`,
  `publish-work-item.md`, `draft-work-item.md`,
  `socratic-gate.md`) and every agent's output format
  (`references/agents/<agent>/…`). Agents are flat `.md` files by design
  (Claude Code has no agent-folder format), so each agent's body carries a
  pointer — "Read `.references/agents/<name>/<format>.md`" — plus a few
  non-negotiable lines as a safety net if the file is missing.
- **`claude/skills/<name>/references/`** — document formats produced by
  exactly one skill (feature-ticket, epic-spec, bug-report,
  implementation-plan, wrap-up-report, postmortem).

The six workflow skills above, plus two infrastructure skills the others
invoke — `codex` (dispatches Codex roles) and `excalidraw-pr-diagrams` (the
PR visual-overview standard `/do`'s PR step uses) — are the whole surface. Web research is the
`web-researcher` sub-agent, review lives inside `/do` (plan review before
implement, code review + QA after the PR opens), and all commit/PR prep
lives in `/do`'s PR step.

## Keeping in sync

See [README.md](README.md): skills are edited only in this repo and mirrored
one-way into each consumer repo by that repo's `update-skills` script
(`pnpm update-skills` in bloomapi/bloom-mono), which wraps `scripts/sync.sh`.
The old per-machine rsync to `~/.claude`, `~/.codex`, and `~/.references` is
retired.
