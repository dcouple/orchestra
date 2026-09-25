import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve("..");
const shipped = new Set(
  ["claude/skills", "codex/skills"].flatMap(dir =>
    readdirSync(join(repo, dir)).filter(name => statSync(join(repo, dir, name)).isDirectory()),
  ),
);

function skillFiles(dir: string): string[] {
  return readdirSync(join(repo, dir)).flatMap(name =>
    existsSync(join(repo, dir, name, "SKILL.md")) ? [join(dir, name, "SKILL.md")] : [],
  );
}

describe("skill cross-references", () => {
  it("route only to skills that ship from claude/skills or codex/skills", () => {
    const dangling: string[] = [];
    for (const file of [...skillFiles("claude/skills"), ...skillFiles("codex/skills")]) {
      const text = readFileSync(join(repo, file), "utf8");
      const named = [
        ...text.matchAll(/the (?:available )?`([a-z0-9-]+)` skill/g),
        ...text.matchAll(/\.claude\/skills\/([a-z0-9-]+)\//g),
      ].map(match => match[1]);
      for (const skill of named) if (!shipped.has(skill)) dangling.push(`${file}: ${skill}`);
    }
    expect(dangling).toEqual([]);
  });
});
