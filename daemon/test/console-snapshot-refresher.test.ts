import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConsoleConfigSnapshot, refreshConsoleConfigSnapshot, writeConsoleConfigSnapshot } from "../src/console-config-snapshot.js";
import { ConsoleSnapshotRefresher } from "../src/console-snapshot-refresher.js";

const MAX_AGE = 86_400_000;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-refresh-"));
  const env = join(dir, "protected.env"); const snapshot = join(dir, "console-config-snapshot.json");
  writeFileSync(env, "PLANNER_HARNESS='claude'\nIMPLEMENTER_HARNESS='claude'\nLINEAR_API_KEY='SECRET'\n", { mode: 0o600 });
  return { dir, env, snapshot };
}

describe("console config snapshot refresh", () => {
  it("preserves the revision for unchanged content and un-stales the snapshot", async () => {
    const f = fixture();
    const original = await writeConsoleConfigSnapshot(f.env, f.snapshot, 1_000);
    const later = 1_000 + MAX_AGE + 60_000;
    await expect(readConsoleConfigSnapshot(f.snapshot, MAX_AGE, later)).rejects.toMatchObject({ code: "snapshot_stale" });
    const refreshed = await refreshConsoleConfigSnapshot(f.env, f.snapshot, later);
    expect(refreshed.revision).toBe(original.revision);
    expect(refreshed.generatedAt).toBe(later);
    await expect(readConsoleConfigSnapshot(f.snapshot, MAX_AGE, later)).resolves.toMatchObject({ revision: original.revision });
  });

  it("rotates the revision when the env content changed", async () => {
    const f = fixture();
    const original = await writeConsoleConfigSnapshot(f.env, f.snapshot, 1_000);
    writeFileSync(f.env, "PLANNER_HARNESS='claudex'\nIMPLEMENTER_HARNESS='claude'\nLINEAR_API_KEY='SECRET'\n", { mode: 0o600 });
    const refreshed = await refreshConsoleConfigSnapshot(f.env, f.snapshot, 2_000);
    expect(refreshed.revision).not.toBe(original.revision);
    expect(refreshed.settings.plannerHarness).toBe("claudex");
    expect(JSON.parse(readFileSync(f.snapshot, "utf8")).revision).toBe(refreshed.revision);
  });

  it("creates a missing snapshot with a fresh revision", async () => {
    const f = fixture();
    const refreshed = await refreshConsoleConfigSnapshot(f.env, f.snapshot, 3_000);
    await expect(readConsoleConfigSnapshot(f.snapshot, MAX_AGE, 3_000)).resolves.toMatchObject({ revision: refreshed.revision });
  });

  it("refresher triggers writes, reports errors, and stops cleanly", async () => {
    const f = fixture();
    const errors: unknown[] = [];
    const broken = new ConsoleSnapshotRefresher({ envPath: join(f.dir, "absent.env"), snapshotPath: f.snapshot,
      now: () => 4_000, onError: error => errors.push(error) });
    await broken.trigger();
    expect(errors).toHaveLength(1);
    await broken.stop();
    const refresher = new ConsoleSnapshotRefresher({ envPath: f.env, snapshotPath: f.snapshot,
      now: () => 5_000, onError: error => errors.push(error) });
    await refresher.trigger();
    await refresher.stop();
    expect(errors).toHaveLength(1);
    await expect(readConsoleConfigSnapshot(f.snapshot, MAX_AGE, 5_000)).resolves.toMatchObject({ generatedAt: 5_000 });
  });
});
