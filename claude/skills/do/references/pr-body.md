# PR Body — format

> Produced by `/do` (Step 4) once the work verifies, then kept live through
> Step 5. The PR body is the **live dashboard** the returning human reads
> first — not a changelog. Two readers must both be served in one document:
> the **reviewer** ("is this correct and safe to merge?") and the
> **returning human / PM** ("what does the user experience now, and what do I
> still need to test?").
>
> Division of labor, load-bearing: the **body carries STATE** — the current
> picture, checkboxes flipped as work lands; **PR comments carry PROOF** — QA
> evidence, screenshots, logs. Never paste raw evidence dumps into the body;
> never let state live only in a comment. A checkbox in the body says *what is
> true now*; the comment it points to says *how we know*.
>
> Pre-open check (cheap mechanical catches): every image URL resolves (a PR
> with a 404 diagram is a failed handoff); the rendered markdown doesn't
> collapse headings/bullets/image into one paragraph (preview it); every AC
> has a Verification line; every Manual test traces to a change that motivated
> it; the closing keyword is present. Grep the draft for `path/to/`, `TBD`,
> `<placeholder>`, and empty sections.

---

## The shape

A PR body is these sections, in this order. Omit a section only where noted;
never reorder (the reviewer scans top-down and expects this spine).

1. **Title** — typed, imperative.
2. **Summary — What / Why / How** — the change, the problem, the approach.
3. **Visual overview** — the before → after diagram + before/after screenshots.
4. **User journeys** — the experience (journey map) + the branches (flow map).
5. **Verification** — evidence per acceptance criterion.
6. **Manual tests** — risk-tiered checkboxes, the human-runnable flows.
7. **QA results** — what the QA pass executed and found (proof in a comment).
8. **Deploy notes** — what the human does before/at deploy (omit if none).
9. **Residual risks** — known-and-accepted (omit if none).
10. **Metadata & closing** — labels per the repo's convention; `Closes #<n>`.

Scale to the change: a one-file linear fix needs a Summary, a one-line
Verification, a short Manual tests list, and a closing keyword — sections 3, 4
(flow map half), 7, 8, 9 collapse to a line or drop out. A routed,
multi-cohort, schema-touching change needs all ten in full. Right-size; don't
pad a small PR to the template, and don't starve a big one.

---

## Section-by-section

### Title
`type: short imperative summary`. Type prefix per the repo's convention
(`feat` / `fix` / `refactor` / …). Names the outcome, not the diff.

### Summary — What / Why / How
Three moves, tight:
- **What** — the change in one or two sentences.
- **Why** — the problem or goal it attacks. Quantify when you can (the metric
  it moves, the failure it removes) — this is what the PM reads.
- **How** — the approach at a structural altitude (subsystems touched, the
  key invariant, phase list for an epic). Not a file tour.

End with a **`Done means:`** line — the concrete, checkable definition of done
for *this* PR, tied to the item's intent. It's the contract the rest of the
body proves.

### Visual overview
Include when the change is flow-, boundary-, or lifecycle-shaped and the
`excalidraw-pr-diagrams` skill is available. Lead with the **rendered
before → after diagram** per that skill's PR standard — it teaches the change
a reviewer hasn't learned yet.

- **When the flow branches**, the diagram contrasts the **old path against the
  new fork tree, with the after emphasized** (bolder strokes / fuller color /
  larger), so the reviewer sees the *shape change*, not just the endpoints.
  This diagram is the visual of the User-journeys flow map below — one image
  serves both.
- Follow the diagram with **before/after screenshots** of the actual behavior
  when the change is user-visible — *before* from the item's refs or the
  reproduction evidence, *after* from the verify captures.
- All images are **hosted-image URLs** (or the repo's committed-asset
  convention where one exists), never a broken relative path. Keep the
  `.excalidraw` source in `./tmp/<id>/refs/`.

### User journeys
Two lenses — a branching change needs **both**; a linear change needs only the
first, as a sentence.

- **Journey map (the experience — depth).** Narrate the 1–3 highest-value
  end-to-end paths from the *user's* point of view: entry → what they see and
  do at each step → the outcome. This answers "what is it actually like to use
  this now?" — the PM's question. Keep it experiential, not architectural.

  > **Primary journey — new user, paid intent:** lands on the offer → starts
  > the trial → picks a number → accepts the agreement → sends their first
  > message from inside the product. No dead-end, no download wall.

- **Flow map (the branches — breadth).** Only when the flow forks (multiple
  entry cohorts, decision points, routed continuations). A flat list hides the
  flow's shape and its coverage holes, so draw:
  - a **decision-tree** of the branches, each fork anchored to its routing
    `file:line`;
  - a **journey-coverage table** — every distinct end-to-end journey (give
    each a stable `J#` id), its risk tier, and the Manual-test item that
    exercises it;
  - **honest gap flags** — branches nothing covers, called out as gaps rather
    than omitted.

  Then **cross-tag the Manual tests** with those `J#` ids so the mapping is
  bidirectional. The journey map tells the reviewer what the golden path feels
  like; the flow map proves no branch was forgotten.

### Verification
One line per acceptance criterion, each with the evidence that it holds — what
was run or driven and the result, quoted or pointed at. Restate the AC id
(`AC1`, `AC2`…) so a reviewer can check them off against the item. Automated
proof (tests, logs) lives here; live/visual proof can point to the QA comment.
Where a criterion wasn't verified, **say so explicitly — "not verified" is
stated, never implied by omission** — and where the run has gates (review
passes, build, a Socrates verdict), fold their outcomes in so the reviewer
sees what cleared the change.

### Manual tests
The human-runnable flows derived from the ACs, as **checkboxes**, risk-tiered:
- **Must** — breaks data / auth / money if wrong.
- **Important** — user-facing behavior.
- **Nice** — cosmetic.

Rules: each item traces to a change that motivated it; 10–20 items total;
tag each with its journey `J#` when the Visual overview has a flow map; end
with an **"Areas not affected"** line so safe surfaces are skippable. This
checklist is also the QA dashboard — Step 5 flips `[ ]` → `[x]` as items pass
and appends `— left to human: <reason>` on the ones it can't drive.

```
**Must (breaks money/auth/data if wrong):**
- [ ] [J1] <flow> → <observable outcome that proves the invariant>
**Important (user-facing behavior):**
- [ ] [J7] <flow> → <observable outcome>
**Nice (cosmetic):**
- [ ] <flow> → <observable outcome>

Areas not affected: <surfaces the reviewer can skip>.
```

### QA results
The QA/verify pass **maintains this section and the Manual-tests checkboxes in
the body** — the body is the system of record; a comment is never the sole
place a result lands when the body has a checklist and a QA-results line to
update. Reported at two altitudes:
- **In the body** — a short summary line: how many Manual-test items were
  executed vs left to the human, and the headline result (incl. any bug the
  QA pass found and its fix). The ticked checkboxes above are the live
  dashboard; this line narrates them.
- **In a PR comment** — the **proof**: each executed item with its quoted
  output or hosted screenshot URL. The body points at this comment; the
  evidence never bloats the body.

Omit the section only when there was genuinely nothing human-runnable to QA.

### Deploy notes
Every finding from the deploy-notes scan (schema/migrations, env vars/secrets,
infra/CI, new dependencies, one-time scripts/backfills): **what changed** and
**the action the human takes before/at deploy**, ordered "must happen before
the code ships" first.

Carry the **concrete artifact, not a command to run**: paste the actual
migration/DDL SQL the deployer will apply (wrapped in a transaction where the
engine supports it), name env vars and secrets by name (never their values),
name the exact dashboard toggle. A deployer should not have to run a tool to
learn what is about to change. For schema changes, put **only additive DDL
(CREATE / ADD)** in the run-this block and **flag any destructive DDL (DROP,
type-changing ALTER) separately for explicit human confirmation** rather than
pasting it as routine.

**Split every finding by environment and state what the run already did.** A
green-tier reversible change on a non-production environment (additive/nullable
staging DDL, a test-mode toggle) is **applied by the run** — mark it
`staging: ✅ applied`; its production counterpart is the human's
`production: ⛔ run at deploy` with the exact SQL/command. Never write one
blended "DDL — not applied to any DB" line: it hides both the green action the
run should have taken and the precise red action the human owns. And flag any
finding that **blocks verification** (a column the tests read, a key the QA
pass needs) as a **prerequisite**, not merely a deploy-time note — a prereq the
run left unmet is why a "green" PR fails the moment someone tests it.

**Omit the whole section when the scan finds nothing** — an empty Deploy notes
reads as "nothing to do," which is a lie if you skipped the scan.

### Residual risks
Known limitations shipping *by choice* — narrowed-but-not-closed windows,
seams tested instead of end-to-end, follow-ups deferred. One line each, honest.
**Omit if none** — don't manufacture risk to fill the section.

### Metadata & closing
Apply the repo's issue/PR metadata convention (type + area labels, milestone
where the repo requires it — read the repo's issues-and-PRs doc; it is not
this file's job to define them). Link the tracker with its closing keyword so
the item auto-closes and the cross-reference survives — `Closes #<n>` for a
GitHub issue.

---

## Pre-open checklist

Run before opening, and again after any body edit in Step 5:

- [ ] Sections present in order; small-PR omissions are deliberate, not lazy.
- [ ] `Done means:` line is concrete and checkable.
- [ ] Every image URL resolves (open it) — no 404, no broken relative path.
- [ ] Rendered markdown previewed — nothing collapsed into one paragraph.
- [ ] Branching flow ⇒ both journey lenses present; flow map's `J#` ids
      cross-tagged into Manual tests; gaps flagged, not hidden.
- [ ] Every AC has a Verification line; every Manual test traces to a change.
- [ ] Build / typecheck / lint gate passed before opening (Step 4's gate).
- [ ] Deploy notes: scan actually run; section present iff findings exist;
      migrations pasted as concrete SQL (additive in the run block, destructive
      flagged), not a command to run; each finding split by environment —
      green staging half applied in-run (`✅ applied`), red production half
      handed off (`⛔ run at deploy`); verification-blocking findings marked as
      prerequisites.
- [ ] No secret values anywhere in the body or a comment.
- [ ] Closing keyword present and correct.
