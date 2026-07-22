import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const proxyBin = process.env.CLIPROXY_BIN;
const dirs: string[] = [];
let child: ChildProcess | undefined;

afterEach(async () => {
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  child = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function credential(type: "codex" | "claude", email: string, token: string): string {
  return JSON.stringify({
    type,
    email,
    account_id: `fixture-${email}`,
    access_token: token,
    refresh_token: `${token}-refresh`,
    disabled: false,
  });
}

async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for proxy");
}

describe.skipIf(!proxyBin)("CLIProxyAPI integration", () => {
  it("loads aliases and credentials, disables one, hot-loads one, and redacts tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cliproxy-integration-")); dirs.push(dir);
    const authDir = join(dir, "auth"); mkdirSync(authDir);
    const apiKey = "a".repeat(48);
    const managementKey = "b".repeat(48);
    const fixtureTokens = ["fixture-codex-one-secret", "fixture-codex-two-secret", "fixture-claude-one-secret", "fixture-claude-two-secret"];
    const fixtures = [
      ["codex-one.json", "codex", "codex-one@example.test", fixtureTokens[0]],
      ["codex-two.json", "codex", "codex-two@example.test", fixtureTokens[1]],
      ["claude-one.json", "claude", "claude-one@example.test", fixtureTokens[2]],
      ["claude-two.json", "claude", "claude-two@example.test", fixtureTokens[3]],
    ] as const;
    for (const [name, type, email, token] of fixtures) writeFileSync(join(authDir, name), credential(type, email, token));
    const port = await freePort();
    const config = join(dir, "config.yaml");
    writeFileSync(config, `host: "127.0.0.1"
port: ${port}
auth-dir: "${authDir}"
api-keys:
  - "${apiKey}"
routing:
  strategy: "round-robin"
  session-affinity: true
  session-affinity-ttl: "168h"
save-cooldown-status: true
remote-management:
  secret-key: "${managementKey}"
  allow-remote: false
oauth-model-alias:
  codex:
    - name: "gpt-5.6-sol"
      alias: "gpt-5.6-sol-low"
      fork: true
    - name: "gpt-5.6-sol"
      alias: "gpt-5.6-sol-medium"
      fork: true
    - name: "gpt-5.6-sol"
      alias: "gpt-5.6-sol-xhigh"
      fork: true
payload:
  default:
    - models:
        - name: "gpt-5.6-sol"
          protocol: "codex"
      params:
        "reasoning.effort": "high"
  override:
    - models:
        - name: "gpt-5.6-sol-low"
          protocol: "codex"
      params:
        "reasoning.effort": "low"
    - models:
        - name: "gpt-5.6-sol-medium"
          protocol: "codex"
      params:
        "reasoning.effort": "medium"
    - models:
        - name: "gpt-5.6-sol-xhigh"
          protocol: "codex"
      params:
        "reasoning.effort": "xhigh"
`);
    let logs = "";
    child = spawn(proxyBin!, ["-config", config], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", chunk => { logs += chunk.toString(); });
    child.stderr?.on("data", chunk => { logs += chunk.toString(); });
    const base = `http://127.0.0.1:${port}`;
    const expectedModels = ["gpt-5.6-sol", "gpt-5.6-sol-low", "gpt-5.6-sol-medium", "gpt-5.6-sol-xhigh"];
    const models = await poll(async () => {
      const response = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!response.ok) return undefined;
      const payload = await response.json() as { data: Array<{ id: string }> };
      const ids = payload.data.map(model => model.id);
      return expectedModels.every(model => ids.includes(model)) ? payload : undefined;
    });
    expect(models.data.map(model => model.id)).toEqual(expect.arrayContaining(expectedModels));

    const managementHeaders = { authorization: `Bearer ${managementKey}` };
    const list = async () => {
      const response = await fetch(`${base}/v0/management/auth-files`, { headers: managementHeaders });
      expect(response.status).toBe(200);
      return await response.json() as { files: Array<Record<string, unknown>> };
    };
    const initial = await poll(async () => {
      const payload = await list();
      return payload.files.length >= 4 ? payload : undefined;
    });
    for (const [name, type, email] of fixtures) {
      expect(initial.files).toContainEqual(expect.objectContaining({ name, provider: type, email, disabled: false }));
    }
    const initialJson = JSON.stringify(initial);
    for (const token of fixtureTokens) expect(initialJson).not.toContain(token);

    const envFile = join(dir, "cliproxy.env");
    writeFileSync(envFile, `CLIPROXY_API_KEY=${apiKey}\nCLIPROXY_MANAGEMENT_KEY=${managementKey}\n`);
    const helperEnv = {
      ...process.env,
      PROXY_URL: base,
      CLIPROXY_ENV_FILE: envFile,
      CLIPROXY_BIN: proxyBin!,
      CLIPROXY_CONFIG: config,
    };
    const helper = join(process.cwd(), "ops/proxy-accounts.sh");
    const helperList = execFileSync(helper, ["list"], { env: helperEnv, encoding: "utf8" });
    expect(helperList).toContain('"provider":"codex"');
    for (const token of fixtureTokens) expect(helperList).not.toContain(token);
    const dryRunOne = execFileSync(helper, ["add", "codex", "--dry-run"], { env: helperEnv, encoding: "utf8" });
    const dryRunTwo = execFileSync(helper, ["add", "codex", "--dry-run"], { env: helperEnv, encoding: "utf8" });
    expect(dryRunTwo).toBe(dryRunOne);
    expect(execFileSync(helper, ["remove", fixtures[0][0], "--dry-run"], { env: helperEnv, encoding: "utf8" }))
      .toContain("credential file retained");
    expect(execFileSync(helper, ["reauth", "codex", fixtures[0][0], "--dry-run"], { env: helperEnv, encoding: "utf8" }))
      .toContain("restore selector");

    const disabledName = fixtures[0][0];
    const disabled = await fetch(`${base}/v0/management/auth-files/status`, {
      method: "PATCH",
      headers: { ...managementHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: disabledName, disabled: true }),
    });
    expect(disabled.status).toBe(200);
    await poll(async () => (await list()).files.find(item => item.name === disabledName && item.disabled === true));
    const removed = execFileSync(helper, ["remove", disabledName, "--yes"], { env: helperEnv, encoding: "utf8" });
    expect(removed).toContain("credential file retained");
    expect(existsSync(join(authDir, disabledName))).toBe(true);

    const hotToken = "fixture-codex-hot-secret";
    fixtureTokens.push(hotToken);
    writeFileSync(join(authDir, "codex-hot.json"), credential("codex", "codex-hot@example.test", hotToken));
    await poll(async () => (await list()).files.find(item => item.name === "codex-hot.json"));
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const token of fixtureTokens) expect(logs).not.toContain(token);
  }, 20_000);
});
