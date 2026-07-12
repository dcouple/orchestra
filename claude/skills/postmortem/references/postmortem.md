# Postmortem — format

> Produced by `/postmortem` after `/do` finishes and the human reviews the PR, when the
> result fell short of intent. Saved as `./tmp/<id>/postmortem.md` and published to the
> tracker the repo's `AGENTS.md` `Work-item tracking` section configures, tagged
> `postmortem` (see SKILL.md step 4 for the metadata; no tracker → stays local).
> The point is **compound learning**: fix the root cause in *our system*
> (skill / agent / template / criteria), so the same gap can't recur.

---
```yaml
---
type: postmortem
item: <id>
pr: <url or # of the /do PR — "none" if the failure predates a PR>
anchor: <the PR or issue this postmortem is connected to (same as pr when a PR exists)>
---
```

# Postmortem — `<item>`

## What we asked for
`<the intent + desired end state, briefly>`

## What `/do` delivered vs intended
`<the gap the human found on PR review — concrete>`

## Why the gap happened
`<root cause in OUR system, not just the code: was it a thin ticket? a weak verification`
`criterion? a review blind spot? a missing architecture direction?>`

## What to change so it doesn't recur
`<a concrete improvement to a specific skill / sub-agent / template / verification block>`

## System change
`<URL of this postmortem in the repo's tracker (or "local-only"), plus the approval verdict`
`on the proposed change once the human gives it>`
