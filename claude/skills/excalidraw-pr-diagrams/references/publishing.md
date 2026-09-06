# Publishing reference

Paths written as `references/...` resolve from the skill directory.

## Local Codex or Claude PR Workflow

When using this skill for pull request diagrams in Codex or Claude:

- Always create and edit diagram working files in a temporary working directory outside the target repo, preferably `/tmp/codex-pr-diagrams/<repo-or-pr>/` or `C:\tmp\codex-pr-diagrams\<repo-or-pr>\`.
- Do not create generated `.excalidraw`, `.png`, or temporary render files inside the repository unless the user explicitly asks for tracked diagram assets.
- For PR descriptions, use the rendered Excalidraw image as the primary visual. Do not add Mermaid diagrams by default; add Mermaid only if the user explicitly asks for a durable text-rendered fallback.
- Save matching `.excalidraw` source files under `/tmp` for local iteration and future reuse.
- PR visual overviews must include explicit `Before` and `After` diagrams so reviewers can see both the old behavior and the new behavior without inferring the diff from prose.
- Keep each PR diagram focused on the change boundary: before, after, and why the new flow is safer.
- After generating diagrams, update the PR description with a dedicated `## Visual Overview` section.

### PR Asset Publishing

Default: PR images are **hosted, not committed**. Upload the rendered PNG to
a durable host and reference it inline in the PR body. Scriptable default: a
rolling GitHub release in the target repo - `gh release create pr-assets --notes "PR image assets"`
once, then `gh release upload pr-assets <image>.png` per image; the asset's
download URL renders inline and outlives branches. (GitHub user-attachment
URLs - drag an image into a comment box - are equally durable but have no
API; use them when a human or a browser-driving agent is doing the upload.
A project upload endpoint or temporary host also works.) The repo stays
free of multi-MB render blobs, and every re-render is just a new URL. If
only a temporary host is available, note its expiry next to the image.

Commit the image only when it is embedded in tracked docs (a README, design
doc) that needs a stable in-repo path - then `.github/pr-assets/` or
`docs/`, referenced with a blob URL + `?raw=1`, e.g.
`https://github.com/<owner>/<repo>/blob/<branch>/.github/pr-assets/<image>.png?raw=1`.
Keep `.excalidraw` sources outside the repo unless the user asks to track them.

Either way:

- After updating, open or fetch the image URL. A PR visual with a 404 image is a failed handoff.
- Read back or preview the PR body after updating it. Markdown that collapses bullets, headings, or the image into one paragraph is a failed handoff.

### PR Diagram Standard

For PR diagrams, a simple pair of red/green cards is not acceptable. The diagram must teach the change in a way prose cannot.

Before drawing, identify the visual truth of the PR:

- **Boundary changed**: draw walls, membranes, trust zones, or origin/process boundaries.
- **Lifecycle changed**: draw a state machine, gate sequence, or retry loop.
- **Responsibility moved**: draw before/after ownership regions and move the action across them.
- **Failure mode removed**: draw the old failure path visibly dead-ending and the new path avoiding it.
- **Concurrency/race fixed**: draw clocks, timelines, joins, or retry circuits.
- **Validation/permissions changed**: draw a decision path, lock/gate, and what passes through it.

Every PR visual overview must include:

- A **before path** showing where the old system failed or was fragile.
- An **after path** showing the new route/control point.
- At least one **semantic visual structure**: boundary, timeline, loop, funnel, state machine, swimlane, queue, fan-out, convergence, or layered stack.
- One short **truth statement** that explains the visual argument in plain language.
- A small **term explainer** when the diagram uses protocol/framework words that a reviewer may not know. Do not assume terms like header, preflight, origin, token, cookie, CORS, WebSocket upgrade, cache key, breakpoint, or trace are self-explanatory.

Do not use the same diagram structure for a series of PRs unless the code changes truly have the same shape. Split PRs usually need different visual metaphors because they fix different kinds of problems.

### Shareable Explainers

When the user wants a PR image that can teach the change to someone else, design it as a shareable explainer, not just reviewer decoration.

- Make the title state the strategic outcome, not the implementation detail.
- Show the old blind spot, failure mode, or uncertainty on the left.
- Show the new loop, boundary, path, or control point on the right.
- Include at least one concrete example input and one concrete output. Real event names, endpoint paths, page names, source URLs, or dashboard fields make the image feel authoritative.
- If measurement is part of the value, show what gets captured and how it becomes a decision, backlog item, or next action.
- Add enough whitespace that each box can breathe. If an arrow needs to loop back, route it around the outside of the boxes.
- Inspect the final image at the size GitHub shows in a PR. If the viewer must open the image full size to understand it, simplify the diagram.

### Reviewer Explainers

When a PR involves technical protocol behavior, include a compact teaching layer in the visual:

- Define the technical noun in a concrete metaphor before using it. Example: `headers = extra notes the browser wants to attach`, `preflight = permission check before the real request`, `origin = website address the browser trusts or blocks`.
- Show who performs each action. Example: `Browser asks`, `API answers`, `Browser blocks`, not just `headers requested`.
- Use concrete examples sparingly: `login badge`, `Sentry trace`, `Firebase app id` is clearer than a long raw header list.
- Keep the official term visible in parentheses after the plain-English term when useful: `permission check (CORS preflight)`.
- If the diagram has a metaphor, keep it mapped to the real system with labels. A security desk can teach CORS, but the browser/API roles must remain visible.

For review diagrams, assume the reader is smart but has not learned this subsystem yet. If the reader would ask "who does that?" or "what is that?", add a visual cue or one-line explainer instead of relying on the PR prose.
