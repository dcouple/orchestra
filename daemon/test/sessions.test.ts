import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import type { LinearGateway, PostResult, ProgressContent, TerminalContent } from "../src/linear.js";
import { SessionWorker } from "../src/sessions.js";

const dirs: string[] = [];
const oldMode = process.env.CLAUDE_FAKE_MODE;
const oldArgs = process.env.CLAUDE_FAKE_ARGS_FILE;
const oldEnv = process.env.CLAUDE_FAKE_ENV_FILE;
const oldDelay = process.env.CLAUDE_FAKE_DELAY_MS;
const oldDispatchOwner = process.env.ORCHESTRA_DISPATCH_OWNER;
const ownerOne = "a0000000-0000-0000-0000-000000000001";
const ownerTwo = "a0000000-0000-0000-0000-000000000002";
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (oldMode === undefined) delete process.env.CLAUDE_FAKE_MODE; else process.env.CLAUDE_FAKE_MODE = oldMode;
  if (oldArgs === undefined) delete process.env.CLAUDE_FAKE_ARGS_FILE; else process.env.CLAUDE_FAKE_ARGS_FILE = oldArgs;
  if (oldEnv === undefined) delete process.env.CLAUDE_FAKE_ENV_FILE; else process.env.CLAUDE_FAKE_ENV_FILE = oldEnv;
  if (oldDelay === undefined) delete process.env.CLAUDE_FAKE_DELAY_MS; else process.env.CLAUDE_FAKE_DELAY_MS = oldDelay;
  if (oldDispatchOwner === undefined) delete process.env.ORCHESTRA_DISPATCH_OWNER; else process.env.ORCHESTRA_DISPATCH_OWNER = oldDispatchOwner; });
function git(args: string[], cwd?: string): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sessions-")); dirs.push(dir);
  const seed = join(dir, "seed"), origin = join(dir, "origin.git"), repo = join(dir, "repo"); mkdirSync(seed);
  git(["init", "-b", "main"], seed); git(["config", "user.email", "test@example.com"], seed); git(["config", "user.name", "Test"], seed);
  git(["commit", "--allow-empty", "-m", "initial"], seed); git(["clone", "--bare", seed, origin]); git(["clone", origin, repo]);
  const log = new EventLog(join(dir, "events.db"));
  const config: Config = { port: 0, bindAddr: "127.0.0.1", dbPath: join(dir, "events.db"), replayWindowMs: 60_000,
    linearGraphqlUrl: "http://unused", linearTokenUrl: "http://unused", apps: {
      planner: { name: "planner", webhookSecret: "p", staticToken: "p" }, implementer: { name: "implementer", webhookSecret: "i", staticToken: "i" } },
    sessionsEnabled: true, worktreesRoot: join(dir, "trees"), targetRepoPath: repo,
    claudeArgv: [process.execPath, resolve("test/fixtures/fake-claude.mjs")], claudePermissionMode: "plan", claudeMaxTurns: 5,
    doPermissionMode:"plan",doMaxTurns:50,doMaxBudgetUsd:10,
    sessionConcurrency: 2, keepaliveMs: 30, linearApiKey: "linear-key", attachmentsEnabled: false, attachmentHosts: ["uploads.linear.app"] };
  return { dir, log, config };
}
class Poster {
  posts: Array<{ app:string; session: string; content: ProgressContent | TerminalContent; ephemeral: boolean; at: number }> = [];
  urls:Array<{app:string;session:string;label:string;url:string}>=[];
  failures = 0;
  urlFailures=0;
  async postActivity(_app: string, session: string, _id: string, content: ProgressContent | TerminalContent, ephemeral: boolean): Promise<PostResult> {
    this.posts.push({ app:_app, session, content, ephemeral, at: Date.now() });
    if (!ephemeral && this.failures-- > 0) return { ok: false, retriable: true, error: "temporary" };
    return { ok: true };
  }
  async setSessionExternalUrl(app:string,session:string,label:string,url:string):Promise<PostResult>{
    if(this.urlFailures-->0)return {ok:false,retriable:true,error:"temporary url failure"};
    this.urls.push({app,session,label,url});return {ok:true};}
}
class CapturingLogger {
  lines: string[] = [];
  log(...args: unknown[]): void { this.lines.push(String(args[0])); }
  error(...args: unknown[]): void { this.lines.push(String(args[0])); }
  entries(): Array<Record<string, unknown>> { return this.lines.map(line => JSON.parse(line) as Record<string, unknown>); }
}
function activityBody(content: ProgressContent | TerminalContent | undefined): string | undefined {
  return content && "body" in content ? content.body : undefined;
}
function append(log: EventLog, delivery: string, session: string, action: "created" | "prompted", issue = "issue-uuid", identifier = "ENG-42") {
  const raw = action === "created" ? { action, promptContext: "Help plan this", agentSession: { id: session, issue: { id: issue, identifier } } }
    : { action, agentActivity: { body: "follow up" }, agentSession: { id: session } };
  log.append({ deliveryId: delivery, app: "planner", action, agentSessionId: session,
    ...(action === "created" ? { issueId: issue, issueIdentifier: identifier } : {}), receivedAt: Date.now(), rawBody: Buffer.from(JSON.stringify(raw)) });
}
function appendImplementer(log:EventLog,delivery:string,session:string,issue="issue-uuid",identifier="ENG-42"){
  log.append({deliveryId:delivery,app:"implementer",action:"created",agentSessionId:session,issueId:issue,issueIdentifier:identifier,
    receivedAt:Date.now(),rawBody:Buffer.from(JSON.stringify({action:"created",agentSession:{id:session,issue:{id:issue,identifier}}}))});
}
async function waitFor(predicate: () => boolean, timeout = 4000): Promise<void> {
  const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function freePort(): Promise<number> {
  const server = createNetServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function healthy(port: number, child: ChildProcess): Promise<void> {
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (child.exitCode !== null) throw new Error(`child exited ${child.exitCode}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("child health timed out");
}

describe("SessionWorker", () => {
  it("phase3 AC1/AC2/AC3: do-mode reuses worktree, starts fresh, uses literal prompt, and posts PR URL",async()=>{
    const {dir,log,config}=setup(); const poster=new Poster(); process.env.CLAUDE_FAKE_ARGS_FILE=join(dir,"args.jsonl");
    append(log,"planner","planner-session","created"); let worker=new SessionWorker(log,poster as unknown as LinearGateway,config,{pollMs:10,reconcileMs:20});worker.start();
    await waitFor(()=>log.turnStates()[0]?.status==="done"); await worker.stop();
    process.env.CLAUDE_FAKE_MODE="do-pr"; appendImplementer(log,"implementer","implementer-session");
    worker=new SessionWorker(log,poster as unknown as LinearGateway,config,{pollMs:10,reconcileMs:20});worker.start();
    await waitFor(()=>log.turnStates()[1]?.status==="done"&&poster.urls.length===1); await worker.stop();
    const starts=readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE,"utf8").trim().split("\n").map(line=>JSON.parse(line)).filter(row=>row.phase==="start");
    expect(starts[1].cwd).toBe(starts[0].cwd); expect(starts[1].args).not.toContain("--resume");
    expect(starts[1].args.slice(starts[1].args.indexOf("-p"),starts[1].args.indexOf("--output-format"))).toEqual(["-p","/do ENG-42"]);
    expect(log.getSession("implementer-session")?.claudeSessionId).toBe("claude-do-session");
    expect(poster.urls[0]).toEqual({app:"implementer",session:"implementer-session",label:"Pull Request",url:"https://github.com/dcouple/example/pull/42"});
    expect(poster.posts.filter(p=>p.session==="implementer-session").every(p=>p.app==="implementer")).toBe(true); log.close();
  });
  it("phase3 AC2/AC3-on-error: creates a missing worktree and retries an error result's PR URL",async()=>{
    const {log,config}=setup();const poster=new Poster();poster.urlFailures=1;process.env.CLAUDE_FAKE_MODE="do-pr-error";
    appendImplementer(log,"implementer-only","implementer-session","issue-new","ENG-99");
    const worker=new SessionWorker(log,poster as unknown as LinearGateway,config,{pollMs:10,reconcileMs:20});worker.start();
    await waitFor(()=>log.turnStates()[0]?.status==="failed"&&poster.urls.length===1);await worker.stop();
    expect(log.getSession("implementer-session")?.worktreePath).toContain("ENG-99");
    expect(log.externalUrlStates()[0]).toMatchObject({status:"posted",url:"https://github.com/dcouple/example/pull/42"});log.close();
  });
  it("implementer prompted turn resumes the stored Claude session with the reply text", async () => {
    const {dir,log,config}=setup(); const poster=new Poster(); process.env.CLAUDE_FAKE_ARGS_FILE=join(dir,"args.jsonl");
    process.env.CLAUDE_FAKE_MODE="do-pr"; appendImplementer(log,"i1","implementer-session");
    const worker=new SessionWorker(log,poster as unknown as LinearGateway,config,{pollMs:10,reconcileMs:20});worker.start();
    await waitFor(()=>log.turnStates()[0]?.status==="done");
    process.env.CLAUDE_FAKE_MODE="happy";
    log.append({deliveryId:"i2",app:"implementer",action:"prompted",agentSessionId:"implementer-session",receivedAt:Date.now(),
      rawBody:Buffer.from(JSON.stringify({action:"prompted",agentActivity:{body:"yes, use option B"},agentSession:{id:"implementer-session"}}))});
    worker.trigger(); await waitFor(()=>log.turnStates()[1]?.status==="done"); await worker.stop();
    const starts=readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE,"utf8").trim().split("\n").map(line=>JSON.parse(line)).filter(row=>row.phase==="start");
    expect(starts[1].args).toContain("--resume");
    expect(starts[1].args[starts[1].args.indexOf("--resume")+1]).toBe("claude-do-session");
    expect(starts[1].args.slice(starts[1].args.indexOf("-p"),starts[1].args.indexOf("--output-format"))).toEqual(["-p","yes, use option B"]);
    expect(starts[1].cwd).toBe(starts[0].cwd); log.close();
  });
  it("dispatch marker auto-resumes its owner once and passes the owner environment", async () => {
    const state = setup(); const { dir, config } = state; let log = state.log;
    const poster = new Poster(); const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    process.env.CLAUDE_FAKE_ENV_FILE = join(dir, "env.jsonl");
    process.env.CLAUDE_FAKE_MODE = "do-pr";
    appendImplementer(log, "implementer", ownerOne);
    let worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    await worker.stop();
    const worktree = log.getSession(ownerOne)!.worktreePath!;
    log.close();
    mkdirSync(join(worktree, ".codex-dispatches", ownerOne), { recursive: true });
    writeFileSync(join(worktree, ".codex-dispatches", ownerOne, "x-1.done"), "0\n");
    process.env.CLAUDE_FAKE_MODE = "happy";
    log = new EventLog(config.dbPath);
    worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[1]?.status === "done");
    expect(log.turnStates()[1]).toMatchObject({ linearSessionId: ownerOne, kind: "prompted",
      sourceKey: `prompt:${ownerOne}:dispatch:x-1.done`, prompt: expect.stringContaining(`.codex-dispatches/${ownerOne}/x-1.done`) });
    expect(log.turnStates()[1]?.prompt).toContain("any sibling completed dispatches");
    worker.trigger(); await new Promise(resolve => setTimeout(resolve, 50));
    expect(log.turnStates()).toHaveLength(2);
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts[1].args).toContain("--resume");
    const envs = readFileSync(process.env.CLAUDE_FAKE_ENV_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(envs.every(row => row.env.ORCHESTRA_DISPATCH_OWNER === ownerOne)).toBe(true);
    expect(logger.entries().filter(entry => entry.event === "dispatch_marker_resume")).toHaveLength(1);
    await worker.stop(); log.close();
  });
  it("does not enqueue a marker while its owner has a running turn", async () => {
    const { log, config } = setup(); const poster = new Poster();
    process.env.CLAUDE_FAKE_MODE = "slow"; process.env.CLAUDE_FAKE_DELAY_MS = "500";
    appendImplementer(log, "implementer", ownerOne);
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config,
      { pollMs: 10, reconcileMs: 20, dispatchScanMs: 25 }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "running" && !!log.getSession(ownerOne)?.worktreePath);
    const worktree = log.getSession(ownerOne)!.worktreePath!;
    mkdirSync(join(worktree, ".codex-dispatches", ownerOne), { recursive: true });
    writeFileSync(join(worktree, ".codex-dispatches", ownerOne, "active.done"), "0\n");
    worker.trigger(); await new Promise(resolve => setTimeout(resolve, 100));
    expect(log.turnStates()).toHaveLength(1);
    await waitFor(() => log.turnStates()[1]?.status === "done");
    await worker.stop(); log.close();
  });
  it("scopes shared-worktree markers to the owning session", async () => {
    const { log, config } = setup(); const poster = new Poster();
    append(log, "planner", ownerTwo, "created");
    appendImplementer(log, "implementer", ownerOne);
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    await waitFor(() => log.turnStates().length === 2 && log.turnStates().every(turn => turn.status === "done"));
    const worktree = log.getSession(ownerOne)!.worktreePath!;
    mkdirSync(join(worktree, ".codex-dispatches", ownerOne), { recursive: true });
    writeFileSync(join(worktree, ".codex-dispatches", ownerOne, "owned.done"), "0\n");
    worker.trigger(); await waitFor(() => log.turnStates().length === 3 && log.turnStates()[2]?.status === "done");
    expect(log.turnStates().filter(turn => turn.linearSessionId === ownerTwo)).toHaveLength(1);
    expect(log.turnStates()[2]?.linearSessionId).toBe(ownerOne);
    await worker.stop(); log.close();
  });
  it("ignores a missing worktree during dispatch scanning", async () => {
    const { dir, log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    appendImplementer(log, "implementer", ownerOne);
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    log.updateSessionWorktree(ownerOne, join(dir, "missing-worktree"), "agents/missing");
    worker.trigger(); await new Promise(resolve => setTimeout(resolve, 50));
    expect(log.turnStates()).toHaveLength(1);
    expect(logger.entries().some(entry => entry.event === "dispatch_scan_failed")).toBe(false);
    await worker.stop(); log.close();
  });
  it("rejects an unsafe dispatch owner for marker scanning and child environment", async () => {
    const { dir, log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    const unsafeOwner = "unsafe_session";
    process.env.CLAUDE_FAKE_ENV_FILE = join(dir, "env.jsonl");
    process.env.ORCHESTRA_DISPATCH_OWNER = "ambient-owner";
    appendImplementer(log, "implementer", unsafeOwner);
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config,
      { pollMs: 10, reconcileMs: 20, dispatchScanMs: 25, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    const worktree = log.getSession(unsafeOwner)!.worktreePath!;
    mkdirSync(join(worktree, ".codex-dispatches", unsafeOwner), { recursive: true });
    writeFileSync(join(worktree, ".codex-dispatches", unsafeOwner, "unsafe.done"), "0\n");
    worker.trigger(); await new Promise(resolve => setTimeout(resolve, 100));
    expect(log.turnStates()).toHaveLength(1);
    expect(logger.entries()).toContainEqual(expect.objectContaining({ event: "dispatch_scan_failed",
      linearSessionId: unsafeOwner, reason: "invalid dispatch owner" }));
    const envs = readFileSync(process.env.CLAUDE_FAKE_ENV_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(envs.every(row => row.env.ORCHESTRA_DISPATCH_OWNER === undefined)).toBe(true);
    await worker.stop(); log.close();
  });
  it("AC1-AC4: aborts a running turn, posts one stop ack, and resumes on the next prompt", async () => {
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>(resolve => { releaseProgress = resolve; });
    class GatedPoster extends Poster {
      isActive?: () => boolean; activeAtTerminal: boolean | undefined;
      override async postActivity(app: string, session: string, id: string, content: ProgressContent | TerminalContent, ephemeral: boolean): Promise<PostResult> {
        const result = super.postActivity(app, session, id, content, ephemeral);
        if (ephemeral) await progressGate;
        else this.activeAtTerminal = this.isActive?.();
        return result;
      }
    }
    const { dir, log, config } = setup(); const poster = new GatedPoster();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl"); process.env.CLAUDE_FAKE_MODE = "slow";
    process.env.CLAUDE_FAKE_DELAY_MS = "1000";
    append(log, "created", "stop-session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 });
    poster.isActive = () => (worker as unknown as { active: Map<number, unknown> }).active.size > 0;
    worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "running" && log.getSession("stop-session")?.claudeSessionId === "claude-session-1");
    const result = log.append({ deliveryId: "stop", app: "planner", action: "prompted", agentSessionId: "stop-session",
      sourceActivityId: "stop-activity", signal: "stop", receivedAt: Date.now(), rawBody: Buffer.from("{}") });
    worker.stopSession(result.stop!.agentSessionId);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(poster.posts.some(post => !post.ephemeral && post.session === "stop-session")).toBe(false);
    releaseProgress();
    await waitFor(() => log.turnStates()[0]?.status === "interrupted" && log.stopAckStates()[0]?.status === "posted");
    expect(poster.posts.filter(post => !post.ephemeral)).toEqual([expect.objectContaining({
      session: "stop-session", content: { type: "response", body: "Stopped at your request. Send a follow-up message to continue." },
    })]);
    expect(poster.activeAtTerminal).toBe(false);
    const terminalIndex = poster.posts.findIndex(post => !post.ephemeral && post.session === "stop-session");
    expect(poster.posts.slice(terminalIndex + 1).some(post => post.ephemeral && post.session === "stop-session")).toBe(false);
    process.env.CLAUDE_FAKE_MODE = "happy"; append(log, "after-stop", "stop-session", "prompted"); worker.trigger();
    await waitFor(() => log.turnStates()[1]?.status === "done"); await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts[1].args[starts[1].args.indexOf("--resume") + 1]).toBe("claude-session-1"); log.close();
  });
  it("AC3: acknowledges a stop with no active turn after cancelling pending work", async () => {
    const { log, config } = setup(); const poster = new Poster(); append(log, "created", "idle-session", "created");
    const result = log.append({ deliveryId: "idle-stop", app: "planner", action: "prompted", agentSessionId: "idle-session",
      sourceActivityId: "idle-stop-activity", signal: "stop", receivedAt: Date.now(), rawBody: Buffer.from("{}") });
    expect(log.turnStates()[0]).toMatchObject({ status: "interrupted" });
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    worker.stopSession(result.stop!.agentSessionId);
    await waitFor(() => log.stopAckStates()[0]?.status === "posted");
    expect(poster.posts.filter(post => !post.ephemeral)).toHaveLength(1);
    await worker.stop(); log.close();
  });
  it("retries stop acknowledgments and marks them failed after the retry window", async () => {
    const first = setup(); const retryPoster = new Poster(); const retryLogger = new CapturingLogger(); let clock = 1_000;
    retryPoster.failures = 1;
    first.log.append({ deliveryId: "retry-stop", app: "planner", action: "prompted", agentSessionId: "retry-session",
      sourceActivityId: "retry-stop-activity", signal: "stop", receivedAt: clock, rawBody: Buffer.from("{}") });
    const retryWorker = new SessionWorker(first.log, retryPoster as unknown as LinearGateway, first.config,
      { pollMs: 10, reconcileMs: 20, now: () => clock, logger: retryLogger }); retryWorker.start();
    await waitFor(() => first.log.stopAckStates()[0]?.attempts === 1);
    expect(first.log.stopAckStates()[0]).toMatchObject({ sourceActivityId: "retry-stop-activity", status: "pending", attempts: 1 });
    expect(retryLogger.entries()).toContainEqual(expect.objectContaining({ event: "stop_ack_retry_scheduled",
      sourceActivityId: "retry-stop-activity", attempts: 1 }));
    clock = 2_000;
    await waitFor(() => first.log.stopAckStates()[0]?.status === "posted");
    expect(first.log.stopAckStates()[0]).toMatchObject({ status: "posted", attempts: 2 });
    await retryWorker.stop(); first.log.close();

    const second = setup(); const failedPoster = new Poster(); const failedLogger = new CapturingLogger();
    failedPoster.failures = 1; const expired = 30 * 60_000 + 1;
    second.log.append({ deliveryId: "failed-stop", app: "planner", action: "prompted", agentSessionId: "failed-session",
      sourceActivityId: "failed-stop-activity", signal: "stop", receivedAt: 0, rawBody: Buffer.from("{}") });
    const failedWorker = new SessionWorker(second.log, failedPoster as unknown as LinearGateway, second.config,
      { pollMs: 10, reconcileMs: 20, now: () => expired, logger: failedLogger }); failedWorker.start();
    await waitFor(() => second.log.stopAckStates()[0]?.status === "failed");
    expect(second.log.stopAckStates()[0]).toMatchObject({ sourceActivityId: "failed-stop-activity", status: "failed", attempts: 1 });
    expect(failedLogger.entries()).toContainEqual(expect.objectContaining({ event: "stop_ack_delivery_failed",
      sourceActivityId: "failed-stop-activity", attempts: 1 }));
    await failedWorker.stop(); second.log.close();
  });
  it("marks a stop-requested turn interrupted when the runner rejects", async () => {
    const { log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger(); config.claudeArgv = [];
    append(log, "reject-stop", "reject-session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "running"); worker.stopSession("reject-session");
    await waitFor(() => log.turnStates()[0]?.status === "interrupted");
    expect(logger.entries()).toContainEqual(expect.objectContaining({ event: "session_turn_stopped", linearSessionId: "reject-session" }));
    expect(logger.entries().some(entry => entry.event === "session_turn_unhandled")).toBe(false);
    expect(poster.posts.some(post => !post.ephemeral)).toBe(false);
    await worker.stop(); log.close();
  });
  it("posts an ntfy notification when a terminal activity is delivered", async () => {
    const {log,config}=setup(); const poster=new Poster();
    const received: Array<{title:string|undefined;priority:string|undefined;body:string}> = [];
    const server=createServer((req,res)=>{let body="";req.on("data",chunk=>body+=chunk);
      req.on("end",()=>{received.push({title:req.headers.title as string,priority:req.headers.priority as string,body});res.end("ok");});});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const ntfyUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    append(log,"d1","session","created");
    const worker=new SessionWorker(log,poster as unknown as LinearGateway,{...config,ntfyUrl},{pollMs:10,reconcileMs:20});worker.start();
    await waitFor(()=>log.turnStates()[0]?.status==="done"&&received.length===1);
    await worker.stop(); server.close(); log.close();
    expect(received[0].title).toContain("bloom-planner replied");
    expect(received[0].title).toContain("ENG-42");
    expect(received[0].priority).toBe("default");
    expect(received[0].body).toBe("planner answer");
  });
  it("AC1/AC2/AC3-contract: creates worktree, posts response, then resumes in the same cwd", async () => {
    const { dir, log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    append(log, "d1", "linear-session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    append(log, "d2", "linear-session", "prompted"); worker.trigger(); await waitFor(() => log.turnStates()[1]?.status === "done");
    expect(poster.posts).toContainEqual(expect.objectContaining({
      content: { type: "action", action: "Read", parameter: "ticket" }, ephemeral: true,
    }));
    expect(poster.posts.some(post => !post.ephemeral && post.content.type === "response" && post.content.body === "planner answer")).toBe(true);
    expect(poster.posts.some(post => !post.ephemeral && activityBody(post.content)?.includes("resumed claude-session-1"))).toBe(true);
    const invocations = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(invocations[1].args).toContain("--resume"); expect(invocations[1].cwd).toBe(invocations[0].cwd);
    const completions = logger.entries().filter(entry => entry.event === "session_turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions[0]).toMatchObject({ event: "session_turn_completed", turnId: 1,
      issueIdentifier: "ENG-42", linearSessionId: "linear-session", attempts: 1, durationMs: expect.any(Number) });
    expect(JSON.stringify(completions)).not.toContain("linear-key");
    expect(JSON.stringify(completions)).not.toContain("Help plan this");
    expect(log.getSession("linear-session")?.branch).toContain("ENG-42"); await worker.stop(); log.close();
  });
  it("AC4-contract: emits progress and keepalive before a slow response", async () => {
    const { log, config } = setup(); const poster = new Poster(); process.env.CLAUDE_FAKE_MODE = "slow"; process.env.CLAUDE_FAKE_DELAY_MS = "120";
    append(log, "d1", "session", "created"); const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    const terminal = poster.posts.findIndex(post => !post.ephemeral); const before = poster.posts.slice(0, terminal);
    expect(before.some(post => activityBody(post.content)?.includes("still working"))).toBe(true); expect(before.every(post => post.ephemeral)).toBe(true);
    await worker.stop(); log.close();
  });
  it("AC5: posts durable error after crash and accepts the next prompt", async () => {
    const { log, config } = setup(); const poster = new Poster(); process.env.CLAUDE_FAKE_MODE = "crash";
    append(log, "d1", "session", "created"); const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed"); expect(poster.posts.some(post => post.content.type === "error" && !post.ephemeral)).toBe(true);
    process.env.CLAUDE_FAKE_MODE = "happy"; append(log, "d2", "session", "prompted"); worker.trigger(); await waitFor(() => log.turnStates()[1]?.status === "done");
    await worker.stop(); log.close();
  });
  it("AC6: serializes one issue while different issues run in parallel", async () => {
    const { dir, log, config } = setup(); const poster = new Poster(); process.env.CLAUDE_FAKE_MODE = "slow"; process.env.CLAUDE_FAKE_DELAY_MS = "100";
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl"); append(log, "d1", "s1", "created", "issue-1", "ENG-1");
    append(log, "d2", "s1", "prompted"); append(log, "d3", "s2", "created", "issue-2", "ENG-2");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    await waitFor(() => log.turnStates().every(turn => turn.status === "done")); await worker.stop();
    const rows = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const starts = rows.filter(row => row.phase === "start"), ends = rows.filter(row => row.phase === "end");
    const issue1 = starts.filter(row => row.cwd.endsWith("ENG-1")); expect(issue1).toHaveLength(2);
    const issue2Start = starts.find(row => row.cwd.endsWith("ENG-2"));
    const intervalFor = (start: { cwd: string; at: number }) => {
      const end = ends.find(row => row.cwd === start.cwd && row.at >= start.at);
      expect(end).toBeDefined();
      return { start: start.at, end: end!.at };
    };
    expect(issue2Start).toBeDefined();
    const issue1Intervals = issue1.map(intervalFor);
    const issue2Interval = intervalFor(issue2Start!);
    expect(issue1[1].at).toBeGreaterThanOrEqual(issue1Intervals[0].end);
    expect(issue1Intervals.some(interval => issue2Interval.start < interval.end && issue2Interval.end > interval.start)).toBe(true);
    log.close();
  });
  it("serializes prompted-before-created turns after provisional issue rekey", async () => {
    const { dir, log, config } = setup(); const poster = new Poster();
    process.env.CLAUDE_FAKE_MODE = "slow"; process.env.CLAUDE_FAKE_DELAY_MS = "100"; process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    log.append({ deliveryId: "d1", app: "planner", action: "prompted", agentSessionId: "session",
      receivedAt: Date.now(), rawBody: Buffer.from(JSON.stringify({ action: "prompted", agentActivity: { body: "first" }, agentSession: { id: "session" } })) });
    append(log, "d2", "session", "created", "issue-1", "ENG-1");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    await waitFor(() => log.turnStates().every(turn => turn.status === "done")); await worker.stop();
    const rows = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const starts = rows.filter(row => row.phase === "start"); const ends = rows.filter(row => row.phase === "end");
    expect(starts).toHaveLength(2);
    expect(starts.every(row => row.cwd.endsWith("ENG-1"))).toBe(true);
    expect(starts[1].at).toBeGreaterThanOrEqual(ends.find(row => row.cwd === starts[0].cwd && row.at >= starts[0].at)!.at);
    log.close();
  });
  it("releases a persisted progress barrier on restart and posts the real terminal response", async () => {
    const { log, config } = setup(); const poster = new Poster();
    append(log, "d1", "session", "created");
    const turn = log.claimNextTurn(1000)!;
    log.finishTurn(turn.id, "response", "real persisted response", 1100, "activity-1", true);
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config,
      { pollMs: 10, reconcileMs: 20, now: () => 1200 }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    expect(poster.posts.find(post => !post.ephemeral)).toMatchObject({ content: { type: "response", body: "real persisted response" } });
    expect(poster.posts.some(post => activityBody(post.content)?.includes("interrupted"))).toBe(false);
    await worker.stop(); log.close();
  });
  it("gives late terminal activities a full retry budget from their creation time", async () => {
    const { log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger(); let clock = 2_000_000;
    poster.failures = 1;
    log.append({ deliveryId: "d1", app: "planner", action: "created", agentSessionId: "session", issueId: "issue", issueIdentifier: "ENG-9",
      receivedAt: 1, rawBody: Buffer.from(JSON.stringify({ action: "created", promptContext: "old", agentSession: { id: "session", issue: { id: "issue", identifier: "ENG-9" } } })) });
    const turn = log.claimNextTurn(clock - 100)!;
    log.finishTurn(turn.id, "response", "late response", clock, "activity-1");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config,
      { pollMs: 10, reconcileMs: 20, logger, now: () => clock }); worker.start();
    await waitFor(() => logger.entries().some(entry => entry.event === "terminal_activity_retry_scheduled"));
    clock += 1000;
    await waitFor(() => log.turnStates()[0]?.status === "done");
    expect(poster.posts.filter(post => !post.ephemeral).map(post => activityBody(post.content))).toEqual(["late response", "late response"]);
    await worker.stop(); log.close();
  });
  it("does not start a later same-issue turn until the earlier terminal activity posts", async () => {
    const { dir, log, config } = setup(); const logger = new CapturingLogger();
    class FastRetryPoster extends Poster {
      override async postActivity(app: string, session: string, id: string, content: ProgressContent | TerminalContent, ephemeral: boolean): Promise<PostResult> {
        this.posts.push({ app, session, content, ephemeral, at: Date.now() });
        if (!ephemeral && this.failures-- > 0) return { ok: false, retriable: true, retryAfterMs: 50, error: "temporary" };
        return { ok: true };
      }
    }
    const poster = new FastRetryPoster(); poster.failures = 1;
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    append(log, "d1", "session", "created", "issue-1", "ENG-1"); append(log, "d2", "session", "prompted");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => logger.entries().some(entry => entry.event === "terminal_activity_retry_scheduled"));
    const firstStarts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(firstStarts).toHaveLength(1);
    await waitFor(() => log.turnStates().every(turn => turn.status === "done"));
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts).toHaveLength(2);
    await worker.stop(); log.close();
  });
  it("expires retriable terminal delivery failures and unblocks the issue", async () => {
    const { log, config } = setup(); const logger = new CapturingLogger(); let clock = 1000;
    class ExpiringPoster extends Poster {
      override async postActivity(app: string, session: string, id: string, content: ProgressContent | TerminalContent, ephemeral: boolean): Promise<PostResult> {
        this.posts.push({ app, session, content, ephemeral, at: clock });
        if (!ephemeral && "body" in content && content.body === "stuck terminal response")
          return { ok: false, retriable: true, retryAfterMs: 30 * 60_000 + 1, error: "temporary" };
        return { ok: true };
      }
    }
    const poster = new ExpiringPoster();
    append(log, "d1", "session", "created", "issue-1", "ENG-1"); append(log, "d2", "session", "prompted");
    const turn = log.claimNextTurn(clock)!;
    log.finishTurn(turn.id, "response", "stuck terminal response", clock, "activity-1");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config,
      { pollMs: 10, reconcileMs: 20, logger, now: () => clock }); worker.start();
    await waitFor(() => logger.entries().some(entry => entry.event === "terminal_activity_retry_scheduled"));
    expect(log.turnStates()[1]?.status).toBe("pending");
    clock += 30 * 60_000 + 1;
    await waitFor(() => logger.entries().some(entry => entry.event === "terminal_activity_delivery_failed"));
    await waitFor(() => log.turnStates()[1]?.status === "done");
    expect(log.turnStates()[0]?.status).toBe("failed");
    expect(logger.entries().find(entry => entry.event === "terminal_activity_delivery_failed"))
      .toMatchObject({ event: "terminal_activity_delivery_failed", turnId: 1,
        linearSessionId: "session", attempts: 2, error: "temporary" });
    await worker.stop(); log.close();
  });
  it("retries a durable terminal activity after a transient failure", async () => {
    const { log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger(); poster.failures = 1;
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done", 6000);
    expect(logger.entries().find(entry => entry.event === "terminal_activity_retry_scheduled"))
      .toMatchObject({ event: "terminal_activity_retry_scheduled", turnId: 1,
        linearSessionId: "session", attempts: 1, next_attempt_at: expect.any(Number), error: "temporary" });
    expect(poster.posts.filter(post => !post.ephemeral)).toHaveLength(2); await worker.stop(); log.close();
  });
  it("logs terminal activity delivery failures with job id and attempts", async () => {
    class TerminalFailingPoster extends Poster {
      override async postActivity(app: string, session: string, id: string, content: ProgressContent | TerminalContent, ephemeral: boolean): Promise<PostResult> {
        await super.postActivity(app, session, id, content, ephemeral);
        return ephemeral ? { ok: true } : { ok: false, retriable: false, error: "permanent" };
      }
    }
    const { log, config } = setup(); const poster = new TerminalFailingPoster(); const logger = new CapturingLogger();
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    expect(logger.entries().find(entry => entry.event === "terminal_activity_delivery_failed"))
      .toMatchObject({ event: "terminal_activity_delivery_failed", turnId: 1,
        linearSessionId: "session", attempts: 1, error: "permanent" });
    await worker.stop(); log.close();
  });
  it("logs unhandled turn failures with job id and attempts", async () => {
    const { dir, log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    config.targetRepoPath = join(dir, "missing-repo");
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    expect(logger.entries().find(entry => entry.event === "session_turn_unhandled"))
      .toMatchObject({ event: "session_turn_unhandled", turnId: 1,
        linearSessionId: "session", issueId: "issue-uuid", attempts: 1, error: expect.any(String) });
    await worker.stop(); log.close();
  });
  it("captures noisy stderr tails in failure logs without exposing them in terminal activity", async () => {
    const { log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_MODE = "stderr-fail";
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    expect(logger.entries().find(entry => entry.event === "session_turn_failed"))
      .toMatchObject({ event: "session_turn_failed", turnId: 1, linearSessionId: "session",
        attempts: 1, stderrTail: expect.stringContaining("stderr-line-") });
    expect(activityBody(poster.posts.find(post => !post.ephemeral)?.content)).not.toContain("stderr-line-");
    await worker.stop(); log.close();
  });
  it("cancels progress and keepalive when the Claude runner rejects after progress starts", async () => {
    const { log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    config.claudeArgv = [];
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    const postsAfterFailure = poster.posts.length;
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(poster.posts).toHaveLength(postsAfterFailure);
    expect(logger.entries().find(entry => entry.event === "session_turn_unhandled"))
      .toMatchObject({ event: "session_turn_unhandled", turnId: 1, attempts: 1, error: expect.stringContaining("Claude argv is empty") });
    await worker.stop(); log.close();
  });
  it("downloads allowlisted attachments with bearer auth, sanitizes names, and keeps git clean", async () => {
    const received: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      received.push(request.headers.authorization);
      if (request.url === "/big") { response.writeHead(200, { "Content-Length": String(11 * 1024 * 1024) }); response.end(); return; }
      if (request.url === "/redirect") { response.writeHead(302, { Location: `http://localhost:${(server.address() as { port: number }).port}/file` }); response.end(); return; }
      response.end("attachment body");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const { log, config } = setup(); const poster = new Poster(); config.attachmentsEnabled = true; config.attachmentHosts = ["127.0.0.1"];
    const raw = { promptContext: "plan", agentSession: { issue: { attachments: [
      { url: `http://127.0.0.1:${port}/file`, title: "../../secret.txt" },
      { url: `http://127.0.0.1:${port}/big`, filename: "big.bin" },
      { url: `http://127.0.0.1:${port}/redirect`, filename: "redirect.txt" },
      { url: `http://example.invalid/file`, filename: "blocked.txt" },
    ] } } };
    log.append({ deliveryId: "d1", app: "planner", action: "created", agentSessionId: "session", issueId: "issue",
      issueIdentifier: "ENG-8", receivedAt: Date.now(), rawBody: Buffer.from(JSON.stringify(raw)) });
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config,
      { pollMs: 10, reconcileMs: 20, attachmentTestAllowHttp: true }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    const worktree = log.getSession("session")!.worktreePath!;
    expect(readdirSync(join(worktree, ".linear-attachments"))).toHaveLength(1);
    expect(received).toEqual(["Bearer linear-key", "Bearer linear-key", "Bearer linear-key"]);
    expect(log.turnStates()[0]?.prompt).toMatch(/big\.bin: failed|redirect\.txt: failed|blocked\.txt: failed/);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" })).toBe("");
    await worker.stop(); log.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
  it("aborts a stalled attachment body at the per-file deadline and continues the turn", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write("partial");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const { log, config } = setup(); const poster = new Poster(); config.attachmentsEnabled = true; config.attachmentHosts = ["127.0.0.1"];
    const raw = { promptContext: "plan", agentSession: { issue: { attachments: [
      { url: `http://127.0.0.1:${port}/stall`, title: "stall.txt" },
    ] } } };
    log.append({ deliveryId: "d1", app: "planner", action: "created", agentSessionId: "session", issueId: "issue",
      issueIdentifier: "ENG-10", receivedAt: Date.now(), rawBody: Buffer.from(JSON.stringify(raw)) });
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config,
      { pollMs: 10, reconcileMs: 20, attachmentTestAllowHttp: true, attachmentTimeoutMs: 50 }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    expect(log.turnStates()[0]?.prompt).toContain("stall.txt: failed (attachment timed out)");
    await worker.stop(); log.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
  it("AC7-contract: reopens SQLite and resumes the persisted Claude session after restart", async () => {
    const { dir, log, config } = setup(); const poster = new Poster(); process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    append(log, "d1", "session", "created"); const first = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); first.start();
    await waitFor(() => log.turnStates()[0]?.status === "done"); await first.stop(); log.close();
    const reopened = new EventLog(config.dbPath); append(reopened, "d2", "session", "prompted");
    const second = new SessionWorker(reopened, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); second.start();
    await waitFor(() => reopened.turnStates()[1]?.status === "done");
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts[1].args.slice(starts[1].args.indexOf("--resume"), starts[1].args.indexOf("--resume") + 2))
      .toEqual(["--resume", "claude-session-1"]);
    await second.stop(); reopened.close();
  });
  it("AC7 child-restart: SIGKILL then prompted resumes the persisted session", async () => {
    const { dir, log, config } = setup(); log.close(); const port = await freePort(); const requests: unknown[] = [];
    const graphql = createServer((request, response) => { const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => { requests.push(JSON.parse(Buffer.concat(chunks).toString())); response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: { agentActivityCreate: { success: true, agentActivity: { id: "a" } } } })); }); });
    await new Promise<void>(resolve => graphql.listen(0, "127.0.0.1", resolve)); const graphqlPort = (graphql.address() as { port: number }).port;
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    const env = { ...process.env, DAEMON_TEST_MODE: "1", PORT: String(port), BIND_ADDR: "127.0.0.1", DB_PATH: config.dbPath,
      PLANNER_WEBHOOK_SECRET: "planner-secret", PLANNER_LINEAR_TOKEN: "p", IMPLEMENTER_WEBHOOK_SECRET: "i", IMPLEMENTER_LINEAR_TOKEN: "i",
      SESSIONS_ENABLED: "1", TARGET_REPO_PATH: config.targetRepoPath!, WORKTREES_ROOT: config.worktreesRoot, LINEAR_API_KEY: "key",
      CLAUDE_BIN: `${process.execPath} ${resolve("test/fixtures/fake-claude.mjs")}`, CLAUDE_PERMISSION_MODE: "plan", ATTACHMENTS_ENABLED: "0",
      LINEAR_GRAPHQL_URL: `http://127.0.0.1:${graphqlPort}/graphql` };
    const launch = () => spawn(process.execPath, [resolve("dist/index.js")], { env, stdio: "ignore" });
    const send = async (delivery: string, body: Record<string, unknown>) => { const encoded = JSON.stringify({ webhookTimestamp: Date.now(), ...body });
      const signature = createHmac("sha256", "planner-secret").update(encoded).digest("hex");
      expect((await fetch(`http://127.0.0.1:${port}/webhook/planner`, { method: "POST", body: encoded,
        headers: { "Linear-Signature": signature, "Linear-Delivery": delivery } })).status).toBe(200); };
    let child = launch(); await healthy(port, child);
    await send("d1", { action: "created", promptContext: "plan", agentSession: { id: "session", issue: { id: "issue", identifier: "ENG-7" } } });
    await waitFor(() => { const db = new EventLog(config.dbPath); const done = db.turnStates()[0]?.status === "done"; db.close(); return done; });
    child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve)); child = launch(); await healthy(port, child);
    await send("d2", { action: "prompted", agentActivity: { body: "continue" }, agentSession: { id: "session" } });
    await waitFor(() => { const db = new EventLog(config.dbPath); const done = db.turnStates()[1]?.status === "done"; db.close(); return done; });
    child.kill("SIGTERM"); await new Promise(resolve => child.once("close", resolve));
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts[1].args).toContain("--resume"); expect(starts[1].args).toContain("claude-session-1"); expect(requests.length).toBeGreaterThan(2);
    await new Promise<void>(resolve => graphql.close(() => resolve()));
  }, 10_000);
  it("persists a compacted session id and never posts progress after the terminal response", async () => {
    const { dir, log, config } = setup(); process.env.CLAUDE_FAKE_MODE = "new-id"; process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    class DelayedPoster extends Poster {
      override async postActivity(app: string, session: string, id: string, content: ProgressContent | TerminalContent, ephemeral: boolean): Promise<PostResult> {
        if (ephemeral) await new Promise(resolve => setTimeout(resolve, 30));
        return super.postActivity(app, session, id, content, ephemeral);
      }
    }
    const poster = new DelayedPoster(); append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done"); expect(log.getSession("session")?.claudeSessionId).toBe("claude-session-2");
    process.env.CLAUDE_FAKE_MODE = "happy"; append(log, "d2", "session", "prompted"); worker.trigger(); await waitFor(() => log.turnStates()[1]?.status === "done");
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts[1].args).toContain("claude-session-2");
    expect(poster.posts.at(-1)?.ephemeral).toBe(false);
    await worker.stop(); log.close();
  });
  it.each(["rate-limit-rejected", "out-of-credits", "api-retry-exhausted", "result-429"])(
    "AC3/AC4: starts on Claude and retries %s exactly once on Claudex", async mode => {
      const { dir, log, config } = setup(); const poster = new Poster();
      process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl"); process.env.CLAUDE_FAKE_MODE = mode;
      config.claudexArgv = [...config.claudeArgv, "--claudex-runtime"];
      config.claudexEnv = { CLAUDE_FAKE_MODE: "happy" };
      append(log, "d1", "session", "created");
      const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
      await waitFor(() => log.turnStates()[0]?.status === "done"); await worker.stop();
      const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n")
        .map(line => JSON.parse(line)).filter(row => row.phase === "start");
      expect(starts).toHaveLength(2); expect(starts[0].args).not.toContain("--claudex-runtime");
      expect(starts[1].args).toContain("--claudex-runtime"); expect(starts[1].args).not.toContain("--resume");
      expect(log.getSession("session")).toMatchObject({ runtime: "claudex", fallbackCause: expect.any(String) });
      log.close();
    });
  it("AC5/AC6/AC8: resumed /do fallback is fresh, records the downgrade, and persists Claudex", async () => {
    const { dir, log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl"); process.env.CLAUDE_FAKE_MODE = "do-pr";
    config.claudexArgv = [...config.claudeArgv, "--claudex-runtime"];
    config.claudexEnv = { CLAUDE_FAKE_MODE: "happy", ENABLE_TOOL_SEARCH: "true" };
    appendImplementer(log, "i1", "implementer-session");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    process.env.CLAUDE_FAKE_MODE = "capacity-after-session";
    log.append({ deliveryId: "i2", app: "implementer", action: "prompted", agentSessionId: "implementer-session", receivedAt: Date.now(),
      rawBody: Buffer.from(JSON.stringify({ action: "prompted", agentActivity: { body: "continue" }, agentSession: { id: "implementer-session" } })) });
    worker.trigger(); await waitFor(() => log.turnStates()[1]?.status === "done");
    process.env.CLAUDE_FAKE_MODE = "crash";
    log.append({ deliveryId: "i3", app: "implementer", action: "prompted", agentSessionId: "implementer-session", receivedAt: Date.now(),
      rawBody: Buffer.from(JSON.stringify({ action: "prompted", agentActivity: { body: "next" }, agentSession: { id: "implementer-session" } })) });
    worker.trigger(); await waitFor(() => log.turnStates()[2]?.status === "done"); await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts).toHaveLength(4);
    const retryArgs = starts[2].args as string[]; expect(retryArgs).toContain("--claudex-runtime"); expect(retryArgs).not.toContain("--resume");
    const retryPrompt = retryArgs[retryArgs.indexOf("-p") + 1];
    expect(retryPrompt).toContain("/do ENG-42\n\nResume where we left off.");
    expect(retryPrompt).toContain("original runtime claude; fallback runtime claudex");
    expect(retryPrompt).toContain("effective review lanes are single/Codex-only regardless of any dual request");
    expect(starts[3].args).toEqual(expect.arrayContaining(["--claudex-runtime", "--resume", "claude-session-1"]));
    expect(log.getSession("implementer-session")).toMatchObject({ runtime: "claudex", claudeSessionId: "claude-session-1" });
    expect(poster.posts.filter(post => post.ephemeral && activityBody(post.content)?.includes("retrying once with Claudex"))).toHaveLength(1);
    expect(logger.entries().filter(entry => entry.event === "session_capacity_fallback")).toHaveLength(1);
    log.close();
  });
  it.each([
    ["error-result-exit", "Planner turn failed: Claude exited with code 11"],
    ["denied", "Planner turn failed: Claude permission was denied"],
    ["no-result", "Planner turn failed: Claude exited without a result"],
    ["non-capacity-api-error", "Planner turn failed: Claude exited with code 1"],
  ])("AC7: %s stays on Claude and preserves its terminal classification", async (mode, detail) => {
    const { dir, log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl"); process.env.CLAUDE_FAKE_MODE = mode;
    config.claudexArgv = [...config.claudeArgv, "--claudex-runtime"]; config.claudexEnv = { CLAUDE_FAKE_MODE: "happy" };
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed"); await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts).toHaveLength(1); expect(starts[0].args).not.toContain("--claudex-runtime");
    expect(poster.posts.filter(post => !post.ephemeral).map(post => activityBody(post.content))).toEqual([detail]);
    expect(logger.entries().filter(entry => entry.event === "session_capacity_fallback")).toHaveLength(0);
    expect(logger.entries().filter(entry => entry.event === "session_turn_failed"))
      .toEqual([expect.objectContaining({ attempts: 1, error: detail.replace("Planner turn failed: ", "") })]);
    expect(log.getSession("session")).toMatchObject({ runtime: "claude", fallbackCause: null }); log.close();
  });
  it("AC7: signal death stays on Claude and preserves the queued terminal classification", async () => {
    const { dir, log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl"); process.env.CLAUDE_FAKE_MODE = "hang";
    config.claudexArgv = [...config.claudeArgv, "--claudex-runtime"]; config.claudexEnv = { CLAUDE_FAKE_MODE: "happy" };
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "running" && readdirSync(dir).includes("args.jsonl"));
    await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts).toHaveLength(1); expect(starts[0].args).not.toContain("--claudex-runtime");
    expect(log.pendingTurnActivities().map(activity => activity.body))
      .toEqual(["Planner turn failed: Claude exited on SIGTERM"]);
    expect(logger.entries().filter(entry => entry.event === "session_capacity_fallback")).toHaveLength(0);
    expect(logger.entries().filter(entry => entry.event === "session_turn_failed"))
      .toEqual([expect.objectContaining({ attempts: 1, error: "Claude exited on SIGTERM" })]);
    expect(log.getSession("session")).toMatchObject({ runtime: "claude", fallbackCause: null }); log.close();
  });
  it("AC7: missing Claude binary does not start Claudex and preserves the spawn failure", async () => {
    const { dir, log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    const argsFile = join(dir, "args.jsonl"); process.env.CLAUDE_FAKE_ARGS_FILE = argsFile;
    config.claudeArgv = [join(dir, "missing-claude")];
    config.claudexArgv = [process.execPath, resolve("test/fixtures/fake-claude.mjs"), "--claudex-runtime"];
    config.claudexEnv = { CLAUDE_FAKE_MODE: "happy" };
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed"); await worker.stop();
    expect(readdirSync(dir)).not.toContain("args.jsonl");
    const terminals = poster.posts.filter(post => !post.ephemeral).map(post => activityBody(post.content));
    expect(terminals).toHaveLength(1); expect(terminals[0]).toContain("Planner turn failed: spawn"); expect(terminals[0]).toContain("ENOENT");
    expect(logger.entries().filter(entry => entry.event === "session_capacity_fallback")).toHaveLength(0);
    expect(logger.entries().filter(entry => entry.event === "session_turn_failed"))
      .toEqual([expect.objectContaining({ attempts: 1, error: expect.stringMatching(/^spawn .* ENOENT$/) })]);
    expect(log.getSession("session")).toMatchObject({ runtime: "claude", fallbackCause: null }); log.close();
  });
  it("reports a sanitized usage limit when fallback is unavailable", async () => {
    const { log, config } = setup(); const poster = new Poster(); process.env.CLAUDE_FAKE_MODE = "rate-limit-rejected";
    append(log, "d1", "session", "created"); const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed"); await worker.stop();
    expect(log.turnStates()[0]?.status).toBe("failed");
    expect(poster.posts.some(post => !post.ephemeral && activityBody(post.content)?.includes("Claude hit a usage limit"))).toBe(true);
    log.close();
  });
  it("cleans up progress and keepalive when the Claudex fallback runner rejects", async () => {
    const { log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_MODE = "rate-limit-rejected";
    config.claudexArgv = []; config.keepaliveMs = 10;
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    const postsAtTerminal = poster.posts.length;
    expect(poster.posts.at(-1)?.ephemeral).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(poster.posts).toHaveLength(postsAtTerminal);
    expect(logger.entries().find(entry => entry.event === "session_turn_unhandled"))
      .toMatchObject({ attempts: 1, error: expect.stringContaining("Claude argv is empty") });
    await worker.stop(); log.close();
  });
  it("degrades a persisted Claudex session to a fresh Claude turn when CLAUDEX_BIN is removed", async () => {
    const { dir, log, config } = setup(); const poster = new Poster(); const logger = new CapturingLogger();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl");
    append(log, "d1", "session", "created");
    const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20, logger }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "done");
    log.recordRuntimeFallback("session", "persisted-claudex-id", "prior capacity", Date.now());
    append(log, "d2", "session", "prompted"); worker.trigger();
    await waitFor(() => log.turnStates()[1]?.status === "done"); await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts).toHaveLength(2); expect(starts[1].args).not.toContain("--resume");
    expect(logger.entries().find(entry => entry.event === "session_runtime_degraded"))
      .toMatchObject({ configuredRuntime: "claudex", effectiveRuntime: "claude", reason: "CLAUDEX_BIN is not configured" });
    expect(log.getSession("session")).toMatchObject({ runtime: "claudex", claudeSessionId: "persisted-claudex-id" });
    log.close();
  });
  it("discards a failed fallback session id and retries Claude fresh next turn", async () => {
    const { dir, log, config } = setup(); const poster = new Poster();
    process.env.CLAUDE_FAKE_ARGS_FILE = join(dir, "args.jsonl"); process.env.CLAUDE_FAKE_MODE = "rate-limit-rejected";
    config.claudexArgv = [...config.claudeArgv, "--claudex-runtime"]; config.claudexEnv = { CLAUDE_FAKE_MODE: "capacity-after-session" };
    append(log, "d1", "session", "created"); const worker = new SessionWorker(log, poster as unknown as LinearGateway, config, { pollMs: 10, reconcileMs: 20 }); worker.start();
    await waitFor(() => log.turnStates()[0]?.status === "failed");
    expect(log.getSession("session")).toMatchObject({ runtime: "claude", claudeSessionId: null });
    process.env.CLAUDE_FAKE_MODE = "happy"; append(log, "d2", "session", "prompted"); worker.trigger();
    await waitFor(() => log.turnStates()[1]?.status === "done"); await worker.stop();
    const starts = readFileSync(process.env.CLAUDE_FAKE_ARGS_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(starts[2].args).not.toContain("--resume"); expect(starts[2].args).not.toContain("--claudex-runtime"); log.close();
  });
});
