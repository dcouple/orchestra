## Step 5: Post-PR review + QA

Reviews run against the open PR and fixes land on it - self-correction
happens on the artifact, not before it exists. The turn in which a reviewer
or verifier report arrives publishes its results (body edit, evidence
comment) before ending.

The lifecycle is linear: run the capped review loop, then QA as the last
work gate on the final head. Only the administrative PR-readiness update
follows successful QA.

- Run the review lanes over the PR diff (zone 0: both reviewers,
  dispatched together in one message - Agent tool + detached `codex exec`
  - never serially; zones 1–3: Codex alone; the item's explicit
  `review_lanes:` outranks the zone default in either direction, including
  when set on a multi-phase item)
  (correctness + security, `(security)` tags). A Codex report may arrive
  tiered P0–P3 (its built-in review format) instead of the prescribed
  Must/Should format - map it, never re-dispatch over format: P0/P1 ≡
  Must Fix, P2 ≡ Should Fix, P3 ≡ Nice to Have. When the reviewers disagree,
  adjudicate it yourself. Use sub-agents to help you understand what is true
  when needed.
- **Another pass runs only on a trigger - the caps are ceilings, never
  quotas** (cap 3 passes; zones 2–3: 1; multi-phase items always 3 passes,
  with lanes derived from zone unless the item's own `review_lanes:` says
  otherwise).
  **The three-pass cap is absolute even when a prompt says “repeat until
  clean”; at the cap, carry survivors to wrap-up rather than starting a
  fourth pass.**
  Two triggers: (a) **any Must Fix / P0 / P1
  from either lane** - loop those findings back to the matching
  implementer, stage the fix commit against `git status --short` (the
  status output is the checklist of the fix round's edits - Step 4's
  selective-commit rule still governs, so unrelated dirty paths stay
  unstaged), never from a remembered file list, push the fixes,
  re-review; (b) the two lanes' reports
  **diverge sharply** (little overlap in what they caught, or conflicting
  overall verdicts) - one extra pass to confirm convergence. **A pass with
  zero Must Fix from every lane ends the loop**, even with Should Fixes
  open: apply the Should Fixes you judge worth it (or leave them to the
  inline comments below) - a Should Fix never triggers a re-review by
  itself.
- When the loop ends - zero Must Fix, or the cap reached with
  survivors flagged in the wrap-up - run the **QA drive**. This is the
  run's **final accepted app-driving phase** (Step 3 defers all UI acceptance
  criteria here): the `frontend-verifier` proves the deferred UI ACs *and*
  executes the PR body's Manual tests checklist in one session, highest
  risk tier first; the `codex` skill role `backend-verifier` runs the
  command-shaped items. Zone dial (`.references/zones.md`): zones 0–1
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
  app is needed, apply Step 0's launch rule; the frontend-verifier dispatch
  carries the `AGENTS.md`-sourced launch command, flags, port/URL, and env.
  When `ios_testing: required`, the verifier must acquire a device with
  `orchestra-sim acquire`, drive every mobile AC, finalize the simulator
  `evidence-manifest.json`, and release the lease before reporting. When it
  is optional and a mobile surface changed, tell the verifier to acquire a
  device whenever it would help.
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
  is incomplete - one re-ask for the enumeration before accepting it. Then
  **every enumerated capture gets hosted and embedded** - after-shots into
  the body's Visual overview, per-item evidence into the QA proof comment;
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
  original review budget has a pass left, loop its fix to the implementer,
  then run one **scoped review pass over the fix's diff alone** - the zone's
  review lanes, using that remaining pass - before the QA results line
  closes. When no pass remains, stop with the bug as a blocker; do not change
  code or accept QA. The QA drive runs after
  the review loop exits, so without this pass a behavioral fix born from
  app-driving evidence (exactly the client-state bug a diff-reading
  reviewer can't see) would ship un-reviewed. Body carries state, comment
  carries proof - never
  leave the results only in a comment when the body has a checklist and a QA
  results line to update. After every body update, **YOU MUST** preserve and
  verify the persisted closing-line set per `.references/tracker-lifecycle.md`.
  Any code fix after QA begins invalidates that QA evidence: return to the
  review phase using only the original cap's remaining passes, then rerun QA
  from the start so the final accepted phase is QA.
- **Hosting evidence media**: when the consumer config sets
  `artifact_host:`, evidence media MAY be hosted as an artifact bundle per
  `.references/artifact-host-upload.md`; its stable viewer URLs are
  unauthenticated. For GitHub repos, the default remains screenshots, GIFs,
  and videos as assets on a rolling `qa-assets` **prerelease**
  (once per repo: `gh release create qa-assets --prerelease
  --title "QA evidence assets" --notes "Rolling QA evidence host - not a
  software release."` - the explicit `--title`/`--notes` matter: without
  them `gh release create` prompts interactively and a headless run hangs;
  then `gh release upload qa-assets <pr#>-<name> --clobber`) and reference the
  `releases/download/...` URLs - CLI-native, permanent, permission-scoped,
  any file type. This rule is step-agnostic: Step 4 hosts the
  Visual-overview captures here *before* the PR exists, so prefix filenames
  with the **work item id** (stable from Step 0; add the PR number once one
  exists if it helps browsing) so the rolling release
  stays browsable. Images/GIFs render inline in comments; videos land as
  links (GitHub only inline-plays web-UI uploads). Expiring temp hosts are
  forbidden for evidence - a dead link months later is no evidence at all.
  On a private repo, note that inline rendering may fail for viewers
  without repo access; the links still work - and unauthenticated fetches
  (curl, markdown proxies) get 404s from `releases/download/...` URLs, so
  verify an upload via its API asset id, never a bare curl.
- Before the frontend-verifier dispatch, save `git status --short`. Accept only
  the actual dispatched verifier's completed `evidence-manifest.json`; require
  its run/attempt ids to match the current daemon environment, require every
  listed absolute path to remain under the current attempt evidence directory,
  and reject missing, partial, unlisted, fixture, or older-attempt files. Host
  every manifest entry through `qa-assets`, then read back the persisted PR
  body and evidence comment and confirm every expected asset is present.
  Compare `git status --short` afterward byte-for-byte with the saved value;
  any delta fails QA publication because evidence must never enter the repo.
  A simulator manifest is accepted equivalently only when it has
  `status: "completed"`, `kind: "ios-simulator"`, the current turn id from
  `ORCHESTRA_SIM_CONTEXT`, absolute paths beneath that lease's `evidenceDir`,
  no older-lease files, and quoted proof the lease was released before the
  report.
- After the loop and QA, post surviving Should Fix / Nice to Have findings
  as line-anchored inline PR comments (`gh api` reviews, event `COMMENT` -
  never `REQUEST_CHANGES`: the loop owns Must Fix, and capped survivors are
  flagged in the wrap-up; these orient the returning human, they gate
  nothing).
