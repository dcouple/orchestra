import { spawnSync } from "node:child_process";
import { readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export type SkillSourceId = "claude" | "codex";
export interface SkillInventorySource {
  id: SkillSourceId;
  label: "Claude Code" | "Codex";
  available: boolean;
  skillCount: number;
}
export interface SkillInventoryEntry {
  name: string;
  description: string;
  version: string | null;
  availability: "available";
  provenance: Array<"Claude Code" | "Codex">;
  compatibility: SkillSourceId[];
}
export interface SkillInventoryArtifact {
  schemaVersion: 1;
  sourceRevision: string;
  sources: SkillInventorySource[];
  skills: SkillInventoryEntry[];
}
export type ConsoleSkillsPayload =
  | ({ availability: "available" } & SkillInventoryArtifact)
  | { availability: "unavailable"; reasonCode: "missing" | "not_regular" | "too_large" | "malformed"; sourceRevision: null; sources: []; skills: [] };

const SOURCE_DEFS = [
  { id: "claude" as const, label: "Claude Code" as const, relative: "claude/skills" },
  { id: "codex" as const, label: "Codex" as const, relative: "codex/skills" },
];
const MAX_SKILLS_PER_SOURCE = 128;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024;

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function scalar(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(frontmatter);
  if (!match) return undefined;
  const raw = match[1]!.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    if (raw.startsWith('"')) {
      try { const value = JSON.parse(raw) as unknown; return typeof value === "string" ? value : undefined; }
      catch { return undefined; }
    }
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

function containsAbsolutePath(value: string): boolean {
  const withoutUrls = value.replace(/\bhttps?:\/\/[^\s'"`<>]+/gi, candidate => {
    if (candidate.includes("\\") || !/^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(candidate)) return candidate;
    try {
      const url = new URL(candidate);
      return (url.protocol === "http:" || url.protocol === "https:")
        && url.hostname && !url.username && !url.password ? "" : candidate;
    } catch { return candidate; }
  });
  const pathDecoded = withoutUrls.replace(/%(?:25)*(2f|5c|3a)/gi, (_, encoded: string) =>
    encoded.toLowerCase() === "2f" ? "/" : encoded.toLowerCase() === "5c" ? "\\" : ":");
  const posix = /(?:^|[^A-Za-z0-9._~%+\/\\-])\/(?!\/)[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%+-]+)*/;
  const drive = /[A-Za-z]:[\\/][^\s'"`<>]+/;
  const unc = /(?:^|[^A-Za-z0-9._~%+\/\\-])(?:\\\\|\/\/)[^\\/\s'"`<>]+[\\/][^\s'"`<>]+/;
  const localPathUri = /\b[a-z][a-z0-9+.-]*:(?:[\\/]{3,}|[\\/](?![\\/])|[\\/]{2}[^\\/\s'"`<>]+[\\/])[^\s'"`<>]*/i;
  return posix.test(pathDecoded) || drive.test(pathDecoded) || unc.test(pathDecoded)
    || localPathUri.test(pathDecoded);
}

function boundedText(value: string | undefined, max: number): string | undefined {
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)
    || containsAbsolutePath(value)) return undefined;
  return value;
}

async function readSkill(path: string): Promise<{ name: string; description: string; version: string | null } | undefined> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_SKILL_BYTES) return undefined;
  const text = await readFile(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  const name = boundedText(scalar(match[1]!, "name"), 64);
  const description = boundedText(scalar(match[1]!, "description"), 500);
  const rawVersion = scalar(match[1]!, "version");
  const version = rawVersion === undefined ? null : boundedText(rawVersion, 64);
  if (!name || !description || version === undefined || !/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(name)) return undefined;
  return { name, description, version };
}

export function resolveSourceRevision(sourceRoot: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (!/^[0-9a-fA-F]{40}$/.test(explicit)) throw new Error("skill inventory source revision is invalid");
    return explicit.toLowerCase();
  }
  const result = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8", timeout: 2_000, shell: false, env: { PATH: process.env.PATH ?? "" },
  });
  const revision = result.status === 0 ? result.stdout.trim() : "";
  if (!/^[0-9a-fA-F]{40}$/.test(revision)) throw new Error("skill inventory source revision is unavailable");
  return revision.toLowerCase();
}

export async function generateSkillInventory(sourceRoot: string, sourceRevision: string): Promise<SkillInventoryArtifact> {
  const root = await realpath(resolve(sourceRoot));
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error("skill inventory source revision is invalid");
  const grouped = new Map<string, SkillInventoryEntry>();
  const sources: SkillInventorySource[] = [];
  for (const source of SOURCE_DEFS) {
    let sourceRootReal: string;
    try { sourceRootReal = await realpath(join(root, source.relative)); }
    catch { sources.push({ id: source.id, label: source.label, available: false, skillCount: 0 }); continue; }
    if (!contained(root, sourceRootReal)) throw new Error("skill inventory source escapes checkout");
    const entries = (await readdir(sourceRootReal, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > MAX_SKILLS_PER_SOURCE) throw new Error("skill inventory source has too many entries");
    let skillCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const lexicalFile = join(sourceRootReal, entry.name, "SKILL.md");
      let file: string;
      try { file = await realpath(lexicalFile); }
      catch { continue; }
      if (!contained(sourceRootReal, file) || !contained(root, file)) throw new Error("skill inventory skill escapes source root");
      const skill = await readSkill(file);
      if (!skill) continue;
      skillCount += 1;
      const existing = grouped.get(skill.name);
      if (existing) {
        if (!existing.compatibility.includes(source.id)) existing.compatibility.push(source.id);
        if (!existing.provenance.includes(source.label)) existing.provenance.push(source.label);
        if (existing.version === null && skill.version !== null) existing.version = skill.version;
      } else grouped.set(skill.name, { ...skill, availability: "available", provenance: [source.label], compatibility: [source.id] });
    }
    sources.push({ id: source.id, label: source.label, available: true, skillCount });
  }
  const skills = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { schemaVersion: 1, sourceRevision, sources, skills };
}

export async function writeSkillInventory(outputPath: string, artifact: SkillInventoryArtifact): Promise<void> {
  const serialized = `${JSON.stringify(artifact)}\n`;
  if (Buffer.byteLength(serialized) > MAX_ARTIFACT_BYTES) throw new Error("skill inventory artifact is too large");
  const output = resolve(outputPath);
  const temporary = join(dirname(output), `.console-inventory-${process.pid}.tmp`);
  await writeFile(temporary, serialized, { mode: 0o644 });
  await rename(temporary, output);
}

function isArtifact(value: unknown): value is SkillInventoryArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  if (!exactKeys(artifact, ["schemaVersion", "sourceRevision", "sources", "skills"])
    || artifact.schemaVersion !== 1 || typeof artifact.sourceRevision !== "string"
    || !/^[0-9a-f]{40}$/.test(artifact.sourceRevision) || !Array.isArray(artifact.sources) || !Array.isArray(artifact.skills)
    || artifact.sources.length !== 2 || artifact.skills.length > 256) return false;
  const sourceIds = new Set<unknown>();
  const validSources = artifact.sources.every(source => {
    if (source === null || typeof source !== "object" || Array.isArray(source)) return false;
    const row = source as Record<string, unknown>;
    sourceIds.add(row.id);
    return exactKeys(row, ["id", "label", "available", "skillCount"])
      && ((row.id === "claude" && row.label === "Claude Code") || (row.id === "codex" && row.label === "Codex"))
      && typeof row.available === "boolean" && Number.isSafeInteger(row.skillCount) && (row.skillCount as number) >= 0;
  });
  return validSources && sourceIds.size === 2 && artifact.skills.every(skill => {
    if (skill === null || typeof skill !== "object" || Array.isArray(skill)) return false;
    const row = skill as Record<string, unknown>;
    return exactKeys(row, ["name", "description", "version", "availability", "provenance", "compatibility"])
      && boundedText(typeof row.name === "string" ? row.name : undefined, 64) !== undefined
      && typeof row.name === "string" && /^[a-z0-9][a-z0-9:_-]{0,63}$/.test(row.name)
      && boundedText(typeof row.description === "string" ? row.description : undefined, 500) !== undefined
      && (row.version === null || boundedText(typeof row.version === "string" ? row.version : undefined, 64) !== undefined)
      && row.availability === "available" && Array.isArray(row.provenance) && row.provenance.length >= 1 && row.provenance.length <= 2
      && new Set(row.provenance).size === row.provenance.length
      && row.provenance.every(item => item === "Claude Code" || item === "Codex")
      && Array.isArray(row.compatibility) && row.compatibility.length >= 1 && row.compatibility.length <= 2
      && new Set(row.compatibility).size === row.compatibility.length
      && row.compatibility.every(item => item === "claude" || item === "codex");
  });
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

export async function readSkillInventory(path: string): Promise<ConsoleSkillsPayload> {
  let info;
  try { info = await stat(path); }
  catch { return { availability: "unavailable", reasonCode: "missing", sourceRevision: null, sources: [], skills: [] }; }
  if (!info.isFile()) return { availability: "unavailable", reasonCode: "not_regular", sourceRevision: null, sources: [], skills: [] };
  if (info.size > MAX_ARTIFACT_BYTES) return { availability: "unavailable", reasonCode: "too_large", sourceRevision: null, sources: [], skills: [] };
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isArtifact(value)) throw new Error("malformed");
    return { availability: "available", ...value };
  } catch { return { availability: "unavailable", reasonCode: "malformed", sourceRevision: null, sources: [], skills: [] }; }
}
