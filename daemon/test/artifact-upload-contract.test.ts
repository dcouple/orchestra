import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "artifact-upload-contract-"));
  dirs.push(dir);
  const item = join(dir, "item");
  mkdirSync(item);
  return { dir, item };
}

function buildManifest(item: string) {
  const reference = readFileSync(new URL("../../references/artifact-host-upload.md", import.meta.url), "utf8");
  const source = /<<'NODE'\n([\s\S]*?)\nNODE/.exec(reference)?.[1];
  if (!source) throw new Error("Artifact upload reference has no executable Node example");
  const result = execFileSync(process.execPath, ["--input-type=module", "-", item], {
    input: source, encoding: "utf8", timeout: 5000,
  });
  return JSON.parse(result) as { files: Array<{ path: string; contentBase64: string }> };
}

describe("documented artifact upload", () => {
  it("preserves phase plans, prototype links, research, and binary bytes through the store", async () => {
    const { dir, item } = fixture();
    const expected = new Map([
      ["brief.html", Buffer.from('<a href="mockups/index.html">Prototype</a>')],
      ["plan.md", Buffer.from("# Plan\n")],
      ["plan-1.md", Buffer.from("---\nphase_complete: true\n---\n")],
      ["plan-2.md", Buffer.from("# Next phase\n")],
      ["wrapup.md", Buffer.from("# Results\n")],
      ["refs/research.md", Buffer.from("Evidence: café\n")],
      ["refs/shots/example.png", Buffer.from([0, 255, 128, 65, 10])],
      ["mockups/index.html", Buffer.from('<link rel="stylesheet" href="mock.css">')],
      ["mockups/mock.css", Buffer.from("body { color: black; }")],
    ]);
    for (const [path, content] of expected) {
      mkdirSync(dirname(join(item, path)), { recursive: true });
      writeFileSync(join(item, path), content);
    }
    writeFileSync(join(item, "unrelated.txt"), "not a work-item artifact");
    const manifest = buildManifest(item);
    expect(manifest.files.map(file => file.path).sort()).toEqual([...expected.keys()].sort());
    const store = new ArtifactStore(join(dir, "store"));
    const id = await store.create(manifest.files.map(file => ({
      path: file.path, content: Buffer.from(file.contentBase64, "base64"),
    })));
    expect((await store.list(id)).sort()).toEqual([...expected.keys()].sort());
    for (const [path, content] of expected) {
      const stored = await store.resolve(id, path);
      expect(stored).toBeDefined();
      expect(readFileSync(stored!)).toEqual(content);
    }
  });

  it("allows absent optional folders and retains legacy item transport", () => {
    const { item } = fixture();
    writeFileSync(join(item, "item.md"), "# Legacy item\n");
    expect(buildManifest(item)).toEqual({ files: [{
      path: "item.md", contentBase64: Buffer.from("# Legacy item\n").toString("base64"),
    }] });
  });
});
