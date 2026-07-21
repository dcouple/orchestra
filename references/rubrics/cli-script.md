# Rubric — CLI / script change

1. **[blocker]** Exit-code contract proven: success exits 0, each failure
   mode exits non-zero. Evidence: both invocations with `echo $?`.
2. **[blocker]** Idempotency: run twice; the second run is a no-op or says
   why not. Evidence: both outputs.
3. **[blocker]** State-mutating scripts have `--dry-run`, and its output was
   captured. Evidence: dry-run output.
4. Bad input handled: a malformed argument/file produces a clear error, not
   a stack trace. Evidence: the error output.
5. Help text (`--help`) matches actual behavior after the change.
6. Critical assertions use explicit failure branches
   (`if ! cmp …; then …; exit 1; fi`) — never a bare `[[ ]]`/`grep` whose
   `set -e` behavior varies by Bash version; macOS-targeted suites also run
   under `/bin/bash` 3.2. Evidence: the assertion source + the 3.2 run.

Known failure modes: exit 0 on partial failure (CI gates on the code, not
the log); depends on the author's shell env; destructive default with no
dry run; assertions that pass on modern Bash but false-pass under macOS
`/bin/bash` 3.2.
