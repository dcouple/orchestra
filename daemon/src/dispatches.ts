import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface InFlightDispatch {
  base: string;
  deadlineAt: number;
}

export const DISPATCH_OWNER_PATTERN = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;
const FALLBACK_DISPATCH_DEADLINE_MS = 45 * 60_000;

export async function inFlightDispatches(
  worktree: string | null,
  owner: string,
): Promise<InFlightDispatch[]> {
  if (!worktree) return [];
  const directory = resolve(worktree, ".codex-dispatches", owner);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const launchers = new Map<string, string>();
  for (const file of files) {
    const match = /^(.*)\.(prompt|sh)$/.exec(file);
    if (match && !files.includes(`${match[1]}.done`) && !launchers.has(match[1]!))
      launchers.set(match[1]!, file);
  }
  return Promise.all(
    [...launchers].sort(([a], [b]) => a.localeCompare(b)).map(async ([base, file]) => {
      let deadlineAt: number | undefined;
      try {
        const sidecar = JSON.parse(
          (await readFile(resolve(directory, `${base}.otel.json`)))
            .subarray(0, 65_536)
            .toString("utf8"),
        ) as { deadline_at?: unknown };
        if (
          typeof sidecar.deadline_at === "number" &&
          Number.isFinite(sidecar.deadline_at)
        )
          deadlineAt = sidecar.deadline_at;
      } catch {}
      if (deadlineAt === undefined)
        deadlineAt =
          (await stat(resolve(directory, file))).mtimeMs +
          FALLBACK_DISPATCH_DEADLINE_MS;
      return { base, deadlineAt };
    }),
  );
}

export async function completedDispatchesAwaitingIngest(
  worktree: string | null,
  owner: string,
): Promise<InFlightDispatch[]> {
  if (!worktree) return [];
  const directory = resolve(worktree, ".codex-dispatches", owner);
  try {
    return (await readdir(directory))
      .filter((file) => file.endsWith(".done"))
      .sort()
      .map((file) => ({ base: file.slice(0, -5), deadlineAt: 0 }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
