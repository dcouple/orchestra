import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executable, opsFixture } from "./operations-fixtures.js";

describe("public daemonctl subscription lifecycle", () => {
  it("AC17-AC20 lists, adds, declines/removes, and reauthenticates Claude and Codex under daemon identity without proxy restart", async () => {
    const f = opsFixture();
    const accounts = [
      { provider: "codex", selector: "codex-public.json", email: "codex@example.test" },
      { provider: "claude", selector: "claude-public.json", email: "claude@example.test" },
    ] as const;
    const disabled = new Map(accounts.map(account => [account.selector, false]));
    const patches: Array<{ selector: string; disabled: boolean }> = [];
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ files: accounts.map(account => ({
          name: account.selector,
          provider: account.provider,
          email: account.email,
          disabled: disabled.get(account.selector),
          failed: false,
          access_token: `access-secret-${account.provider}`,
          refresh_token: `refresh-secret-${account.provider}`,
          authorization: `Bearer header-secret-${account.provider}`,
          credential_file_contents: `file-secret-${account.provider}`,
        })) }));
        return;
      }
      let body = "";
      request.on("data", chunk => { body += String(chunk); });
      request.on("end", () => {
        const payload = JSON.parse(body) as { name: string; disabled: boolean };
        disabled.set(payload.name, payload.disabled);
        patches.push({ selector: payload.name, disabled: payload.disabled });
        response.end("{}");
      });
    });
    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as { port: number }).port;
    const proxyEnv = join(f.dir, "subscriptions-proxy.env");
    writeFileSync(proxyEnv, "CLIPROXY_MANAGEMENT_KEY=management-header-secret\n");
    const credentialDir = join(f.dir, "credentials");
    mkdirSync(credentialDir);
    for (const account of accounts) writeFileSync(join(credentialDir, account.selector), `retained-credential-secret-${account.provider}`);
    const loginLog = join(f.dir, "provider-login.log");
    const proxy = executable(join(f.dir, "fake-cliproxy"), `printf '%s\n' "$*" >> '${loginLog}'`);
    const env = {
      ...f.env,
      DAEMONCTL_FORCE_RUNUSER: "1",
      DAEMONCTL_PROXY_ACCOUNTS: resolve("ops/proxy-accounts.sh"),
      PROXY_URL: `http://127.0.0.1:${port}`,
      CLIPROXY_ENV_FILE: proxyEnv,
      CLIPROXY_BIN: proxy,
      CLIPROXY_CONFIG: join(f.dir, "proxy.yaml"),
      CURL: execFileSync("which", ["curl"], { encoding: "utf8" }).trim(),
    };
    const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; output: string }>(resolveRun => {
      const child = spawn(resolve("ops/daemonctl"), args, { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.on("data", chunk => { output += String(chunk); });
      child.on("close", code => resolveRun({ code, output }));
    });
    const outputs: string[] = [];
    try {
      const listed = await run(["subscriptions", "list"]);
      outputs.push(listed.output);
      expect(listed.code).toBe(0);
      for (const account of accounts) {
        expect(listed.output).toContain(`"provider":"${account.provider}"`);
        expect(listed.output).toContain(`"selector":"${account.selector}"`);
      }
      expect(listed.output.match(/"eligible":true/g)).toHaveLength(2);
      expect(listed.output.match(/"status":"ready"/g)).toHaveLength(2);

      for (const account of accounts) {
        const added = await run(["subscriptions", "add", account.provider]);
        outputs.push(added.output);
        expect(added.code).toBe(0);
        expect(added.output).toContain(`"selector":"${account.selector}"`);

        const declined = await run(["subscriptions", "remove", account.selector], { PROXY_ACCOUNTS_CONFIRM_RESPONSE: "n" });
        outputs.push(declined.output);
        expect(declined.code).toBe(0);
        expect(declined.output).toContain("unchanged");
        expect(disabled.get(account.selector)).toBe(false);
        expect(existsSync(join(credentialDir, account.selector))).toBe(true);

        const removed = await run(["subscriptions", "remove", account.selector, "--yes"]);
        outputs.push(removed.output);
        expect(removed.code).toBe(0);
        expect(disabled.get(account.selector)).toBe(true);
        expect(removed.output).toContain(`"selector":"${account.selector}"`);
        expect(removed.output).toContain('"eligible":false');
        expect(removed.output).toContain('"status":"ineligible; run reauth"');
        expect(existsSync(join(credentialDir, account.selector))).toBe(true);

        const reauthed = await run(["subscriptions", "reauth", account.provider, account.selector]);
        outputs.push(reauthed.output);
        expect(reauthed.code).toBe(0);
        expect(disabled.get(account.selector)).toBe(false);
        expect(reauthed.output).toContain(`"selector":"${account.selector}"`);
        expect(reauthed.output).toContain('"eligible":true');
        expect(existsSync(join(credentialDir, account.selector))).toBe(true);
      }

      expect(patches).toEqual([
        { selector: "codex-public.json", disabled: true },
        { selector: "codex-public.json", disabled: false },
        { selector: "claude-public.json", disabled: true },
        { selector: "claude-public.json", disabled: false },
      ]);
      const logins = readFileSync(loginLog, "utf8").trim().split("\n");
      expect(logins.filter(line => line.includes("--codex-login --no-browser"))).toHaveLength(2);
      expect(logins.filter(line => line.includes("--claude-login --no-browser"))).toHaveLength(2);
      const runuser = readFileSync(String(f.env.FAKE_RUNUSER_LOG), "utf8").trim().split("\n");
      expect(runuser).toHaveLength(9);
      expect(runuser.every(line => line.startsWith("-u linear-daemon --"))).toBe(true);
      expect(existsSync(f.serviceLog) ? readFileSync(f.serviceLog, "utf8") : "").not.toContain("cliproxyapi");
      expect(outputs.join("\n")).not.toMatch(/management-header-secret|access-secret|refresh-secret|header-secret|file-secret|retained-credential-secret/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  }, 20_000);
});
