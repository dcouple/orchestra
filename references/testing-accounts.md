# Testing accounts - shared convention

How QA-driving agents (frontend-verifier, PR test automation, any app-driving
verification) authenticate against a consumer repo's app. This generalizes the
same pattern as the DB migrator roles: durable, purpose-scoped credentials live
in the org's secret manager, the repo documents only the pointer, and agents
fetch at use time. Credential values never appear in any repo, doc, PR, or
notification.

## The rule

1. **Every app with UI verification criteria has at least one durable testing
   account** in its non-production environment. Throwaway-per-run accounts are
   the bootstrap path, not the steady state: the first run that needs one
   may create it via the app's own signup flow when authorized, then persist
   it under this convention when secret-store and repository writes are also
   authorized. Otherwise report the bootstrap steps for the owner.
2. **Credentials live in the org's secret manager** (the same store the repo's
   secrets tooling already uses - e.g. the GCP project named in the repo's
   secrets mapping). Naming: `TESTING_ACCOUNT_<APP>_<ROLE>` (role defaults to
   `E2E`, e.g. `TESTING_ACCOUNT_ACME_E2E` for an app named Acme). Payload is JSON:
   `{"email", "password", "purpose", "environment"}` - `environment` is never
   `production`.
3. **The repo documents the pointer, never the value.** The repo
   `AGENTS.md` `## Testing accounts` section names each secret, the
   environment it belongs to, and the fetch command. `AGENTS.md`
   specifically: /do's Step 0 preflight and the frontend-verifier read
   that file, not `CLAUDE.md`. E.g.:

   ```
   ## Testing accounts
   - TESTING_ACCOUNT_<APP>_E2E - <env> webapp E2E login (<auth mechanism>).
     Fetch: gcloud secrets versions access latest --secret TESTING_ACCOUNT_<APP>_E2E --project <project>
   ```

4. **Agents fetch at use time.** Pass the secret reference and authorized
   retrieval route, not the value, in the dispatch. Use the environment's
   protected credential mechanism; do not echo fetched values into tool
   output, prompts, transcripts, reports, Grain, captures, or notifications.
   If the verifier cannot retrieve credentials safely, report that gap.
5. **Account hygiene.** Test accounts are never deleted or destructively
   mutated by a run (they are shared infrastructure); test entities created
   inside them carry a unique run marker (`agent-e2e-<timestamp>`) per
   `.references/qa-verification.md` cleanup rules (the path as synced into
   consumer repos). Rotation goes through the
   secret manager (new version), not through the repo.
6. **Preflight probes are executable, not documentary** (restating the /do
   Step 0 rule this file backs): the section existing is half; the named
   secret actually being fetchable with the run's credentials is the other
   half. Probe both, surface either gap in the preflight message.

## Bootstrap procedure (first time for an app)

Run only with authorization for account creation, secret persistence, and
documentation edits. Follow `.references/artifact-storage.md` for safe setup
notes; secret values remain in the secret manager.

1. Generate credentials locally (never echo the password into chat/PRs):
   strong random password, email on a domain the org controls.
2. Create the account through the app's real signup flow in the target
   non-production environment (a scripted browser run - e.g. Playwright - is
   the standard transport; complete onboarding to a usable state).
3. `printf '<json>' | gcloud secrets create TESTING_ACCOUNT_<APP>_E2E
   --data-file=- --project <project>` (or the org's equivalent store).
4. Add the `## Testing accounts` section to the repo's `AGENTS.md`
   and, where the repo keeps deeper docs, a `docs/testing-accounts.md` with
   environment notes.
