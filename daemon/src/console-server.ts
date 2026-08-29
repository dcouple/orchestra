import { randomUUID } from "node:crypto";
import { constants, type ReadStream } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ConsoleConfig } from "./config.js";
import { ConsoleAuthorizationError, ConsoleMutationGuard } from "./console-authorization.js";
import { ConsoleBrokerError, type ConsoleOperationBroker } from "./console-operation-broker.js";
import { ConsoleValidationError } from "./console-operation-schema.js";
import { ConsoleLoopBrokerError, type ConsoleLoopBroker } from "./console-loop-broker.js";
import { parseJsonNoDuplicateKeys, StrictJsonError } from "./strict-json.js";
import { LoopValidationError } from "./loops.js";
import type { EventLog } from "./eventlog.js";
import { projectConsoleOperation, projectDependencies, type ConsoleDaemonHealth, type ConsoleOverview } from "./console-projections.js";
import { readSkillInventory, type ConsoleSkillsPayload } from "./skill-inventory.js";

export type DaemonProbe = (url: string, timeoutMs: number) => Promise<boolean>;
interface ConsoleLogger { log(...args: unknown[]): void; error(...args: unknown[]): void }
export interface ConsoleServerOptions {
  config: ConsoleConfig;
  log: EventLog;
  probe?: DaemonProbe;
  now?: () => number;
  logger?: ConsoleLogger;
  beforeAssetOpen?: (canonicalPath: string) => void | Promise<void>;
  readSkills?: () => Promise<ConsoleSkillsPayload>;
  broker?: ConsoleOperationBroker;
  loopBroker?: ConsoleLoopBroker;
}

interface OpenAsset { path: string; handle: FileHandle }

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

export async function probeDaemon(url: string, timeoutMs: number): Promise<boolean> {
  let response: Response | undefined;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    return response.ok;
  } catch { return false; }
  finally {
    try { await response?.body?.cancel(); }
    catch { /* The observed health status remains authoritative if cancellation races a closed body. */ }
  }
}

export class ConsoleServer {
  private readonly server: Server;
  private readonly probe: DaemonProbe;
  private readonly now: () => number;
  private readonly logger: ConsoleLogger;
  private readonly readSkills: () => Promise<ConsoleSkillsPayload>;
  private readonly mutationGuard: ConsoleMutationGuard;
  private boundPort?: number;

  constructor(private readonly options: ConsoleServerOptions) {
    this.probe = options.probe ?? probeDaemon;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.readSkills = options.readSkills ?? (() => readSkillInventory(options.config.skillInventoryPath));
    this.mutationGuard = new ConsoleMutationGuard(options.config.capabilityMode ?? "read-only", options.config.maxBodyBytes ?? 64 * 1024);
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.requestTimeout = 5_000;
    this.server.headersTimeout = 5_000;
    this.server.keepAliveTimeout = 5_000;
  }

  async listen(): Promise<AddressInfo> {
    await new Promise<void>((resolveListen, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.config.port, this.options.config.bindAddr, resolveListen);
    });
    const address = this.server.address() as AddressInfo;
    if (address.address !== "127.0.0.1") {
      await this.close();
      throw new Error(`console refused non-loopback listener: ${address.address}`);
    }
    this.boundPort = address.port;
    return address;
  }

  close(): Promise<void> {
    return new Promise((resolveClose, reject) => this.server.close(error => error ? reject(error) : resolveClose()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.trustedRequest(request)) { this.json(response, 403, { error: { code: "forbidden", message: "untrusted host or origin" } }); return; }
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (path.startsWith("/api/")) {
        if (request.method !== "GET") { await this.mutationApi(path, request, response); return; }
        await this.api(path, response);
        if ((path === "/api/dependencies" || path === "/api/skills")
          && response.statusCode >= 200 && response.statusCode < 300) this.logApiRequest(request, path, response.statusCode);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        this.json(response, 405, { error: { code: "method_not_allowed", message: "console is read-only" } }, { Allow: "GET, HEAD" }); return;
      }
      await this.staticFile(path, request.method === "HEAD", response);
    } catch (error) {
      const known = error instanceof ConsoleAuthorizationError || error instanceof ConsoleBrokerError || error instanceof ConsoleValidationError
        || error instanceof ConsoleLoopBrokerError || error instanceof StrictJsonError || error instanceof LoopValidationError;
      if (!known) this.logger.error(JSON.stringify({ level: "error", event: "console_request_failed", error: "internal_error" }));
      if (!response.headersSent) {
        const status = error instanceof ConsoleAuthorizationError || error instanceof ConsoleBrokerError || error instanceof ConsoleLoopBrokerError ? error.status
          : error instanceof ConsoleValidationError || error instanceof LoopValidationError || error instanceof StrictJsonError ? 400 : 500;
        const code = known ? (error as ConsoleAuthorizationError | ConsoleBrokerError | ConsoleValidationError).code : "internal_error";
        this.json(response, status, { error: { code, message: code.replaceAll("_", " ") } });
      }
      else response.end();
    }
  }

  private logApiRequest(request: IncomingMessage, path: "/api/dependencies" | "/api/skills", status: number): void {
    const remote = request.socket.remoteAddress;
    const caller = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1"
      ? "loopback" : "unknown";
    try {
      this.logger.log(JSON.stringify({ event: "console_api_request", requestId: randomUUID(),
        caller, method: "GET", path, status }));
    } catch { /* Observability must not change a successful read response. */ }
  }

  private trustedRequest(request: IncomingMessage): boolean {
    const host = request.headers.host?.toLowerCase();
    const hostMatch = host ? /^(localhost|127\.0\.0\.1):(\d+)$/.exec(host) : null;
    if (!hostMatch || Number(hostMatch[2]) !== this.boundPort) return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      return parsed.protocol === "http:" && parsed.hostname === hostMatch[1]
        && parsed.port === String(this.boundPort);
    } catch { return false; }
  }

  private async daemonHealth(): Promise<ConsoleDaemonHealth> {
    const observedAt = this.now();
    let timer: NodeJS.Timeout | undefined;
    const online = await Promise.race([
      this.probe(this.options.config.daemonHealthUrl, 1_500).catch(() => false),
      new Promise<false>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), 1_500); }),
    ]);
    if (timer) clearTimeout(timer);
    return { status: online ? "online" : "offline", observedAt };
  }

  private async api(path: string, response: ServerResponse): Promise<void> {
    if (path === "/api/bootstrap") { this.json(response, 200, this.mutationGuard.bootstrap(response)); return; }
    if (path === "/api/configuration") {
      if (!this.options.broker) { this.json(response, 503, { error: { code: "writes_unavailable", message: "writes unavailable" } }); return; }
      this.json(response, 200, await this.options.broker.configuration()); return;
    }
    if (path === "/api/operations") {
      this.json(response, 200, { operations: this.options.log.listOperations()
        .map(operation => projectConsoleOperation(operation, this.options.log.operationEvents(operation.id))) }); return;
    }
    if (path === "/api/loops") { this.json(response,200,{loops:this.options.log.listLoops().map(loop=>({ ...loop, task:{kind:"agent",role:loop.task.role} }))}); return; }
    const loopMatch=/^\/api\/loops\/([^/]+)$/.exec(path);
    if(loopMatch){let id:string;try{id=decodeURIComponent(loopMatch[1]!);}catch{this.json(response,400,{error:{code:"bad_request",message:"invalid loop id"}});return;}
      const loop=this.options.log.loopById(id);if(!loop){this.json(response,404,{error:{code:"not_found",message:"loop not found"}});return;}
      this.json(response,200,{...loop,audit:this.options.log.loopAudit(id),cleanups:this.options.log.loopCleanups(id).map(({worktreePath,ownerKey,...row})=>row),occurrences:this.options.log.loopOccurrences(id).map(({snapshot,...row})=>({...row,policy:{budgetUsd:snapshot.budgetUsd,timeoutMinutes:snapshot.timeoutMinutes,maxRetries:snapshot.maxRetries}}))});return;}
    if (path === "/api/health") { this.json(response, 200, { ok: true, observedAt: this.now() }); return; }
    if (path === "/api/overview") {
      const observedAt = this.now();
      const allRuns = this.options.log.consoleRuns(100, observedAt, this.options.config.linearWorkspaceBaseUrl);
      const recentRuns = allRuns.slice(0, 10);
      const daemon = await this.daemonHealth();
      const dependencies = projectDependencies(this.options.log.dependencyObservations(), daemon, observedAt);
      const payload: ConsoleOverview = {
        observedAt,
        daemon,
        providers: this.options.log.consoleProviders(),
        operations: this.options.log.operationStatus(observedAt),
        activeRuns: allRuns.filter(run => run.completedAt === null && run.status === "active").length,
        recentRuns,
        dependencies: { status: dependencies.status,
          configured: dependencies.dependencies.filter(row => row.configured === true).length,
          total: dependencies.dependencies.length },
      };
      this.json(response, 200, payload); return;
    }
    if (path === "/api/runs") {
      this.json(response, 200, { runs: this.options.log.consoleRuns(50, this.now(), this.options.config.linearWorkspaceBaseUrl) }); return;
    }
    if (path === "/api/dependencies") {
      const now = this.now();
      const daemon = await this.daemonHealth();
      this.json(response, 200, projectDependencies(this.options.log.dependencyObservations(), daemon, now)); return;
    }
    if (path === "/api/skills") { this.json(response, 200, await this.readSkills()); return; }
    const match = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (match) {
      let id: string;
      try { id = decodeURIComponent(match[1]!); } catch { this.json(response, 400, { error: { code: "bad_request", message: "invalid run id" } }); return; }
      const run = this.options.log.consoleRun(id, this.now(), this.options.config.linearWorkspaceBaseUrl);
      if (!run) { this.json(response, 404, { error: { code: "not_found", message: "run not found" } }); return; }
      this.json(response, 200, run); return;
    }
    this.json(response, 404, { error: { code: "not_found", message: "endpoint not found" } });
  }

  private async mutationApi(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if(path==="/api/loops/drafts"||path==="/api/loops/confirm"){
      if(!this.options.loopBroker){this.json(response,503,{error:{code:"writes_unavailable",message:"writes unavailable"}});return;}
      const raw=await this.mutationGuard.authorizeAndReadBody(request,this.boundPort??0);let body:unknown;
      try{body=parseJsonNoDuplicateKeys(raw.toString("utf8"));}catch(error){if(error instanceof StrictJsonError)throw new ConsoleAuthorizationError(error.code,400);throw error;}
      if(path==="/api/loops/drafts"){this.json(response,200,this.options.loopBroker.draft(body));return;}
      this.json(response,200,await this.options.loopBroker.confirm(body));return;
    }
    if (!this.options.broker) { this.json(response, 405, { error: { code: "method_not_allowed", message: "read-only endpoint" } }, { Allow: "GET" }); return; }
    const body = await this.mutationGuard.authorizeAndReadJson(request, this.boundPort ?? 0);
    if (path === "/api/drafts" || path === "/api/config/drafts" || path === "/api/operations/drafts") {
      this.json(response, 200, await this.options.broker.draft(body)); return;
    }
    if (path === "/api/operations/confirm" || path === "/api/config/confirm") {
      this.json(response, 202, await this.options.broker.confirm(body)); return;
    }
    const control = /^\/api\/operations\/([^/]+)\/(retry|cancel)$/.exec(path);
    if (control) {
      let targetOperationId: string; try { targetOperationId = decodeURIComponent(control[1]!); }
      catch { throw new ConsoleBrokerError("invalid_target", 400); }
      const row = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
      this.json(response, 202, await this.options.broker.control({ ...row, targetOperationId, kind: `operation.${control[2]}` })); return;
    }
    this.json(response, 404, { error: { code: "not_found", message: "endpoint not found" } });
  }

  private async staticFile(pathname: string, head: boolean, response: ServerResponse): Promise<void> {
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { this.json(response, 400, { error: { code: "bad_request", message: "invalid path" } }); return; }
    if (decoded.includes("\0")) { this.json(response, 400, { error: { code: "bad_request", message: "invalid path" } }); return; }
    let root: string;
    try { root = await realpath(resolve(this.options.config.assetsDir)); }
    catch { this.json(response, 503, { error: { code: "assets_unavailable", message: "console assets are not built" } }); return; }
    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const requested = resolve(root, relative);
    if (!this.pathContained(root, requested)) { this.json(response, 404, { error: { code: "not_found", message: "asset not found" } }); return; }
    let asset = await this.openRealFileWithin(root, requested);
    if (!asset) {
      if (extname(relative)) { this.json(response, 404, { error: { code: "not_found", message: "asset not found" } }); return; }
      asset = await this.openRealFileWithin(root, resolve(root, "index.html"));
      if (!asset) { this.json(response, 503, { error: { code: "assets_unavailable", message: "console assets are not built" } }); return; }
    }
    await this.serveAsset(asset, head, response);
  }

  private pathContained(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(`${root}${sep}`);
  }

  private async openRealFileWithin(root: string, candidate: string): Promise<OpenAsset | undefined> {
    let handle: FileHandle | undefined;
    try {
      const realCandidate = await realpath(candidate);
      if (!this.pathContained(root, realCandidate) || !(await stat(realCandidate)).isFile()) return undefined;
      await this.options.beforeAssetOpen?.(realCandidate);
      handle = await open(realCandidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const [openedStat, currentRealPath, currentStat] = await Promise.all([
        handle.stat(), realpath(realCandidate), stat(realCandidate),
      ]);
      if (!openedStat.isFile() || currentRealPath !== realCandidate || !this.pathContained(root, currentRealPath)
        || openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
        await this.closeAsset(handle); return undefined;
      }
      return { path: realCandidate, handle };
    } catch {
      if (handle) await this.closeAsset(handle);
      return undefined;
    }
  }

  private async serveAsset(asset: OpenAsset, head: boolean, response: ServerResponse): Promise<void> {
    const contentType = MIME[extname(asset.path).toLowerCase()] ?? "application/octet-stream";
    const headers = { "Content-Type": contentType,
      "Cache-Control": asset.path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
    let stream: ReadStream | undefined;
    try {
      if (head) { response.writeHead(200, headers); response.end(); return; }
      stream = asset.handle.createReadStream({ autoClose: false });
      response.writeHead(200, headers);
      await pipeline(stream, response);
    } catch (error) {
      this.logger.error(JSON.stringify({ level: "error", event: "console_asset_stream_failed",
        error: error instanceof Error ? error.message : String(error) }));
      if (!response.headersSent)
        this.json(response, 500, { error: { code: "asset_read_failed", message: "asset could not be read" } });
      else if (!response.destroyed) response.destroy();
    } finally {
      stream?.destroy();
      await this.closeAsset(asset.handle);
    }
  }

  private async closeAsset(handle: FileHandle): Promise<void> {
    try { await handle.close(); }
    catch (error) {
      this.logger.error(JSON.stringify({ level: "error", event: "console_asset_close_failed",
        error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
    response.end(JSON.stringify(body));
  }
}
