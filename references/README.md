# Synced from dcouple/orchestra - do not edit here

Shared skill-system references: work-item formats, verification methods,
rubrics, and sub-agent role instructions/output formats. One copy serves both
harnesses (Claude and Codex) - skills point here instead of inlining these
documents, so shared contracts have one canonical copy. Skill-specific stage procedures
and private formats live in each skill's own `references/` directory and are
loaded through its entrypoint. Harness-specific dispatch and QA rules stay with
the relevant skill or role.

This directory is a one-way mirror of `references/` in
[dcouple/orchestra](https://github.com/dcouple/orchestra). Any edit made in a
consumer repo is overwritten by the next sync PR. These files are
repo-agnostic - repo-specific knowledge belongs in the consumer repo's
`CLAUDE.md` / `AGENTS.md` / docs.
