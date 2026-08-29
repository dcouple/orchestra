import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class ConsoleAuthorizationError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = "ConsoleAuthorizationError"; }
}

export class ConsoleMutationGuard {
  readonly token = randomBytes(32).toString("base64url");
  readonly cookieName = "orchestra_console_csrf";

  constructor(readonly capabilityMode: "read-only" | "local-trusted", readonly maxBodyBytes: number) {}

  bootstrap(response: ServerResponse): { capability: "read-only" | "local-trusted"; csrfToken: string } {
    response.setHeader("Set-Cookie", `${this.cookieName}=${this.token}; Path=/; HttpOnly; SameSite=Strict`);
    return { capability: this.capabilityMode, csrfToken: this.token };
  }

  async authorizeAndReadJson(request: IncomingMessage, boundPort: number): Promise<unknown> {
    if (request.method !== "POST") throw new ConsoleAuthorizationError("method_not_allowed", 405);
    const remote = request.socket.remoteAddress;
    const local = request.socket.localAddress;
    if (!isLoopback(remote) || !isLoopback(local)) throw new ConsoleAuthorizationError("forbidden", 403);
    const host = request.headers.host;
    if (!host || (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`))
      throw new ConsoleAuthorizationError("forbidden", 403);
    if (request.headers.origin !== `http://${host}`) throw new ConsoleAuthorizationError("forbidden", 403);
    if (this.capabilityMode !== "local-trusted") throw new ConsoleAuthorizationError("capability_disabled", 403);
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new ConsoleAuthorizationError("unsupported_media_type", 415);
    const cookieToken = parseCookies(request.headers.cookie)[this.cookieName];
    const header = request.headers["x-orchestra-csrf"];
    const headerToken = Array.isArray(header) ? undefined : header;
    if (!safeEqual(cookieToken, this.token) || !safeEqual(headerToken, this.token))
      throw new ConsoleAuthorizationError("csrf_invalid", 403);
    const declared = request.headers["content-length"];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > this.maxBodyBytes))
      throw new ConsoleAuthorizationError("body_too_large", 413);
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      length += bytes.length;
      if (length > this.maxBodyBytes) throw new ConsoleAuthorizationError("body_too_large", 413);
      chunks.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new ConsoleAuthorizationError("invalid_json", 400); }
  }
}

function isLoopback(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}
function parseCookies(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of value?.split(";") ?? []) {
    const at = part.indexOf("="); if (at < 1) continue;
    result[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return result;
}
function safeEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
