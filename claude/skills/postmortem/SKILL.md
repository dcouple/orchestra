---
name: postmortem
description: Runs a postmortem after /do finished and the human reviewed the PR, when the result fell short of intent. Use when the user says a /do run missed the mark, the PR needed rework, the delivered feature didn't match the ticket, or asks "why did /do get this wrong" — or when any workflow skill (/discussion, /create-*) produced the wrong outcome. Root-causes the gap in our system and proposes one concrete improvement.
argument-hint: "[PR url/# or work-item id]"
---

# Postmortem

## Target: $ARGUMENTS

Compound learning: when a `/do` run fell short of intent — or another workflow
skill produced the wrong outcome (a ticket the gate should have killed, a skill
that fired at the wrong moment) — find the root cause in **our system** — the
skills, agents, templates, and criteria — not just the code. The completion
artifact is `./tmp/<id>/postmortem.md`, published to the tracker the current
repo's `AGENTS.md` `Work-item tracking` section configures (postmortems live
with the repo the run happened in; no tracker configured → local-only),
plus one proposed (not applied) system change.

This skill changes nothing: no code fixes, no skill edits. If the code itself needs
fixing, that goes through `/create-issue` then `/do`; the proposed system change is
presented for the human to approve, not applied.

## Steps

### 1. Load the record
Resolve `<id>` from $ARGUMENTS (a work-item id directly, or match a PR to the `pr:` field
across `./tmp/*/item.md`). Then read:
- `./tmp/<id>/item.md` — what we asked for
- `./tmp/<id>/plan.md` — what `/do` planned
- `./tmp/<id>/wrapup.md` — what `/do` claims it delivered and verified
- PR feedback — `gh pr view <pr> --comments` and the review threads, or ask the user to
  paste it if it lives outside GitHub

**Success criteria**: all four sources loaded (or their absence noted — a missing wrapup
is itself a finding).

### 2. Establish the gap [human]
Discuss with the human what fell short: delivered vs intended, concretely. Anchor on the
item's intent and ACs — did `/do` miss the ticket, or did the ticket miss the intent?

**Success criteria**: the gap is stated in one or two concrete sentences the human agrees
with.

### 3. Root-cause it in OUR system
Trace the gap upstream through the pipeline and name where it entered:
- **Thin ticket** — intent or end state under-specified, so `/do` optimized the wrong thing
- **Weak AC** — verification criteria passed while the intent failed (untestable or
  mis-aimed criteria)
- **Missing direction** — a decision the model shouldn't have made alone wasn't locked
- **Review blind spot** — a reviewer should have caught it and the report shows it didn't
- **Skill/agent gap** — a pipeline stage lacks an instruction this failure needed

The code defect (if any) is a symptom here. Note it, and route the fix through
`/create-issue` then `/do` — not this skill.

**Success criteria**: one primary system-level cause identified, with evidence from the
step-1 documents (quote the thin section, the weak AC, the review miss).

### 4. Write the postmortem
Write `./tmp/<id>/postmortem.md` following this skill's `references/postmortem.md` —
emit the filled-in frontmatter and body only; the template's "— format" header and
guidance quotes are authoring notes, not output.

Then publish it to the tracker the current repo's `AGENTS.md` `Work-item
tracking` section configures — postmortems are kept with the repo the run
happened in. If no tracker is configured, skip publishing: the postmortem
stays in `./tmp/<id>/postmortem.md` and you tell the user so. When
publishing, use this metadata:
- **Label/tag**: `postmortem` (create it if the tracker supports labels and
  it's missing)
- **Anchor**: the artifact the postmortem is about — the `/do` PR if one
  exists, else the published work item, else none (e.g. a failure inside
  a `/create-*` run before anything was published)
- **Title**: `Postmortem: <repo>#<anchor#> — <one-line gap>` (drop the
  `<repo>#<anchor#>` part only when there is no anchor)
- **Body**: the postmortem body (frontmatter stripped), ending with links to
  the work item and the anchor PR/issue

Record the published postmortem's URL in postmortem.md's "System change"
section. Then
**connect it back**: comment on the anchor PR/issue with a one-liner linking
the postmortem issue, so the connection is visible from both sides — someone
reading the PR/issue later must be able to find the postmortem without
searching the issue list.

**Success criteria**: `postmortem.md` exists, the "why the gap happened" section names
the system cause (not just the code defect), the postmortem is published per the
repo's tracker instructions with its URL recorded (or kept local and the user told,
when no tracker is configured), and the anchor PR/issue (when one exists) carries a
comment linking back to it.

### 5. Propose ONE system change [human checkpoint]
Propose exactly one concrete change to one specific file — a skill, sub-agent, template,
or criteria block, named by its path in the canonical skills repo
(`dcouple/orchestra` — e.g. `claude/skills/discussion/SKILL.md`,
`references/verification-criteria.md`, `claude/agents/code-reviewer.md`).
The copies in each consumer repo (`.claude/`, `.codex/`, `.references/`) are synced
mirrors — the edit lands in orchestra and re-syncs. Quote the file path and show the
proposed edit.

Do **not** apply it. Present it for the human to approve; record the proposal (and the
verdict, if given now) in postmortem.md's "What to change so it doesn't recur" section.
One change per postmortem — the highest-leverage one — so each fix is attributable.

**Success criteria**: proposal names an exact file and shows the concrete edit; nothing
outside `./tmp/<id>/` was modified.

```
Suggested next steps:
- `/create-issue [defect]` then `/do ./tmp/<id>/item.md` — fix the code gap itself
- Apply the approved system change in a normal editing session, then commit it
```
