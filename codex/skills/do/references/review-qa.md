## Step 5: Post-PR review + QA

Reviews run against the open PR and fixes land on it - self-correction
happens on the artifact, not before it exists. The turn in which a reviewer
or verifier report arrives publishes its results (body edit, evidence
comment) before ending.

The lifecycle is linear: run the capped review loop, then QA as the last
work gate on the final head. Only the administrative PR-readiness update
follows successful QA.

**One global code-review budget governs the entire run.** The zone sets the
smaller ceiling; four reviewer dispatches is the absolute maximum at every
zone. Count every code-review invocation against the same cumulative ledger,
including per-phase reviews, the whole-PR review, confirmation passes, hosted
GitHub review triggers such as `@codex review`, and scoped reviews after QA
fixes. Never reset the counter at a phase, commit, push, PR creation, QA entry,
resume, or changed HEAD. Reserve at least one dispatch for the whole-PR review,
so at most three may be spent before Step 5. Persist the cumulative count in
the current plan's `code_review_dispatches` field and carry it forward across
phase plans. A new commit does not by itself invalidate prior review evidence
or require an exact-head review.

- Run the single Codex review lane over the PR diff. The item's explicit
  `review_lanes:` may request a topology, but this Codex entrypoint remains
  Codex-only and never dispatches a Claude reviewer or Agent-tool lane.
  (correctness + security, `(security)` tags). A Codex report may arrive
  tiered P0–P3 (its built-in review format) instead of the prescribed
  Must/Should format - map it, never re-dispatch over format: P0/P1 ≡
  Must Fix, P2 ≡ Should Fix, P3 ≡ Nice to Have. When the reviewers disagree,
  adjudicate it yourself. Use sub-agents to help you understand what is true
  when needed.
- **Another pass runs only on a trigger - the zone and global caps are
  ceilings, never quotas.** Zones 0–1 may use up to their zone ceiling while
  zones 2–3 stop at one; no run may exceed four cumulative code-review
  dispatches. At either cap, carry survivors to wrap-up rather than starting
  another pass, even when a prompt says “repeat until clean” or “review the
  latest head.”
  Two triggers: (a) **any Must Fix / P0 / P1
  from either lane** - loop those findings back to the matching
  implementer, stage the fix commit against `git status --short` (the
  status output is the checklist of the fix round's edits - Step 4's
  selective-commit rule still governs, so unrelated dirty paths stay
  unstaged), never from a remembered file list, push the fixes,
  re-review only when both the zone and global ledgers have budget; (b) the two lanes' reports
  **diverge sharply** (little overlap in what they caught, or conflicting
  overall verdicts) - one extra pass to confirm convergence. **A pass with
  zero Must Fix from every lane ends the loop**, even with Should Fixes
  open: apply the Should Fixes you judge worth it (or leave them to the
  inline comments below) - a Should Fix never triggers a re-review by
  itself. Fixing a Should Fix / P2 or Nice to Have / P3 never creates a review
  trigger; verify the affected behavior and continue.
- When the loop ends - zero Must Fix, or the cap reached with
  survivors flagged in the wrap-up - run the **QA drive**. This is the
  run's **final accepted app-driving phase** (Step 3 defers all UI acceptance
  criteria here): the Codex `frontend-verifier` proves the deferred UI ACs *and*
  executes the PR body's Manual tests checklist in one session, highest
  risk tier first; the Codex `backend-verifier` role runs the command-shaped
  items. Zone dial (`.references/zones.md`): zones 0–1
  full; zone 2 trimmed to the command-shaped items *plus* the deferred UI
  ACs (record `qa_pass: trimmed`); zone 3 skips both the command-shaped
  items and the Manual-tests execution (record `skipped`) - but **an AC
  whose only possible proof needs the running app is driven at any zone,
  zone 3 included; acceptance evidence is never trimmed by a zone dial.**
  The item's explicit `frontend_verifier:` metadata is the user's override,
  honored in both directions: `true` runs the verifier even where the zone
  wouldn't; `false` skips it entirely - app-only ACs left unproven are
  recorded as `unverified - frontend verifier disabled by the item` in the
  wrap-up, never claimed passed. When the
  app is needed, apply Step 0's launch rule; the frontend-verifier dispatch carries
  the `AGENTS.md`-sourced launch command, flags, port/URL, and env. For web UI,
  it also carries the local-Playwright contract: reuse repo Playwright when
  present, otherwise install it and its browser in a temporary directory
  outside the repo; never add it to the product's dependencies merely to run
  QA. An attached Codex Browser/Chrome transport is optional and must not be
  treated as the only valid way to drive the app.
  When `ios_testing: required`, the verifier prefers a leased device from
  `orchestra-sim acquire`; in standalone Codex where that tool is unavailable,
  it may select a local simulator via `xcrun simctl`, record the UDID and
  pre-run state, and use the run's attempt evidence directory. Drive every
  mobile AC, finalize `evidence-manifest.json`, then release an orchestra lease
  or restore/shut down only the local simulator the run started before
  reporting. When testing is optional and a mobile surface changed, use either
  simulator path whenever it would help.
  The dispatch also carries the QA-drive contract: map every touched surface
  and user journey to **ordered,
  step-named captures** (`01-<journey>-<state>.png`) covering meaningful
  states - empty/default, filled, expanded, validation error,
  loading/success, and one narrow viewport when responsive layout is in
  scope; generate a unique test marker (`agent-e2e-<timestamp>`) and
  verify external effects by **readback through connected tools** (a
  network request proves the browser tried; the provider/connector query
  proves the product received it). Both
  dispatches follow `.references/qa-verification.md` - external-system
  confirmation by unique marker, preflight, test-mode safety, cleanup of
  both the run's machinery and the product state it created (deleted where
  the surface is safe, registered by marker where it isn't - reported either
  way).
  **The capture contract rides in every frontend-verifier/QA dispatch you
  write** - the sub-agent only knows what its prompt says, so state it:
  screenshot every UI state verified, record a video of every journey
  driven through a scriptable driver (one native WebM per journey -
  `.references/qa-verification.md` § Journey videos), save all to the
  scratchpad, enumerate each in the report's Captures table (path · what it
  shows · AC#/J#). A report claiming a UI pass with an empty Captures table
  is incomplete - one re-ask for the enumeration before accepting it. If the
  browser attempt itself remains unavailable after the retry, accept an
  explicit `not run` result with the environment evidence and move those
  items to `remaining for the human`; never claim a UI pass. Then
  **every safe, publishable enumerated capture gets hosted and embedded when a
  durable host is available** - after-shots into the body's Visual overview,
  per-item evidence into the QA proof comment. Unsafe captures and captures
  blocked on hosting stay local and are listed with the reason in the handoff;
  journey videos get hosted for a durable link (the rolling `qa-assets`
  prerelease below) and linked next to their journey's gallery with the local
  path noted, since inline video players require a human web-UI upload; a
  capture that exists only as prose in a report is a dropped handoff, the
  exact failure this contract exists to prevent.
  Report at two altitudes, into the PR body first per `references/pr-body.md`
  (the body is the live dashboard, not a comment): with `gh pr edit
  --body-file`, flip the Manual-tests `[ ]`→`[x]` on passed items (append
  `- left to human: <reason>` on skipped ones) **and** fill the **QA results**
  summary line - items executed vs left to the human, plus any bug the pass
  found and its fix - changing nothing else. Then post the evidence as a PR
  comment: each item with its quoted output or hosted-image screenshot
  evidence (never committed files) - screenshots render **inline as grouped
  preview galleries**, one `<details open>` block per journey/surface in
  chronological step order, each capture labeled with what the reviewer
  should notice (`<img width="420">` when using HTML); a bare list of
  screenshot URLs is a failed handoff. The comment ends with an explicit
  split: **passed automated** vs **remaining for the human**, so the
  returning human's manual pass starts from the unchecked boxes and the
  remainder list. The QA drive's after-shots also complete the body's
  Visual overview (replacing its `After-shots: landing with the QA drive`
  note). **A bug the QA drive surfaces is never report-and-ship:** when the
  zone-derived global review budget has a pass left, loop its fix to the implementer,
  then run one **scoped review pass over the fix's diff alone** - the zone's
  review lanes, using that remaining pass - before the QA results line
  closes. When no pass remains, do not change code or accept QA: mark the PR
  and wrap-up `QA blocked`, preserve the reproduction evidence, leave the
  affected Manual tests unchecked, and continue the administrative handoff so
  the human still receives the open PR and exact blocker. The QA drive runs after
  the review loop exits, so without this pass a behavioral fix born from
  app-driving evidence (exactly the client-state bug a diff-reading
  reviewer can't see) would ship un-reviewed. This scoped pass spends from the
  same cumulative maximum of four; QA never creates a new budget. Body carries state, comment
  carries proof - never
  leave the results only in a comment when the body has a checklist and a QA
  results line to update. After every body update, **YOU MUST** preserve and
  verify the persisted closing-line set per `.references/tracker-lifecycle.md`.
  Any code fix after QA begins invalidates that QA evidence: return to the
  review phase using only the zone-derived global budget's remaining passes, then rerun QA
  from the start so the final accepted phase is QA.
- **Hosting evidence media**: classify every capture before publication.
  Secrets, PHI, MFA codes, payment details, private customer data, and other
  unsafe captures stay local; publish only a visually verified redacted copy
  when safe, and state why the original was withheld. When the consumer config sets
  `artifact_host:`, evidence media MAY be hosted as an artifact bundle per
  `.references/artifact-host-upload.md`; its stable viewer URLs are
  unauthenticated. For GitHub repos, the default remains screenshots, GIFs,
  and videos as assets on an existing rolling `qa-assets` **prerelease**.
  Creating that release is a separate external mutation requiring explicit
  authorization; if it does not exist or upload is unavailable, keep the
  evidence local, write the asset manifest and ready-to-paste PR Markdown,
  mark publication unavailable, and continue the handoff. For uploads, use
  content-addressed filenames containing item/PR context, head SHA, and a
  source-hash suffix; never `--clobber` an existing asset. Reference the
  `releases/download/...` URLs - CLI-native, permanent, permission-scoped,
  any file type. This rule is step-agnostic: Step 4 hosts the
  Visual-overview captures here *before* the PR exists, so prefix filenames
  with the **work item id** (stable from Step 0; add the PR number once one
  exists if it helps browsing) so the rolling release
  stays browsable. Images/GIFs render inline in comments; videos land as
  links (GitHub only inline-plays web-UI uploads). Expiring temp hosts are
  forbidden for evidence - a dead link months later is no evidence at all.
  On a private repo, note that inline rendering may fail for viewers
  without repo access; the links still work. Verify every upload by an
  authenticated byte download and compare SHA-256, size, and decoded file
  type with the local source; an asset API record alone is insufficient.
  Persist those values, the head commit, asset URL, and verification timestamp
  in the run's asset manifest.
- Before the frontend-verifier dispatch, save `git status --short`. Create a
  unique attempt directory under `./tmp/<id>/qa/` (or use the current
  `ORCHESTRA_BROWSER_EVIDENCE_DIR` when supplied) and pass its absolute path
  plus a generated run/attempt id to the verifier. Accept only the actual
  dispatched verifier's completed `evidence-manifest.json` whenever it
  produced captures; require its run/attempt ids to match the values passed in
  that dispatch, require every listed absolute path to remain under that
  attempt directory, and reject missing, partial, unlisted, fixture, or
  older-attempt files. This validation is identical in daemon and standalone
  Codex runs; orchestra environment variables are not required. An explicit
  browser `not run` result requires diagnostics and no manifest, and leaves
  every affected checkbox unchecked for the human. For each safe, publishable
  manifest entry, host it through the available durable evidence surface; when
  hosting is unavailable, preserve it locally and list it in the publication
  handoff instead. Then read back the persisted PR body and evidence comment
  and confirm every expected published asset is present.
  Compare `git status --short` afterward byte-for-byte with the saved value;
  any new staged path or any evidence path inside the repo fails QA
  publication because evidence must never enter the product diff. Classify
  unrelated concurrent worktree deltas separately instead of failing QA for
  changes the verifier did not create.
  A simulator manifest is accepted equivalently only when it has
  `status: "completed"`, `kind: "ios-simulator"`, the current turn id from
  `ORCHESTRA_SIM_CONTEXT` when supplied or the generated run/attempt id passed
  to the verifier in standalone Codex, absolute paths beneath the orchestra
  lease or standalone attempt `evidenceDir`, no older-attempt files, and quoted
  proof that the lease was released or the locally started simulator was
  restored before the report.
- After the loop and QA, post surviving Should Fix / Nice to Have findings
  as line-anchored inline PR comments (`gh api` reviews, event `COMMENT` -
  never `REQUEST_CHANGES`: the loop owns Must Fix, and capped survivors are
  flagged in the wrap-up; these orient the returning human, they gate
  nothing).
