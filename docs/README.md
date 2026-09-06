# Workflow visuals

These editable sources and PNG exports are maintained with the workflow docs.
The executable contracts remain in the linked skills and references.

| Visual | Scope | Source | Render |
| --- | --- | --- | --- |
| Workflow map | Current capture, stage routing, review/QA, and PR handoff | [Excalidraw](workflow-map.excalidraw) | [PNG](workflow-map.png) |
| Software-factory story | Earlier manual coordination, current Orchestra, and the direction of configured signal intake | [Excalidraw](software-factory-story.excalidraw) | [PNG](software-factory-story.png) |

The story is conceptual: it does not assert that every signal source,
schedule, or deployment is enabled. Current role routing and stage contracts
are linked from [WORKFLOW.md](../WORKFLOW.md). Model IDs belong to executable
skill/agent metadata, so the workflow map shows roles and decision boundaries.
The story's copy in `dcouple/skills/docs/` should be updated in the same change
when work spans both repos.

## Regenerate

From the repository root, install the renderer dependencies once:

```bash
uv sync --project claude/skills/excalidraw-pr-diagrams/references
uv run --project claude/skills/excalidraw-pr-diagrams/references playwright install chromium
```

Render a changed source, inspect the PNG at README size, and fix any clipped
text, overlap, or incorrect connections before committing both files:

```bash
uv run --project claude/skills/excalidraw-pr-diagrams/references python claude/skills/excalidraw-pr-diagrams/references/render_excalidraw.py "$PWD/docs/workflow-map.excalidraw"
```

Use `software-factory-story.excalidraw` for the other source. The
[rendering contract](../claude/skills/excalidraw-pr-diagrams/references/rendering.md)
explains the visual checks and completion condition.
