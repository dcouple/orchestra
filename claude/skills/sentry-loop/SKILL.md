---
name: sentry-loop
description: On-demand Sentry triage loop — sweep every project's errors over a time window, classify each issue (new / recurring / regressed, user-impacting / zero-user, real / noise), root-cause only the clusters that matter, file findings into the work tracker under the loop's label, and annotate Sentry so the state sticks. Use when the user asks to run the sentry loop, triage Sentry, "what's new in Sentry", or wants a period's errors root-caused. Report-only — fixes go through /create-plan then /do.
argument-hint: "[time window, default 7d]"
---

# Sentry Loop — Claude adapter

Treat `$ARGUMENTS` as the time window. Follow
`.references/workflows/sentry-loop.md` as the authoritative semantic contract.

For each independent cluster that earns a deep investigation, dispatch one
detached `investigator` role through the `codex` skill and await all required
reports before filing. Keep this workflow report-only and use Claude
slash-skill names for suggested follow-up work.
