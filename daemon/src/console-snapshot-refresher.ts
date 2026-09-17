import { refreshConsoleConfigSnapshot } from "./console-config-snapshot.js";

// Keeps the daemon's authoritative console config snapshot fresh while the
// process runs, so the console write surface does not expire between daemon
// restarts. Content-preserving: an unchanged env keeps its revision.
export class ConsoleSnapshotRefresher {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: { envPath: string; snapshotPath: string; intervalMs?: number;
    now?: () => number; onError?: (error: unknown) => void }) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.trigger(), this.options.intervalMs ?? 3_600_000);
    this.timer.unref?.();
    void this.trigger();
  }

  trigger(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = refreshConsoleConfigSnapshot(this.options.envPath, this.options.snapshotPath, this.now())
      .then(() => undefined, (error: unknown) => { this.options.onError?.(error); })
      .finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.inFlight;
  }
}
