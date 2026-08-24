import type { AppName, Config } from "./config.js";
import type { EventLog, TurnRow } from "./eventlog.js";
import type {
  PostResult,
  ProgressContent,
  TerminalContent,
} from "./linear.js";
import type { WorkProvider } from "./provider.js";

interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

type JsonObject = Record<string, unknown>;

export interface DoozyProviderOptions {
  now?: () => number;
  logger?: Logger;
  onInserted?: () => void;
}

export class DoozyProvider implements WorkProvider {
  private timer?: NodeJS.Timeout;
  private polling: Promise<void> | undefined;
  private stopped = false;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly chatIds = new Map<string, string>();

  constructor(
    private readonly log: EventLog,
    private readonly config: Config,
    private readonly options: DoozyProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(
      () => void this.trigger(),
      this.config.doozyPollIntervalMs ?? 5_000,
    );
    this.timer.unref();
    void this.trigger();
  }

  trigger(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.polling ??= this.poll().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.polling;
  }

  private async poll(): Promise<void> {
    try {
      const todos = await this.listTodos("active");
      let claimed = 0;
      for (const todo of todos) {
        if (!this.eligible(todo)) continue;
        const id = string(todo.id);
        if (!id) continue;
        const status = string(todo.status);
        const existing = this.log.getSession(id);
        if (!existing && status === "ready") {
          if (claimed >= (this.config.doozyPollLimit ?? 1)) continue;
          if (!(await this.claim(todo))) continue;
          claimed++;
          this.appendCreated(todo);
          continue;
        }
        if (existing && status === "in_progress")
          await this.appendFollowUps(todo, existing.lastSeenActivityAt ?? 0);
      }
    } catch (error) {
      this.logger.error(JSON.stringify({
        event: "doozy_poll_failed",
        error: message(error),
      }));
    }
  }

  private async listTodos(status: string): Promise<JsonObject[]> {
    const todos: JsonObject[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ status, limit: "100" });
      if (this.config.doozyAgentId) query.set("assigneeId", this.config.doozyAgentId);
      if (cursor) query.set("cursor", cursor);
      const response = await this.request("GET", `/todos?${query}`);
      todos.push(...objects(response, "todos"));
      cursor = response.hasMore === true ? string(response.nextCursor) : undefined;
    } while (cursor);
    return todos;
  }

  private eligible(todo: JsonObject): boolean {
    const agentId = this.config.doozyAgentId;
    const tag = this.config.doozyTag?.toLowerCase();
    const assigned = new Set([
      string(todo.assigneeId),
      string(todo.agentId),
      string(todo.assignedToId),
      string(object(todo.assignee)?.id),
      string(object(todo.agent)?.id),
      ...array(todo.assignees).map((value) => string(object(value)?.id) ?? string(value)),
    ].filter((value): value is string => Boolean(value)));
    const tags = array(todo.tags).map((value) =>
      (string(value) ?? string(object(value)?.name) ?? string(object(value)?.slug) ?? "").toLowerCase(),
    );
    const title = (string(todo.title) ?? "").toLowerCase();
    return Boolean((agentId && assigned.has(agentId))
      || (tag && (tags.includes(tag) || title.includes(`[${tag}]`))));
  }

  private async claim(todo: JsonObject): Promise<boolean> {
    const id = string(todo.id)!;
    try {
      const response = await this.request("PATCH", `/todos/${encodeURIComponent(id)}`, {
        status: "in_progress",
      });
      const updated = object(response.todo) ?? object(response.data) ?? response;
      if (string(updated.status) && string(updated.status) !== "in_progress") return false;
      this.logger.log(JSON.stringify({ event: "doozy_todo_claimed", todoId: id }));
      return true;
    } catch (error) {
      if (error instanceof DoozyHttpError && (error.status === 409 || error.status === 412)) return false;
      throw error;
    }
  }

  private appendCreated(todo: JsonObject): void {
    const id = string(todo.id)!;
    const app = this.appFor(todo);
    const title = string(todo.title) ?? `Doozy todo ${id}`;
    const content = string(todo.content) ?? string(todo.description) ?? "";
    const raw = {
      action: "created",
      provider: "doozy",
      promptContext: [title, content].filter(Boolean).join("\n\n"),
      todo,
      agentSession: { id, issue: { id, identifier: id } },
    };
    const result = this.log.append({
      deliveryId: `doozy:created:${id}`,
      app,
      action: "created",
      agentSessionId: id,
      issueId: id,
      issueIdentifier: id,
      receivedAt: this.now(),
      rawBody: Buffer.from(JSON.stringify(raw)),
    });
    this.log.updateLastSeenActivity(id, this.now(), this.now());
    if (result.inserted) this.options.onInserted?.();
  }

  private appFor(todo: JsonObject): AppName {
    const labels = [
      ...array(todo.tags).map((value) => string(value) ?? string(object(value)?.name) ?? ""),
      string(todo.mode) ?? "",
      string(todo.title) ?? "",
    ].join(" ");
    return /\bimplement(?:er|ation)?\b|\/do\b/i.test(labels)
      ? "implementer"
      : "planner";
  }

  private async appendFollowUps(todo: JsonObject, since: number): Promise<void> {
    const id = string(todo.id)!;
    const chatId = this.chatId(id, todo);
    if (!chatId) return;
    const response = await this.request("GET", `/chats/${encodeURIComponent(chatId)}/messages`);
    const messages = objects(response, "messages")
      .filter((entry) => this.isHumanMessage(entry))
      .map((entry) => ({
        entry,
        id: string(entry.id),
        body: string(entry.text) ?? string(entry.content) ?? string(entry.body) ?? string(entry.message),
        createdAt: timestamp(entry.createdAt) ?? timestamp(entry.created_at),
      }))
      .filter((entry): entry is { entry: JsonObject; id: string; body: string; createdAt: number } =>
        Boolean(entry.id && entry.body && entry.createdAt && entry.createdAt > since))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const item of messages) {
      const raw = {
        action: "prompted",
        provider: "doozy",
        agentActivity: { id: item.id, body: item.body, createdAt: new Date(item.createdAt).toISOString() },
        agentSession: { id, issue: { id, identifier: id } },
      };
      const result = this.log.append({
        deliveryId: `doozy:prompt:${id}:${item.id}`,
        app: this.appFor(todo),
        action: "prompted",
        agentSessionId: id,
        sourceActivityId: item.id,
        issueId: id,
        issueIdentifier: id,
        receivedAt: this.now(),
        rawBody: Buffer.from(JSON.stringify(raw)),
      });
      this.log.updateLastSeenActivity(id, item.createdAt, this.now());
      if (result.inserted) this.options.onInserted?.();
    }
  }

  private isHumanMessage(entry: JsonObject): boolean {
    const role = (string(entry.role) ?? string(entry.senderType) ?? string(object(entry.sender)?.type) ?? "").toLowerCase();
    const body = string(entry.text) ?? string(entry.content) ?? string(entry.body) ?? string(entry.message) ?? "";
    return (role === "user" || role === "human" || role === "member")
      && !body.startsWith("[orchestra daemon]")
      && !body.startsWith("Help me accomplish this to-do.");
  }

  async postAckActivity(
    app: AppName,
    sessionId: string,
    activityId: string,
    deadlineAt: number,
  ): Promise<PostResult> {
    return this.postActivity(app, sessionId, activityId,
      { type: "thought", body: "picked up, starting work" }, true, deadlineAt);
  }

  async postActivity(
    _app: AppName,
    sessionId: string,
    activityId: string,
    content: ProgressContent | TerminalContent,
    ephemeral: boolean,
    deadlineAt: number,
  ): Promise<PostResult> {
    try {
      if (deadlineAt <= this.now()) return failure("Doozy activity request deadline exceeded", true);
      const body = "body" in content ? content.body : `${content.action}: ${content.parameter}`;
      const todo = await this.getTodo(sessionId);
      if (ephemeral) {
        await this.appendTodoNote(sessionId, todo, `Progress: ${body}`, deadlineAt);
      } else {
        await this.postResult(sessionId, todo, activityId, body, deadlineAt);
      }
      if (!ephemeral && content.type === "response")
        await this.request("PATCH", `/todos/${encodeURIComponent(sessionId)}`, { status: "done" }, deadlineAt);
      return { ok: true };
    } catch (error) {
      return this.postFailure(error);
    }
  }

  async setSessionExternalUrl(
    _app: AppName,
    sessionId: string,
    label: string,
    url: string,
    deadlineAt: number,
  ): Promise<PostResult> {
    try {
      const todo = await this.getTodo(sessionId);
      await this.appendTodoNote(sessionId, todo, `${label}: ${url}`, deadlineAt);
      return { ok: true };
    } catch (error) {
      return this.postFailure(error);
    }
  }

  turnPrompt(turn: TurnRow, identifier: string, implementer: boolean, resuming: boolean): string {
    const payload = parse(turn.rawBody);
    if (resuming) {
      const activity = object(payload.agentActivity);
      return string(activity?.body) ?? "Continue using the latest Doozy todo conversation.";
    }
    const todo = object(payload.todo);
    const title = string(todo?.title) ?? `Doozy todo ${identifier}`;
    const content = string(todo?.content) ?? string(todo?.description) ?? string(payload.promptContext) ?? "";
    const role = implementer ? "bloom-implementer" : "bloom-planner";
    const instruction = implementer
      ? "Implement the requested change end to end in this repository, verify it, and open a pull request when the work is complete."
      : "Discuss, research, and converge on the requested outcome. Use the repository's planning skills when a plan or specification is needed.";
    return `You are ${role}, working on Doozy todo ${identifier}. ${instruction}\n\nTitle: ${title}\n\n${content}`;
  }

  mcpConfigJson(): string {
    return JSON.stringify({ mcpServers: {} });
  }

  private async getTodo(id: string): Promise<JsonObject> {
    const response = await this.request("GET", `/todos/${encodeURIComponent(id)}`);
    return object(response.todo) ?? object(response.data) ?? response;
  }

  private chatId(todoId: string, todo: JsonObject): string | undefined {
    const cached = this.chatIds.get(todoId);
    if (cached) return cached;
    const found = string(todo.chatId) ?? string(todo.conversationId)
      ?? string(object(todo.chat)?.id) ?? string(object(todo.conversation)?.id);
    const latestRunChatId = string(object(todo.latestRun)?.chatId);
    const resolved = found ?? latestRunChatId;
    if (resolved) {
      this.chatIds.set(todoId, resolved);
      return resolved;
    }
    return undefined;
  }

  private async postResult(
    todoId: string,
    todo: JsonObject,
    activityId: string,
    body: string,
    deadlineAt: number,
  ): Promise<void> {
    const messageBody = `[orchestra daemon]\n${body}`;
    const chatId = this.chatId(todoId, todo);
    if (chatId) {
      await this.request("POST", `/chats/${encodeURIComponent(chatId)}/messages`, {
        message: messageBody,
      }, deadlineAt, activityId);
      return;
    }
    await this.appendTodoNote(todoId, todo, `Result: ${body}`, deadlineAt);
  }

  private async appendTodoNote(
    todoId: string,
    todo: JsonObject,
    note: string,
    deadlineAt: number,
  ): Promise<void> {
    const marker = "\n\n### Orchestra daemon activity\n";
    const current = string(todo.content) ?? "";
    const before = current.includes(marker) ? current.slice(0, current.indexOf(marker)) : current;
    const existing = current.includes(marker) ? current.slice(current.indexOf(marker) + marker.length) : "";
    const lines = [...existing.split("\n").filter(Boolean), `- ${note}`].slice(-20);
    const activity = lines.join("\n").slice(-2_900);
    const content = `${before.slice(0, 12_000)}${marker}${activity}`;
    await this.request("PATCH", `/todos/${encodeURIComponent(todoId)}`, { content }, deadlineAt);
  }

  private postFailure(error: unknown): PostResult {
    if (error instanceof DoozyHttpError)
      return failure(error.message, error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500,
        error.retryAfterMs);
    return failure(message(error), true);
  }

  private async request(method: string, path: string, body?: unknown, deadlineAt = this.now() + 10_000,
    idempotencyKey?: string): Promise<JsonObject> {
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) throw new DoozyHttpError("Doozy request deadline exceeded", 408);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    timer.unref();
    try {
      const response = await fetch(`${this.config.doozyApiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.doozyApiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as JsonObject;
      if (!response.ok) {
        const retry = response.headers.get("retry-after");
        const retryAfterMs = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1_000 : undefined;
        throw new DoozyHttpError(`Doozy API ${method} ${path.split("?")[0]} returned ${response.status}`,
          response.status, retryAfterMs);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}

class DoozyHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

function failure(error: string, retriable: boolean, retryAfterMs?: number): PostResult {
  return retryAfterMs === undefined
    ? { ok: false, retriable, error }
    : { ok: false, retriable, error, retryAfterMs };
}
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
function parse(raw: Buffer): JsonObject {
  try { return object(JSON.parse(raw.toString("utf8"))) ?? {}; } catch { return {}; }
}
function objects(value: JsonObject, key: string): JsonObject[] {
  const source = Array.isArray(value[key]) ? value[key]
    : Array.isArray(object(value.data)?.[key]) ? object(value.data)![key]
      : Array.isArray(value.data) ? value.data : [];
  return (source as unknown[]).map(object).filter((entry): entry is JsonObject => Boolean(entry));
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
