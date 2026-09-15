# Excalidraw renderer setup

The skill arrives through Orchestra sync. Locate its installed `references/`
directory rather than assuming a Claude or Codex path.

Run there when renderer setup is requested:

```bash
uv sync
uv run playwright install chromium
uv run python render_excalidraw.py <diagram.excalidraw>
```

The renderer uses Python 3.11+, Playwright/Chromium, and an Excalidraw module
loaded from the CDN named in `render_template.html`; initial rendering needs
network access. Do not claim offline validation when that module is unavailable.

## Resources

- `SKILL.md`: design, validation, storage, and authorized PR publishing.
- `references/color-palette.md`: default colors; user-provided palettes may override.
- `references/element-templates.md`: element examples and bindings.
- `references/json-schema.md`: field reference.
- `references/render_excalidraw.py`: render command, including output/scale options.
- `references/render_template.html`: browser-side renderer.
- `references/pyproject.toml`: renderer dependencies.

For example: “Draw the old and new retry paths for this PR.” The workflow
returns editable source and a visually checked image; it updates a PR or
commits diagram assets only when that delivery is in scope.

Save safe output per `.references/artifact-storage.md`, retaining the local
files the renderer needs. Shared storage does not grant public-upload authority.
