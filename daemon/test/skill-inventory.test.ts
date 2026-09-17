import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSkillInventory, readSkillInventory, resolveSourceRevision, writeSkillInventory } from "../src/skill-inventory.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "skill-inventory-")); dirs.push(dir); return dir; }
function skill(root: string, source: "claude" | "codex", directory: string, name: string, description: string, version?: string) {
  const dir = join(root, source, "skills", directory); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${version ? `version: ${JSON.stringify(version)}\n` : ""}---\n\n# SECRET BODY\n`);
}
function tree(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = join(prefix, entry.name);
    return entry.isDirectory() ? [relative, ...tree(join(root, entry.name), relative)] : [relative];
  }).sort();
}
function compileInventoryCli(sandbox: string): string {
  const compiled = join(sandbox, "compiled");
  const compile = spawnSync("pnpm", ["exec", "tsc", "--outDir", compiled, "--sourceMap", "false"], {
    cwd: resolve("."), encoding: "utf8", env: process.env,
  });
  expect(compile.status, compile.stderr).toBe(0);
  return join(compiled, "skill-inventory-cli.js");
}
function runInventoryCli(cli: string, args: string[], revision?: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...(revision === undefined ? {} : { SKILL_INVENTORY_SOURCE_REVISION: revision }) },
  });
}

describe("skill inventory", () => {
  it("groups logical names and emits only bounded frontmatter metadata with explicit revision", async () => {
    const root = temp(); skill(root, "claude", "implement", "implement", "Implement approved work.");
    skill(root, "codex", "implementer", "implement", "Different body is not emitted.", "2.1.0");
    skill(root, "codex", "review", "review", "Review a change.");
    const artifact = await generateSkillInventory(root, "a".repeat(40));
    expect(artifact).toEqual({ schemaVersion: 1, sourceRevision: "a".repeat(40),
      sources: [{ id: "claude", label: "Claude Code", available: true, skillCount: 1 },
        { id: "codex", label: "Codex", available: true, skillCount: 2 }],
      skills: [{ name: "implement", description: "Implement approved work.", version: "2.1.0", availability: "available",
        provenance: ["Claude Code", "Codex"], compatibility: ["claude", "codex"] },
        { name: "review", description: "Review a change.", version: null, availability: "available",
          provenance: ["Codex"], compatibility: ["codex"] }] });
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain("SECRET BODY"); expect(serialized).not.toContain(root);
    const output = join(root, "inventory.json"); await writeSkillInventory(output, artifact);
    expect(await readSkillInventory(output)).toEqual({ availability: "available", ...artifact });
  });

  it("rejects canonical root and skill symlink escapes", async () => {
    const parent = temp(); const root = join(parent, "checkout"); mkdirSync(join(root, "claude", "skills"), { recursive: true });
    mkdirSync(join(root, "codex", "skills"), { recursive: true });
    const outside = join(parent, "outside"); skill(outside, "claude", "leak", "leak", "Outside secret metadata.");
    symlinkSync(join(outside, "claude", "skills", "leak"), join(root, "claude", "skills", "leak"));
    await expect(generateSkillInventory(root, "b".repeat(40))).rejects.toThrow("escapes source root");
    const rootLink = join(parent, "root-link"); symlinkSync(join(outside, "claude", "skills"), rootLink);
    rmSync(join(root, "claude", "skills"), { recursive: true }); symlinkSync(rootLink, join(root, "claude", "skills"));
    await expect(generateSkillInventory(root, "b".repeat(40))).rejects.toThrow("escapes checkout");
  });

  it("rejects embedded absolute path metadata while preserving safe semantic slashes and URLs", async () => {
    const root = temp();
    const unsafe = [
      "See (/Users/alice/key)",
      "Look!/var/run/daemon.sock",
      "Read /etc/daemon.env before use",
      String.raw`Read C:\secrets\daemon.env before use`,
      String.raw`Read \\server\share\daemon.env before use`,
      "Open file:///Users/alice/key",
      "Open vscode://file/C:/Users/alice/key",
      "Open custom-editor://open/etc/daemon.env",
      "Open custom-editor:%2Fetc%2Fdaemon.env",
      String.raw`Open custom-editor:%5C%5Cserver%5Cshare%5Cdaemon.env`,
      "Open file:%252F%252F%252FUsers/alice/key",
      "Open vscode://file/C%3A%5CUsers%5Calice%5Ckey",
      "Open https:///etc/daemon.env",
      String.raw`Open https:\etc\daemon.env`,
      "Read ./tmp/private.json before use",
      "Read ../private/secret before use",
    ];
    unsafe.forEach((description, index) => skill(root, "claude", `unsafe-${index}`, `unsafe-${index}`, description));
    skill(root, "claude", "unsafe-version", "unsafe-version", "Safe description", String.raw`C:\secrets\version.txt`);
    const safeDescription = "Run /do and /create-brief; Claude/Codex guidance is at http://example.invalid/docs and https://example.invalid/%2Fdocs/C:/setup.";
    skill(root, "codex", "safe", "safe", safeDescription, "1.2.3/rc1");
    const artifact = await generateSkillInventory(root, "e".repeat(40));
    expect(artifact.skills).toEqual([{ name: "safe", description: safeDescription, version: "1.2.3/rc1",
      availability: "available", provenance: ["Codex"], compatibility: ["codex"] }]);
    expect(artifact.sources).toMatchObject([{ id: "claude", skillCount: 0 }, { id: "codex", skillCount: 1 }]);
  });

  it("reports bounded accepted/rejected diagnostics without exposing rejected metadata",async()=>{
    const root=temp();skill(root,"claude","safe","safe","Run /do to continue.");
    skill(root,"claude","unsafe","unsafe","Read ./tmp/SECRET_DIAGNOSTIC_SENTINEL first.");
    mkdirSync(join(root,"codex","skills"),{recursive:true});
    const diagnostics:Array<{source:string;outcome:string;reason:string}>=[];
    const artifact=await generateSkillInventory(root,"9".repeat(40),entry=>diagnostics.push(entry));
    expect(artifact.skills.map(row=>row.name)).toEqual(["safe"]);
    expect(diagnostics).toEqual([{source:"claude",outcome:"accepted",reason:"valid"},
      {source:"claude",outcome:"rejected",reason:"invalid_metadata"}]);
    expect(JSON.stringify(diagnostics)).not.toContain("SECRET_DIAGNOSTIC_SENTINEL");
  });

  it("rejects installed absolute path metadata and accepts safe slash-containing metadata", async () => {
    const root = temp(); skill(root, "claude", "safe", "safe",
      "Claude/Codex read/write docs: http://example.invalid/a and https://example.invalid/%2Fdocs/C:/b.", "2.0/rc1");
    mkdirSync(join(root, "codex", "skills"), { recursive: true });
    const artifact = await generateSkillInventory(root, "f".repeat(40)); const path = join(root, "inventory.json");
    await writeSkillInventory(path, artifact);
    await expect(readSkillInventory(path)).resolves.toMatchObject({ availability: "available",
      skills: [{ description: "Claude/Codex read/write docs: http://example.invalid/a and https://example.invalid/%2Fdocs/C:/b.", version: "2.0/rc1" }] });
    for (const unsafe of ["See (/Users/alice/key)", "/etc/daemon.env", String.raw`C:\secrets\daemon.env`,
      String.raw`\\server\share\daemon.env`, "file:///Users/alice/key", "vscode://file/C:/Users/alice/key",
      "custom-editor://open/etc/daemon.env", "custom-editor:%2Fetc%2Fdaemon.env",
      String.raw`custom-editor:%5C%5Cserver%5Cshare%5Cdaemon.env`,
      "file:%252F%252F%252FUsers/alice/key", "vscode://file/C%3A%5CUsers%5Calice%5Ckey"]) {
      const malformed = structuredClone(artifact); malformed.skills[0]!.description = unsafe;
      writeFileSync(path, JSON.stringify(malformed));
      await expect(readSkillInventory(path)).resolves.toEqual({ availability: "unavailable", reasonCode: "malformed",
        sourceRevision: null, sources: [], skills: [] });
      malformed.skills[0]!.description = "Safe prose"; malformed.skills[0]!.version = unsafe;
      writeFileSync(path, JSON.stringify(malformed));
      await expect(readSkillInventory(path)).resolves.toMatchObject({ availability: "unavailable", reasonCode: "malformed" });
    }
  });

  it("returns bounded unavailable states for missing, oversized, and malformed installed manifests", async () => {
    const root = temp(); const path = join(root, "inventory.json");
    expect(await readSkillInventory(path)).toMatchObject({ availability: "unavailable", reasonCode: "missing", skills: [] });
    writeFileSync(path, "x".repeat(300_000));
    expect(await readSkillInventory(path)).toMatchObject({ availability: "unavailable", reasonCode: "too_large", skills: [] });
    writeFileSync(path, '{"token":"SECRET","skills":[]}');
    const malformed = await readSkillInventory(path);
    expect(malformed).toEqual({ availability: "unavailable", reasonCode: "malformed", sourceRevision: null, sources: [], skills: [] });
    expect(JSON.stringify(malformed)).not.toContain("SECRET");
    expect(() => resolveSourceRevision(root, "not-a-commit")).toThrow("revision is invalid");
  });

  it("resolves a strict revision from a real local Git source checkout", () => {
    const root = temp(); writeFileSync(join(root, "tracked"), "inventory source\n");
    for (const args of [["init"], ["config", "user.name", "Inventory Test"], ["config", "user.email", "inventory@example.invalid"],
      ["add", "tracked"], ["-c", "commit.gpgSign=false", "commit", "-m", "inventory fixture"]]) {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(resolveSourceRevision(root)).toBe(revision);
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it("runs the explicit inventory build contract twice with byte-identical output and no state growth", () => {
    const sandbox = temp(); const sourceRoot = join(sandbox, "checkout");
    skill(sourceRoot, "claude", "shared", "shared", "Shared skill.");
    skill(sourceRoot, "codex", "shared-copy", "shared", "Shared skill.");
    const installed = join(sandbox, "installed");
    mkdirSync(installed);
    const cli = compileInventoryCli(sandbox);
    const output = join(installed, "console-inventory.json");
    const revision = "c".repeat(40); const sourceBefore = tree(sourceRoot);
    const run = () => runInventoryCli(cli, ["--source-root", sourceRoot, "--output", output], revision);
    const first = run(); expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toBe("skill-inventory-cli: accepted=2 rejected=0\n");
    const firstBytes = readFileSync(output); const stateAfterFirst = tree(installed);
    const second = run(); expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toBe(first.stderr);
    expect(readFileSync(output)).toEqual(firstBytes);
    expect(tree(installed)).toEqual(stateAfterFirst);
    expect(tree(sourceRoot)).toEqual(sourceBefore);
    expect(stateAfterFirst).toEqual(["console-inventory.json"]);
    expect(JSON.parse(firstBytes.toString("utf8"))).toMatchObject({ sourceRevision: revision,
      skills: [{ name: "shared", compatibility: ["claude", "codex"] }] });
    expect(tree(installed).some(path => /(?:claude|codex)[/\\]skills|SKILL\.md/.test(path))).toBe(false);
  }, 30_000);

  it("normalizes executable failures without paths, secrets, raw errors, or stack traces", () => {
    const sandbox = temp(); const cli = compileInventoryCli(sandbox); const revision = "d".repeat(40);
    const validSource = join(sandbox, "VALID_SOURCE_PATH_SENTINEL");
    skill(validSource, "claude", "safe", "safe", "Safe metadata.");
    mkdirSync(join(validSource, "codex", "skills"), { recursive: true });

    const missing = runInventoryCli(cli, ["--source-root", validSource]);
    const malformed = runInventoryCli(cli, ["--unknown", "ARGUMENT_SECRET_SENTINEL", "--output", join(sandbox, "out.json")]);
    const invalidRevision = runInventoryCli(cli, ["--source-root", validSource, "--output", join(sandbox, "out.json")],
      "INVALID_REVISION_SECRET_SENTINEL");

    const outside = join(sandbox, "OUTSIDE_SOURCE_PATH_SENTINEL");
    skill(outside, "claude", "leak", "leak", "SOURCE_BODY_SECRET_SENTINEL");
    const sourceEscape = join(sandbox, "SOURCE_ESCAPE_PATH_SENTINEL");
    mkdirSync(join(sourceEscape, "claude"), { recursive: true });
    mkdirSync(join(sourceEscape, "codex", "skills"), { recursive: true });
    symlinkSync(join(outside, "claude", "skills"), join(sourceEscape, "claude", "skills"));
    const escapedSource = runInventoryCli(cli, ["--source-root", sourceEscape, "--output", join(sandbox, "escaped.json")], revision);

    const skillEscape = join(sandbox, "SKILL_ESCAPE_PATH_SENTINEL");
    mkdirSync(join(skillEscape, "claude", "skills"), { recursive: true });
    mkdirSync(join(skillEscape, "codex", "skills"), { recursive: true });
    symlinkSync(join(outside, "claude", "skills", "leak"), join(skillEscape, "claude", "skills", "leak"));
    const escapedSkill = runInventoryCli(cli, ["--source-root", skillEscape, "--output", join(sandbox, "escaped-skill.json")], revision);

    const nonDirectoryParent = join(sandbox, "OUTPUT_PATH_SECRET_SENTINEL");
    writeFileSync(nonDirectoryParent, "OUTPUT_BODY_SECRET_SENTINEL");
    const unwritable = runInventoryCli(cli,
      ["--source-root", validSource, "--output", join(nonDirectoryParent, "inventory.json")], revision);

    const cases = [
      [missing, 2, "skill-inventory-cli: invalid_arguments\n"],
      [malformed, 2, "skill-inventory-cli: invalid_arguments\n"],
      [invalidRevision, 2, "skill-inventory-cli: invalid_source_revision\n"],
      [escapedSource, 1, "skill-inventory-cli: source_escape\n"],
      [escapedSkill, 1, "skill-inventory-cli: source_escape\n"],
      [unwritable, 1, "skill-inventory-cli: output_unwritable\n"],
    ] as const;
    for (const [result, status, stderr] of cases) {
      expect(result.status).toBe(status); expect(result.stdout).toBe(""); expect(result.stderr).toBe(stderr);
      expect(result.stderr).not.toContain(sandbox);
      expect(result.stderr).not.toMatch(/SECRET_SENTINEL|SOURCE_BODY|OUTPUT_BODY|Error:|\bat\s|file:\/\//);
    }
  }, 30_000);
});
