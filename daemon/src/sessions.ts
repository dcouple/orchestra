import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Config } from "./config.js";
import { runTurn, type ClaudeEvent } from "./claude.js";
import type { EventLog, ExternalUrlRow, TurnActivityRow, TurnRow } from "./eventlog.js";
import type { LinearGateway, PostResult, ProgressContent } from "./linear.js";
import { WorktreeManager } from "./worktrees.js";

interface Logger { log(...args: unknown[]): void; error(...args: unknown[]): void; }
export interface SessionWorkerOptions {
  pollMs?: number; reconcileMs?: number; now?: () => number; logger?: Logger;
  attachmentTestAllowHttp?: boolean; attachmentTimeoutMs?: number;
  onTurnComplete?: () => void;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function bodyFrom(value: unknown): string | undefined {
  const node = object(value); if (!node) return undefined;
  return text(node.body) ?? text(object(node.content)?.body) ?? text(node.prompt);
}
function describeTool(event: Extract<ClaudeEvent, { type: "toolUse" }>): string {
  const input = object(event.input);
  const detail = text(input?.description) ?? text(input?.command) ?? JSON.stringify(event.input ?? {}).slice(0, 500);
  return `${event.name}: ${detail || "running"}`;
}
function jsonLog(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

class ProgressQueue {
  private queue: Array<{ id: string; content: ProgressContent }> = [];
  private running: Promise<void> | undefined;
  private cancelled = false;
  lastSuccess: number;
  constructor(private readonly post: (id: string, content: ProgressContent) => Promise<PostResult>,
    private readonly now: () => number, private readonly logger: Logger) { this.lastSuccess = now(); }
  push(content: ProgressContent): void {
    if (this.cancelled) return;
    if (this.queue.length >= 20) this.queue.shift();
    this.queue.push({ id: randomUUID(), content });
    this.running ??= this.drain();
  }
  private async drain(): Promise<void> {
    while (!this.cancelled) {
      const item = this.queue.shift(); if (!item) break;
      const result = await this.post(item.id, item.content);
      if (result.ok) this.lastSuccess = this.now();
      else this.logger.error(JSON.stringify({ event: "session_progress_failed", error: result.error }));
    }
    this.running = undefined;
    if (!this.cancelled && this.queue.length) this.running = this.drain();
  }
  async cancelAndWait(): Promise<void> { this.cancelled = true; this.queue.length = 0; await this.running; }
}

export class SessionWorker {
  private timer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private stopped = false;
  private draining = false;
  private activityDrain: Promise<void> | undefined;
  private readonly active = new Map<number, { promise: Promise<void>; controller: AbortController }>();
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly worktrees: WorktreeManager;

  constructor(private readonly log: EventLog, private readonly gateway: LinearGateway, private readonly config: Config,
    private readonly options: SessionWorkerOptions = {}) {
    this.now = options.now ?? Date.now; this.logger = options.logger ?? console;
    this.worktrees = new WorktreeManager(config.worktreesRoot, config.targetRepoPath!);
  }
  start(): void {
    this.stopped = false;
    this.log.interruptStaleRunning(this.now());
    this.timer = setInterval(() => { void this.drain(); void this.triggerActivityDrain(); }, this.options.pollMs ?? 250);
    this.reconcileTimer = setInterval(() => void this.triggerActivityDrain(), this.options.reconcileMs ?? 60_000);
    this.timer.unref(); this.reconcileTimer.unref(); void this.drain(); void this.triggerActivityDrain();
  }
  trigger(): void { queueMicrotask(() => void this.drain()); }
  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (!this.stopped && this.active.size < this.config.sessionConcurrency) {
        const turn = this.log.claimNextTurn(this.now()); if (!turn) break;
        const controller = new AbortController();
        const promise = this.process(turn, controller.signal).catch(error => {
          this.logger.error(jsonLog({ event: "session_turn_unhandled", turnId: turn.id,
            linearSessionId: turn.linearSessionId, issueId: turn.issueId, attempts: turn.attempts, error: String(error) }));
          const role = turn.app === "implementer" ? "Implementer" : "Planner";
          try { this.log.finishTurn(turn.id, "error", `${role} turn failed: ${error instanceof Error ? error.message : String(error)}`, this.now()); } catch {}
        }).finally(() => { this.active.delete(turn.id); void this.triggerActivityDrain(); void this.drain(); });
        this.active.set(turn.id, { promise, controller });
      }
    } finally { this.draining = false; }
  }

  private async process(turn: TurnRow, signal: AbortSignal): Promise<void> {
    const session = this.log.getSession(turn.linearSessionId);
    if (!session) throw new Error(`Missing session ${turn.linearSessionId}`);
    const identifier = session.issueIdentifier ?? session.issueId ?? turn.issueId;
    const worktree = await this.worktrees.ensureWorktree(identifier);
    this.log.updateSessionWorktree(turn.linearSessionId, worktree.path, worktree.branch, this.now());
    const implementer = session.mode === "implementer";
    let prompt = implementer ? `/do ${identifier}` : this.composePrompt(turn, identifier);
    if (!implementer && this.config.attachmentsEnabled) prompt += await this.downloadAttachments(turn.rawBody, worktree.path);
    this.log.setTurnPrompt(turn.id, prompt);
    const postProgress = (id: string, content: ProgressContent) => this.gateway.postActivity(
      turn.app, turn.linearSessionId, id, content, true, this.now() + 10_000);
    const progress = new ProgressQueue(postProgress, this.now, this.logger);
    progress.push({ type: "thought", body: implementer ? "implementation started — running /do" : "session started — reading the ticket" });
    const keepalive = setInterval(() => {
      if (this.now() - progress.lastSuccess >= this.config.keepaliveMs)
        progress.push({ type: "thought", body: implementer ? "still working on implementation" : "still working on this turn" });
    }, Math.max(10, Math.min(this.config.keepaliveMs, 60_000)));
    keepalive.unref();
    const mcpConfigJson = JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp",
      headers: { Authorization: `Bearer ${this.config.linearApiKey}` } } } });
    const result = await runTurn({ cwd: worktree.path, prompt,
        ...(!implementer && turn.kind === "prompted" && session.claudeSessionId ? { resumeSessionId: session.claudeSessionId } : {}),
        argv: this.config.claudeArgv, permissionMode: implementer ? this.config.doPermissionMode : this.config.claudePermissionMode,
        maxTurns: implementer ? this.config.doMaxTurns : this.config.claudeMaxTurns,
        ...(implementer && this.config.doMaxBudgetUsd !== undefined ? { maxBudgetUsd: this.config.doMaxBudgetUsd } : {}),
        mcpConfigJson, env: { LINEAR_API_KEY: this.config.linearApiKey!, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN }, signal,
        onSessionId: id => this.log.updateClaudeSessionId(turn.linearSessionId, id, this.now()),
        onEvent: event => progress.push(event.type === "text"
          ? { type: "thought", body: event.text } : { type: "action", body: describeTool(event) }),
      }).catch(async error => {
        clearInterval(keepalive);
        await progress.cancelAndWait();
        throw error;
      });
    clearInterval(keepalive);
    const finishedAt = this.now();
    if (implementer && result.resultText) {
      const url = this.extractPullRequestUrl(result.resultText);
      if (url) this.log.stageExternalUrl(turn.linearSessionId, turn.app, "Pull Request", url, finishedAt);
      else this.logger.log(jsonLog({ event: "implementer_pr_url_not_found", turnId: turn.id, linearSessionId: turn.linearSessionId }));
    }
    if (result.ok) {
      this.log.finishTurn(turn.id, "response", result.resultText || "Turn completed.", finishedAt, randomUUID(), true);
      this.logger.log(jsonLog({ event: "session_turn_completed", turnId: turn.id, issueIdentifier: identifier,
        linearSessionId: turn.linearSessionId, attempts: turn.attempts,
        durationMs: Math.max(0, finishedAt - (turn.startedAt ?? turn.receivedAt)) }));
    } else {
      const detail = result.spawnError ?? (result.permissionDenials.length ? "Claude permission was denied" :
        result.signal ? `Claude exited on ${result.signal}` : !result.sawResult ? "Claude exited without a result" : `Claude exited with code ${result.exitCode}`);
      this.log.finishTurn(turn.id, "error", `${implementer ? "Implementer" : "Planner"} turn failed: ${detail}`, finishedAt, randomUUID(), true);
      this.logger.error(jsonLog({ event: "session_turn_failed", turnId: turn.id, issueIdentifier: identifier,
        linearSessionId: turn.linearSessionId, attempts: turn.attempts, durationMs: Math.max(0, finishedAt - (turn.startedAt ?? turn.receivedAt)),
        error: detail, ...(result.stderrTail ? { stderrTail: result.stderrTail } : {}) }));
    }
    await progress.cancelAndWait();
    this.log.touchSession(turn.linearSessionId, this.now());
    this.log.clearTurnProgressBarrier(turn.id);
  }

  private extractPullRequestUrl(value: string): string | undefined {
    return /https:\/\/(?:github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+|gitlab\.com\/[^\s]+\/-\/merge_requests\/\d+|[^\s/]+\/[^\s]+\/(?:pull|merge_requests?)\/\d+)/i.exec(value)?.[0]
      ?.replace(/[),.;]+$/, "");
  }

  private composePrompt(turn: TurnRow, identifier: string): string {
    let payload: Record<string, unknown> = {};
    try { payload = object(JSON.parse(turn.rawBody.toString("utf8"))) ?? {}; } catch {}
    const session = object(payload.agentSession);
    if (turn.kind === "created") {
      const context = text(payload.promptContext) ?? text(session?.promptContext) ?? bodyFrom(payload.agentActivity);
      return `You are bloom-planner, a planning/discussion agent on Linear issue ${identifier}. Discuss, research, and converge; when the user asks for a plan/spec, use this repo's existing skills (/create-feature, /create-epic, /create-issue). Read the ticket via the Linear MCP tools if context is missing.\n\n${context ?? "Read the Linear ticket and begin the planning discussion."}`;
    }
    const activity = bodyFrom(payload.agentActivity) ?? bodyFrom(session?.agentActivity);
    const comments = Array.isArray(payload.previousComments) ? payload.previousComments.map(bodyFrom).filter(Boolean) : [];
    return activity ?? comments.at(-1) ?? "Continue the planning discussion using the latest Linear context.";
  }

  private attachmentNodes(raw: Buffer): Array<{ url: string; name: string }> {
    let payload: Record<string, unknown> = {}; try { payload = object(JSON.parse(raw.toString("utf8"))) ?? {}; } catch { return []; }
    const found: Array<{ url: string; name: string }> = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      const node = object(value); if (!node) return;
      const url = text(node.url); const name = text(node.title) ?? text(node.filename);
      if (url && name) found.push({ url, name });
      for (const child of Object.values(node)) if (typeof child === "object") visit(child);
    };
    const scope = (value: unknown): void => {
      const node = object(value); if (!node) return;
      for (const [key, child] of Object.entries(node)) {
        if (key === "attachments") visit(child);
        else if (typeof child === "object") Array.isArray(child) ? child.forEach(scope) : scope(child);
      }
    };
    scope(object(object(payload.agentSession)?.issue));
    scope(object(payload.agentActivity));
    return found.slice(0, 10);
  }

  private async downloadAttachments(raw: Buffer, worktree: string): Promise<string> {
    const nodes = this.attachmentNodes(raw); if (!nodes.length) return "";
    const root = resolve(worktree, ".linear-attachments"); await mkdir(root, { recursive: true });
    const realWorktree = await realpath(worktree); const realRoot = await realpath(root);
    if (!realRoot.startsWith(`${realWorktree}${sep}`)) throw new Error("Attachment directory escaped worktree");
    const notes: string[] = []; const names = new Set<string>();
    for (const node of nodes) {
      let name = node.name.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
      const base = name; let suffix = 1; while (names.has(name)) name = `${base}-${suffix++}`; names.add(name);
      const destination = resolve(realRoot, name);
      if (!destination.startsWith(`${realRoot}${sep}`)) { notes.push(`${name}: rejected unsafe filename`); continue; }
      try {
        const bytes = await this.fetchAttachment(node.url);
        const handle = await open(destination, "wx", 0o600);
        try { await handle.writeFile(bytes); } finally { await handle.close(); }
        notes.push(`${name}: .linear-attachments/${name}`);
      } catch (error) { try { await unlink(destination); } catch {} notes.push(`${name}: failed (${error instanceof Error ? error.message : String(error)})`); }
    }
    return `\n\nLinear attachments:\n${notes.map(note => `- ${note}`).join("\n")}`;
  }

  private async fetchAttachment(rawUrl: string): Promise<Buffer> {
    const controller = new AbortController();
    const timeoutMs = this.options.attachmentTimeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
    let url = new URL(rawUrl); let redirected = false;
    try {
      for (let redirects = 0; redirects < 5; redirects++) {
        const protocolAllowed = url.protocol === "https:" || (this.options.attachmentTestAllowHttp === true && url.protocol === "http:");
        if (!protocolAllowed || !this.config.attachmentHosts.includes(url.hostname)) throw new Error("attachment host is not allowed");
        const response = await fetch(url, { redirect: "manual", signal: controller.signal,
          headers: redirected ? {} : { Authorization: `Bearer ${this.config.linearApiKey}` } });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => {});
          if (!location) throw new Error("attachment redirect missing location");
          url = new URL(location, url); redirected = true; continue;
        }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`attachment HTTP ${response.status}`); }
        const length = Number(response.headers.get("content-length")); if (length > 10 * 1024 * 1024) {
          await response.body?.cancel().catch(() => {}); throw new Error("attachment exceeds 10 MB");
        }
        const reader = response.body?.getReader(); if (!reader) return Buffer.alloc(0);
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
          if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new Error("attachment exceeds 10 MB"); } chunks.push(value); }
        return Buffer.concat(chunks);
      }
      throw new Error("too many attachment redirects");
    } catch (error) {
      if (controller.signal.aborted) throw new Error("attachment timed out");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private triggerActivityDrain(): Promise<void> {
    if (this.activityDrain) return this.activityDrain;
    this.activityDrain = this.drainActivities().finally(() => { this.activityDrain = undefined; });
    return this.activityDrain;
  }
  private async drainActivities(): Promise<void> {
    if (this.stopped) return;
    for (const activity of this.log.pendingTurnActivities(this.now())) await this.postTerminal(activity);
    for (const external of this.log.pendingExternalUrls(this.now())) await this.postExternalUrl(external);
  }
  private async postExternalUrl(row: ExternalUrlRow): Promise<void> {
    const result = await this.gateway.setSessionExternalUrl(row.app,row.linearSessionId,row.label,row.url,this.now()+10_000);
    if (result.ok) { this.log.markExternalUrlPosted(row.id); return; }
    if (result.retriable && this.now() < row.createdAt + 30*60_000) {
      this.log.markExternalUrlRetry(row.id,result.error,this.now()+Math.max(result.retryAfterMs ?? 0,1_000)); return;
    }
    this.log.markExternalUrlFailed(row.id,result.error);
    this.logger.error(jsonLog({ event:"external_url_delivery_failed", id:row.id, error:result.error }));
  }
  private async postTerminal(activity: TurnActivityRow): Promise<void> {
    const result = await this.gateway.postActivity(activity.app, activity.linearSessionId, activity.activityId,
      { type: activity.kind, body: activity.body }, false, this.now() + 10_000);
    if (result.ok) { this.log.markTurnActivityPosted(activity.turnId, this.now()); this.options.onTurnComplete?.(); return; }
    if (result.retriable && this.now() < activity.createdAt + 30 * 60_000) {
      const nextAttemptAt = this.now() + Math.max(result.retryAfterMs ?? 0, 1_000);
      this.log.markTurnActivityRetry(activity.turnId, nextAttemptAt);
      this.logger.error(jsonLog({ event: "terminal_activity_retry_scheduled", turnId: activity.turnId,
        linearSessionId: activity.linearSessionId, attempts: activity.attempts + 1, next_attempt_at: nextAttemptAt, error: result.error }));
      return;
    }
    this.log.markTurnActivityFailed(activity.turnId, `terminal_activity_delivery_failed: ${result.error}`, this.now());
    this.logger.error(jsonLog({ event: "terminal_activity_delivery_failed", turnId: activity.turnId,
      linearSessionId: activity.linearSessionId, attempts: activity.attempts + 1, error: result.error }));
  }
  async stop(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([...this.active.values()].map(active => active.promise));
    await this.activityDrain;
  }
}
