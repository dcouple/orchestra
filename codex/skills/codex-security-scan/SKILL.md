---
name: codex-security-scan
description: "Run or diagnose an authorized repository scan with the official Codex Security plugin, applying repository-specific scope and reporting policy when present. Use for explicit security scans, scheduled scan runs, or Codex Security preflight failures; not for ordinary code review."
---

# Codex Security Scan

Use the official Codex Security plugin for the scan. Do not substitute an ad hoc
model review, dependency audit, or unrelated scanner when the plugin is absent.

## Preflight

1. Confirm that the current session exposes the Codex Security plugin or its
   contributed scan capability.
2. If it is missing, stop before reading repository scan configuration. Tell the
   user to open `/plugins` in Codex CLI, install **Codex Security**, and start a
   new session. Do not install software or switch to API-key billing unless the
   user explicitly asks.
3. If the plugin is installed but reports an authentication, access, or usage
   problem, report that exact condition separately from a scan failure. For
   subscription-backed use, direct the user to authenticate Codex with their
   ChatGPT account; do not silently fall back to an API key.
4. Scan only a repository the user owns or is authorized to assess.

## Repository configuration

Resolve the repository root, then look for
`docs/security/codex-security.md`. Read it completely only when this skill is
invoked and the plugin preflight passes.

- Apply its scope, exclusions, threat model, mode, artifact handling, and
  reporting requirements unless the user explicitly overrides them.
- If it is absent, use a standard, whole-repository, read-only scan and disclose
  that no repository-specific Codex Security configuration was found.
- Treat configuration as scan guidance, not authorization to modify code,
  publish findings, create issues, or open pull requests.

## Run the scan

- Default to a standard, report-only scan. Use deep, diff, or working-tree mode
  only when the user or repository configuration requests it.
- Confirm and report the target revision and scope. For a scheduled scan, follow
  the configured scheduled target rather than assuming the current worktree is
  correct.
- Keep detailed artifacts in the plugin's private state or another location
  outside the repository. Never commit vulnerability reports or source excerpts.
- Do not patch findings, create commits, open pull requests, or publish tracking
  items without separate explicit authorization.
- Let the plugin finish and use its findings and coverage artifacts as the
  source of truth. Partial or unknown coverage is incomplete, not a passing scan.

## Report

Return the scan status, repository and revision, mode and scope, critical/high
findings first, artifact location, and coverage status. Include exclusions,
deferred surfaces, and open questions. When blocked, distinguish among missing
plugin, authentication/access, usage limit, invalid target, scanner failure, and
incomplete coverage, and give the next concrete action.
