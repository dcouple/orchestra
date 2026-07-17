# Tracker lifecycle — shared contract

Used by `/do` and `/prepare-pull-request` whenever a work item or PR is linked
to an external tracker. Tracker hygiene must improve the handoff without
blocking implementation, review, verification, QA, PR creation, or completion.

## Activation and identity

A tracker lifecycle activates only from an **explicit link** supplied by the
invocation, the loaded `item.md` frontmatter, or the published work item. A
configured or available connector is not a link and must never trigger issue
searches or mutations.

For Linear, preserve each canonical issue URL, identifier, and relationship as
one inseparable entry when publishing or loading an item. The canonical
frontmatter representation is always a list, including for one issue:

```yaml
linear_issues:
  - url: https://linear.app/<workspace>/issue/TEAM-123/<slug>
    identifier: TEAM-123
    relationship: completes
```

`relationship` is exactly `completes` (this PR resolves the issue) or `relates`
(context or dependency). Keeping all three values in one entry prevents URLs,
identifiers, and intent from drifting or being reordered across parallel lists.

The identifier parsed from the explicit canonical Linear URL is the mapping
authority, and **YOU MUST** require it to equal the paired `identifier` exactly.
Publication derives and stores that field from the returned canonical URL; it
must not copy an independently supplied value. During `/do` Step 0, parse every
entry's URL and compare the result before any PR line, fetch, or mutation. On a
mismatch, **YOU MUST NOT** guess, search, fetch either candidate, emit a closing
line, or mutate either candidate. Report the mismatch, mark that entry's
lifecycle `unavailable`, and continue non-blockingly. This identity validation
belongs only to preflight and introduces no later prompt.

A matching `TEAM-123` may be used to direct-fetch or mutate that issue; title
similarity, workspace searches, and guessed mappings may not. Exact duplicate
records may deduplicate. If the same identifier appears in entries with a
conflicting URL or relationship, **YOU MUST** mark all conflicting entries
`unavailable`; do not guess, search, fetch, emit a closing line, or mutate for
that identifier. Report the conflict and continue non-blockingly. Only
`completes` entries receive closing keywords or lifecycle completion mutations;
`relates` entries never do. This frontmatter conflict rule does not change
end-of-run hygiene: identical identifiers parsed from valid merged-PR `Fixes`
lines still deduplicate normally.

## Access and failure policy

For `/do`, connector availability, authentication, and required workflow-status
availability are checked only in Step 0, after the item is loaded and before
autonomous execution starts. For every explicitly linked Linear issue, resolve
its team and confirm that team's `In Review` and resolved `Done` statuses are
available. If the Linear connector exists but is unauthenticated, **YOU MUST**
ask for authentication there and only there. If access or a required status
remains unresolved, record that Linear lifecycle work as `unavailable` and
continue.

After `/do` starts autonomous execution, **YOU MUST NOT** prompt for tracker
authentication or let a tracker mutation, readback, verification, or hygiene
failure stop or delay implementation, review, verification, QA, PR work,
handoff, or completion. Attempt what access permits, report the exact failure,
and continue.

`/prepare-pull-request` reuses the mapping and PR-body rules below but does not
own the `/do` lifecycle preflight, status transitions, or authentication
prompts. Missing tracker access there is reported, never escalated into a new
authentication gate.

## PR closing references

**YOU MUST** derive closing lines from explicit completing references, never
from titles:

- GitHub issue completed by the PR: `Closes #123`.
- Linear issue completed by the PR: exact case-sensitive standalone line
  `Fixes TEAM-123`.
- Multiple completing issues: generate one standalone closing line per issue.
- Related-only reference: use non-closing prose or `Refs ...`; never `Closes`
  or `Fixes`.
- No explicit tracker reference: add no tracker line.

Before creating the PR, build the expected set of exact closing lines. After
`gh pr create`, **YOU MUST** retrieve the persisted body from GitHub, verify
that every expected line is present exactly, repair any missing line, and read
back again before leaving PR creation. Perform the same persisted-body check
after every later body edit. Preserve all closing lines while QA updates
checkboxes, QA results, or visual evidence; never trust the local body file or
the edit command's success as proof of persisted state.

## Human-review transition

At the actual handoff — after automated review and QA are complete, immediately
before applying or entering the repo's `awaiting-human-review` state — `/do`
**YOU MUST** attempt to move every explicitly linked Linear issue whose
relationship is `completes` to that issue's team-specific `In Review` status.
An issue whose relationship is `relates` is never moved. Direct-fetch by
identifier, resolve the status for that team, mutate only when needed, then read
the issue back. Report each issue as one of:

- `verified` — moved and read back as `In Review`;
- `already-correct` — read back already in `In Review`;
- `failed` — an attempted fetch, resolution, mutation, or readback failed;
- `unavailable` — Step 0 established that access or the required status was
  unavailable.

This transition is idempotent and non-blocking.

## End-of-run merged-PR hygiene

Before the final `/do` report, **YOU MUST** run this non-blocking repair pass
for prior merged PRs in the current GitHub repository:

1. Enumerate merged PRs in the current repository as candidates, following
   GitHub pagination through every result rather than accepting a CLI/API
   default-page cap, and retrieve their persisted bodies.
2. Parse only case-sensitive standalone lines matching exactly
   `^Fixes ([A-Z][A-Z0-9]*-[0-9]+)\r?$`. Reject Markdown bullets, prefixes,
   suffixes, backticks, trailing text, multiple identifiers on one line, and
   alternate verbs. Ignore titles, prose, branches, and comments.
3. Deduplicate identifiers. Do not scan a Linear workspace, search by title, or
   infer any issue.
4. Direct-fetch only those identifiers. For each issue not already in a
   resolved `Done` status, resolve that issue's team-specific resolved `Done`,
   attempt the mutation, and read back.
5. Report each identifier as `verified`, `already-correct`, `failed`, or
   `unavailable`, using the same meanings as the handoff transition.

The current PR is normally open, so this pass repairs earlier merged PRs whose
integration transition did not land. A related-only reference never enters this
pass because it has no `Fixes` line. Re-running it is safe: already-correct
issues remain unchanged. Any listing, parsing, connector, status, mutation, or
readback failure is reported accurately and never blocks wrap-up, handoff, or
run completion.
