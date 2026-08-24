import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DoozyProvider } from "../src/doozy.js";
import { EventLog } from "../src/eventlog.js";
import { SessionWorker } from "../src/sessions.js";

const dirs: string[] = [];
const oldMode = process.env.CLAUDE_FAKE_MODE;
const oldEnvFile = process.env.CLAUDE_FAKE_ENV_FILE;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (oldMode === undefined) delete process.env.CLAUDE_FAKE_MODE;
  else process.env.CLAUDE_FAKE_MODE = oldMode;
  if (oldEnvFile === undefined) delete process.env.CLAUDE_FAKE_ENV_FILE;
  else process.env.CLAUDE_FAKE_ENV_FILE = oldEnvFile;
});

describe("DoozyProvider", () => {
  it("claims a tagged todo, runs it, posts progress and PR, then resumes from human chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doozy-provider-"));
    dirs.push(dir);
    const repo = setupRepo(dir);
    const todo = {
      id: "a0000000-0000-0000-0000-000000000164",
      title: "[daemon-agent] Implementer: prove the adapter",
      content: "Open a pull request and report it here.",
      status: "ready",
      latestRun: { chatId: "chat-164" },
    };
    const messages: Array<Record<string, unknown>> = [];
    const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const api = createServer(async (request, response) => {
      const body = await readJson(request);
      requests.push({ method: request.method!, path: request.url!, ...(body ? { body } : {}) });
      expect(request.headers.authorization).toBe("Bearer test-doozy-key");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url?.startsWith("/todos?"))
        return response.end(JSON.stringify({ todos: [todo] }));
      if (request.method === "GET" && request.url === `/todos/${todo.id}`)
        return response.end(JSON.stringify({ todo }));
      if (request.method === "PATCH" && request.url === `/todos/${todo.id}`) {
        Object.assign(todo, body);
        return response.end(JSON.stringify({ todo }));
      }
      if (request.method === "GET" && request.url === "/chats/chat-164/messages")
        return response.end(JSON.stringify({ messages }));
      if (request.method === "POST" && request.url === "/chats/chat-164/messages") {
        messages.push({ id: `daemon-${messages.length}`, role: "user", text: body?.message, createdAt: new Date().toISOString() });
        response.statusCode = 201;
        return response.end(JSON.stringify({ message: messages.at(-1) }));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
    const port = (api.address() as { port: number }).port;
    const proxyFile = join(dir, "proxy.env");
    writeFileSync(proxyFile, "CLIPROXY_API_KEY=fake-provider-key\n");
    const config = loadConfig({
      DAEMON_TEST_MODE: "1",
      WORK_PROVIDER: "doozy",
      SESSIONS_ENABLED: "1",
      TARGET_REPO_PATH: repo,
      DB_PATH: join(dir, "events.db"),
      WORKTREES_ROOT: join(dir, "worktrees"),
      DOOZY_API_URL: `http://127.0.0.1:${port}`,
      DOOZY_API_KEY: "test-doozy-key",
      DOOZY_TAG: "daemon-agent",
      CLAUDE_BIN: `${process.execPath} ${resolve("test/fixtures/fake-claude.mjs")}`,
      FABLE_BIN: `${process.execPath} ${resolve("test/fixtures/fake-claude.mjs")}`,
      CLIPROXY_ENV_FILE: proxyFile,
      BROWSER_ENABLED: "0",
      KEEPALIVE_MS: "1000",
    });
    const log = new EventLog(config.dbPath);
    let worker: SessionWorker;
    const provider = new DoozyProvider(log, config, { onInserted: () => worker.trigger() });
    worker = new SessionWorker(log, provider, config, { pollMs: 10, reconcileMs: 20 });
    process.env.CLAUDE_FAKE_MODE = "do-pr";
    process.env.CLAUDE_FAKE_ENV_FILE = join(dir, "claude-env.jsonl");
    await worker.start();
    await provider.trigger();
    await waitFor(() => todo.status === "done" && String(todo.content).includes("pull/42"));

    expect(requests).toContainEqual(expect.objectContaining({
      method: "PATCH",
      path: `/todos/${todo.id}`,
      body: { status: "in_progress" },
    }));
    expect(String(todo.content)).toContain("implementation started");
    expect(String(todo.content)).toContain("Pull Request: https://github.com/");
    expect(messages.some((entry) => String(entry.text).includes("Opened https://github.com/"))).toBe(true);
    const childEnv = JSON.parse(readFileSync(process.env.CLAUDE_FAKE_ENV_FILE, "utf8").split("\n")[0]).env;
    expect(childEnv.DOOZY_API_KEY).toBeUndefined();

    todo.status = "in_progress";
    messages.push({
      id: "human-follow-up",
      role: "user",
      text: "Please double-check the result.",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });
    process.env.CLAUDE_FAKE_MODE = "happy";
    await provider.trigger();
    await waitFor(() => messages.some((entry) => String(entry.text).includes("resumed claude-do-session")));

    await provider.stop();
    await worker.stop();
    log.close();
    await new Promise<void>((resolveClose) => api.close(() => resolveClose()));
  });
});

function setupRepo(dir: string): string {
  const seed = join(dir, "seed"), origin = join(dir, "origin.git"), repo = join(dir, "repo");
  mkdirSync(seed);
  git(["init", "-b", "main"], seed);
  git(["config", "user.email", "test@example.com"], seed);
  git(["config", "user.name", "Test"], seed);
  git(["commit", "--allow-empty", "-m", "initial"], seed);
  git(["clone", "--bare", seed, origin]);
  git(["clone", origin, repo]);
  return repo;
}
function git(args: string[], cwd?: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
async function readJson(request: import("node:http").IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}
