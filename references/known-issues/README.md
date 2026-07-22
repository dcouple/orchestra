# Known issues — environment fact pages

One page per environment, each a short list of facts about that environment
that runs otherwise re-derive live — runner quirks, toolchain traps,
platform defaults. These are environment facts, not project bugs, and they
stay repo-agnostic like everything in `references/`.

- **Consult at plan time.** A run whose change touches a listed environment
  reads the matching page and carries it into the implementer dispatch —
  each fact re-derived live costs a round-trip against that environment.
- **Pages grow from postmortems.** When `/postmortem-loop` finds a proposal
  cluster that is environment knowledge rather than a rule change, it lands
  here — as a new page or a bullet on an existing one.
- Keep each page under ~25 lines: one bullet per fact, the symptom named,
  the working alternative stated.

## Pages

- `windows-github-runners.md` — CI on `windows-latest` GitHub runners
