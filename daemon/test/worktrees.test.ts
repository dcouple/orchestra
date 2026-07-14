import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/worktrees.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function git(args: string[], cwd?: string): string { return execFileSync("git", args, { cwd, encoding: "utf8" }); }
function repository() {
  const dir = mkdtempSync(join(tmpdir(), "worktrees-")); dirs.push(dir);
  const seed = join(dir, "seed"), origin = join(dir, "origin.git"), repo = join(dir, "repo"), root = join(dir, "trees");
  mkdirSync(seed); git(["init", "-b", "main"], seed); git(["config", "user.email", "test@example.com"], seed); git(["config", "user.name", "Test"], seed);
  git(["commit", "--allow-empty", "-m", "initial"], seed); git(["clone", "--bare", seed, origin]); git(["clone", origin, repo]);
  return { dir, origin, repo, root };
}

describe("WorktreeManager", () => {
  it("creates and reuses a branch containing the sanitized issue identifier", async () => {
    const setup = repository(); const manager = new WorktreeManager(setup.root, setup.repo);
    const first = await manager.ensureWorktree("ENG-42");
    expect(first.branch).toBe("agents/ENG-42"); expect(first.path).toBe(join(setup.root, "ENG-42"));
    const exclude = git(["rev-parse", "--git-path", "info/exclude"], first.path).trim();
    expect(readFileSync(isAbsolute(exclude) ? exclude : join(first.path, exclude), "utf8")).toContain("/.linear-attachments/");
    expect(await manager.ensureWorktree("ENG-42")).toEqual(first);
  });
  it("uses an existing unregistered branch", async () => {
    const setup = repository(); git(["branch", "agents/ENG-43", "origin/main"], setup.repo);
    expect((await new WorktreeManager(setup.root, setup.repo).ensureWorktree("ENG-43")).branch).toBe("agents/ENG-43");
  });
  it("rejects an existing path from a foreign repository", async () => {
    const setup = repository(); mkdirSync(setup.root);
    git(["clone", setup.origin, join(setup.root, "ENG-99")]);
    await expect(new WorktreeManager(setup.root, setup.repo).ensureWorktree("ENG-99")).rejects.toThrow(/foreign repository/);
  });
});
