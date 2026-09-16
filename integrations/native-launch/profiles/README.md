# Codex workflow identities

These profiles match the `dcouple/skills` workflows at revision
`5b0f704cd8eabff98d53e1a4a57f0acb76fc39aa`:

- `codex-issue-creator`: `$create-ticket` plus its `explain-visually` dependency.
- `codex-implementer`: `$astra-ticket` and the planning, implementation, PR,
  review and QA skills listed in its profile.

Both use Codex with GPT-6 Astra, high reasoning effort. The implementation
workflow verifies the actual parent model and requires Luna Max workers and
Sol Medium QA. Those requirements remain in the original skill; the profile
uses native Codex subagents rather than headless generated dispatch scripts.
It must stop if required native model/delegation capabilities are unavailable.

The profiles and 17 shared skill trees are installed on the development Mac in
`~/.config/orchestra/{agents,skills}`. The local `keycard` workspace supplies the
previously authenticated gateway. Secrets are not present in these profiles.
`~/.config/orchestra/codex-profile-provenance.json` records the installed source
revision and path for every skill.

From the Orchestra checkout:

```sh
uv run --script integrations/native-launch/prototype.py codex-issue-creator \
  --workspace keycard --directory /absolute/path/to/repo

uv run --script integrations/native-launch/prototype.py codex-implementer \
  --workspace keycard --directory /absolute/path/to/repo \
  --message 'Use $astra-ticket for owner/repo#123'
```

Omit `--message` to wait in the native TUI. Replace the example issue identifier
with the intended work item. Omit `--workspace keycard` for no workspace
connection additions; existing native global MCP registrations can still appear.
Follow the parent README's Git exclusion guidance for generated bundles.

On another machine, copy these YAML files into the central `agents/` directory
and copy each listed skill directory, including all support files, from
`parsa/.codex/skills/<name>/` at the revision above into `skills/<name>/`.
The exception is `review`, which comes from `parsa/.claude/skills/review/` and
includes `CRITERIA.md`. The implementation profile explicitly selects that
bundled copy instead of relying on a separately installed Claude skill.
Set up the workspace endpoint and native login independently on that machine.

Both installed profiles successfully compiled with Keycard into separate bundles
in the same scratch repository. This verifies configuration and file packaging,
not an end-to-end issue publication or implementation run. Grain access depends
on the user's connected native tools/CLI; Keycard availability alone does not
establish Grain access.
