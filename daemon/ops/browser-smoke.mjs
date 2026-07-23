#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";

export const REQUIRED_TOOLS = ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_fill_form",
  "browser_tabs", "browser_wait_for", "browser_take_screenshot", "browser_console_messages", "browser_network_requests",
  "browser_start_tracing", "browser_stop_tracing", "browser_start_video", "browser_stop_video", "browser_evaluate", "browser_close"];

async function executable(path, kind) {
  try { await access(path, constants.X_OK); } catch { throw new Error(`${kind}_unavailable: ${path}`); }
}
async function files(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
}
async function fixture(videoPath) {
  const server = createServer((request, response) => {
    if (request.url === "/ping") { response.setHeader("content-type", "application/json"); response.end('{"ok":true}'); return; }
    if (request.url === "/journey.webm") { response.setHeader("content-type", "video/webm"); createReadStream(videoPath).pipe(response); return; }
    if (request.url === "/video-check") { response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><video id="video" src="/journey.webm" muted></video><p id="result">loading</p>
        <script>video.onloadedmetadata=()=>result.textContent='duration:'+video.duration</script>`); return; }
    response.setHeader("content-type", "text/html"); response.end(`<!doctype html><html><body><h1>Browser MCP fixture</h1>
      <label>Name <input id="name" /></label><button id="submit" onclick="fetch('/ping').then(()=>{console.log('submitted');document.querySelector('#result').textContent='Saved'})">Submit</button>
      <p id="result">Ready</p><script>console.log('fixture-ready')</script></body></html>`);
  });
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
function text(result) { return (result.content ?? []).map(item => item.type === "text" ? item.text : "").join("\n"); }

export async function runBrowserSmoke(options = {}) {
  const mcpBin = options.mcpBin ?? process.env.PLAYWRIGHT_MCP_BIN;
  const chromeBin = options.chromeBin ?? process.env.PLAYWRIGHT_CHROME_BIN;
  const outputRoot = resolve(options.outputDir ?? process.env.BROWSER_E2E_OUTPUT_DIR ?? "tmp/browser-smoke");
  if (!mcpBin) throw new Error("mcp_unavailable: set PLAYWRIGHT_MCP_BIN");
  if (!chromeBin) throw new Error("chrome_unavailable: set PLAYWRIGHT_CHROME_BIN");
  await executable(mcpBin, "mcp"); await executable(chromeBin, "chrome");
  const attempt = join(outputRoot, `attempt-${randomUUID()}`), stateDir = join(attempt, "state"), evidenceDir = join(attempt, "evidence");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(evidenceDir, { recursive: true })]);
  const socketAlias = `/tmp/orchestra-pw-${randomUUID()}`;
  await symlink(stateDir, socketAlias);
  const videoPath = join(evidenceDir, "journey.webm");
  const { server, url } = await fixture(videoPath);
  const targetUrl = options.targetUrl ?? url;
  const transport = new StdioClientTransport({ command: mcpBin,
    args: ["--browser", "chrome", "--executable-path", chromeBin, "--headless", "--isolated", "--output-dir", evidenceDir, "--output-mode", "file", "--caps", "devtools"],
    env: { ...process.env, TMPDIR: socketAlias, TEMP: socketAlias, TMP: socketAlias, PWTEST_SOCKETS_DIR: socketAlias } });
  const client = new Client({ name: "orchestra-browser-smoke", version: "1.0.0" });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`tool_failure:${name}:${text(result)}`);
    if (process.env.BROWSER_SMOKE_DEBUG === "1") process.stderr.write(`${name}: ${JSON.stringify(result)}\n`);
    return text(result);
  };
  let observedProfile = false;
  try {
    await client.connect(transport);
    const listed = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of REQUIRED_TOOLS) if (!listed.includes(name)) throw new Error(`mcp_tool_unavailable:${name}`);
    await call("browser_navigate", { url: targetUrl });
    await call("browser_start_tracing"); await call("browser_start_video", { filename: videoPath });
    const snapshot = await call("browser_snapshot", { filename: join(evidenceDir, "snapshot.md") });
    const storagePath = join(evidenceDir, "storage-clean.json");
    await call("browser_evaluate", { function: "() => ({ cookie: document.cookie, local: localStorage.getItem('orchestra'), session: sessionStorage.getItem('orchestra') })", filename: storagePath });
    const storage = JSON.parse(await readFile(storagePath, "utf8"));
    if (storage.cookie || storage.local !== null || storage.session !== null) throw new Error("browser_state_leaked");
    await call("browser_evaluate", { function: "() => { document.cookie='orchestra=seed'; localStorage.setItem('orchestra','seed'); sessionStorage.setItem('orchestra','seed'); return true; }" });
    await call("browser_type", { target: "#name", element: "Name input", text: "agent-e2e" });
    await call("browser_fill_form", { fields: [{ name: "Name", type: "textbox", target: "#name", value: "agent-e2e-filled" }] });
    await call("browser_click", { target: "#submit", element: "Submit button" });
    await call("browser_wait_for", { text: "Saved" });
    await call("browser_tabs", { action: "new", url: `${targetUrl}/tab` }); await call("browser_tabs", { action: "close" });
    await call("browser_take_screenshot", { type: "png", filename: join(evidenceDir, "checkpoint.png"), fullPage: true, scale: "css" });
    await call("browser_console_messages", { level: "info", all: true, filename: join(evidenceDir, "console.txt") });
    await call("browser_network_requests", { static: false, filename: join(evidenceDir, "network.txt") });
    observedProfile = (await files(stateDir)).length > 0;
    if (!observedProfile) throw new Error("chrome_profile_unobserved: no files beneath MCP-scoped state root");
    await call("browser_stop_tracing"); await call("browser_stop_video");
    await call("browser_navigate", { url: `${url}/video-check` }); await call("browser_wait_for", { text: "duration:" });
    await call("browser_evaluate", { function: "() => ({ ready: document.querySelector('video').readyState, duration: document.querySelector('video').duration })", filename: join(evidenceDir, "media-validation.json") });
    const media = JSON.parse(await readFile(join(evidenceDir, "media-validation.json"), "utf8"));
    if (!(media.ready >= 1 && media.duration > 0)) throw new Error("artifact_unplayable:journey.webm");
    await call("browser_close");
    const inventory = await files(evidenceDir);
    const required = ["checkpoint.png", "console.txt", "network.txt", "journey.webm"];
    for (const suffix of required) {
      const path = inventory.find(file => file.endsWith(suffix));
      if (!path || (await stat(path)).size === 0) throw new Error(`artifact_missing:${suffix}`);
    }
    const trace = inventory.find(file => /trace.*\.trace$/.test(file));
    if (!trace || (await stat(trace)).size === 0) throw new Error("artifact_missing:trace");
    const artifacts = inventory.filter(file => file !== join(evidenceDir, "evidence-manifest.json")).map(path => ({ path, bytes: 0 }));
    for (const artifact of artifacts) artifact.bytes = (await stat(artifact.path)).size;
    const manifest = { version: 1, status: "completed", runId: "standalone-smoke", attemptId: basename(attempt),
      attemptRoot: attempt, observedProfile, storageWasClean: true,
      snapshotObserved: snapshot.includes("snapshot") || inventory.some(file => file.endsWith("snapshot.md")), artifacts };
    await writeFile(join(evidenceDir, "evidence-manifest.json"), JSON.stringify(manifest, null, 2));
    return { attempt, stateDir, evidenceDir, manifest };
  } catch (error) {
    throw error instanceof Error && /ECONNREFUSED|net::ERR_/.test(error.message)
      ? new Error(`target_unreachable: ${error.message}`) : error;
  } finally {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    await new Promise(resolveClose => server.close(resolveClose));
    await unlink(socketAlias).catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBrowserSmoke().then(result => process.stdout.write(`${JSON.stringify(result)}\n`), error => {
    process.stderr.write(`browser_smoke_failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
  });
}
