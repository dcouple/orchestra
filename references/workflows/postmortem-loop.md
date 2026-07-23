# Postmortem adoption workflow contract

## Input

The repository set to sweep and an optional window, defaulting to 30 days.

Postmortems record system-change proposals but never apply them — that is
the postmortem workflow's contract. This loop is the other half: collect every
open proposal, show the human one deduplicated decision matrix, apply what
they approve to the canonical files, and post a verdict on each swept
postmortem so the next sweep skips it. Run it from a checkout of the
canonical skill-system source, because that is where edits land and re-sync
to installed copies.

## Steps

### 1. Collect
Sweep each input repository (default: this repo's `origin`) for published
postmortems:

```bash
gh api "repos/<repo>/issues/comments?sort=created&direction=desc&per_page=100" \
  -q '.[] | select(.created_at >= "<since>")
          | select(.body | test("^# Postmortem|type: postmortem"))'
```

Page manually (`?page=N`) and stop once a page's oldest `created_at`
precedes the window (default 30 days) — `--paginate` walks the repo's
entire comment history regardless of the filter. From each postmortem,
extract the proposals in its "What to change so it doesn't recur" section:
target file, proposed edit, evidence — each tagged with its source comment
URL. A postmortem is settled only when its anchor thread carries a verdict
comment (first line `# Proposal verdicts`) that names **that postmortem's
item and source comment URL** and gives every proposal a terminal status —
an anchor thread can host several postmortems, so a verdict for one never
settles another, and a proposal marked `deferred` stays open: harvest it
again on every sweep until a later verdict closes it.

**Success criteria**: every postmortem in the window is harvested or skipped
as settled by its own matching verdict; deferred proposals re-enter the
sweep; each harvested proposal carries its source URL.

### 2. Reconcile
Cluster proposals that target the same file and change substance — the same
fix is typically proposed by several runs. Check every cluster against the
current canonical file: many are already landed or superseded by later
edits. Classify each cluster `open`, `landed (<commit>)`, or
`superseded (<what replaced it>)`.

**Success criteria**: one deduplicated cluster list, each cluster classified
with file-level evidence, no proposal double-counted.

### 3. Decide (human gate)
Present the matrix — cluster · target file · runs citing it ·
classification · the concrete edit — and ask the human to approve, decline,
or defer each open cluster. This is the loop's one gate; nothing is applied
without it.

### 4. Apply
Make each approved cluster's edit in the canonical file, worded per the
repo's conventions (concise positive rules; evidence and rationale go in
the commit message). A cluster that is environment knowledge rather than a
rule change lands in `references/known-issues/` (see its README). One commit per cluster
(`skills: <what changed> (postmortem adoption)`); one PR for the sweep via
the normal branch flow.

### 5. Post verdicts
Reply on every swept postmortem's anchors (the same work-item and PR
threads it was published to), first line
`# Proposal verdicts — <item> — <date>`, with the source postmortem
comment URL on the next line, then each of its proposals as
`adopted (<commit/PR>)`, `declined — <reason>`, `landed earlier (<commit>)`,
`superseded`, or `deferred — <reason>`. The verdict comment is the ledger —
it is what step 1 of the next sweep matches against, and only the terminal
statuses settle a proposal; `deferred` keeps it in play.

**Success criteria**: every swept postmortem has a verdict reply naming its
item and source comment URL and covering each of its proposals; approved
edits are committed with evidence in the messages; nothing was applied
without step 3's approval.
