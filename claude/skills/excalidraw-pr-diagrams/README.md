# Excalidraw Diagram Skill

A coding agent skill that generates beautiful and practical Excalidraw diagrams from natural language descriptions. Not just boxes-and-arrows - diagrams that **argue visually**. It also supports PR visual overviews that teach before/after changes to reviewers.

Compatible with either installed workflow adapter.

## What Makes This Different

- **Diagrams that argue, not display.** Every shape/group of shapes mirrors the concept it represents — fan-outs for one-to-many, timelines for sequences, convergence for aggregation. No uniform card grids.
- **Evidence artifacts.** As an example, technical diagrams include real code snippets and actual JSON payloads.
- **Built-in visual validation.** A Playwright-based render pipeline lets the agent see its own output, catch layout issues (overlapping text, misaligned arrows, unbalanced spacing), and fix them in a loop before delivering.
- **PR-ready handoff.** The skill covers shareable reviewer explainers, committed PR assets, raw GitHub image URLs, and PR body preview checks.
- **Brand-customizable.** All colors and brand styles live in
  `.references/workflows/formats-and-assets/excalidraw/color-palette.md`.
  Swap it out and every diagram follows your palette.

## Installation

The workflow adapter and shared assets arrive through the configured
skill-system sync. No manual install is required.

## Setup

The skill includes a render pipeline that lets the agent visually validate its diagrams. There are two ways to set it up:

**Option A: Ask your coding agent (easiest)**

Just tell your agent: *"Set up the Excalidraw diagram skill renderer by following the instructions in SKILL.md."* It will run the commands for you.

**Option B: Manual**

```bash
cd .references/workflows/formats-and-assets/excalidraw
uv sync
uv run playwright install chromium
```

## Usage

Ask your coding agent to create a diagram:

> "Create an Excalidraw diagram showing how the AG-UI protocol streams events from an AI agent to a frontend UI"

Or ask for a PR visual overview:

> "Create a shareable PR diagram that explains the before and after behavior, commit the PNG under .github/pr-assets, and update the PR body."

The skill handles the rest — concept mapping, layout, JSON generation, rendering, and visual validation.

## Customize Colors

Edit `.references/workflows/formats-and-assets/excalidraw/color-palette.md` to
match your brand. Everything else in the workflow is universal design
methodology.

## File Structure

```
.references/workflows/
  excalidraw-pr-diagrams.md          # Design methodology + workflow
  formats-and-assets/excalidraw/
    color-palette.md                 # Brand colors (edit this to customize)
    element-templates.md             # JSON templates for each element type
    json-schema.md                   # Excalidraw JSON format reference
    render_excalidraw.py             # Render .excalidraw to PNG
    render_template.html             # Browser template for rendering
    pyproject.toml                   # Python dependencies (playwright)
```
