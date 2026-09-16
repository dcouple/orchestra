# Native launch prototype verification

The original Python compatibility checks on 2026-09-15 used Claude Code 2.1.273 and Codex 0.154.0.

- The original 11 Python compiler/runtime tests passed before the TypeScript port.
- Both native TUIs opened concurrently in the same scratch repository and read its instruction marker. Each loaded its separately generated proof skill.
- A generated Claude dispatch script launched the generated Codex child and loaded its selected skill. The headless child's public MCP call required approval and did not complete; unattended tool approval remains unresolved.
- Claude called Keycard's GitHub `get_me` tool using its existing native authentication without another browser login.
- After a separate Codex native OAuth login, a fresh generated Codex runtime connected to `orchestra_keycard` with 57 tools without another browser login. It called `mcp__orchestra_keycard__api_githubcopilot__get_me` successfully. The probe returned only a success indicator, without account details.

The Codex result verifies immediate credential reuse through the prototype's separate runtime home and native credential references. It does not prove token refresh after expiry, reuse on another machine, or access to every upstream service. Existing user-level MCP registrations remain visible in Codex; this prototype does not isolate their tool inventory.

The prototype is not the production launcher. Full profile inheritance, workflow dependency packaging, delegation policies, and production authentication lifecycle handling still require implementation and verification.

## TypeScript port

The native launcher now uses Node 22.15+ on macOS/Linux, TypeScript and pinned YAML parsing. The Python launcher sources were removed; already generated Python bundles retain their copied runtime.

The port has 13 Node tests covering the original contracts plus duplicate YAML keys, symlink rejection, child directory collisions, and real subprocess handoff with literal arguments, cwd, native credential references and exit status. Standalone generated child dispatch runs without importing the CLI package. Both installed Codex workflow profiles compile with the Keycard workspace. Full workflow execution, OAuth renewal and unattended approvals remain unverified.

Live TypeScript CLI smoke check: native Claude and Codex TUIs opened in the scratch repository with the selected models; Codex connected to Keycard and listed 57 tools without a new login. The authenticated GitHub tool-call proof above was performed before the language port.

## Profile/agent split and native roles (2026-09-16)

- Typecheck and 19 tests pass, including whole-model replacement, appended
  profile instructions, legacy commands, connection inheritance, and generated
  native child definitions for Claude and Codex.
- Installed three referencing profiles and eleven agent definitions under the
  local central configuration root. Previous profile files were backed up.
- Compiled planner, Astra planner, and implementer with the Keycard workspace.
- Live Codex 0.154.0 accepted `--strict-config` with generated role registrations
  and reported `socrates`, `pr-preparer`, and `qa` in its native spawn tool schema.
- Live Claude Code accepted the generated CLI agent definitions; Fable 5.1
  reported Socrates in its native Agent tool schema. Result metadata confirmed
  the Fable model and no subagents spawned.
- These were read-only registration checks, not end-to-end child execution,
  child model/effort verification, follow-up/resume, or new MCP call tests.
  Native skill selections are explicit bundled paths in role instructions,
  not isolated skill discovery catalogs. Existing global skills remain visible.

## Markdown instructions and workflow-role audit (2026-09-16)

- 22 tests cover directory definitions, ordered Markdown composition, profile
  append behavior, missing/out-of-root files, ambiguous sources, and bundle
  invalidation when instruction text changes.
- A shipped-profile graph test checks all ten implementation children, their
  exact Luna Max/Sol Medium choices, packaged skills, and generated role files.
- All five current/legacy entry points compiled locally with installed skills
  and Keycard: the two ticket-creator entry points declare Socrates, and both
  implementer entry points declare all ten roles. Claude planner declares its
  native Fable Socrates.
- Audited create-ticket, astra-ticket and installed supporting skill Markdown.
  Added the previously implicit fresh-context cold-reader role. Frontend/browser
  and backend verification belong to Astra's pr-test-automation QA role; the
  separate Orchestra /do verifiers are not part of these workflows.
- No live child execution or external publication was performed for this
  migration. Earlier live registration checks remain documented above.

## User-level skill load/unload

- 29 tests pass, including seven user-skill tests exercising shared ownership,
  idempotence, non-destructive collision handling, replaced links, missing source
  files, harness overrides, and original Codex home selection.
- CLI `load`, `loaded`, and `unload` completed successfully in an isolated home.
- Actual user-level skills were not changed during verification. Native discovery
  after a global load has not been exercised against a live model in this change.

## Single-file Markdown agents and entry-only profiles

- 30 tests pass. Tests verify Markdown frontmatter parsing, instruction includes,
  malformed/duplicate metadata rejection, and rejection of behavior in profiles.
- All five installed entry points compile with their expected models, skills,
  Keycard connections, and one or ten native children. Previous installed
  definitions were backed up before migration.
- No new live model or child execution was performed for this format migration.

## Skill metadata naming

- 32 tests pass, including Codex output mapping, Claude omission, byte-preserved
  invocation policy, metadata-sensitive bundle hashes, ambiguous-source
  rejection, and global load/unload with translated native layouts.
- Migrated create-ticket, explain-visually, and pr-test-automation in the local
  central configuration to metadata/codex.yaml with backups and SHA-256
  equality checks. All three pass the skill-creator validator.
- Planner, Astra planner, and implementer compile against the migrated files;
  Codex metadata matches source bytes and Claude output omits it. Live model
  invocation/discovery was not repeated for this filename migration.

## Configuration cleanup and live child checks (2026-09-16)

- 34 tests pass. New coverage requires explicit child launch modes and verifies
  that inspection reports resolved source paths, child models and MCP endpoints
  without generating bundles.
- Added `orchestra profiles list` and `orchestra inspect NAME --workspace NAME`.
  Added the explicit `astra-implementer-high` profile; old Codex entry-point
  names remain compatibility aliases. Medium Fast remains `implementer`.
- Archived two obsolete local YAML definitions under central `backups/`.
  Audited and retained 5 checkout bundles and 29 scratch bundle manifests:
  existing sessions can still reference those immutable inputs.
- Live Codex Astra High spawned native Socrates once with fresh context. The
  child rollout `01a0abfb-68cf-78f3-88df-ed15cfc7d2e3` records Luna Max in both
  turn contexts. It read the skill/rubric, completed Keycard GitHub get_me,
  and retained the test marker on the same child's follow-up. The actual tool
  output reports status success and isError false; account contents omitted.
- Live Claude Fable 5.1 spawned Socrates `a7bc00ed9af8b9d98`, read the bundled
  skill/rubric, and resumed that same child with the marker. Its child transcript
  records claude-fable-5-1. Effective reasoning effort is not exposed there;
  the generated role requests High, which is not independent runtime proof.
- Claude's first headless get_me call was blocked by native permissions. A
  separate test allowed only `mcp__orchestra_keycard__api-githubcopilot__get_me`
  via a process-local CLI flag: child `aca730b78229012e1` called it successfully,
  with no permission denials. No saved permission or OAuth settings changed.
- Tests made no repository edits or external writes. Raw test logs and private
  native transcripts remain local; no account response data is published here.
