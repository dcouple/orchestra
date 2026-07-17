# Tracker lifecycle — shared contract

Used by `/do` and `/prepare-pull-request`. Tracker work is non-blocking hygiene:
report failures accurately and continue implementation, review, verification,
QA, PR creation, handoff, and completion.

## Links and identity

Current-item lifecycle comes from explicit links in the invocation, loaded
`item.md`, or published item. Linear links use an always-list:

```yaml
linear_issues:
  - url: https://linear.app/<workspace>/issue/TEAM-123/<slug>
    identifier: TEAM-123
    relationship: completes
```

`relationship` is exactly `completes` or `relates`. Publication derives the
identifier from the canonical URL. In `/do` Step 0, **YOU MUST** parse it again
and require exact equality with the paired field. Mark an entry `unavailable`
when they differ. Exact duplicates may deduplicate; the same identifier with a
conflicting URL or relationship makes all conflicting entries `unavailable`.

A validated identifier is the mapping authority for direct lookup. Linear title
matching and full-workspace scans are not mapping sources. Only `completes`
entries receive closing lines and lifecycle mutations.

Merged-PR hygiene has a separate explicit-link source: exact Linear closing
lines in persisted bodies of prior merged PRs in the current GitHub repository.
Connector availability alone creates neither kind of link.

## `/do` Step 0 readiness

After loading the current item and before autonomous execution, **YOU MUST**
build and retain two independent operation sets:

1. Current validated `completes` Linear entries, each requiring its issue team's
   `In Review` status for handoff.
2. Every prior merged PR in the current GitHub repository, enumerated through
   all GitHub pagination. Retrieve each persisted body, parse the exact grammar
   below, deduplicate identifiers, and retain the candidates. Each requires its
   issue team's resolved `Done` status for end-of-run hygiene.

Direct-fetch candidate identifiers and discover readiness per issue and per
operation. A missing `In Review` affects only that handoff operation; a missing
`Done` affects only that hygiene operation. A global access failure may make
both sets unavailable.

If either set needs Linear and the connector is unauthenticated, **YOU MUST**
ask for authentication in Step 0 only. Record unresolved access or status
readiness as `unavailable` and continue. After autonomous execution starts,
**YOU MUST NOT** prompt for tracker authentication; all mutations, readbacks,
and hygiene remain non-blocking.

`/prepare-pull-request` uses the identity and PR-body rules without performing
this readiness preflight or prompting for authentication.

## PR closing lines

Generate closing lines only for explicit completing references:

- GitHub: `Closes #123`
- Linear: `Fixes TEAM-123`
- Multiple completing issues: one standalone line per issue
- Related-only or no tracker: no closing line

Before PR creation, build the expected exact line set. After creation and every
later body edit, **YOU MUST** retrieve the persisted body, verify every expected
line, repair omissions, and read it back again. Preserve the set through QA body
updates.

## Human handoff

After automated review and QA, immediately before `awaiting-human-review`,
**YOU MUST** process each ready current-item Linear `completes` operation:
direct-fetch its identifier, move it to its team-specific `In Review` when
needed, and read it back. Report `verified`, `already-correct`, `failed`, or
`unavailable` per issue.

## End-of-run merged-PR hygiene

Before the final report, **YOU MUST** process the retained candidate set. The
case-sensitive parser accepts only lines matching:

```text
^Fixes ([A-Z][A-Z0-9]*-[0-9]+)\r?$
```

Markdown bullets, prefixes, suffixes, backticks, trailing text, multiple IDs,
and alternate verbs do not match. Deduplicate matches, direct-fetch only those
identifiers, move ready non-Done issues to their team-specific resolved `Done`,
and read them back. Report `verified`, `already-correct`, `failed`, or
`unavailable` per identifier. Re-running the pass leaves correct issues
unchanged.
