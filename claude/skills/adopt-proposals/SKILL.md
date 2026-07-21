---
name: adopt-proposals
description: Sweeps published postmortem comments for open system-change proposals, dedupes them against the current canonical files, and lands the human-approved edits in the canonical skills repo (dcouple/orchestra). Use when the user asks to adopt postmortem proposals, sweep postmortems, or close the loop on postmortem findings — routinely after a batch of /do runs.
argument-hint: "[owner/repo ... to sweep; default: this repo's origin] [window in days, default 30]"
---

# Adopt postmortem proposals

## Sweep: $ARGUMENTS

Postmortems record system-change proposals but never apply them — that is
the postmortem skill's contract. This skill is the other half of the loop:
collect every open proposal, show the human one deduplicated decision
matrix, apply what they approve to the canonical files, and post a verdict
on each swept postmortem so the next sweep skips it. Run it from a checkout
of the canonical skills repo (`dcouple/orchestra`) — that is where edits
land and re-sync to consumers.

## Steps

### 1. Collect
Sweep each repo in $ARGUMENTS (default: this repo's `origin`) for published
postmortems:

```bash
gh api "repos/<repo>/issues/comments?sort=created&direction=desc&per_page=100" \
  --paginate -q '.[] | select(.body | test("^# Postmortem|type: postmortem"))'
```

Stop paginating past the window (default 30 days). From each postmortem,
extract the proposals in its "What to change so it doesn't recur" section:
target file, proposed edit, evidence — each tagged with its source comment
URL. A postmortem whose anchor thread already carries a verdict comment
(first line `# Proposal verdicts`) is settled — skip it.

**Success criteria**: every postmortem in the window is harvested or skipped
as settled; each harvested proposal carries its source URL.

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
or defer each open cluster. This is the skill's one gate; nothing is
applied without it.

### 4. Apply
Make each approved cluster's edit in the canonical file, worded per the
repo's conventions (concise positive rules; evidence and rationale go in
the commit message). One commit per cluster
(`skills: <what changed> (postmortem adoption)`); one PR for the sweep via
the normal branch flow.

### 5. Post verdicts
Reply on every swept postmortem's anchors (the same work-item and PR
threads it was published to), first line `# Proposal verdicts — <date>`,
listing each of its proposals as `adopted (<commit/PR>)`,
`declined — <reason>`, `landed earlier (<commit>)`, or `superseded`. The
verdict comment is the ledger — it is what step 1 of the next sweep reads.

**Success criteria**: every swept postmortem has a verdict reply covering
each of its proposals; approved edits are committed with evidence in the
messages; nothing was applied without step 3's approval.
