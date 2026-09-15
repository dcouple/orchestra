---
name: excalidraw-diagram
description: Create editable Excalidraw diagrams and rendered explainers for workflows, architecture, or PR changes.
---

# Excalidraw diagrams

Make the relationship easier to understand than prose alone. Deliver editable
`.excalidraw` JSON and a rendered, visually inspected image.

## Start with the question

- Identify the audience, the relationship to explain, and the detail they need.
- For a real system, inspect its code or authoritative specifications before
  drawing. Use actual method names, states, and formats; distinguish proposed
  behavior from observed behavior.
- Choose the smallest useful visual. An overview may need only a few labels;
  a technical explainer may need an example request, event, or output.
- Read `references/color-palette.md` before choosing colors. Use the supplied
  palette as the default; honor a user-provided visual identity.

## Choose a structure

| Relationship | Useful structure |
|---|---|
| One source affects several consumers | Fan-out |
| Several inputs produce one result | Convergence |
| Ownership or nested components | Regions or a tree |
| Ordered actions or a race | Timeline or swimlanes |
| Retry, lifecycle, or feedback | State machine or loop |
| Trust or permission boundary | Boundary with explicit gates |
| Behavior changed | Comparable before/after paths |

- Shape and placement should convey meaning, not just decorate labels.
- Label who acts: `Browser asks → API answers → Browser proceeds` is clearer
  than an unowned `permission check`.
- For unfamiliar terms, add a short explanation while keeping the real term
  visible: `permission check (preflight)`.
- Show concrete input/output where it teaches the mechanism. Do not add
  sensitive source data for realism.
- Use consistent shapes for consistent concepts. Vary structures only when
  the relationships differ; a card grid is fine for a genuine comparison.
- Use lines and free-floating text for labels or hierarchy. Add containers
  when grouping, boundaries, or connections need them.

## PR diagrams

- Show `Before` and `After`, focused on the changed boundary. Include the old
  failure path when there was one; do not invent a defect for a new feature.
- Add one short statement of the change. A pair of colored paragraphs is not
  a diagram: show the routing, ownership, lifecycle, or decision that changed.
- Match the PR's actual shape rather than reusing an unrelated metaphor.
- Use the rendered image as the primary visual. Add Mermaid only when requested.
- Update the PR only when PR preparation or editing is in scope, following
  its existing Visual overview section and repository conventions.

## Layout and JSON

Read `references/element-templates.md` for element construction and
`references/json-schema.md` for fields and bindings.

- Start with enough space for readable labels, then fit the export to its
  destination. A roughly 1600×1000 canvas is a starting point, not a requirement.
- Keep titles short and labels brief. Insert explicit line breaks and allow
  extra text-box width; Excalidraw does not wrap like HTML.
- Use whitespace and type size for hierarchy. Route arrows around labels and
  bind them to the intended shapes; color must not be the only meaning.
- Defaults: `fontFamily: 3`, `roughness: 0`, `opacity: 100`; use the requested
  style when different. Text properties contain readable text, not instructions.
- Use descriptive, unique IDs. For large diagrams, build and check one natural
  section at a time, updating both ends of cross-section bindings.
- Keep every reference valid and preserve the complete JSON wrapper:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [],
  "appState": {"viewBackgroundColor": "#ffffff", "gridSize": 20},
  "files": {}
}
```

## Render and inspect

From this skill's installed `references/` directory:

```bash
uv run python render_excalidraw.py <path-to-file.excalidraw>
```

For first-time setup, follow `README.md`; do not assume a particular host's
installation path. The renderer writes a PNG beside the source by default.

View the actual PNG, then fix and re-render until:

- The structure explains the intended relationship and the before/after is accurate.
- Text is legible at the final display size, with no clipping or overlap.
- Arrows connect correctly without crossing unrelated shapes or labels.
- The composition has a clear reading order and balanced spacing.

One successful render may be enough. If rendering is unavailable, deliver the
editable source and state that visual validation is incomplete.

## Storage and delivery

- Read `.references/artifact-storage.md`. Save safe source and rendered output
  in the task's Grain folder when connected, preserving editable source and
  required local working files. Pass the folder ID/rule to any authorized agent.
- Use the caller's scratch directory (for example `./tmp/<id>/`) when supplied;
  otherwise use an isolated temporary directory. Do not commit generated
  assets unless the user or tracked-document workflow calls for them.
- For PR images, use an authorized durable host. Grain storage does not imply
  public access or that its URL can render inline on GitHub.
- Use an existing approved release/upload endpoint if available. Creating a
  release or publishing private artifacts needs authorization. Prefer unique,
  content-addressed asset names; do not overwrite another run's evidence.
- If only local or expiring hosting is available, report that limitation.
- Fetch the hosted image and read back the persisted PR body before claiming
  the visual is delivered. Preserve Markdown headings, blank lines, and bullets.
