# Synced from dcouple/orchestra - do not edit here

Shared skill-system references: work-item formats, verification methods,
rubrics, and sub-agent role instructions/output formats. One copy serves both
harnesses (Claude and Codex) - skills point here instead of inlining these
documents, so there are no duplicates to drift. The shared `pr-writing.md`
reference carries intent provenance and zero-context PR teaching guidance;
`do/references/pr-body.md` remains the PR section and evidence contract for
each runtime.

This directory is a one-way mirror of `references/` in
[dcouple/orchestra](https://github.com/dcouple/orchestra). Any edit made in a
consumer repo is overwritten by the next sync PR. These files are
repo-agnostic - repo-specific knowledge belongs in the consumer repo's
`CLAUDE.md` / `AGENTS.md` / docs.
