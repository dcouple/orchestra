# CI on Windows GitHub runners

Environment facts for `windows-latest` GitHub runners - consult per this
directory's README; each fact re-derived live costs a full CI round-trip.

- **Corepack/toolcache conflicts.** If a shim shadows the intended install or
  stale signing keys fail with `Cannot find matching keyid`, inspect the
  runner's resolved versions. One supported fallback is a direct pinned install:
  `npm i -g pnpm@<pin>`.
- **The default step shell is pwsh.** Bash-isms need an explicit
  `shell: bash` on the step.
- **npm lifecycle scripts run under cmd.** POSIX install scripts need
  `npm_config_script_shell` pointed at git-bash.
- **Hoisted-linker module discovery.** When electron-builder cannot resolve
  a hoisted dependency, verify its packaging workspace declarations; exact
  local declarations may be needed.
- **Signing:** discover signtool by glob (its versioned path moves between
  images); `Invoke-TrustedSigning` rejects `publisherName` and needs its
  preinstall snippet; signed builds need an RFC3161 timestamp URL.
