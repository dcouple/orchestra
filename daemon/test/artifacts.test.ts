import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";
import { loadConfig } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import { WebhookServer } from "../src/server.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(maxBodyBytes = 32 * 1024 * 1024) {
  const dir = mkdtempSync(join(tmpdir(), "artifact-server-")); dirs.push(dir);
  const artifactsDir = join(dir, "artifacts");
  const config = loadConfig({
    DAEMON_TEST_MODE: "1", SESSIONS_ENABLED: "0", DB_PATH: join(dir, "events.db"),
    PLANNER_WEBHOOK_SECRET: "planner-secret", PLANNER_LINEAR_TOKEN: "p",
    IMPLEMENTER_WEBHOOK_SECRET: "implementer-secret", IMPLEMENTER_LINEAR_TOKEN: "i",
    ARTIFACT_TOKEN: "artifact-secret", ARTIFACTS_DIR: artifactsDir,
    ARTIFACT_MAX_BODY_BYTES: String(maxBodyBytes), WEBHOOK_BASE_URL: "https://artifacts.example.test",
  });
  config.port = 0;
  const log = new EventLog(config.dbPath);
  const store = new ArtifactStore(artifactsDir);
  const logger = { log: vi.fn(), error: vi.fn() };
  const server = new WebhookServer({ config, log, artifactStore: store, logger });
  return { dir, artifactsDir, config, log, store, server, logger };
}

function manifest(files: Array<{ path: string; content: string | Buffer }>): string {
  return JSON.stringify({ files: files.map(file => ({ path: file.path,
    contentBase64: (typeof file.content === "string" ? Buffer.from(file.content) : file.content).toString("base64") })) });
}

function auth(token = "artifact-secret"): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function expectJsonError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ error });
}

async function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject); request.end();
  });
}

async function oversizedWebhook(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }); let raw = "";
    socket.on("connect", () => socket.write([
      "POST /webhook/planner HTTP/1.1", "Host: 127.0.0.1", "Content-Length: 1048577",
      "Linear-Signature: oversized", "", "",
    ].join("\r\n")));
    socket.on("data", chunk => { raw += chunk.toString(); });
    socket.on("end", () => resolve(raw)); socket.on("close", () => resolve(raw)); socket.on("error", reject);
  });
}

describe("artifact store", () => {
  it("generates distinct 128-bit base64url ids and rejects traversal", async () => {
    const { store } = setup();
    const first = store.createId(); const second = store.createId();
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/); expect(second).not.toBe(first);
    const id = await store.create([{ path: "item.md", content: Buffer.from("safe") }]);
    await expect(store.resolve(id, "../secret.txt")).resolves.toBeUndefined();
    await expect(store.resolve(id, "refs\\secret.txt")).resolves.toBeUndefined();
  });
});

describe("artifact HTTP integration", () => {
  it("AC1/AC3/AC4: creates a multi-file bundle with a server id and serves the viewer", async () => {
    const { artifactsDir, log, server, logger } = setup(); const address = await server.listen();
    const body = manifest([
      { path: "item.md", content: "# Item" },
      { path: "refs/explainer.html", content: "<h1>Explainer</h1>" },
      { path: "refs/pixel.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const response = await fetch(`http://127.0.0.1:${address.port}/a`, { method: "POST", headers: auth(), body });
    expect(response.status).toBe(201);
    const { url } = await response.json() as { url: string };
    const id = /\/a\/([^/]+)\/$/.exec(url)?.[1];
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(readFileSync(join(artifactsDir, id!, "current"), "utf8")).toMatch(/^v-/);
    expect((await fetch(`http://127.0.0.1:${address.port}/a/${id}/item.md`)).status).toBe(200);
    const viewer = await fetch(`http://127.0.0.1:${address.port}/a/${id}/`);
    const html = await viewer.text();
    expect(viewer.status).toBe(200); expect(html).toContain("refs/explainer.html");
    expect(html).toContain('setAttribute("sandbox", "allow-scripts allow-popups")');
    expect(html.indexOf("refs/explainer.html")).toBeLessThan(html.indexOf("item.md"));
    await expectJsonError(await fetch(`http://127.0.0.1:${address.port}/a`), 404, "not_found");
    await expectJsonError(await fetch(`http://127.0.0.1:${address.port}/a/`), 404, "not_found");
    const redirect = await fetch(`http://127.0.0.1:${address.port}/a/${id}`, { redirect: "manual" });
    expect(redirect.status).toBe(301); expect(redirect.headers.get("location")).toBe(`/a/${id}/`);
    expect(logger.log).toHaveBeenCalledWith(JSON.stringify({ event: "artifact_write", method: "POST",
      bundleId: id, fileCount: 3, outcome: "success", status: 201 }));
    await server.close(); log.close();
  });

  it("AC2/AC3: rejects unauthorized writes and client-minted ids without creating storage", async () => {
    const { artifactsDir, log, server, logger } = setup(); const address = await server.listen();
    const body = manifest([{ path: "item.md", content: "private" }]);
    await expectJsonError(await fetch(`http://127.0.0.1:${address.port}/a`, { method: "POST", body }), 401, "unauthorized");
    await expectJsonError(await fetch(`http://127.0.0.1:${address.port}/a`, { method: "POST", headers: auth("wrong"), body }), 401, "unauthorized");
    expect(existsSync(artifactsDir)).toBe(false);
    const chosen = "AAAAAAAAAAAAAAAAAAAAAA";
    await expectJsonError(await fetch(`http://127.0.0.1:${address.port}/a/${chosen}`, { method: "PUT", headers: auth(), body }), 404, "not_found");
    await expectJsonError(await fetch(`http://127.0.0.1:${address.port}/a/${chosen}`, { method: "PUT", headers: auth("wrong"), body }), 401, "unauthorized");
    expect(existsSync(artifactsDir)).toBe(false);
    const records = logger.log.mock.calls.map(([line]) => JSON.parse(line as string) as Record<string, unknown>);
    expect(records).toContainEqual({ event: "artifact_write", method: "POST", bundleId: null,
      fileCount: null, outcome: "unauthorized", status: 401 });
    expect(records).toContainEqual({ event: "artifact_write", method: "PUT", bundleId: chosen,
      fileCount: 1, outcome: "not_found", status: 404 });
    expect(JSON.stringify(records)).not.toContain("artifact-secret");
    await server.close(); log.close();
  });

  it("rejects unauthorized replacement and malformed paths without changing the live bundle", async () => {
    const { log, server } = setup(); const address = await server.listen();
    const created = await fetch(`http://127.0.0.1:${address.port}/a`, { method: "POST", headers: auth(),
      body: manifest([{ path: "item.md", content: "original" }]) });
    const id = /\/a\/([^/]+)\/$/.exec(((await created.json()) as { url: string }).url)![1]!;
    const replacement = manifest([{ path: "item.md", content: "changed" }]);
    await expectJsonError(await fetch(`http://127.0.0.1:${address.port}/a/${id}`, { method: "PUT", body: replacement }), 401, "unauthorized");
    await expectJsonError(await fetch(`http://127.0.0.1:${address.port}/a/${id}`, { method: "PUT", headers: auth("wrong"), body: replacement }), 401, "unauthorized");
    const malformed = manifest([{ path: "../secret.txt", content: "bad" }]);
    await expectJsonError(await fetch(`http://127.0.0.1:${address.port}/a/${id}`, { method: "PUT", headers: auth(), body: malformed }), 400, "invalid_manifest");
    await expectJsonError(await fetch(`http://127.0.0.1:${address.port}/a/${id}`, { method: "PUT", headers: auth(), body: "{" }), 400, "invalid_manifest");
    expect(await (await fetch(`http://127.0.0.1:${address.port}/a/${id}/item.md`)).text()).toBe("original");
    await server.close(); log.close();
  });

  it("AC6: serves raw files with correct content types and no-cache", async () => {
    const { log, server } = setup(); const address = await server.listen();
    const body = manifest([
      { path: "refs/page.html", content: "<p>x</p>" }, { path: "item.md", content: "# x" },
      { path: "refs/image.png", content: "png" }, { path: "refs/image.svg", content: "<svg/>" },
    ]);
    const created = await fetch(`http://127.0.0.1:${address.port}/a`, { method: "POST", headers: auth(), body });
    const id = /\/a\/([^/]+)\/$/.exec(((await created.json()) as { url: string }).url)![1]!;
    const expected = { "refs/page.html": "text/html; charset=utf-8", "item.md": "text/markdown; charset=utf-8",
      "refs/image.png": "image/png", "refs/image.svg": "image/svg+xml" };
    for (const [path, type] of Object.entries(expected)) {
      const response = await fetch(`http://127.0.0.1:${address.port}/a/${id}/${path}`);
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
    await server.close(); log.close();
  });

  it("AC7: atomically replaces contents at the stable URL", async () => {
    const { log, server } = setup(); const address = await server.listen();
    const oldContent = "old-".repeat(20_000); const newContent = "new-".repeat(20_000);
    const created = await fetch(`http://127.0.0.1:${address.port}/a`, { method: "POST", headers: auth(),
      body: manifest([{ path: "item.md", content: oldContent }]) });
    const url = ((await created.json()) as { url: string }).url;
    const id = /\/a\/([^/]+)\/$/.exec(url)![1]!;
    const reads: Array<Promise<string>> = [];
    const replacing = fetch(`http://127.0.0.1:${address.port}/a/${id}`, { method: "PUT", headers: auth(),
      body: manifest([{ path: "item.md", content: newContent }]) });
    for (let index = 0; index < 20; index++) reads.push(fetch(`http://127.0.0.1:${address.port}/a/${id}/item.md`).then(response => {
      expect(response.status).toBe(200); return response.text();
    }));
    const replaced = await replacing; expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as { url: string }).url).toBe(url);
    for (const content of await Promise.all(reads)) expect([oldContent, newContent]).toContain(content);
    const latest = await fetch(`http://127.0.0.1:${address.port}/a/${id}/item.md`);
    expect(await latest.text()).toBe(newContent); expect(latest.headers.get("cache-control")).toBe("no-cache");
    await server.close(); log.close();
  });

  it("AC8: returns 404 for literal and encoded traversal without exposing a sibling secret", async () => {
    const { dir, log, server } = setup(); writeFileSync(join(dir, "secret.txt"), "outside-secret");
    const address = await server.listen();
    const created = await fetch(`http://127.0.0.1:${address.port}/a`, { method: "POST", headers: auth(),
      body: manifest([{ path: "item.md", content: "safe" }]) });
    const id = /\/a\/([^/]+)\/$/.exec(((await created.json()) as { url: string }).url)![1]!;
    for (const path of [`/a/${id}/../secret.txt`, `/a/${id}/%2e%2e/%2e%2e/secret.txt`]) {
      const response = await rawGet(address.port, path);
      expect(response.status).toBe(404); expect(JSON.parse(response.body)).toEqual({ error: "not_found" });
      expect(response.body).not.toContain("outside-secret");
    }
    await server.close(); log.close();
  });

  it("keeps artifact and webhook body limits route-specific", async () => {
    const { log, server } = setup(256); const address = await server.listen();
    const artifactResponse = await fetch(`http://127.0.0.1:${address.port}/a`, { method: "POST", headers: auth(),
      body: manifest([{ path: "item.md", content: "x".repeat(512) }]) });
    await expectJsonError(artifactResponse, 413, "payload_too_large");
    expect((await oversizedWebhook(address.port)).startsWith("HTTP/1.1 413")).toBe(true);
    await server.close(); log.close();
  });
});
