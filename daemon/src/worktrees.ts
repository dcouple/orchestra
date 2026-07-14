import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Worktree { path: string; branch: string; }

export class WorktreeManager {
  private mutation: Promise<void> = Promise.resolve();
  constructor(private readonly root: string, private readonly repo: string) {}

  async ensureWorktree(rawIdentifier: string): Promise<Worktree> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await this.ensureWorktreeLocked(rawIdentifier); }
    finally { release(); }
  }

  private async ensureWorktreeLocked(rawIdentifier: string): Promise<Worktree> {
    const identifier = rawIdentifier.replace(/[^A-Za-z0-9-]/g, "-") || "issue";
    const path = resolve(this.root, identifier);
    const branch = `agents/${identifier}`;
    await mkdir(this.root, { recursive: true });
    if (await this.exists(path)) {
      await this.validate(path);
      const actual = (await this.git(["branch", "--show-current"], path)).trim();
      if (actual !== branch) throw new Error(`Existing worktree uses unexpected branch ${actual || "(detached)"}: ${path}`);
      await this.excludeAttachments(path);
      return { path, branch };
    }
    await this.git(["fetch", "origin"], this.repo);
    const head = await this.defaultHead();
    const branchExists = await this.gitOk(["show-ref", "--verify", `refs/heads/${branch}`], this.repo);
    const args = branchExists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", path, "-b", branch, head];
    await this.git(args, this.repo);
    await this.validate(path);
    await this.excludeAttachments(path);
    return { path, branch };
  }

  private async defaultHead(): Promise<string> {
    try { return (await this.git(["symbolic-ref", "refs/remotes/origin/HEAD"], this.repo)).trim(); }
    catch {
      const output = await this.git(["ls-remote", "--symref", "origin", "HEAD"], this.repo);
      const match = /^ref:\s+(refs\/heads\/\S+)\s+HEAD/m.exec(output);
      if (!match) throw new Error("Unable to resolve origin default branch");
      return `refs/remotes/origin/${match[1]!.slice("refs/heads/".length)}`;
    }
  }

  private async validate(path: string): Promise<void> {
    const commonRaw = (await this.git(["rev-parse", "--git-common-dir"], path)).trim();
    const common = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(path, commonRaw));
    const expected = await realpath(join(this.repo, ".git"));
    if (common !== expected) throw new Error(`Existing worktree belongs to a foreign repository: ${path}`);
  }

  private async excludeAttachments(path: string): Promise<void> {
    const raw = (await this.git(["rev-parse", "--git-path", "info/exclude"], path)).trim();
    const exclude = isAbsolute(raw) ? raw : resolve(path, raw);
    await mkdir(resolve(exclude, ".."), { recursive: true });
    let contents = "";
    try { contents = await readFile(exclude, "utf8"); } catch {}
    if (!contents.split(/\r?\n/).includes("/.linear-attachments/")) {
      await writeFile(exclude, `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}/.linear-attachments/\n`);
    }
  }

  private async exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
  private async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await exec("git", args, { cwd }); return stdout;
  }
  private async gitOk(args: string[], cwd: string): Promise<boolean> { try { await this.git(args, cwd); return true; } catch { return false; } }
}
