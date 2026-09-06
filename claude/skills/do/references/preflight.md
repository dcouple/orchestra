## Step 0: Preflight, then Load

Preflight the tools and access this item actually needs. Start with its local
brief or tracker metadata, then check required dispatch, artifact, and testing
capabilities. Group missing dependencies into one actionable message. A missing
optional capability does not block independent work.

Use the harness's configured permission mode. A skill cannot override an
approval or sandbox policy; report a denied required operation and continue
per the action tiers. Check credentials with a non-secret status or read-only
probe, and keep token values out of logs and chat. Authentication requests and
production actions remain subject to the active session's authorization.

Make the worktree's environment ready - installing dependencies and running
the development app inside its own worktree are the pipeline's deliberate,
logged actions, whatever the platform. For a workspace that needs executable checks or an app launch, ensure
dependencies are current; if missing or inconsistent with the lockfile, run the project's own idempotent install (a no-op when the
tree is already current), detecting the toolchain from the repo's
`AGENTS.md`/manifests rather than assuming one - always in the toolchain's
reproducible mode (locked versions) and with lifecycle scripts suppressed
where the toolchain supports it. Compare installed linter/build-tool
versions against the versions the repo's `AGENTS.md`/CI pin - a mismatch is
a preflight note, and the pinned install can start in the background before
implement. A missing toolchain or failed install
emits an **environment note** in the preflight message or run chat naming
the workspace and tool; continue per the action tiers and carry a
persistent note into the wrap-up/PR notes. If a later stage fails on an
artifact a suppressed install step would have produced, emit the same named
environment note for that package - never continue silently or improvise a
workaround.

Then **Load:**

Get everything about the work item into `./tmp/<id>/` before starting.
This mirrors the publish rule: the project's `AGENTS.md` `Work-item
tracking` section says where work items and their artifacts live - fetch
them per its instructions; with no instructions, the item exists only
locally, so expect it in `./tmp/<id>/`. The item is `brief.html`; its machine
state is the YAML in its `<script type="application/yaml"
id="orchestra-meta">` head element (read it by extracting that element's
text and parsing it as YAML - `.references/html-brief.md` · Metadata).
Treat the tracker body's published metadata as the item's state and
preserve it separately before writing or loading any `./tmp/<id>/brief.html`
copy. Also record whether `brief.html` contained genuinely pre-existing local
document content before the tracker fetch; the lean tracker stub fetched
during this load does not count as pre-existing local content.
If that metadata, or a local-only item's metadata, carries
`artifact_bundle:`, fetch `<artifact_bundle>index.json` and then GET every
listed raw file from the bundle into `./tmp/<id>/`.
Existing local files win for document content and bundle files normally fill
content gaps only. The exception is a tracker-loaded lean stub: when no
genuinely pre-existing local `brief.html` document content was present before
the tracker fetch, always replace the stub with the bundle's authoritative
`brief.html`. Retry the index fetch or any file GET once.
If the configured bundle is still
unreachable, this is a **red gate blocking everything**: notify per
`.references/notify.md`, state exactly which bundle request must become
reachable, and wait. Never proceed from the lean tracker stub.

For a tracker-loaded item, after the bundle pull replace the loaded
`brief.html`'s `#orchestra-meta` element's text **wholesale** with the tracker
body's full metadata values - touch nothing else in the file. Tracker
metadata governs the run and overrides both pulled and pre-existing local
metadata: state beats documents, while disk wins applies only to document
content (the page body). For a GitHub issue with no `artifact_bundle:`, use
the marker transport: harvest every `<!-- ORCHESTRA-ARTIFACT path="..." -->`
comment block back to its path under `./tmp/<id>/` (joining `part=n` splits)
before planning - a hostless-published item carries its authoritative
`brief.html` this way (the issue body is only its markdown rendition);
legacy items carry an `item.md` instead - run from that as-is. Only a
GitHub item with neither an artifact bundle nor artifact comments gives you
the body alone; say so in the plan's Known mismatches. A local path is read directly. Invoked with no
argument: list the local items whose metadata says `status: ready`
(`./tmp/*/brief.html`, legacy `./tmp/*/item.md`) and ask the user which to
run - never pick one silently. Skim `refs/`; read individual refs as the work
calls for them.

These preflight items are only checkable now that the item is loaded:

- Classify browser need from the authoritative loaded item before any browser
  preflight. E2E-browser criteria or a manual UI journey make the run browser
  required. On the initial daemon turn, if required and
  `ORCHESTRA_BROWSER_REQUEST_FILE` is present, atomically replace that file
  with JSON `{ "requested": true }` and return exactly
  `ORCHESTRA_BROWSER_RELAUNCH_REQUIRED` with no other terminal text. Never
  write the marker for a non-browser item. If browser proof is required but
  neither the request file nor `ORCHESTRA_BROWSER_EVIDENCE_DIR` is present,
  stop with an explicit browser-prerequisite failure.
- After relaunch, prove the attached MCP and Chrome by invoking
  `mcp__playwright__browser_snapshot`, then close the probe with
  `mcp__playwright__browser_close`. Classify MCP startup/connection, Chrome
  launch, and target-application reachability as separate prerequisite
  failures. None may fall back to scripts/logs as browser evidence.
- Read `ios_testing` (`optional` by default). When it is `required`, run
  the metadata conflict rule from `.references/html-brief.md` first: if
  `frontend_verifier: false`, stop with `ios_testing: required needs the
  frontend verifier; frontend_verifier: false contradicts it - fix the item
  metadata`. Otherwise run
  `orchestra-sim status` and call `mcp__xcodebuildmcp__list_sims`;
  `orchestra-sim status` is the non-mutating readiness check, so exit 0 means
  the configured golden is present and shut down and the pool is reconciled.
  If either check fails, stop with `simulator prerequisite failed:` naming
  the missing `orchestra-sim` or XcodeBuildMCP half, never “unverified.” When
  optional, note which halves are available and continue.

- Read the item's **Dependencies & mechanics** section when present and
  check each listed dependency; a dependency the brief marks `assumed` gets
  verified here or named in the preflight message. When the item was already local, this runs before the
  preflight message goes out, so the gaps fold into that single message;
  for a fetched item, surface them in an immediate preflight follow-up, as
  with a missing testing-accounts section below.
- Follow `.references/tracker-lifecycle.md`. **YOU MUST** validate current
  `linear_issues`, then build and retain two operation sets: current `completes`
  issues needing team-specific `In Review`, and exact `Fixes TEAM-123`
  candidates parsed from the persisted bodies of all paginated prior merged PRs
  in this GitHub repository, each needing team-specific resolved `Done`.
  Discover access and status readiness per operation; one missing status does
  not disable the other set. If Linear is needed but unauthenticated, **YOU
  MUST** ask for authentication here only. Mark unresolved operations
  `unavailable` and continue; after Step 0, tracker work stays non-blocking and
  **YOU MUST NOT** prompt for tracker authentication.
- When verification criteria imply driving the running app (UI acceptance
  criteria, manual flows), confirm the repo `AGENTS.md`'s testing-accounts
  section exists and is filled - it is the verifier's credentials source,
  provisioned per `.references/testing-accounts.md` (secret-manager storage,
  `TESTING_ACCOUNT_<APP>_<ROLE>` naming, bootstrap procedure) -
  and prove the readiness executable, not documentary: the browser-automation
  transport connects and the named test sessions/credentials are actually
  reachable. Either half missing → an immediate preflight follow-up note
  naming each missing half, so the gap surfaces now instead of when the
  verifier blocks mid-run.
- When any stage will need the running app - verification, reproduction, or a
  staging prerequisite - confirm the repo `AGENTS.md` documents its launch
  command, flags, port/URL, and env. Missing or unfilled → an immediate
  preflight follow-up note. Using only those sourced facts, the pipeline may
  start the app in the background when needed and must stop what it started;
  never invent a launch command.

Check branch state before edits: fetch the remote default branch and inspect
`git status`, branch history, and open PRs for the current branch. Continue an
existing task branch only when it belongs to this item. Otherwise create a
named work branch from the current default, using an isolated worktree if
unrelated edits or another task's PR need to be preserved. Branch/worktree
creation is part of executing /do. Ask only when ownership cannot be resolved
without risking another task's work.

Require `status: ready` and actionable verification criteria before execution.
If either is missing, report the exact missing input without changing item
state to manufacture authorization.

Classify the item's goal as you load it: an item whose outcome is one named
metric reaching a target - latency, bundle size, suite time, lint count -
runs Step 2 as a bounded measure/change/re-measure loop, each
cycle's change dispatched to the Codex `implementer`, its accepted-win
commits riding this run's PR under Step 4, and its attempt log kept in
`./tmp/<id>/`. Record the metric, its baseline, and its target in the
plan's Goal & invariants; the action tiers govern, so the loop never idles
for the human, and a climb that stops short of target carries its
trajectory into the wrap-up. Use a `hillclimb` skill if available; otherwise
retain measured wins, revert regressions, and stop at the target, the agreed
attempt budget, or when evidence no longer supports another attempt.

**Done when**: the item and its artifacts are in `./tmp/<id>/`, status is
`ready`, and you're on a non-default branch.
