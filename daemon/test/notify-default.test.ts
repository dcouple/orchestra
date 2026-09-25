import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The documented send snippet in .references/notify.md, run as a skill would.
const snippet = [...readFileSync(resolve("../references/notify.md"), "utf8").matchAll(/```bash\n([\s\S]*?)```/g)]
  .map(match => match[1]!).find(block => block.includes("NOTIFY="))!;

function send(home: string): string {
  const bin = join(home, "bin"); mkdirSync(bin, { recursive: true });
  const sent = join(home, "sent-to");
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nfor last; do :; done\nprintf '%s' "$last" > "${sent}"\n`);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho same-login\n"); // the old default derived the topic from this
  chmodSync(join(bin, "curl"), 0o755); chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("bash", ["-c", snippet], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, BODY: "body", ID: "1", STAGE: "s", WHAT: "w" }, encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(sent, "utf8");
}

describe("default run-notification topic", () => {
  it("is random per install and stable across sends", () => {
    const first = mkdtempSync(join(tmpdir(), "notify-a-")); const second = mkdtempSync(join(tmpdir(), "notify-b-"));
    dirs.push(first, second);
    const url = send(first);
    expect(url).toMatch(/^https:\/\/ntfy\.sh\/[A-Za-z0-9_-]{20,}$/);
    expect(url).not.toContain("same-login");
    expect(send(first)).toBe(url);
    expect(send(second)).not.toBe(url);
  });
});
