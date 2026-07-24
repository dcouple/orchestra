# Artifact-host file uploads

Use this procedure when a skill needs to publish files through the optional
artifact host. The consumer repository owns the configuration:

- Read `artifact_host:` from the `Work-item tracking` section of the
  repository's `AGENTS.md` (or `CLAUDE.md`). If the key is absent, do not use
  the artifact host.
- Read the bearer token from `ARTIFACT_HOST_TOKEN`. Daemon-spawned sessions
  receive this variable automatically when artifact hosting is configured.
  Never print or persist the token.

The wire format is a JSON manifest:

```json
{
  "files": [
    { "path": "item.md", "contentBase64": "IyBJdGVtCg==" },
    { "path": "refs/explainer.html", "contentBase64": "PGgxPkV4cGxhaW5lcjwvaDE+" }
  ]
}
```

Paths use `/` separators and are relative to the bundle root. File contents
are base64 encoded. The root name `index.json` is reserved.

For a work-item bundle, include `item.md`, any present `plan.md` and
`wrapup.md`, and every regular file under `refs/`. This dependency-free Node
snippet writes that manifest to a temporary file. Set `ARTIFACT_HOST` to the
exact configured host value and `ITEM_DIR` to the work-item directory:

```bash
MANIFEST_FILE="$(mktemp)"
node --input-type=module - "$ITEM_DIR" >"$MANIFEST_FILE" <<'NODE'
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const root = process.argv[2];
const files = [];
const add = path => files.push({ path: relative(root, path).split("\\").join("/"), contentBase64: readFileSync(path).toString("base64") });
for (const name of ["item.md", "plan.md", "wrapup.md"]) {
  const path = join(root, name); try { if (statSync(path).isFile()) add(path); } catch {}
}
const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
  const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.isFile()) add(path);
}};
try { walk(join(root, "refs")); } catch {}
process.stdout.write(JSON.stringify({ files }));
NODE
```

Other skills may build the same manifest from their own file set, preserving
the same relative-path and base64 rules.

Create a bundle with authenticated `POST /a`:

```bash
curl --fail-with-body --retry 1 \
  -H "Authorization: Bearer $ARTIFACT_HOST_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "@$MANIFEST_FILE" \
  "$ARTIFACT_HOST/a"
```

The response supplies the server-generated id and stable viewer `url`. Keep
that URL as the bundle identifier. To atomically replace the bundle, rebuild
the complete manifest and send the same request with `-X PUT` to the viewer
URL with its trailing slash removed:

```bash
curl --fail-with-body --retry 1 -X PUT \
  -H "Authorization: Bearer $ARTIFACT_HOST_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "@$MANIFEST_FILE" \
  "${ARTIFACT_BUNDLE_URL%/}"
```

Remove the manifest file after the request. Retry a failed upload once; if
the retry also fails, surface the failure rather than silently continuing.
The calling skill defines whether that failure blocks its larger workflow.

Reads need no authentication:

- `<artifact_bundle_url>` is the self-contained viewer.
- `<artifact_bundle_url>index.json` is a no-cache JSON array of file paths in
  the live version.
- `<artifact_bundle_url><path>` returns a raw file.

Nothing enumerates bundles above their unguessable viewer URLs. Treat the
stable URL as the only read capability and reuse it for later replacements.
