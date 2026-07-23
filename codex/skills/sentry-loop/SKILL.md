---
name: sentry-loop
description: Triage a Sentry window, investigate qualifying clusters, file findings, and annotate Sentry without fixing code.
---

# Sentry Loop — native Codex adapter

Treat `$ARGUMENTS` as the time window. Follow
`.references/workflows/sentry-loop.md` as the authoritative semantic contract.

For each independent qualifying cluster, explicitly start one native
`investigator` custom agent through collaboration tools. Never launch an agent
CLI. Await every required child report before filing. Keep the workflow
report-only and use explicit Codex `$skill` entrypoints for suggested
follow-up work.
