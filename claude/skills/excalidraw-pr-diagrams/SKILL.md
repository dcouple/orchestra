---
name: excalidraw-diagram
description: Create Excalidraw diagram JSON files and PR visual overviews that make visual arguments. Use when the user wants to visualize workflows, architectures, concepts, pull request changes, before/after behavior, or a shareable explainer image for reviewers.
---

# Excalidraw Diagram — Claude adapter

Follow `.references/workflows/excalidraw-pr-diagrams.md` as the authoritative
diagram contract. Resolve every referenced template, palette, renderer, and
schema under `.references/workflows/formats-and-assets/excalidraw/`.

Build large diagrams incrementally to stay within the current Claude turn,
render them for visual inspection, and apply the contract's evidence and
publication rules. If research is delegated, await the report before encoding
its claims in the diagram.
