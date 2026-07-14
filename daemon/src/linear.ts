import {
  LinearClient,
  LinearError,
  LinearErrorType,
  RatelimitedLinearError,
  parseLinearError,
} from "@linear/sdk";
import type { AppConfig, AppName } from "./config.js";
import type { EventLog } from "./eventlog.js";

export type PostResult = { ok: true } | { ok: false; retriable: boolean; error: string; retryAfterMs?: number };
export type ProgressContent = { type: "thought" | "action"; body: string };
export type TerminalContent = { type: "response" | "error"; body: string };

interface TokenResponse { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown; }
interface TokenGrant { promise: Promise<string>; force: boolean; }

class OAuthTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Headers,
    readonly code?: string,
  ) { super(message); }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { status?: unknown; response?: { status?: unknown } }).status
    ?? (error as { response?: { status?: unknown } }).response?.status;
  return typeof value === "number" ? value : undefined;
}

function retryAfterMsOf(error: unknown, now: number): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const headers = (error as { response?: { headers?: { get?: (name: string) => string | null } } }).response?.headers;
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function retryAfterMsFromSeconds(seconds: unknown): number | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds * 1000)) : undefined;
}

function linearErrorOf(error: unknown): LinearError | undefined {
  if (error instanceof LinearError) return error;
  if (typeof error !== "object" || error === null) return undefined;
  if (!("response" in error)) return undefined;
  return parseLinearError(error as Parameters<typeof parseLinearError>[0]);
}

function hasDuplicateIdError(error: LinearError): boolean {
  return error.type === LinearErrorType.InvalidInput
    && (error.errors ?? []).some(graphqlError =>
      graphqlError.type === LinearErrorType.InvalidInput
      && /already exists|unique constraint|duplicate/i.test(graphqlError.message));
}

function classifyError(error: unknown, now: number): PostResult & { unauthorized?: boolean } {
  const message = errorMessage(error);
  if (error instanceof OAuthTokenError) {
    const terminal = error.status >= 400 && error.status < 500
      && (error.code === "invalid_client" || error.code === "invalid_grant");
    const retryAfterMs = retryAfterMsOf({ response: { headers: error.headers } }, now);
    const result = { ok: false as const, retriable: !terminal, error: message, unauthorized: false };
    return retryAfterMs === undefined ? result : { ...result, retryAfterMs };
  }

  const linearError = linearErrorOf(error);
  if (linearError) {
    if (hasDuplicateIdError(linearError)) return { ok: true };
    if (linearError instanceof RatelimitedLinearError || linearError.type === LinearErrorType.Ratelimited) {
      const retryAfterMs = retryAfterMsFromSeconds((linearError as RatelimitedLinearError).retryAfter)
        ?? retryAfterMsOf(linearError, now);
      return retryAfterMs === undefined
        ? { ok: false, retriable: true, error: linearError.message }
        : { ok: false, retriable: true, error: linearError.message, retryAfterMs };
    }
    if (linearError.type === LinearErrorType.AuthenticationError) {
      return { ok: false, retriable: true, error: linearError.message, unauthorized: true };
    }
    const retriable = linearError.type === LinearErrorType.NetworkError
      || linearError.type === LinearErrorType.InternalError
      || linearError.type === LinearErrorType.LockTimeout
      || linearError.type === LinearErrorType.Unknown
      || linearError.status === 408
      || linearError.status === 429
      || (typeof linearError.status === "number" && linearError.status >= 500);
    return { ok: false, retriable, error: linearError.message, unauthorized: linearError.status === 401 };
  }

  if (/already exists|unique constraint|duplicate/i.test(message)) return { ok: true };
  const status = statusOf(error);
  const retryAfterMs = status === 429 ? retryAfterMsOf(error, now) : undefined;
  const result = {
    ok: false as const,
    retriable: status === undefined || status === 401 || status === 408 || status === 429 || status >= 500,
    error: message,
    unauthorized: status === 401,
  };
  return retryAfterMs === undefined ? result : { ...result, retryAfterMs };
}

export class LinearGateway {
  private readonly tokenGrants = new Map<AppName, TokenGrant>();

  constructor(
    private readonly log: EventLog,
    private readonly apps: Record<AppName, AppConfig>,
    private readonly graphqlUrl: string,
    private readonly tokenUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  async getAppToken(app: AppName, deadlineAt = this.now() + 5_000, force = false): Promise<string> {
    const config = this.apps[app];
    if (config.staticToken) return config.staticToken;
    if (!force) {
      const stored = this.log.getToken(app);
      if (stored && stored.expiresAt > this.now() + 60_000) return stored.accessToken;
    }
    if (!config.clientId || !config.clientSecret) throw new Error(`Missing OAuth credentials for ${app}`);
    const inFlight = this.tokenGrants.get(app);
    if (inFlight && (!force || inFlight.force)) return this.withDeadline(inFlight.promise, deadlineAt, "OAuth token request deadline exceeded");
    const grantDeadlineAt = this.now() + 5_000;
    const promise = this.fetchAppToken(app, config, grantDeadlineAt).finally(() => {
      if (this.tokenGrants.get(app)?.promise === promise) this.tokenGrants.delete(app);
    });
    this.tokenGrants.set(app, { promise, force });
    return this.withDeadline(promise, deadlineAt, "OAuth token request deadline exceeded");
  }

  private async withDeadline<T>(promise: Promise<T>, deadlineAt: number, message: string): Promise<T> {
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) throw new Error(message);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), remaining);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchAppToken(app: AppName, config: AppConfig, deadlineAt: number): Promise<string> {
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) throw new Error("OAuth token request deadline exceeded");
    const body = new URLSearchParams({ grant_type: "client_credentials", scope: "read,write,app:assignable,app:mentionable" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("OAuth token request timed out")), remaining);
    timer.unref();
    try {
      const response = await fetch(this.tokenUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      });
      const json = await response.json().catch(() => ({})) as TokenResponse;
      if (!response.ok || typeof json.access_token !== "string" || typeof json.expires_in !== "number") {
        const code = typeof json.error === "string" ? json.error : undefined;
        const detail = String(json.error_description ?? json.error ?? "invalid response");
        throw new OAuthTokenError(`OAuth token request failed (${response.status}): ${detail}`, response.status, response.headers, code);
      }
      const token = { accessToken: json.access_token, expiresAt: this.now() + json.expires_in * 1000 };
      this.log.putToken(app, token);
      return token.accessToken;
    } finally {
      clearTimeout(timer);
    }
  }

  async postAckActivity(
    app: AppName,
    agentSessionId: string,
    activityId: string,
    deadlineAt: number,
  ): Promise<PostResult> {
    return this.postActivity(app, agentSessionId, activityId,
      { type: "thought", body: "picked up — starting work" }, true, deadlineAt);
  }

  async postActivity(app: AppName, agentSessionId: string, activityId: string,
    content: ProgressContent, ephemeral: true, deadlineAt: number): Promise<PostResult>;
  async postActivity(app: AppName, agentSessionId: string, activityId: string,
    content: TerminalContent, ephemeral: false, deadlineAt: number): Promise<PostResult>;
  async postActivity(app: AppName, agentSessionId: string, activityId: string,
    content: ProgressContent | TerminalContent, ephemeral: boolean, deadlineAt: number): Promise<PostResult> {
    if (ephemeral && content.type !== "thought" && content.type !== "action") {
      return { ok: false, retriable: false, error: `ephemeral is invalid for ${content.type} activities` };
    }
    const attempt = async (forceToken: boolean): Promise<PostResult & { unauthorized?: boolean }> => {
      try {
        const token = await this.getAppToken(app, deadlineAt, forceToken);
        const remaining = deadlineAt - this.now();
        if (remaining <= 0) return { ok: false, retriable: true, error: "Linear activity request deadline exceeded" };
        const controller = new AbortController();
        const client = new LinearClient({ accessToken: token, apiUrl: this.graphqlUrl, signal: controller.signal });
        const timer = setTimeout(() => controller.abort(new Error("Linear activity request timed out")), remaining);
        timer.unref();
        const operation = client.createAgentActivity({
          id: activityId,
          agentSessionId,
          content,
          ...(ephemeral ? { ephemeral: true } : {}),
        });
        const payload = await operation.finally(() => clearTimeout(timer));
        if (!payload.success) return { ok: false, retriable: false, error: "agentActivityCreate returned success:false" };
        return { ok: true };
      } catch (error) {
        return classifyError(error, this.now());
      }
    };
    const first = await attempt(false);
    if (!first.ok && first.unauthorized && !this.apps[app].staticToken) {
      this.log.invalidateToken(app);
      if (deadlineAt <= this.now()) return first;
      return attempt(true);
    }
    return first;
  }
}
