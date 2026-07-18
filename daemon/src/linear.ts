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
export interface AgentSessionSummary {
  id: string;
  app: AppName;
  issueId?: string;
  issueIdentifier?: string;
  createdAt?: number;
}
export interface AgentPromptActivity {
  id: string;
  body: string;
  createdAt: number;
  signal?: string;
}
export interface WebhookEnsureResult { matched: boolean; updated: boolean; }
interface Logger { warn(...args: unknown[]): void; }

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
    private readonly logger: Logger = console,
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
    try {
      return await this.fetchAppTokenWithScope(app, config, deadlineAt, "read,write,app:assignable,app:mentionable,admin");
    } catch (error) {
      // Linear rejects `admin` for some client-credentials apps; without it the
      // startup webhook re-enable is unavailable but everything else works.
      if (error instanceof OAuthTokenError && error.status === 400 && /invalid scope/i.test(error.message)) {
        this.logger.warn(JSON.stringify({ level: "warn", event: "oauth_admin_scope_rejected", app }));
        return await this.fetchAppTokenWithScope(app, config, deadlineAt, "read,write,app:assignable,app:mentionable");
      }
      throw error;
    }
  }

  private async fetchAppTokenWithScope(app: AppName, config: AppConfig, deadlineAt: number, scope: string): Promise<string> {
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) throw new Error("OAuth token request deadline exceeded");
    const body = new URLSearchParams({ grant_type: "client_credentials", scope });
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

  async setSessionExternalUrl(app: AppName, agentSessionId: string, label: string, url: string,
    deadlineAt: number): Promise<PostResult> {
    const attempt = async (forceToken: boolean): Promise<PostResult & { unauthorized?: boolean }> => {
      try {
        const token = await this.getAppToken(app, deadlineAt, forceToken);
        const remaining = deadlineAt - this.now();
        if (remaining <= 0) return { ok: false, retriable: true, error: "Linear session update deadline exceeded" };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("Linear session update timed out")), remaining); timer.unref();
        const client = new LinearClient({ accessToken: token, apiUrl: this.graphqlUrl, signal: controller.signal });
        const payload = await client.updateAgentSession(agentSessionId, { addedExternalUrls: [{ label, url }] })
          .finally(() => clearTimeout(timer));
        if (!payload.success) return { ok: false, retriable: false, error: "agentSessionUpdate returned success:false" };
        return { ok: true };
      } catch (error) { return classifyError(error, this.now()); }
    };
    const first = await attempt(false);
    if (!first.ok && first.unauthorized && !this.apps[app].staticToken) {
      this.log.invalidateToken(app);
      if (deadlineAt <= this.now()) return first;
      return attempt(true);
    }
    return first;
  }

  async listAgentSessions(app: AppName, appActorId: string | undefined, deadlineAt = this.now() + 10_000): Promise<AgentSessionSummary[]> {
    if (!appActorId) throw new Error(`APP_ACTOR_ID is required to list ${app} agent sessions`);
    return this.withLinearClient(app, deadlineAt, "Linear agentSessions request", async client => {
      const sessions: AgentSessionSummary[] = [];
      let after: string | undefined;
      do {
        const variables = { first: 100, ...(after ? { after } : {}) };
        const connection = await client.agentSessions(variables);
        for (const node of connection.nodes) {
          if (this.isTerminalSession(node)) continue;
          const summary = await this.sessionSummary(app, node);
          if (this.appUserIdOf(node) === appActorId) sessions.push(summary);
        }
        after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor ?? undefined : undefined;
      } while (after);
      return sessions;
    });
  }

  async listDelegatedIssueAgentSessions(app: AppName, appActorId: string, deadlineAt = this.now() + 10_000): Promise<AgentSessionSummary[]> {
    return this.withLinearClient(app, deadlineAt, "Linear delegated issue request", async client => {
      const sessions = new Map<string, AgentSessionSummary>();
      let after: string | undefined;
      do {
        const data = await this.rawRequest<DelegatedIssuesResponse>(client, delegatedIssuesQuery, {
          first: 50,
          ...(after ? { after } : {}),
          delegateId: appActorId,
        });
        for (const issue of data.issues.nodes) {
          const session = await this.delegatedIssueSession(client, app, appActorId, issue);
          if (session) sessions.set(session.id, session);
        }
        after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor ?? undefined : undefined;
      } while (after);
      return [...sessions.values()];
    });
  }

  private async delegatedIssueSession(client: LinearClient, app: AppName, appActorId: string,
    issue: { id: string; identifier: string }): Promise<AgentSessionSummary | undefined> {
    let after: string | undefined;
    let sawSessionIdentity = false;
    let fallback: DelegatedSessionNode | undefined;
    do {
      const data = await this.rawRequest<IssueAgentSessionsResponse>(client, delegatedIssueAgentSessionsQuery, {
        issueId: issue.id,
        first: 20,
        ...(after ? { after } : {}),
      });
      const connection = data.issue?.agentSessions;
      if (!connection) return undefined;
      for (const node of connection.nodes) {
        if (this.isTerminalSession(node)) continue;
        const nodeActorId = this.appUserIdOf(node);
        if (nodeActorId) sawSessionIdentity = true;
        if (nodeActorId === appActorId) return this.delegatedSessionSummary(app, issue, node);
        if (!nodeActorId && this.newerSession(node, fallback)) fallback = node;
      }
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor ?? undefined : undefined;
    } while (after);

    if (fallback && !sawSessionIdentity) {
      this.logger.warn(JSON.stringify({ event: "delegated_issue_session_identity_missing", app, issueId: issue.id,
        selectedSessionId: fallback.id }));
      return this.delegatedSessionSummary(app, issue, fallback);
    }
    return undefined;
  }

  async listSessionActivitiesSince(app: AppName, agentSessionId: string, since: number | null, deadlineAt = this.now() + 10_000): Promise<AgentPromptActivity[]> {
    return this.withLinearClient(app, deadlineAt, "Linear agent session activities request", async client => {
      const session = await client.agentSession(agentSessionId);
      const activities: AgentPromptActivity[] = [];
      let after: string | undefined;
      do {
        const connection = await session.activities({
          first: 100,
          ...(after ? { after } : {}),
          filter: {
            type: { eq: "prompt" },
            ...(since !== null ? { createdAt: { gte: new Date(since) } } : {}),
          },
        });
        for (const node of connection.nodes) {
          const body = activityBody(node);
          const signal = typeof node.signal === "string" ? node.signal : undefined;
          if (!body && !signal) continue;
          activities.push({ id: node.id, body: body ?? "", createdAt: node.createdAt.getTime(), ...(signal ? { signal } : {}) });
        }
        after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor ?? undefined : undefined;
      } while (after);
      activities.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      return activities;
    });
  }

  async ensureWebhookEnabled(app: AppName, webhookUrl: string, deadlineAt = this.now() + 10_000): Promise<WebhookEnsureResult> {
    return this.withLinearClient(app, deadlineAt, "Linear webhooks request", async client => {
      const target = webhookUrl.replace(/\/+$/, "");
      let after: string | undefined;
      do {
        const connection = await client.webhooks({ first: 100, ...(after ? { after } : {}) });
        for (const webhook of connection.nodes) {
          if (webhook.url?.replace(/\/+$/, "") !== target) continue;
          if (webhook.enabled) return { matched: true, updated: false };
          const payload = await client.updateWebhook(webhook.id, { enabled: true });
          if (!payload.success) throw new Error(`webhook update returned success:false for ${webhook.id}`);
          return { matched: true, updated: true };
        }
        after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor ?? undefined : undefined;
      } while (after);
      return { matched: false, updated: false };
    });
  }

  private async withLinearClient<T>(
    app: AppName,
    deadlineAt: number,
    description: string,
    operation: (client: LinearClient) => Promise<T>,
  ): Promise<T> {
    const attempt = async (forceToken: boolean): Promise<T> => {
      const token = await this.getAppToken(app, deadlineAt, forceToken);
      const remaining = deadlineAt - this.now();
      if (remaining <= 0) throw new Error(`${description} deadline exceeded`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`${description} timed out`)), remaining);
      timer.unref();
      try {
        const client = new LinearClient({ accessToken: token, apiUrl: this.graphqlUrl, signal: controller.signal });
        return await operation(client);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      return await attempt(false);
    } catch (error) {
      const classified = classifyError(error, this.now());
      if (!classified.ok && classified.unauthorized && !this.apps[app].staticToken && deadlineAt > this.now()) {
        this.log.invalidateToken(app);
        return attempt(true);
      }
      throw error;
    }
  }

  private async rawRequest<T>(client: LinearClient, query: string, variables: Record<string, unknown>): Promise<T> {
    const rawClient = (client as unknown as { client: { request(query: string, variables: Record<string, unknown>): Promise<T> } }).client;
    return rawClient.request(query, variables);
  }

  private async sessionSummary(app: AppName, node: unknown, issueIdOverride?: string, issueIdentifierOverride?: string): Promise<AgentSessionSummary> {
    const session = node as {
      id: string; createdAt?: Date; issueId?: string; issue?: Promise<{ id: string; identifier?: string }>; _issue?: { id?: string; identifier?: string };
    };
    let issueId = issueIdOverride ?? session.issueId ?? stringValue(session._issue?.id);
    let issueIdentifier = issueIdentifierOverride ?? stringValue(session._issue?.identifier);
    return {
      id: session.id,
      app,
      ...(issueId ? { issueId } : {}),
      ...(issueIdentifier ? { issueIdentifier } : {}),
      ...(session.createdAt ? { createdAt: session.createdAt.getTime() } : {}),
    };
  }

  private appUserIdOf(node: unknown): string | undefined {
    const session = node as {
      appUserId?: string;
      _appUser?: { id?: string | null };
      appUser?: { id?: string | null } | null;
      creator?: { id?: string | null } | null;
    };
    return session.appUserId ?? stringValue(session._appUser?.id) ?? stringValue(session.appUser?.id) ?? stringValue(session.creator?.id);
  }

  private delegatedSessionSummary(app: AppName, issue: { id: string; identifier: string },
    node: DelegatedSessionNode): AgentSessionSummary {
    const createdAt = typeof node.createdAt === "string" ? Date.parse(node.createdAt) : undefined;
    return {
      id: node.id,
      app,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      ...(createdAt !== undefined && Number.isFinite(createdAt) ? { createdAt } : {}),
    };
  }

  private isTerminalSession(node: AgentSessionNodeState): boolean {
    if (node.endedAt || node.archivedAt || node.dismissedAt) return true;
    const status = node.status?.toLowerCase();
    return status === "done" || status === "completed" || status === "complete"
      || status === "failed" || status === "canceled" || status === "cancelled"
      || status === "dismissed" || status === "ended";
  }

  private newerSession(candidate: DelegatedSessionNode, current: DelegatedSessionNode | undefined): boolean {
    if (!current) return true;
    const candidateTime = typeof candidate.createdAt === "string" ? Date.parse(candidate.createdAt) : 0;
    const currentTime = typeof current.createdAt === "string" ? Date.parse(current.createdAt) : 0;
    return candidateTime > currentTime;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function activityBody(node: unknown): string | undefined {
  const content = (node as { content?: unknown }).content;
  if (content && typeof content === "object") {
    const body = (content as { body?: unknown }).body;
    if (typeof body === "string" && body.trim()) return body;
    const prompt = (content as { prompt?: unknown }).prompt;
    if (typeof prompt === "string" && prompt.trim()) return prompt;
  }
  return undefined;
}

interface DelegatedIssuesResponse {
  issues: {
    nodes: Array<{
      id: string;
      identifier: string;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
}

interface DelegatedSessionNode {
  id: string;
  createdAt?: string | null;
  endedAt?: unknown;
  archivedAt?: unknown;
  dismissedAt?: unknown;
  status?: string | null;
  appUser?: { id?: string | null } | null;
  creator?: { id?: string | null } | null;
}

interface AgentSessionNodeState {
  endedAt?: unknown;
  archivedAt?: unknown;
  dismissedAt?: unknown;
  status?: string | null;
}

interface IssueAgentSessionsResponse {
  issue?: {
    agentSessions: {
      nodes: DelegatedSessionNode[];
      pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    };
  } | null;
}

const delegatedIssuesQuery = `
  query delegatedIssues($first: Int!, $after: String, $delegateId: String!) {
    issues(first: $first, after: $after, filter: { delegate: { id: { eq: $delegateId } } }) {
      nodes { id identifier }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const delegatedIssueAgentSessionsQuery = `
  query delegatedIssueAgentSessions($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      agentSessions(first: $first, after: $after) {
        nodes {
          id
          createdAt
          endedAt
          archivedAt
          dismissedAt
          status
          appUser { id }
          creator { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
