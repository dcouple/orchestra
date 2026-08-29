import { resolve } from "node:path";
import { generateSkillInventory, resolveSourceRevision, writeSkillInventory } from "./skill-inventory.js";

type FailureCode =
  | "invalid_arguments"
  | "invalid_source_revision"
  | "source_escape"
  | "source_rejected"
  | "output_unwritable"
  | "internal_failure";

class CliFailure extends Error {
  constructor(readonly code: FailureCode, readonly exitCode: 1 | 2) {
    super(code);
  }
}

function parseArguments(args: string[]): { sourceRoot: string; output: string } {
  if (args.length !== 4) throw new CliFailure("invalid_arguments", 2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if ((name !== "--source-root" && name !== "--output") || !value || value.startsWith("--") || options.has(name)) {
      throw new CliFailure("invalid_arguments", 2);
    }
    options.set(name, value);
  }
  const sourceRoot = options.get("--source-root"); const output = options.get("--output");
  if (!sourceRoot || !output) throw new CliFailure("invalid_arguments", 2);
  return { sourceRoot, output };
}

async function main(): Promise<void> {
  const { sourceRoot, output } = parseArguments(process.argv.slice(2));
  const canonicalSource = resolve(sourceRoot);
  let revision: string;
  try {
    revision = resolveSourceRevision(canonicalSource, process.env.SKILL_INVENTORY_SOURCE_REVISION?.trim() || undefined);
  } catch {
    throw new CliFailure("invalid_source_revision", 2);
  }
  let artifact;
  try {
    artifact = await generateSkillInventory(canonicalSource, revision);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new CliFailure(message.includes("escapes ") ? "source_escape" : "source_rejected", 1);
  }
  try {
    await writeSkillInventory(resolve(output), artifact);
  } catch {
    throw new CliFailure("output_unwritable", 1);
  }
}

try {
  await main();
} catch (error) {
  // Exit 2 denotes a rejected invocation/revision; exit 1 denotes a source/output failure.
  const failure = error instanceof CliFailure ? error : new CliFailure("internal_failure", 1);
  process.stderr.write(`skill-inventory-cli: ${failure.code}\n`);
  process.exitCode = failure.exitCode;
}
