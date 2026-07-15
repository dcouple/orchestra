---
name: sentry-loop
description: On-demand Sentry triage loop — sweep every project's errors over a time window, classify each issue (new / recurring / regressed, user-impacting / zero-user, real / noise), root-cause only the clusters that matter, file findings into the work tracker under the loop's label, and annotate Sentry so the state sticks. Use when the user asks to run the sentry loop, triage Sentry, "what's new in Sentry", or wants a period's errors root-caused. Report-only — fixes go through /create-plan then /do.
argument-hint: "[time window, default 7d]"
---

# Sentry Loop

## Window: $ARGUMENTS (default: 7d)

Triage-then-investigate over the error tracker. The output is knowledge, not
fixes: every issue in the window ends the run classified, the few that matter
end it root-caused, and the findings live in the work tracker — separably from
human-authored work items.

## Configuration

Read the current repo's `AGENTS.md` before filing anything:

- **Tracker + label**: the `Work-item tracking` section names the tracker and
  the label/team that marks loop-generated issues (default label:
  `sentry-loop`). Create the label on first use if it doesn't exist.
- **Sentry access**: use the Sentry MCP (`find_organizations` once, then
  `search_issues` / `search_events` / `get_sentry_resource`). If the repo has
  a `docs/mcp-sentry.md`, follow it.

No tracker configured → produce the report locally under `./tmp/` and stop
before the filing stage.

## Stage 1 — Sweep

1. Establish the window: `$ARGUMENTS` if given, else 7d. Then find the
   standing loop-report issue (search by the loop label); if its latest run
   comment is newer than the window start, narrow the window to "since last
   run" and note that in this run's comment.
2. Pull the volume shape: `search_events` grouped by project
   (`count()`, `count_unique(issue)`) for the window.
3. Pull the issue list: `search_issues` per project, sorted by `new`, for the
   window — capture id, title, culprit, first/last seen, event count, user
   count, status.

## Stage 2 — Classify

Tag every issue with one value per axis. This table IS the deliverable for
most issues — classification is cheap, so nothing is skipped.

- **Age**: `new` (first seen in window) / `recurring` / `regressed`
  (previously resolved, seen again).
- **Impact**: `user-impacting` (users > 0) / `zero-user`.
- **Nature**: `real` (a defect in our code) / `env-noise` (dev/staging
  pollution, infra flakes, third-party outages) / `external` (browser
  extensions, network, user-device).
- **Cluster**: issues sharing one probable root cause (same command, culprit,
  error string, or release boundary) get one cluster id — a burst of distinct
  Sentry issues is often one incident. Check event `extra` data
  (`get_sentry_resource`) when titles are generic; the real error string
  usually lives there.

## Stage 3 — Investigate (only what earns it)

Deep-dive a cluster only if it is **new AND (user-impacting OR clearly a
defect)**. Everything else stays at classification depth.

Per cluster, hypothesis-first:

1. Read the fullest event (`get_sentry_resource`): stack, tags (release!),
   and `extra` data.
2. Form 2–3 ranked hypotheses before reading code.
3. Trace the stack into the codebase; check `git log` / `git log -S` around
   the release tag and first-seen date — most new issues correlate with a
   recent change.
4. Conclude with: root cause, confidence, file:line references, introducing
   change if found, affected users/orgs, and what a fix needs (not the fix).

Independent clusters may be investigated in parallel — dispatch one
investigator sub-agent per cluster (the Codex `investigator` role via the
codex skill, or an equivalent read-only agent), each fed the cluster's Sentry
ids and the classification context; the orchestrator keeps the table and
merges reports.

## Stage 4 — File

All loop-generated tracker items carry the loop label. Before creating
anything, search the tracker for open loop-labeled issues covering the same
fix or the same recurring noise — update those instead of duplicating.

**The unit of filing is one PR, not one incident.** Every issue the loop
creates must be closable by a single PR; its title is the change, imperative
("Guard team deletion when a phone number is assigned"), not the symptom.

1. **One issue per fix.** If a root cause needs two changes (a revert now and
   a redo later; a backend guard and a separate UI affordance), that is two
   issues, cross-linked, each independently shippable. Never start the fix.

   **The body is the investigation, not just its verdict.** A reader must be
   able to follow the journey from Sentry to conclusion without re-deriving
   it. Required sections, in order:
   - **Sentry evidence** — what the event(s) actually showed: error string,
     `extra` data, decisive tags (release, counts, first/last seen, users),
     linked issue(s).
   - **Hypotheses** — the ranked candidates formed before reading code.
   - **Trace** — the path walked (file:line) and what confirmed the winner;
     the introducing change if found.
   - **Ruled out** — each discarded hypothesis with the evidence that killed
     it. An issue with nothing ruled out is a smell (Stage 3 wasn't
     hypothesis-first).
   - **Root cause + confidence** — one sentence, and why that confidence.
   - **Fix shape** — acceptance criteria and the suggested entry point
     (`/create-plan <id>` or straight `/do` for trivial ones).
2. **Hygiene findings follow the same rule** — each fixable noise source
   (a dev cron writing to prod Sentry, a dead task type still queued) is its
   own small PR-sized issue. Noise that isn't ours to fix (third-party,
   browser extensions) does NOT become an issue; it's recorded in the run
   report and ignored in Sentry with a reason.
3. **One standing loop-report issue** (create on first run, then reuse): each
   run appends a comment with the window, volume shape, the full
   classification table, links to the issues filed above, and what was left
   un-investigated and why. The latest comment is the next run's "since"
   marker. Runs never create per-run report issues — the tracker holds work,
   not logs.

## Stage 5 — Annotate Sentry

Make the triage stick in Sentry so next run's sweep is smaller:

- Root-caused and a fix is **already deployed** → `resolved` with a reason
  comment linking the fix and tracker issue.
- Root-caused but **not fixed** → leave unresolved; comment the root cause
  and tracker issue link.
- `env-noise` / `external` → `ignored` (untilEscalating) with a reason
  comment.

Never resolve an issue whose fix has not shipped — it will re-alert as a
regression and poison the age axis.

## Boundaries

- Report-only: no code changes, no fixes, no config edits. Fixes go through
  `/create-plan` → `/do`.
- Don't investigate recurring known issues past confirming their tracker item
  still reflects reality.
- If the window's volume is an order of magnitude above the norm, stop
  classifying individual issues, say so, and triage the spike itself first.
