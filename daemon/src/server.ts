import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ArtifactNotFoundError, type ArtifactFile, ArtifactStore, InvalidArtifactError } from "./artifacts.js";
import type { AppName, Config } from "./config.js";
import type { EventLog } from "./eventlog.js";
import { verifyWebhook } from "./verify.js";
import { renderViewer } from "./viewer.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface WebhookServerOptions {
  config: Config;
  log: EventLog;
  artifactStore?: ArtifactStore;
  onInserted?: () => void;
  onStop?: (agentSessionId: string) => void;
  logger?: Pick<Console, "log" | "error">;
}

function stringField(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function objectField(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class WebhookServer {
  private readonly server: Server;
  private readonly logger: Pick<Console, "log" | "error">;

  constructor(private readonly options: WebhookServerOptions) {
    this.logger = options.logger ?? console;
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
  }

  async listen(): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.config.port, this.options.config.bindAddr, resolve);
    });
    return this.server.address() as AddressInfo;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        this.earlyJson(request, response, 200, { ok: true }); return;
      }
      const pathname = (request.url ?? "").split("?", 1)[0] ?? "";
      if (pathname === "/a" || pathname === "/a/" || pathname.startsWith("/a/")) {
        await this.handleArtifact(request, response, pathname);
        return;
      }
      const routeMatch = /^\/webhook\/(planner|implementer)$/.exec(pathname);
      if (routeMatch && request.method !== "POST") {
        this.earlyJson(request, response, 405, { error: "method_not_allowed" }, { Allow: "POST" });
        return;
      }
      const match = request.method === "POST" ? routeMatch : null;
      if (!match) { this.earlyJson(request, response, 404, { error: "not_found" }); return; }
      if (this.contentLengthTooLarge(request, MAX_BODY_BYTES)) {
        this.json(response, 413, { error: "payload_too_large" }, undefined, () => request.socket.destroy());
        return;
      }
      const app = match[1] as AppName;
      const rawBody = await this.readBody(request, response, MAX_BODY_BYTES);
      if (!rawBody) return;
      const signatureHeader = Array.isArray(request.headers["linear-signature"])
        ? request.headers["linear-signature"][0] : request.headers["linear-signature"];
      const verified = verifyWebhook(rawBody, signatureHeader, this.options.config.apps[app].webhookSecret,
        Date.now(), this.options.config.replayWindowMs);
      if (!verified.ok) { this.json(response, 401, { error: verified.reason }); return; }

      const payloadType = stringField(verified.payload.type);
      const isIssue = payloadType === "Issue";
      const session = isIssue ? undefined : objectField(verified.payload.agentSession);
      const issue = isIssue ? objectField(verified.payload.data) : objectField(session?.issue);
      const agentActivity = isIssue ? undefined : objectField(verified.payload.agentActivity);
      const state = objectField(issue?.state);
      const deliveryHeader = request.headers["linear-delivery"];
      const deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;
      const event = {
        deliveryId,
        app,
        type: payloadType,
        stateType: isIssue ? stringField(state?.type) : undefined,
        action: stringField(verified.payload.action),
        agentSessionId: isIssue ? undefined : stringField(session?.id),
        sourceActivityId: isIssue ? undefined : stringField(agentActivity?.id),
        signal: isIssue ? undefined : stringField(agentActivity?.signal),
        issueId: isIssue ? stringField(issue?.id) : stringField(session?.issueId) ?? stringField(issue?.id),
        issueIdentifier: stringField(issue?.identifier),
        webhookId: stringField(verified.payload.webhookId),
        receivedAt: Date.now(),
        rawBody,
      };
      const result = this.options.log.append(event);
      this.logger.log(JSON.stringify({ event: "webhook", deliveryId: result.deliveryId, app,
        action: event.action ?? null, signal: event.signal ?? null, sessionId: event.agentSessionId ?? null, issueId: event.issueId ?? null,
        inserted: result.inserted }));
      this.json(response, 200, { ok: true });
      if (result.inserted) this.options.onInserted?.();
      if (result.stop) this.options.onStop?.(result.stop.agentSessionId);
    } catch (error) {
      this.logger.error(JSON.stringify({ level: "error", event: "request_failed", error: error instanceof Error ? error.message : String(error) }));
      if (!response.headersSent) this.json(response, 500, { error: "internal_error" }); else response.end();
    }
  }

  private async handleArtifact(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const store = this.options.artifactStore;
    if (!store) { this.earlyJson(request, response, 404, { error: "not_found" }); return; }

    const createRoute = pathname === "/a" && request.method === "POST";
    const putMatch = request.method === "PUT" ? /^\/a\/([^/]+)$/.exec(pathname) : null;
    if (createRoute || putMatch) {
      let bundleId = putMatch ? safeDecode(putMatch[1]!) : undefined;
      let fileCount: number | undefined;
      if (!this.authorized(request)) {
        this.logArtifactWrite(request.method!, bundleId, fileCount, "unauthorized", 401);
        this.earlyJson(request, response, 401, { error: "unauthorized" }); return;
      }
      if (this.contentLengthTooLarge(request, this.options.config.artifactMaxBodyBytes)) {
        this.logArtifactWrite(request.method!, bundleId, fileCount, "payload_too_large", 413);
        this.json(response, 413, { error: "payload_too_large" }, undefined, () => request.socket.destroy());
        return;
      }
      const rawBody = await this.readBody(request, response, this.options.config.artifactMaxBodyBytes);
      if (!rawBody) {
        this.logArtifactWrite(request.method!, bundleId, fileCount, "payload_too_large", 413);
        return;
      }
      let files: ArtifactFile[];
      try {
        files = parseManifest(rawBody);
        fileCount = files.length;
        const id = createRoute ? await store.create(files) : decodeURIComponent(putMatch![1]!);
        bundleId = id;
        if (!createRoute) await store.replace(id, files);
        const url = `${this.options.config.webhookBaseUrl}/a/${id}/`;
        this.logArtifactWrite(request.method!, bundleId, fileCount, "success", createRoute ? 201 : 200);
        this.json(response, createRoute ? 201 : 200, { url });
      } catch (error) {
        if (error instanceof ArtifactNotFoundError || error instanceof URIError) {
          this.logArtifactWrite(request.method!, bundleId, fileCount, "not_found", 404);
          this.json(response, 404, { error: "not_found" });
        } else if (error instanceof InvalidArtifactError || error instanceof SyntaxError) {
          this.logArtifactWrite(request.method!, bundleId, fileCount, "invalid_manifest", 400);
          this.json(response, 400, { error: "invalid_manifest" });
        } else {
          this.logArtifactWrite(request.method!, bundleId, fileCount, "internal_error", 500);
          throw error;
        }
      }
      return;
    }

    if (request.method !== "GET") {
      this.earlyJson(request, response, 405, { error: "method_not_allowed" }, { Allow: pathname === "/a" ? "POST" : "GET, PUT" });
      return;
    }
    if (pathname === "/a" || pathname === "/a/") { this.earlyJson(request, response, 404, { error: "not_found" }); return; }

    const redirectMatch = /^\/a\/([^/]+)$/.exec(pathname);
    if (redirectMatch) {
      const id = safeDecode(redirectMatch[1]!);
      if (!id || !store.isValidId(id) || (await store.list(id)).length === 0) {
        this.earlyJson(request, response, 404, { error: "not_found" }); return;
      }
      response.writeHead(301, { Location: `/a/${encodeURIComponent(id)}/`, "Cache-Control": "no-cache" });
      response.end(); return;
    }
    const viewerMatch = /^\/a\/([^/]+)\/$/.exec(pathname);
    if (viewerMatch) {
      const id = safeDecode(viewerMatch[1]!);
      const files = id && store.isValidId(id) ? await store.list(id) : [];
      if (!id || files.length === 0) { this.earlyJson(request, response, 404, { error: "not_found" }); return; }
      const html = renderViewer(id, files);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html), "Cache-Control": "no-cache" });
      response.end(html); return;
    }
    const rawMatch = /^\/a\/([^/]+)\/(.+)$/.exec(pathname);
    if (!rawMatch) { this.earlyJson(request, response, 404, { error: "not_found" }); return; }
    const id = safeDecode(rawMatch[1]!);
    const relPath = safeDecode(rawMatch[2]!);
    if (!id || relPath === undefined) { this.earlyJson(request, response, 404, { error: "not_found" }); return; }
    const absolute = await store.resolve(id, relPath);
    if (!absolute) { this.earlyJson(request, response, 404, { error: "not_found" }); return; }
    try {
      const content = await readFile(absolute);
      response.writeHead(200, { "Content-Type": store.contentTypeFor(relPath), "Content-Length": content.length, "Cache-Control": "no-cache" });
      response.end(content);
    } catch {
      this.earlyJson(request, response, 404, { error: "not_found" });
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const expected = this.options.config.artifactToken;
    const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
    const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!expected) return false;
    const expectedHash = createHash("sha256").update(expected).digest();
    const suppliedHash = createHash("sha256").update(supplied).digest();
    return timingSafeEqual(expectedHash, suppliedHash);
  }

  private logArtifactWrite(method: string, bundleId: string | undefined, fileCount: number | undefined, outcome: string, status: number): void {
    this.logger.log(JSON.stringify({ event: "artifact_write", method, bundleId: bundleId ?? null,
      fileCount: fileCount ?? null, outcome, status }));
  }

  private readBody(request: IncomingMessage, response: ServerResponse, maxBytes: number): Promise<Buffer | undefined> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      request.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > maxBytes) {
          tooLarge = true;
          this.json(response, 413, { error: "payload_too_large" }, undefined, () => request.socket.destroy());
          resolve(undefined);
        } else chunks.push(chunk);
      });
      request.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
      request.on("error", error => { if (tooLarge) resolve(undefined); else reject(error); });
    });
  }

  private contentLengthTooLarge(request: IncomingMessage, maxBytes: number): boolean {
    const header = request.headers["content-length"];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) return false;
    const length = Number(value);
    return Number.isFinite(length) && length > maxBytes;
  }

  private hasRequestBody(request: IncomingMessage): boolean {
    return request.headers["transfer-encoding"] !== undefined || request.headers["content-length"] !== undefined;
  }

  private earlyJson(request: IncomingMessage, response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (this.hasRequestBody(request)) {
      this.json(response, status, body, headers, () => request.socket.destroy());
    } else {
      this.json(response, status, body, headers);
    }
  }

  private json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, done?: () => void): void {
    const encoded = JSON.stringify(body);
    response.writeHead(status, { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) });
    response.end(encoded, done);
  }
}

function safeDecode(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function parseManifest(rawBody: Buffer): ArtifactFile[] {
  const manifest = JSON.parse(rawBody.toString("utf8")) as unknown;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new InvalidArtifactError("manifest must be an object");
  const files = (manifest as { files?: unknown }).files;
  if (!Array.isArray(files)) throw new InvalidArtifactError("manifest files must be an array");
  return files.map(file => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new InvalidArtifactError("invalid file entry");
    const { path, contentBase64 } = file as { path?: unknown; contentBase64?: unknown };
    if (typeof path !== "string" || typeof contentBase64 !== "string" || !validBase64(contentBase64)) {
      throw new InvalidArtifactError("invalid file entry");
    }
    return { path, content: Buffer.from(contentBase64, "base64") };
  });
}

function validBase64(value: string): boolean {
  if (value === "") return true;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}
