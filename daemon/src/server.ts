import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppName, Config } from "./config.js";
import type { EventLog } from "./eventlog.js";
import { verifyWebhook } from "./verify.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface WebhookServerOptions {
  config: Config;
  log: EventLog;
  onInserted?: () => void;
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
      if (this.contentLengthTooLarge(request)) {
        this.json(response, 413, { error: "payload_too_large" }, undefined, () => request.socket.destroy());
        return;
      }
      if (request.method === "GET" && request.url === "/healthz") {
        this.earlyJson(request, response, 200, { ok: true }); return;
      }
      const routeMatch = /^\/webhook\/(planner|implementer)$/.exec(request.url ?? "");
      if (routeMatch && request.method !== "POST") {
        this.earlyJson(request, response, 405, { error: "method_not_allowed" }, { Allow: "POST" });
        return;
      }
      const match = request.method === "POST" ? routeMatch : null;
      if (!match) { this.earlyJson(request, response, 404, { error: "not_found" }); return; }
      const app = match[1] as AppName;
      const rawBody = await this.readBody(request, response);
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
        issueId: isIssue ? stringField(issue?.id) : stringField(session?.issueId) ?? stringField(issue?.id),
        issueIdentifier: stringField(issue?.identifier),
        webhookId: stringField(verified.payload.webhookId),
        receivedAt: Date.now(),
        rawBody,
      };
      const result = this.options.log.append(event);
      this.logger.log(JSON.stringify({ event: "webhook", deliveryId: result.deliveryId, app,
        action: event.action ?? null, sessionId: event.agentSessionId ?? null, issueId: event.issueId ?? null,
        inserted: result.inserted }));
      this.json(response, 200, { ok: true });
      if (result.inserted) this.options.onInserted?.();
    } catch (error) {
      this.logger.error(JSON.stringify({ level: "error", event: "request_failed", error: error instanceof Error ? error.message : String(error) }));
      if (!response.headersSent) this.json(response, 500, { error: "internal_error" }); else response.end();
    }
  }

  private readBody(request: IncomingMessage, response: ServerResponse): Promise<Buffer | undefined> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      request.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          this.json(response, 413, { error: "payload_too_large" }, undefined, () => request.socket.destroy());
          resolve(undefined);
        } else chunks.push(chunk);
      });
      request.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
      request.on("error", error => { if (tooLarge) resolve(undefined); else reject(error); });
    });
  }

  private contentLengthTooLarge(request: IncomingMessage): boolean {
    const header = request.headers["content-length"];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) return false;
    const length = Number(value);
    return Number.isFinite(length) && length > MAX_BODY_BYTES;
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
