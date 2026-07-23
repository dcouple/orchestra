import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const server = config.mcpServers?.playwright;
if (!server) throw new Error("missing Playwright MCP config");
const evidenceDir = process.env.ORCHESTRA_BROWSER_EVIDENCE_DIR;
const stateDir = process.env.ORCHESTRA_BROWSER_STATE_DIR;
const url = process.env.ORCHESTRA_BROWSER_LIFECYCLE_URL;
if (!evidenceDir || !stateDir || !url) throw new Error("missing browser lifecycle environment");

const transport = new StdioClientTransport({ command: server.command, args: server.args, env: server.env });
const client = new Client({ name: "orchestra-browser-lifecycle", version: "1.0.0" });
await client.connect(transport);
for (const [name, args] of [["browser_navigate", { url }], ["browser_snapshot", {}]]) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`lifecycle tool failed: ${name}`);
}

async function processRows() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="]);
  return stdout.split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean).map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}
async function descendants(rootPid) {
  const rows = await processRows(); const ids = new Set([rootPid]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
  return rows.filter(row => ids.has(row.pid));
}

const deadline = Date.now() + 10_000;
let processes = [];
while (Date.now() < deadline) {
  processes = await descendants(process.pid);
  const stateFiles = await readdir(stateDir, { recursive: true }).catch(() => []);
  if (transport.pid && stateFiles.length && processes.some(row => /Google Chrome|google-chrome/.test(row.command))) break;
  await delay(25);
}
if (!transport.pid || !processes.some(row => row.pid === transport.pid)
  || !processes.some(row => /Google Chrome|google-chrome/.test(row.command))) {
  throw new Error("real MCP/Chrome descendants were not observed");
}
await writeFile(join(evidenceDir, "lifecycle-retained.txt"), "real MCP and Chrome started\n");
await writeFile(join(evidenceDir, "lifecycle-ready.json"), JSON.stringify({ driverPid: process.pid, mcpPid: transport.pid, processes }, null, 2));
await new Promise(() => {});
