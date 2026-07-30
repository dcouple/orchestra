import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Worktree { path: string; branch: string; }
export interface PreservationResult {
  preserved: "pushed" | "bundled" | "none";
  detail: string;
}
export interface WorktreeSnapshot {
  identity: string;
  generation: number;
  present: boolean;
}
export class WorktreeChangedError extends Error {
  constructor(identifier: string) {
    super(`Worktree changed after reconciliation lookup: ${identifier}`);
  }
}

export class WorktreeManager {
  private mutation: Promise<void> = Promise.resolve();
  private readonly generations = new Map<string, number>();
  constructor(private readonly root: string, private readonly repo: string) {}

  async ensureWorktree(rawIdentifier: string): Promise<Worktree> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const identifier = this.identifier(rawIdentifier);
      this.generations.set(
        identifier,
        (this.generations.get(identifier) ?? 0) + 1,
      );
      return await this.ensureWorktreeLocked(rawIdentifier);
    }
    finally { release(); }
  }

  async isClean(path: string): Promise<boolean> {
    await this.validate(path);
    return (await this.git(["status", "--porcelain"], path)).trim() === "";
  }

  async isPresent(path: string): Promise<boolean> { return this.exists(path); }

  async isOwned(path: string): Promise<boolean> {
    try {
      await this.validate(path);
      return true;
    } catch {
      return false;
    }
  }

  async snapshot(
    rawIdentifier: string,
    opts: { includeAbsent?: boolean } = {},
  ): Promise<WorktreeSnapshot | undefined> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const identifier = this.identifier(rawIdentifier);
      const path = resolve(this.root, identifier);
      if (!(await this.exists(path)))
        return opts.includeAbsent
          ? {
              identity: "",
              generation: this.generations.get(identifier) ?? 0,
              present: false,
            }
          : undefined;
      try {
        return {
          identity: await this.identityLocked(path),
          generation: this.generations.get(identifier) ?? 0,
          present: true,
        };
      } catch {
        return undefined;
      }
    } finally {
      release();
    }
  }

  async remove(
    rawIdentifier: string,
    opts: { expectedSnapshot?: WorktreeSnapshot } = {},
  ): Promise<void> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const identifier = this.identifier(rawIdentifier);
      const path = resolve(this.root, identifier);
      await this.assertExpectedSnapshotLocked(
        identifier,
        path,
        opts.expectedSnapshot,
      );
      if (await this.exists(path)) {
        await this.validate(path);
        if (!(await this.isClean(path))) throw new Error(`Refusing to remove dirty worktree: ${path}`);
        await rm(resolve(path, ".linear-attachments"), { recursive: true, force: true });
        await rm(resolve(path, ".codex-dispatches"), { recursive: true, force: true });
        await this.git(["worktree", "remove", path], this.repo);
      }
      try { await this.git(["branch", "-D", `agents/${identifier}`], this.repo); }
      catch (error) { if (await this.gitOk(["show-ref", "--verify", `refs/heads/agents/${identifier}`], this.repo)) throw error; }
    } finally { release(); }
  }

  async preserveAndRemove(
    rawIdentifier: string,
    bundlesDir: string,
    opts: {
      alwaysPreserve: boolean;
      expectedSnapshot?: WorktreeSnapshot;
    },
  ): Promise<PreservationResult> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const identifier = this.identifier(rawIdentifier);
      const path = resolve(this.root, identifier);
      const branch = `agents/${identifier}`;
      let result: PreservationResult = {
        preserved: "none",
        detail: "no preservation required",
      };
      await this.assertExpectedSnapshotLocked(
        identifier,
        path,
        opts.expectedSnapshot,
      );
      if (await this.exists(path)) {
        await this.validate(path);
        const wasDirty =
          (await this.git(["status", "--porcelain"], path)).trim() !== "";
        if (wasDirty) {
          await this.git(["add", "-A"], path);
          await this.git(
            [
              "-c",
              "user.email=daemon",
              "-c",
              "user.name=daemon",
              "commit",
              "-m",
              "preserve: agent worktree state before cleanup",
            ],
            path,
          );
        }
        if (wasDirty || opts.alwaysPreserve) {
          try {
            await this.git(
              ["push", "origin", `${branch}:${branch}`],
              path,
            );
            result = {
              preserved: "pushed",
              detail: `pushed to ${branch}`,
            };
          } catch {
            await mkdir(bundlesDir, { recursive: true });
            const bundlePath = resolve(
              bundlesDir,
              `${identifier}-${Date.now()}.bundle`,
            );
            await this.git(["bundle", "create", bundlePath, "--all"], path);
            result = {
              preserved: "bundled",
              detail: `bundled at ${bundlePath}`,
            };
          }
        }
        await rm(resolve(path, ".linear-attachments"), {
          recursive: true,
          force: true,
        });
        await rm(resolve(path, ".codex-dispatches"), {
          recursive: true,
          force: true,
        });
        await this.git(["worktree", "remove", "--force", path], this.repo);
      } else if (
        opts.alwaysPreserve &&
        (await this.gitOk(
          ["show-ref", "--verify", `refs/heads/${branch}`],
          this.repo,
        ))
      ) {
        try {
          await this.git(["push", "origin", `${branch}:${branch}`], this.repo);
          result = {
            preserved: "pushed",
            detail: `pushed to ${branch}`,
          };
        } catch {
          await mkdir(bundlesDir, { recursive: true });
          const bundlePath = resolve(
            bundlesDir,
            `${identifier}-${Date.now()}.bundle`,
          );
          await this.git(["bundle", "create", bundlePath, "--all"], this.repo);
          result = {
            preserved: "bundled",
            detail: `bundled at ${bundlePath}`,
          };
        }
      }
      try {
        await this.git(["branch", "-D", branch], this.repo);
      } catch (error) {
        if (
          await this.gitOk(
            ["show-ref", "--verify", `refs/heads/${branch}`],
            this.repo,
          )
        )
          throw error;
      }
      return result;
    } finally {
      release();
    }
  }

  private async ensureWorktreeLocked(rawIdentifier: string): Promise<Worktree> {
    const identifier = this.identifier(rawIdentifier);
    const path = resolve(this.root, identifier);
    const branch = `agents/${identifier}`;
    await mkdir(this.root, { recursive: true });
    if (await this.exists(path)) {
      await this.validate(path);
      const actual = (await this.git(["branch", "--show-current"], path)).trim();
      if (actual !== branch) throw new Error(`Existing worktree uses unexpected branch ${actual || "(detached)"}: ${path}`);
      await this.excludeTransientDirectories(path);
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
    await this.excludeTransientDirectories(path);
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

  private async identityLocked(path: string): Promise<string> {
    await this.validate(path);
    const gitDirRaw = (await this.git(["rev-parse", "--git-dir"], path)).trim();
    const gitDir = isAbsolute(gitDirRaw)
      ? gitDirRaw
      : resolve(path, gitDirRaw);
    const markerPath = resolve(gitDir, "orchestra-worktree-id");
    let marker: string;
    try {
      marker = (await readFile(markerPath, "utf8")).trim();
    } catch {
      marker = randomUUID();
      await writeFile(markerPath, `${marker}\n`, { flag: "wx" }).catch(
        async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
          marker = (await readFile(markerPath, "utf8")).trim();
        },
      );
    }
    const branch = (await this.git(["branch", "--show-current"], path)).trim();
    const head = (await this.git(["rev-parse", "HEAD"], path)).trim();
    return `${marker}:${branch}:${head}`;
  }

  private async assertExpectedSnapshotLocked(
    identifier: string,
    path: string,
    expected?: WorktreeSnapshot,
  ): Promise<void> {
    if (!expected) return;
    const generation = this.generations.get(identifier) ?? 0;
    const present = await this.exists(path);
    if (
      generation !== expected.generation ||
      present !== expected.present ||
      (present && (await this.identityLocked(path)) !== expected.identity)
    )
      throw new WorktreeChangedError(identifier);
  }

  private async excludeTransientDirectories(path: string): Promise<void> {
    const raw = (await this.git(["rev-parse", "--git-path", "info/exclude"], path)).trim();
    const exclude = isAbsolute(raw) ? raw : resolve(path, raw);
    await mkdir(resolve(exclude, ".."), { recursive: true });
    let contents = "";
    try { contents = await readFile(exclude, "utf8"); } catch {}
    const lines = contents.split(/\r?\n/);
    const additions = ["/.linear-attachments/", "/.codex-dispatches/"].filter(entry => !lines.includes(entry));
    if (additions.length) await writeFile(exclude,
      `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`);
  }

  private async exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
  private identifier(rawIdentifier: string): string {
    return rawIdentifier.replace(/[^A-Za-z0-9-]/g, "-") || "issue";
  }
  private async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await exec("git", args, { cwd }); return stdout;
  }
  private async gitOk(args: string[], cwd: string): Promise<boolean> { try { await this.git(args, cwd); return true; } catch { return false; } }
}
