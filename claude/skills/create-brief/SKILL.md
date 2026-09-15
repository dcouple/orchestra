---
name: create-brief
description: Capture agreed, buildable work as a feature or bug brief ready for /do. Use after discussion converges and no work item already exists.
argument-hint: "[title or one-line summary]"
---

# Create brief

Turn `$ARGUMENTS` and the established discussion into `./tmp/<id>/brief.html`.
This is the user's decision document; `/do` derives its implementation plan
later. Capture settled decisions without reopening them. Do not fix code.

Read `.references/html-brief.md` for the page contract and
`.references/artifact-storage.md` for shared artifacts. Pass the task folder
ID/storage rule to each agent; retain the required local files and bundle.

Intent has provenance, but the initial request is an origin record, not a
binding contract. Use `.references/pr-writing.md` while assembling either
track so the brief distinguishes the origin from the current accepted outcome,
scope, and approach, and preserves the decision trail for each revision and
its reason. Discussion, evidence, the existing Socratic gate, and required
user alignment may forge, refine, or reject the initial idea; reflect that
result in the brief. Keep `Rationale not established` distinct from an
`[assumption]`; never silently invent or redefine the current intent.

## 1. Choose the track

- **Feature**: a change, addition, refactor, or chore.
- **Bug**: behavior that should work but does not.

Use one brief with at least one phase. Split into phases only when the
verification surfaces or sequential outcomes warrant it, not by file count.

## 2. Establish the work

### Feature

Carry forward:

- Intent and observable desired end state.
- Locked directions (`D1`, `D2`, …): decisions the implementer must not remake.
- Out of scope.
- Dependencies and mechanics, including an explicit schema delta (`none` if none).

Follow the dependency contract in `.references/html-brief.md`: use the Codex
`code-researcher` for code facts and `web-researcher` for external facts. Each
load-bearing dependency ends **verified** or **assumed with the user's
conscious acceptance**. Research missing facts; ask for missing preferences.

When replacing behavior, agree on and lock the compatibility stance:
clean replacement, or preservation of existing consumers. Do not infer an
intentional breaking change from silence.

### Bug

- Reuse an existing investigation: repro, root cause, evidence, and confidence.
- If the cause is unknown, dispatch the Codex `investigator` with expected
  versus actual behavior, environment, repro steps, and traces. If reproduction
  requires the app, run `frontend-verifier` first and pass its transcript along.
- If reproduction fails, record attempts and uncertainty. Gather missing
  evidence or label the cause `Hypothesis:`; never invent confirmation.
- Agree on severity (`critical | high | medium | low`), affected users, impact,
  and whether the resolution direction is locked. Include dependencies and
  schema delta even when the latter is `none`.

### Align the dials

Read `.references/zones.md` and confirm the user's choices:

- `zone: 0–3`, based on stakes and consequence radius, not diff size.
  Escalator surfaces require zone ≤ 1 unless the user explicitly overrides.
- `review_lanes: dual | single`; default dual at zone 0, single at zones 1–3.
- `frontend_verifier: true | false`, the user's choice even with UI criteria.
- `ios_testing: required | optional`; propose required for guaranteed mobile
  UI verification. Never pair required with `frontend_verifier: false`.

Zone 0–1 or multi-phase work gets an interview until important decisions and
dependency assumptions are accepted. Zone 2–3 single-phase work gets one
focused clarification round. Do not ask questions already answered by the
conversation or evidence. No unresolved `[NEEDS CLARIFICATION]` marker may
remain when the brief becomes ready.

## 3. Shape the approach

- Write the Approach at decision altitude, not as a file-by-file plan.
- Agree on each phase's goal, scope, verification surface, and order.
- Multi-phase work runs sequentially in one PR. An independent outcome that
  can ship or wait separately belongs in the Sequencing panel as another item.

## 4. Draft and align in the browser

- Read the matching dated decision log in `./tmp/discussions/` or the task's
  shared artifacts. Carry its decisions into the current accepted intent and
  locked directions; preserve the origin, revision trail, source labels, and
  rationale status per `.references/pr-writing.md`. Link longer records from `refs/`.
- Choose a short kebab-case `<id>` and author `brief.html` per
  `.references/html-brief.md`. Keep research, raw traces, and longer exchanges
  under `refs/`, linked rather than pasted into the page.
- Use `.references/system-analysis.md` for a current-state deep dive worth
  keeping as `refs/system-analysis.md`.
- Number every acceptance criterion and map it to observable verification.
  For bugs, AC1 is the rerunnable repro changing from fail to pass, followed
  by prevention criteria. Each phase has its own criteria.
- Open the brief in the user's browser and fold corrections into the same
  page. Confirm intent, directions, scope, dials, phases, and dependency standing.

### User-facing work

Do the first-pass mockup and app reconnaissance concurrently:

1. Inspect the project's real tokens, control styles, and copy directly.
   Draw section 08 from those values using the template's `.mock` parts;
   caption it `first pass - real captures pending`.
2. Dispatch `frontend-verifier` in the background to capture touched screens
   and the app shell under `refs/shots/`. Continue authoring and alignment.
   Upgrade the mockups when evidence returns; re-upload an already-published
   bundle after the update.

Flows or changes spanning more than about two screens also get a clickable
prototype in `mockups/`, with shared styling and error/blocked states. Serve
it over `127.0.0.1` when a browser driver cannot use `file://`.
Zone 0 must receive the real-capture upgrade before becoming ready.

## 5. Socratic gate

Run `.references/socratic-gate.md`, with the emphasis appropriate to the item:

- **Feature**: necessity, alternatives, scope, and assumed dependencies.
- **Bug**: cause versus symptom, evidence, prevention of the defect class,
  sibling instances, and implied follow-up work.
- **Multi-phase**: whether the phases belong together and are shaped correctly.

Recut phases if the dialogue changes the approach. Re-investigate if it
reveals a deeper possible cause. Record the justification and any explicit
waiver; unresolved readiness questions still block `status: ready`.

## 6. Publish and hand off

- Follow `.references/publish-work-item.md` and
  `.references/artifact-host-upload.md`; use `feat: <title>` or `fix: <title>`.
- Mark the aligned brief ready. A bug may stay draft when the cause remains
  a hypothesis and the user wants more evidence; publish its draft honestly.
- With a configured artifact host, publish the bundle and lean tracker body.
  Without one, use the documented Markdown transport. With no tracker, retain
  the complete artifact and say it was not published to a tracker.
- Verify cross-links and shared saves before reporting their locations.

Offer `/do <item ref or ./tmp/<id>/brief.html>` to execute, or `/discussion`
when an unresolved decision needs more thought.
