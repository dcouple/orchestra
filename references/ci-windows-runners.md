# CI on Windows GitHub runners — known issues

Read at plan time by any run whose CI touches `windows-latest`, and carried
into the implementer dispatch. These are runner-environment facts, not
project bugs; each one re-derived live costs a full CI round-trip.

- **corepack is unusable.** The hosted toolcache shim shadows npm-prefix
  installs, and stale bundled signing keys fail with `Cannot find matching
  keyid`. Install the pinned package manager directly:
  `npm i -g pnpm@<pin>`.
- **The default step shell is pwsh.** Bash-isms need an explicit
  `shell: bash` on the step.
- **npm lifecycle scripts run under cmd.** POSIX install scripts need
  `npm_config_script_shell` pointed at git-bash.
- **Hoisted-linker monorepos defeat electron-builder's module discovery.**
  Pin exact versions in the packaging workspace.
- **Signing:** discover signtool by glob (its versioned path moves between
  images); `Invoke-TrustedSigning` rejects `publisherName` and needs its
  preinstall snippet; signed builds need an RFC3161 timestamp URL.
