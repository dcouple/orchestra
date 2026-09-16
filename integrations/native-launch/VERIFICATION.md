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
