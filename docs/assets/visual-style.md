# dcouple README visual language

The dcouple projects share a pixel-art world, with a different setting and role
for each project. The original visual reference is the
[Agent Farm banner](https://github.com/dcouple/agent-farm/blob/19f1fba8ef12050eef39c1b44e725c697b57b87b/docs/assets/agent-farm-banner.png).

## Shared design rules

- Crisp, consistent pixel art; readable silhouettes and isometric miniature scenes.
- Midnight charcoal backgrounds, warm cream type, and warm lantern lighting.
- Cream robot characters with black faceplates and two green eyes. Props and clothing reflect their role.
- Wood, stone, modest greenery, and floating islands connect the settings.
- Banner titles sit on the left, with the scene on the right. Use a wide 3:1 composition.
- Supporting images use roughly 2:1 compositions, large readable labels, and restrained scenery.
- Keep explanations and exact commands in accessible Markdown. Illustrations must not invent UI, features, approvals, or execution guarantees.

## Project identities

| Project | Setting and role | Accent direction | Distinctive props |
| --- | --- | --- | --- |
| Agent Farm | Cultivation and native terminals | Moss green and gold | Straw-hatted farmer, skill crops, terminal huts |
| Skills | Playbook library and outfitter | Amber and parchment | Librarian with book satchel, books, profile cards, agent figurines |
| Orchestra | Conductor's workshop | Lilac and brass | Waistcoat, baton, code stands, coordinated workstations |
| Doozy | Everyday task desk and post office | Mint and soft blue | Messenger satchel, inbox, checklist, human collaborator |

The shared style should make the relationship recognizable; each project's
setting and props should make its purpose distinguishable. Do not turn every
project into a farm or reuse the same scene with a different title.

## Making future images

Supply this repo's banner as an image reference, alongside the family reference
when needed. Preserve its pixel treatment, character design, palette, and lighting.
Adapt the scene to the documented feature; check every label and arrow against
the current README or code. Keep real screenshots and detailed technical diagrams
accurate and readable.

Save final assets and prompts under `docs/assets/`. Review at typical README
display width before embedding them. Keep alt text and a text equivalent for
information-bearing diagrams. Use sibling filenames for experiments rather than
overwriting selected artwork.

Generation prompts are recorded in [image-prompts.md](image-prompts.md).

Local visual reference: [orchestra banner](orchestra-banner.png).
