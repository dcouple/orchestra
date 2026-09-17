import { readFile, writeFile } from "node:fs/promises";
import { readConsoleConfigSnapshot, refreshConsoleConfigSnapshot, snapshotMatchesSource, writeConsoleConfigSnapshot } from "./console-config-snapshot.js";
import { renderManagedEnv, parseManagedEnv } from "./managed-env.js";

const [command, ...args] = process.argv.slice(2);
function usage(): never { throw new Error("usage: managed-env-cli <inspect|render|snapshot|refresh|matches> ..."); }
try {
  if (command === "inspect" && args.length === 1) {
    const doc = parseManagedEnv(await readFile(args[0]!, "utf8"));
    process.stdout.write(`${JSON.stringify({ keys: Object.keys(doc.values).sort() })}\n`);
  } else if (command === "render" && args.length === 3) {
    const changes = JSON.parse(await readFile(args[1]!, "utf8")) as Record<string, string | null>;
    await writeFile(args[2]!, renderManagedEnv(parseManagedEnv(await readFile(args[0]!, "utf8")), changes), { flag: "wx", mode: 0o600 });
  } else if (command === "snapshot" && args.length === 2) {
    await writeConsoleConfigSnapshot(args[0]!, args[1]!);
  } else if (command === "refresh" && args.length === 2) {
    // Revision-preserving for unchanged content: startup must not rotate the
    // revision, or a config.apply resumed across a restart is spuriously
    // rejected by the executor's superseded-revision guard.
    await refreshConsoleConfigSnapshot(args[0]!, args[1]!);
  } else if (command === "matches" && args.length === 2) {
    const matches = await snapshotMatchesSource(await readConsoleConfigSnapshot(args[0]!, Number.MAX_SAFE_INTEGER), args[1]!);
    process.stdout.write(`${JSON.stringify({ matches })}\n`);
    if (!matches) process.exitCode = 1;
  } else usage();
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
