import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

export interface ArtifactFile {
  path: string;
  content: Buffer;
}

export class InvalidArtifactError extends Error {}
export class ArtifactNotFoundError extends Error {}

const ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
const VERSION_PATTERN = /^v-[A-Za-z0-9_-]+$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9._ -]+$/;

export class ArtifactStore {
  constructor(readonly artifactsDir: string) {}

  createId(): string {
    return randomBytes(16).toString("base64url");
  }

  isValidId(id: string): boolean {
    return ID_PATTERN.test(id);
  }

  async create(files: readonly ArtifactFile[]): Promise<string> {
    await mkdir(this.artifactsDir, { recursive: true });
    for (;;) {
      const id = this.createId();
      try {
        await mkdir(this.bundleDir(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try {
        await this.write(id, files);
        return id;
      } catch (error) {
        await rm(this.bundleDir(id), { recursive: true, force: true });
        throw error;
      }
    }
  }

  async replace(id: string, files: readonly ArtifactFile[]): Promise<void> {
    if (!this.isValidId(id) || !(await this.currentVersion(id))) throw new ArtifactNotFoundError("artifact not found");
    await this.write(id, files);
  }

  async resolve(id: string, relPath: string): Promise<string | undefined> {
    if (!this.isValidId(id) || !validRelativePath(relPath)) return undefined;
    const version = await this.currentVersion(id);
    if (!version) return undefined;
    const root = resolvePath(this.bundleDir(id), version);
    const candidate = resolvePath(root, relPath);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;
    try {
      return (await stat(candidate)).isFile() ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  async list(id: string): Promise<string[]> {
    if (!this.isValidId(id)) return [];
    const version = await this.currentVersion(id);
    if (!version) return [];
    const root = resolvePath(this.bundleDir(id), version);
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const absolute = resolvePath(dir, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
      }
    };
    try {
      await walk(root);
      return files;
    } catch {
      return [];
    }
  }

  contentTypeFor(path: string): string {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".pdf": "application/pdf",
    };
    return types[extname(path).toLowerCase()] ?? "application/octet-stream";
  }

  private bundleDir(id: string): string {
    return resolvePath(this.artifactsDir, id);
  }

  private async currentVersion(id: string): Promise<string | undefined> {
    try {
      const version = (await readFile(resolvePath(this.bundleDir(id), "current"), "utf8")).trim();
      return VERSION_PATTERN.test(version) ? version : undefined;
    } catch {
      return undefined;
    }
  }

  private async write(id: string, files: readonly ArtifactFile[]): Promise<void> {
    validateFiles(files);
    const bundleDir = this.bundleDir(id);
    const previous = await this.currentVersion(id);
    const version = `v-${randomBytes(12).toString("base64url")}`;
    const versionDir = resolvePath(bundleDir, version);
    const pointerTemp = resolvePath(bundleDir, `.current.tmp-${randomBytes(8).toString("base64url")}`);
    await mkdir(versionDir);
    try {
      for (const file of files) {
        const destination = resolvePath(versionDir, file.path);
        await mkdir(resolvePath(destination, ".."), { recursive: true });
        await writeFile(destination, file.content);
      }
      await writeFile(pointerTemp, version, { flag: "wx" });
      await rename(pointerTemp, resolvePath(bundleDir, "current"));
    } catch (error) {
      await rm(pointerTemp, { force: true });
      await rm(versionDir, { recursive: true, force: true });
      throw error;
    }
    if (previous && previous !== version) {
      const cleanup = setTimeout(() => {
        void rm(resolvePath(bundleDir, previous), { recursive: true, force: true }).catch(() => undefined);
      }, 30_000);
      cleanup.unref();
    }
  }
}

function validateFiles(files: readonly ArtifactFile[]): void {
  if (files.length === 0 || files.length > 100) throw new InvalidArtifactError("bundle must contain 1 to 100 files");
  const paths = new Set<string>();
  for (const file of files) {
    if (!validRelativePath(file.path)) throw new InvalidArtifactError("invalid artifact path");
    if (paths.has(file.path)) throw new InvalidArtifactError("duplicate artifact path");
    paths.add(file.path);
    if (!Buffer.isBuffer(file.content)) throw new InvalidArtifactError("invalid artifact content");
  }
}

function validRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\\")) return false;
  const segments = path.split("/");
  return segments.length <= 8 && segments.every(segment => segment !== "" && segment !== "." && segment !== ".." && SEGMENT_PATTERN.test(segment));
}
