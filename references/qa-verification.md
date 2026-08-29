# QA verification - external-evidence discipline

> Read by `/do` Step 5's QA-pass dispatches: the `frontend-verifier` driving
> the app, the `backend-verifier` running command-shaped checks. Extends
> `verification-methods.md` - same proof standard, plus the rules that make
> automated QA evidence trustworthy end to end.

## Discover connected tooling first

Inventory what this environment can already prove things with before the
first flow: MCP servers and connectors (analytics, email/SMS, payments,
CRM - a Composio-style tool catalog often holds an authenticated tool for
the product even when nothing is configured in the repo), authenticated
CLIs (`gh`, payment/cloud CLIs), local containers and their logs. Product
data queried through a connected tool beats any local inference - prefer
it wherever one exists, and name in the report which tools you used and
which were missing.

## Build what's missing

The run is allowed to make its own tools. No browser driver in the repo?
Install one in the scratch directory - never pollute the repo or its
lockfiles. Need a probe script, webhook listener, or log parser? Write it
in scratch and remove it after. Drive UIs by stable user-visible selectors
(labels, button text, routes), and pull verification links/codes from
local service logs when the environment emits them.

## React runtime hooks (repo-declared)

When the change under test touches React code (web or React Native), probe
the app workspace's `package.json` for the conventional runtime-hook
scripts before the first flow:

- **`perf:scan`** - serves the web app in a scan mode that instruments
  React re-renders (e.g. react-scan behind a dev-only flag) and emits
  structured render-evidence lines to the browser console. When present,
  drive the changed journeys against this server instead of the plain dev
  server: capture the render-evidence console lines alongside your normal
  captures, and report abnormal render fan-out - a whole list re-rendering
  on a single interaction, renders continuing after the UI is idle, or
  render counts far out of proportion to what changed on screen - as a
  finding with the console excerpt as evidence. Render evidence is
  qualitative: excessive-render findings are judgment calls backed by
  quoted numbers, not threshold gates.
- **`a11y:scan`** - runs an axe-style scan (e.g. @axe-core/playwright)
  against key screens and emits a violations report. When present and the
  diff touches rendered UI, run it per the repo's documented usage and
  attach new violations on changed screens to the report.

Hooks absent from `package.json` → note `no React runtime hooks declared`
in the report and move on - never improvise a profiler or a11y harness the
repo doesn't declare (the build-what's-missing rule covers drivers and
probes, not app instrumentation; setting hooks up in a repo that wants
them is its own user-approved change - see `react-harness.md`). Hook launch commands, flags, and ports
come from the repo's `AGENTS.md`/docs like any other launch fact. **A
declared hook that fails to start does not block the drive**: after one
diagnostic retry, fall back to the app's normal documented server, drive
every journey there as usual, record the hook failure as a named
environment note, and mark only the criteria whose sole possible proof is
hook evidence (a render-evidence or axe-report criterion) as
`Left to human - hook failed to start`. The charter's missing-or-failed-
launch-is-blocked rule governs the app launch itself, not this optional
instrumentation layer - hooks degrade to a note plus per-criterion
handoff, never to a blocked drive.

## External verification

A network request only proves the app *tried*; ingestion is proven at the
receiving system. When a flow ends in an external system - analytics,
payments, email/SMS, webhooks - confirm arrival there: query the connected
tool or API for the event, never just the browser's network tab. No
connector available → the item is `Left to human - <reason>`, not assumed.
Record what lets a human find the test again: event ids,
customer/subscription ids, dashboard URLs, the date range and filters
queried.

## Unique test identity

Stamp the run's actions with a unique marker (e.g. `agent-e2e-<timestamp>`
in names, emails, note fields) and query external systems by that marker -
it separates this run's evidence from prior runs and from real users.

## Preflight

Before a long flow, verify the tools it needs are alive: authenticated CLIs
(`gh auth status` and peers), running services/containers, connectors,
test-mode keys wherever the flow touches money. A flow that dies at step 7
for a missing login wastes the run - fail fast at step 0.

Probe HTTP responses with `GET` (`curl -sS -D - -o /dev/null`), never
HEAD, unless HEAD support is itself a criterion - a GET-only service fails
a HEAD probe as a false negative.

## Test-mode safety

Stay in test/staging mode by default. Real production mutations - payments,
messages to real users, destructive data operations, feature-flag flips -
are never taken: stop that action, mark the checklist item
`Left to human - <reason>`, and continue the rest of the run.

## Automation artifacts

Products treat automated browsers differently - analytics SDKs silently
drop events from bot-flagged sessions (`navigator.webdriver`, headless
user-agent brands). When the goal is proving ingestion, mask the
automation signals for the test context only, and disclose the masking in
the report. Pace critical flows like a human - batched events need time to
fire in order - and rerun with slower pacing before calling an ordering
anomaly a product bug. Every artifact the harness caused (mocked signals,
prevented navigation, dummy keys) is named in the report, never left to be
mistaken for product behavior.

## Evidence hosting

Screenshots and clips are evidence, not repo content - never commit them.
Upload to whatever host the environment provides and inline the URLs in
the PR comment so previews render where the reviewer reads. Durable +
scriptable: the rolling `qa-assets` prerelease (once per repo:
`gh release create qa-assets --prerelease`, then
`gh release upload qa-assets <img>` - asset URLs render inline and
outlive the review). GitHub user-attachment URLs are just as durable but
have no API (browser-only); a project upload endpoint or temporary image
host works too. When only a temporary host is available, note its
expiry next to the link and keep the textual evidence (quoted output, ids)
self-sufficient without the image.

## Journey videos

When a journey is driven by a scriptable browser driver (Playwright-style),
record it as a video alongside the stills - thirty seconds of continuous UI
catches what discrete screenshots structurally cannot: layout jumps,
white flashes, missing loading states, janky transitions. Record at the
driver level (e.g. Playwright's `recordVideo` on the context) so the video
is a free byproduct of the drive, never a second pass for the camera; one
video per journey, named for it.

Keep the driver's native recording as the published artifact - WebM from the
browser driver; a simulator driver's native MP4 stands in the same
way. Where ffmpeg is available, an H.264 mp4 with `yuv420p` may also be
published as an optional compatibility transcode, but it never replaces the
required native recording.
Videos complement stills, never replace them: the per-step captures stay the
frame-addressable evidence each report row cites; the video is the continuity
check and the artifact a reviewer actually watches.

Publish videos like any other evidence (see Evidence hosting) - the rolling
`qa-assets` prerelease gives a durable link
(`gh release upload qa-assets <journey>.webm`).
One platform caveat goes in the report: GitHub renders an inline video
player only for files a human uploads through the web UI, so link the
hosted WebM next to the journey's stills *and* enumerate the local file
paths - the human can drag-drop those files wherever inline playback
matters. When a connected work tracker accepts file attachments by API,
attach the videos there too.

A video is also machine-scannable evidence: per-frame luma stats
(`ffprobe -f lavfi "movie=<video>,fps=5,signalstats" -show_entries
frame=pts_time -show_entries frame_tags=lavfi.signalstats.YAVG -of
default=noprint_wrappers=1`, watching `YAVG` - ~235 is a blank white frame)
locate blank-frame bands, flashes, and dead time without a realtime watch -
when a band becomes a finding, cite its timestamp range in the report.

## Cleanup

Kill the listeners, processes, and temp state the run started; leftovers
poison the next run's evidence.

### Product state the drive created

The run's marker also names real things that now exist: accounts,
organizations, records, subscriptions, and the analytics events they emitted.
Disclosure is not disposal - a report that says an account was created and
leaves it there has done half the job, and the leftovers land in someone's
dashboard as real signups and real revenue.

Delete in-run only when all three hold:

- the surface is **non-production** - and that is established from the
  environment the drive actually reached (the ingestion target, the key, the
  project id), never assumed from the stack you launched;
- the deletion is **scoped by this run's unique marker**, not a broader query;
- the drive **already holds** the credentials that perform it.

If any condition fails or is uncertain, do not delete - **register** it: name
the marker, the system, and what remains, precisely enough that a repo-side
reaper can find it by marker alone. Production analytics and live-mode billing
are register-only by default; a QA drive never issues deletes against them.

Either way the disposition is reported - see `verification-result.md`
§ Cleanup disposition. "Nothing created" is a disposition too.

### Playwright attempt finalization

Daemon browser attempts have sibling `state/` and `evidence/` directories.
Only `evidence/` survives teardown. A Playwright attempt is publication-ready
only after trace and video stop successfully, media is validated, and a final
`evidence-manifest.json` with `status: "completed"` lists every artifact from
that same run and attempt. Missing manifests, partial manifests, paths outside
the current evidence directory, and files from earlier attempts are diagnostic
only and cannot prove acceptance criteria or be published as QA evidence.

### Simulator attempt finalization

Keep every capture beneath the acquired lease's `evidenceDir`. After stopping
the native MP4 recording, write `evidence-manifest.json` last with
`status: "completed"`, `kind: "ios-simulator"`, current `turnId`,
`lease: {udid,name,index}`, and absolute artifact paths beneath that directory.
The manifest's `lease.index` is the `lease` number printed by
`orchestra-sim acquire`. Pass the recording's original `outputFile` path again
when calling `record_sim_video{stop:true}`. `wait_for_ui` takes a string-enum
`predicate` such as `"settled"` or `"exists"`, not an object. Name
`screenshot{returnFormat:"path"}` captures with `.jpg`, because the simulator
driver writes JPEG data regardless of the requested filename. Files from
another lease are invalid. Release the lease before reporting and
preserve the release output as evidence.
