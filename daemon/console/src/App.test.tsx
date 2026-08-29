import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { ConfigurationSnapshot, Dependencies, Operation, Overview, RunDetail, Skills } from "./api";
import { RunTimeline } from "./components/RunTimeline";

const run: RunDetail = { id: "session-1", app: "planner", mode: "planner", status: "active", issueIdentifier: "ENG-42",
  origin: "linear", loopName: null, loopId: null, occurrenceId: null,
  runtime: "claude", startedAt: 1_000, completedAt: null, durationMs: 1_000, invocationCount: 1, totalTokens: 15,
  resources: [{ label: "Linear issue", url: "https://linear.example/issue/ENG-42" }, { label: "Artifact bundle", url: "https://artifacts.example/one" }],
  invocations: [{ id: 1, role: "code-researcher", runtime: "codex", model: "gpt-test", startedAt: 1_100,
    endedAt: 1_600, durationMs: 500, state: "terminal", outcome: "done",
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: null, cacheReadTokens: null, totalTokens: 15 } }] };
const runB: RunDetail = { ...run, id: "session-2", app: "implementer", mode: "implementer", issueIdentifier: "ENG-43",
  resources: [{ label: "Linear issue", url: "https://linear.example/issue/ENG-43" },
    { label: "Artifact bundle", url: "https://artifacts.example/two" }] };
const overview: Overview = { observedAt: 2_000, daemon: { status: "online", observedAt: 2_000 },
  providers: [{ provider: "claude", status: "ready", reason: null, cooldownUntil: null, updatedAt: 2_000 }],
  operations: { pending: null, runningTurns: 1, lastOutcome: null }, activeRuns: 1, recentRuns: [run],
  dependencies: { status: "degraded", configured: 2, total: 5 } };
const dependencies: Dependencies = { observedAt: 2_000, daemon: overview.daemon, status: "degraded", dependencies: [
  { kind: "mcp", name: "linear", configured: true, status: "healthy", lastStatus: "healthy", reasonCode: null,
    capabilities: { toolCount: 12, truncated: false }, observedAt: 1_900, staleAt: 2_900 },
  { kind: "mcp", name: "playwright", configured: false, status: "disabled", lastStatus: "disabled", reasonCode: "disabled",
    capabilities: {}, observedAt: 1_900, staleAt: 2_900 },
  { kind: "mcp", name: "xcodebuildmcp", configured: true, status: "stale", lastStatus: "healthy", reasonCode: "stale",
    capabilities: {}, observedAt: 900, staleAt: 1_900 },
  { kind: "harness", name: "claude", configured: true, status: "future_timestamp", lastStatus: "healthy", reasonCode: "future_timestamp",
    capabilities: {}, observedAt: 3_000, staleAt: 4_000 },
  { kind: "harness", name: "claudex", configured: null, status: "unknown", lastStatus: "unknown", reasonCode: "not_observed",
    capabilities: {}, observedAt: null, staleAt: null },
] };
const skills: Skills = { availability: "available", schemaVersion: 1, sourceRevision: "a".repeat(40),
  sources: [{ id: "claude", label: "Claude Code", available: true, skillCount: 1 },
    { id: "codex", label: "Codex", available: true, skillCount: 1 }],
  skills: [{ name: "implementer", description: "Implements an approved plan.", version: null, availability: "available",
    provenance: ["Claude Code", "Codex"], compatibility: ["claude", "codex"] },
    { name: "review", description: "Reviews a change.", version: "1.2.3", availability: "available",
      provenance: ["Codex"], compatibility: ["codex"] }] };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}
function mockApi(snapshot: Overview = overview) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    const body = path.includes("/api/overview") ? snapshot : path.endsWith("/api/bootstrap") ? { capability: "local-trusted", csrfToken: "csrf" } : path.endsWith("/api/runs") ? { runs: snapshot.recentRuns }
      : path.includes("/api/dependencies") ? dependencies : path.includes("/api/skills") ? skills : run;
    return { ok: true, json: async () => body } as Response;
  }));
}

describe("Orchestra Console", () => {
  it("keyboard-drives a bounded loop definition and exposes no arbitrary execution control",async()=>{
    const requests:Array<{path:string;init?:RequestInit}>=[];
    vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{const path=String(input);requests.push({path,...(init?{init}:{})});
      const loop={id:"loop-1",revision:1,digest:"a".repeat(64),version:1,name:"Health",description:"Review",trigger:{kind:"fixed-interval",everyMinutes:60,startsAt:2_000},task:{kind:"agent",role:"planner"},harness:{runtime:"claude",profile:"sol"},maxConcurrency:1,budgetUsd:2,timeoutMinutes:10,maxRetries:1,enabled:false,nextDueAt:3_000,blockedReason:null,createdAt:2_000,updatedAt:2_000};
      const body=path.includes("/api/overview")?overview:path.endsWith("/api/runs")?{runs:[run]}:path.includes("/api/dependencies")?dependencies:path.includes("/api/skills")?skills
        :path.endsWith("/api/bootstrap")?{capability:"local-trusted",csrfToken:"csrf"}:path.endsWith("/api/loops/drafts")?{id:"draft-loop",digest:"b".repeat(64),kind:"create",loopId:"loop-1",expectedRevision:null,reason:"bounded upkeep",expiresAt:9_000,changedFields:["name"],policy:{maxConcurrency:1,budgetUsd:2,timeoutMinutes:10,maxRetries:1}}
        :path.endsWith("/api/loops/confirm")?{loop,auditSequence:1,deduplicated:false}:path.endsWith("/api/loops")?{loops:[]}:run;
      return jsonResponse(body);}));
    const user=userEvent.setup();render(<App/>);await screen.findByRole("heading",{name:"Overview"});screen.getByRole("button",{name:"Loops"}).focus();await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading",{name:"Loops"})).toBeInTheDocument();await user.type(screen.getByLabelText("Name"),"Health");
    await user.type(screen.getByLabelText("Starts at"),"2030-01-01T00:00");await user.type(screen.getByLabelText("Objective"),"Review repository health");await user.type(screen.getByLabelText("Reason"),"bounded upkeep");
    await user.click(screen.getByRole("button",{name:"Review definition"}));expect(await screen.findByRole("dialog",{name:"Confirm local operation"})).toBeInTheDocument();
    expect(screen.queryByLabelText(/command|shell|argv|path|cron|model|permission/i)).not.toBeInTheDocument();await user.click(screen.getByRole("button",{name:"Confirm and apply"}));
    await waitFor(()=>expect(requests.some(row=>row.path.endsWith("/api/loops/confirm"))).toBe(true));
  });
  it("requires bounded operator reasons for toggles and retained-cleanup recovery",async()=>{
    const requests:Array<{path:string;init?:RequestInit}>=[];let draftNumber=0;
    const loop={id:"loop-1",revision:1,digest:"a".repeat(64),version:1 as const,name:"Health",description:"Review",
      trigger:{kind:"fixed-interval" as const,everyMinutes:60,startsAt:2_000},task:{kind:"agent" as const,role:"planner" as const},
      harness:{runtime:"claude" as const,profile:"sol" as const},maxConcurrency:1,budgetUsd:2,timeoutMinutes:10,maxRetries:1,
      enabled:false,nextDueAt:3_000,blockedReason:"cleanup_retained",createdAt:2_000,updatedAt:2_000};
    const detail={...loop,audit:[],occurrences:[],
      cleanups:[{id:1,occurrenceId:"occ-1",status:"retained",attempts:1,error:"cleanup retained: dirty worktree",createdAt:2_000}]};
    const enabledLoop={...loop,id:"loop-2",name:"Enabled health",enabled:true,blockedReason:null};
    vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{const path=String(input);requests.push({path,...(init?{init}:{})});
      const submitted=init?.body?JSON.parse(String(init.body)) as {kind?:string;reason?:string}:{};
      if(path.endsWith("/api/loops/drafts")){
        if(submitted.reason?.startsWith("offline"))return {ok:false,status:503,json:async()=>({error:{message:"Loop service offline"}})} as Response;
        draftNumber++;return jsonResponse({id:`draft-${draftNumber}`,digest:"b".repeat(64),kind:submitted.kind,loopId:loop.id,expectedRevision:1,reason:submitted.reason,expiresAt:9_000,changedFields:["enabled"],policy:null});
      }
      const body=path.includes("/api/overview")?overview:path.endsWith("/api/runs")?{runs:[run]}:path.includes("/api/dependencies")?dependencies:path.includes("/api/skills")?skills
        :path.endsWith("/api/bootstrap")?{capability:"local-trusted",csrfToken:"csrf"}:path.endsWith("/api/loops/confirm")?{loop,auditSequence:1,deduplicated:false}
        :path.endsWith("/api/loops/loop-1")?detail:path.endsWith("/api/loops")?{loops:[loop,enabledLoop]}:run;
      return jsonResponse(body);
    }));
    const user=userEvent.setup();render(<App/>);await screen.findByRole("heading",{name:"Overview"});await user.click(screen.getByRole("button",{name:"Loops"}));
    const enable=await screen.findByRole("button",{name:"Enable"});enable.focus();await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog",{name:/Reason to enable Health/})).toBeInTheDocument();expect(screen.getByLabelText("Operator reason")).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");expect(screen.getByRole("button",{name:"Review change"})).toHaveFocus();
    await user.keyboard("{Tab}");expect(screen.getByLabelText("Operator reason")).toHaveFocus();await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("A reason is required");expect(requests.filter(row=>row.path.endsWith("/api/loops/drafts"))).toHaveLength(0);
    await user.type(screen.getByLabelText("Operator reason"),"cancel this change");await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog",{name:/Reason to enable/})).not.toBeInTheDocument();
    expect(enable).toHaveFocus();
    await user.click(screen.getByRole("button",{name:"Enable"}));await user.type(screen.getByLabelText("Operator reason"),"offline attempt");await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Loop service offline");expect(screen.getByRole("dialog",{name:/Reason to enable/})).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Operator reason"));await user.type(screen.getByLabelText("Operator reason"),"enable after review");await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog",{name:"Confirm local operation"})).toHaveTextContent("enable after review");screen.getByRole("button",{name:"Back"}).focus();await user.keyboard("{Enter}");
    expect(requests.filter(row=>row.path.endsWith("/api/loops/confirm"))).toHaveLength(0);
    await user.click(screen.getByRole("button",{name:"Disable"}));await user.type(screen.getByLabelText("Operator reason"),"pause during maintenance");await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog",{name:"Confirm local operation"})).toHaveTextContent("pause during maintenance");
    const submittedBodies=requests.flatMap(row=>row.init?.body?[JSON.parse(String(row.init.body))]:[]);
    expect(submittedBodies).toEqual(expect.arrayContaining([expect.objectContaining({kind:"disable",reason:"pause during maintenance"})]));
    await user.click(screen.getByRole("button",{name:"Back"}));
    await user.click(screen.getByRole("button",{name:"Health"}));expect(await screen.findByRole("button",{name:"Retry cleanup"})).toBeInTheDocument();
    screen.getByRole("button",{name:"Retry cleanup"}).focus();await user.keyboard("{Enter}");await user.type(screen.getByLabelText("Operator reason"),"offline cleanup");await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Loop service offline");expect(screen.getByRole("button",{name:"Retry cleanup"})).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Operator reason"));await user.type(screen.getByLabelText("Operator reason"),"revalidate retained worktree");await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog",{name:"Confirm local operation"})).toHaveTextContent("revalidate retained worktree");
    const retryDraft=requests.filter(row=>row.path.endsWith("/api/loops/drafts")).map(row=>JSON.parse(String(row.init?.body))).find(body=>body.kind==="cleanup.retry"&&body.reason==="revalidate retained worktree");
    expect(retryDraft).toMatchObject({kind:"cleanup.retry",reason:"revalidate retained worktree"});
  });

  it("bootstraps read-only capability before rendering mutation affordances on every write surface", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const configuration: ConfigurationSnapshot = { version: 1, revision: "revision_read_only", generatedAt: 1_900, staleAt: 9_000,
      settings: { plannerHarness: "claude", implementerHarness: "claudex", sessionConcurrency: 2 }, secrets: {} };
    const operation: Operation = { id: "op-read", digest: "a".repeat(64), kind: "config.apply", actor: "local-console", reason: "history",
      state: "blocked", stage: "rollback", attempts: 1, stateVersion: 2, outcome: "failed", recoveryActions: ["retry"], events: [] };
    const loop = { id: "loop-read", revision: 1, digest: "b".repeat(64), version: 1 as const, name: "Observed loop", description: "history",
      trigger: { kind: "fixed-interval" as const, everyMinutes: 60, startsAt: 2_000 }, task: { kind: "agent" as const, role: "planner" as const },
      harness: { runtime: "claude" as const, profile: "sol" as const }, maxConcurrency: 1, budgetUsd: 2, timeoutMinutes: 10,
      maxRetries: 1, enabled: false, nextDueAt: 3_000, blockedReason: "cleanup_retained", createdAt: 2_000, updatedAt: 2_000 };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); requests.push({ path, method: init?.method ?? "GET" });
      const body = path.endsWith("/api/bootstrap") ? { capability: "read-only", csrfToken: "csrf" }
        : path.includes("/api/overview") ? overview : path.endsWith("/api/runs") ? { runs: [run] }
          : path.includes("/api/dependencies") ? dependencies : path.includes("/api/skills") ? skills
            : path.includes("/api/configuration") ? configuration : path.endsWith("/api/operations") ? { operations: [operation] }
              : path.endsWith("/api/loops/loop-read") ? { ...loop, audit: [], occurrences: [], cleanups: [{ id: 1, occurrenceId: "occ", status: "retained", attempts: 1, error: "retained", createdAt: 2_000 }] }
                : path.endsWith("/api/loops") ? { loops: [loop] } : run;
      return jsonResponse(body);
    }));
    const user = userEvent.setup(); render(<App />); await screen.findByRole("heading", { name: "Overview" });
    await user.click(screen.getByRole("button", { name: "Configuration" }));
    expect(await screen.findByText(/Read-only mode/)).toBeInTheDocument(); expect(screen.getByText("revision_read_only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review|apply|restart|reload/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New Linear API key")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Operations" }));
    expect(await screen.findByRole("table", { name: "Operation history" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry|cancel/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Loops" }));
    expect(await screen.findByRole("button", { name: "Observed loop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable|disable|retry cleanup|edit definition|review definition/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Objective")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Observed loop" }));
    expect(await screen.findByRole("heading", { name: "Observed loop occurrence history" })).toBeInTheDocument();
    expect(requests.filter(request => request.method === "POST")).toEqual([]);
  });

  it("shows capability loading and failure states without exposing guaranteed-403 controls", async () => {
    const bootstrap = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input); if (path.endsWith("/api/bootstrap")) return bootstrap.promise;
      const body = path.includes("/api/overview") ? overview : path.endsWith("/api/runs") ? { runs: [run] }
        : path.includes("/api/dependencies") ? dependencies : path.includes("/api/skills") ? skills
          : path.endsWith("/api/loops") ? { loops: [] } : run;
      return jsonResponse(body);
    }));
    const user = userEvent.setup(); render(<App />); await screen.findByRole("heading", { name: "Overview" });
    await user.click(screen.getByRole("button", { name: "Loops" }));
    expect(await screen.findByRole("heading", { name: "Capability loading" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review definition" })).not.toBeInTheDocument();
    await act(async () => { bootstrap.resolve({ ok: false, status: 503, json: async () => ({ error: {} }) } as Response); await bootstrap.promise; });
    expect(await screen.findByText(/Capability could not be verified/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review definition" })).not.toBeInTheDocument();
  });

  it("traps confirmation focus, ignores Escape while busy, and restores the opener", async () => {
    const confirmation = deferred<Response>(); let confirmPending = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/loops/confirm") && confirmPending) return confirmation.promise;
      const body = path.endsWith("/api/bootstrap") ? { capability: "local-trusted", csrfToken: "csrf" }
        : path.includes("/api/overview") ? overview : path.endsWith("/api/runs") ? { runs: [run] }
          : path.includes("/api/dependencies") ? dependencies : path.includes("/api/skills") ? skills
            : path.endsWith("/api/loops/drafts") ? { id: "modal-draft", digest: "c".repeat(64), kind: "create", loopId: "modal-loop", expectedRevision: null, reason: "modal test", expiresAt: 9_000, changedFields: ["name"], policy: null }
              : path.endsWith("/api/loops") ? { loops: [] } : init?.method === "POST" ? {} : run;
      return jsonResponse(body);
    }));
    const user = userEvent.setup(); render(<App />); await screen.findByRole("heading", { name: "Overview" });
    await user.click(screen.getByRole("button", { name: "Loops" })); await screen.findByLabelText("Objective");
    await user.type(screen.getByLabelText("Name"), "Modal loop"); await user.type(screen.getByLabelText("Starts at"), "2030-01-01T00:00");
    await user.type(screen.getByLabelText("Objective"), "bounded objective"); await user.type(screen.getByLabelText("Reason"), "modal test");
    const opener = screen.getByRole("button", { name: "Review definition" }); await user.click(opener);
    expect(await screen.findByRole("dialog", { name: "Confirm local operation" })).toBeInTheDocument();
    expect(document.querySelector(".shell")?.parentElement).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Confirm and apply" })).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}"); expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
    await user.keyboard("{Tab}"); expect(screen.getByRole("button", { name: "Confirm and apply" })).toHaveFocus();
    await user.keyboard("{Escape}"); expect(screen.queryByRole("dialog", { name: "Confirm local operation" })).not.toBeInTheDocument(); expect(document.querySelector(".shell")?.parentElement).not.toHaveAttribute("inert"); expect(opener).toHaveFocus();
    const secondOpener=screen.getByRole("button",{name:"Review definition"});await user.click(secondOpener); await screen.findByRole("dialog", { name: "Confirm local operation" }); confirmPending = true;
    await user.click(screen.getByRole("button", { name: "Confirm and apply" })); expect(screen.getByRole("dialog", { name: "Confirm local operation" })).toBeInTheDocument();
    await user.keyboard("{Escape}"); expect(screen.getByRole("dialog", { name: "Confirm local operation" })).toBeInTheDocument();
    await act(async () => { confirmation.resolve(jsonResponse({ loop: {}, auditSequence: 1, deduplicated: false })); await confirmation.promise; });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm local operation" })).not.toBeInTheDocument()); expect(secondOpener).toHaveFocus();
  });
  it("renders overview and opens exact run resources with a labeled invocation timeline", async () => {
    mockApi(); const user = userEvent.setup(); render(<App />);
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ENG-42" }));
    expect(await screen.findByText("Sub-agent invocation timeline")).toBeInTheDocument();
    expect(screen.getByLabelText("Invocation role axis")).toHaveTextContent("Role / runtime");
    expect(screen.getByRole("img", { name: /code-researcher, terminal, duration/ })).toBeInTheDocument();
    expect(document.querySelector("[style]")).toBeNull();
    expect(screen.getByRole("link", { name: "Open Linear issue" })).toHaveAttribute("href", "https://linear.example/issue/ENG-42");
    expect(screen.getByRole("link", { name: "Open Artifact bundle" })).toHaveAttribute("href", "https://artifacts.example/one");
    expect(document.body.textContent).not.toContain("PROMPT_SECRET");
    expect(screen.getByText(window.location.host)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("127.0.0.1:8790");
  });

  it("labels loop runs by loop name without presenting a Linear issue identity",async()=>{
    const loopRun:RunDetail={...run,id:"loop:occ-1",issueIdentifier:null,origin:"loop",loopName:"Repository upkeep",loopId:"loop-1",occurrenceId:"occ-1",resources:[]};
    vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request)=>{const path=String(input);const body=path.includes("/api/overview")?{...overview,recentRuns:[loopRun]}
      :path.endsWith("/api/runs")?{runs:[loopRun]}:path.includes("/api/dependencies")?dependencies:path.includes("/api/skills")?skills:loopRun;return jsonResponse(body)}));
    const user=userEvent.setup();render(<App/>);const label=await screen.findByRole("button",{name:"Repository upkeep"});await user.click(label);
    expect(await screen.findByRole("heading",{name:"Repository upkeep"})).toBeInTheDocument();expect(screen.queryByRole("link",{name:"Open Linear issue"})).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("loop:occ-1");
  });

  it("does not count or positively style a not_ready provider", async () => {
    mockApi({ ...overview, providers: [overview.providers[0]!,
      { provider: "codex", status: "not_ready", reason: "unavailable", cooldownUntil: null, updatedAt: 2_000 }] });
    render(<App />);
    expect(await screen.findByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("not ready")).toHaveClass("status-bad");
    expect(screen.getByText("not ready")).not.toHaveClass("status-good");
  });

  it("keeps one global degraded warning visible across every keyboard-accessible page", async () => {
    mockApi(); const user = userEvent.setup(); render(<App />);
    await screen.findByRole("heading", { name: "Overview" });
    expect(screen.getAllByRole("heading", { name: "Dependency health degraded" })).toHaveLength(1);
    screen.getByRole("button", { name: "Runs" }).focus(); await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Runs" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Dependency health degraded" })).toHaveLength(1);
    screen.getByRole("button", { name: "MCP" }).focus(); await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "MCP & Harnesses" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Dependency health degraded" })).toHaveLength(1);
    expect(screen.getByRole("table", { name: "Dependency readiness" })).toBeInTheDocument();
    expect(screen.getByText("toolCount: 12 · truncated: false")).toBeInTheDocument();
    expect(screen.getByText("disabled")).toHaveClass("status-warn");
    expect(screen.getByText("stale")).toHaveClass("status-warn");
    expect(screen.getByText("future timestamp")).toHaveClass("status-warn");
    expect(screen.getByText("Never observed")).toBeInTheDocument();
    screen.getByRole("button", { name: "Skills" }).focus(); await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Dependency health degraded" })).toHaveLength(1);
    expect(screen.getByRole("table", { name: "Installed skill inventory" })).toBeInTheDocument();
    expect(screen.getByText("Implements an approved plan.")).toBeInTheDocument();
    expect(screen.getByText("Not versioned")).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(screen.getAllByText("Claude Code, Codex")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("/Users/");
  });

  it("keyboard-navigates redacted configuration confirmation and operation recovery without arbitrary controls", async () => {
    const configuration: ConfigurationSnapshot = { version: 1, revision: "revision_123456789", generatedAt: 1_900, staleAt: 9_000,
      settings: { plannerHarness: "claude", implementerHarness: "claude", sessionConcurrency: 2, iosSimMaxConcurrent: 2,
        claudeMaxTurns: 30, doMaxTurns: 60, doMaxBudgetUsd: null, mcpEnvPassthrough: [], browserEnabled: true,
        iosSimEnabled: false, attachmentsEnabled: true, ntfyUrl: null }, secrets: {
        LINEAR_API_KEY: { configured: true }, ARTIFACT_TOKEN: { configured: false }, PLANNER_WEBHOOK_SECRET: { configured: true },
        IMPLEMENTER_WEBHOOK_SECRET: { configured: false }, PLANNER_LINEAR_CLIENT_SECRET: { configured: true },
        IMPLEMENTER_LINEAR_CLIENT_SECRET: { configured: false } } };
    const operation: Operation = { id: "op-1", digest: "a".repeat(64), kind: "config.apply", actor: "local-console", reason: "rotate",
      state: "blocked", stage: "rollback_acceptance", attempts: 1, stateVersion: 3, outcome: "health failed",
      recoveryActions: ["retry"], events: [{ sequence: 1, state: "pending", stage: "scheduled", createdAt: 2_000 }] };
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); requests.push({ path, ...(init ? { init } : {}) });
      let body: unknown = path.includes("/api/overview") ? overview : path.endsWith("/api/runs") ? { runs: [run] }
        : path.includes("/api/dependencies") ? dependencies : path.includes("/api/skills") ? skills
        : path.includes("/api/configuration") ? configuration : path.endsWith("/api/bootstrap") ? { capability: "local-trusted", csrfToken: "csrf-token" }
        : path.endsWith("/api/drafts") ? { id: "draft-1", kind: "config.apply", digest: "b".repeat(64), reason: "rotate safely",
          expiresAt: 8_000, changedFields: ["plannerHarness"], before: { plannerHarness: "claude" }, after: { plannerHarness: "claudex" },
          secrets: { LINEAR_API_KEY: "Will rotate", ARTIFACT_TOKEN: "Will add", PLANNER_WEBHOOK_SECRET: "Will rotate",
            IMPLEMENTER_WEBHOOK_SECRET: "Will add", PLANNER_LINEAR_CLIENT_SECRET: "Will rotate",
            IMPLEMENTER_LINEAR_CLIENT_SECRET: "Will add" }, restartRequired: true }
        : path.endsWith("/api/operations/confirm") ? { operation, deduplicated: false }
        : path.endsWith("/api/operations") ? { operations: [operation] } : {};
      return { ok: true, status: init?.method === "POST" ? 202 : 200, json: async () => body } as Response;
    }));
    const user = userEvent.setup(); render(<App />); await screen.findByRole("heading", { name: "Overview" });
    screen.getByRole("button", { name: "Configuration" }).focus(); await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Configuration" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Concurrency & budgets" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Planner harness"), "claudex");
    const secretInputs = [
      ["New Linear API key", "UI_LINEAR_SECRET"], ["New Artifact token", "UI_ARTIFACT_SECRET"],
      ["New Planner webhook secret", "UI_PLANNER_WEBHOOK"], ["New Implementer webhook secret", "UI_IMPLEMENTER_WEBHOOK"],
      ["New Planner Linear client secret", "UI_PLANNER_CLIENT"], ["New Implementer Linear client secret", "UI_IMPLEMENTER_CLIENT"],
    ] as const;
    for (const [label, value] of secretInputs) await user.type(screen.getByLabelText(label), value);
    await user.type(screen.getByLabelText("Reason"), "rotate safely"); await user.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByRole("dialog", { name: "Confirm local operation" })).toBeInTheDocument();
    for (const text of ["LINEAR_API_KEY: Will rotate", "ARTIFACT_TOKEN: Will add", "PLANNER_WEBHOOK_SECRET: Will rotate",
      "IMPLEMENTER_WEBHOOK_SECRET: Will add", "PLANNER_LINEAR_CLIENT_SECRET: Will rotate", "IMPLEMENTER_LINEAR_CLIENT_SECRET: Will add"])
      expect(screen.getByText(text)).toBeInTheDocument();
    for (const [label, value] of secretInputs) { expect(screen.getByLabelText(label)).toHaveValue(""); expect(document.body.textContent).not.toContain(value); }
    const draftRequest = requests.find(value => value.path.endsWith("/api/drafts") && value.init?.method === "POST");
    expect(JSON.parse(String(draftRequest?.init?.body))).toMatchObject({ secrets: Object.fromEntries(secretInputs.map(([, value], index) => [
      ["LINEAR_API_KEY", "ARTIFACT_TOKEN", "PLANNER_WEBHOOK_SECRET", "IMPLEMENTER_WEBHOOK_SECRET",
        "PLANNER_LINEAR_CLIENT_SECRET", "IMPLEMENTER_LINEAR_CLIENT_SECRET"][index], value])) });
    await user.click(screen.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(requests.some(value => value.path.endsWith("/api/operations/confirm"))).toBe(true));
    await user.click(screen.getByRole("button", { name: "Operations" }));
    expect(await screen.findByRole("table", { name: "Operation history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /command|path|argv|commit|branch/i })).not.toBeInTheDocument();
    expect(requests.filter(value => value.path.endsWith("/api/operations/confirm")).map(value => value.init?.body).join("\n"))
      .not.toMatch(/UI_(LINEAR|ARTIFACT|PLANNER|IMPLEMENTER)/);
  });

  it.each(["healthy", "unknown"] as const)("omits the global dependency warning when overview health is %s", async status => {
    mockApi({ ...overview, dependencies: { ...overview.dependencies, status } }); render(<App />);
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Dependency health degraded" })).not.toBeInTheDocument();
  });

  it("removes the global warning when polling changes degraded health to healthy or unknown", async () => {
    let status: Overview["dependencies"]["status"] = "degraded"; let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
      if (delay === 10_000) poll = () => handler(undefined);
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input); const snapshot = { ...overview, dependencies: { ...overview.dependencies, status } };
      const body = path.includes("/api/overview") ? snapshot : path.endsWith("/api/runs") ? { runs: snapshot.recentRuns }
        : path.includes("/api/dependencies") ? { ...dependencies, status } : path.includes("/api/skills") ? skills : run;
      return jsonResponse(body);
    }));
    render(<App />); expect(await screen.findByRole("heading", { name: "Dependency health degraded" })).toBeInTheDocument();
    status = "healthy"; await act(async () => { poll?.(); await Promise.resolve(); });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Dependency health degraded" })).not.toBeInTheDocument());
    status = "degraded"; await act(async () => { poll?.(); await Promise.resolve(); });
    expect(await screen.findByRole("heading", { name: "Dependency health degraded" })).toBeInTheDocument();
    status = "unknown"; await act(async () => { poll?.(); await Promise.resolve(); });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Dependency health degraded" })).not.toBeInTheDocument());
  });

  it("shows a bounded unavailable inventory state without edit or execution controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input); const body = path.includes("/api/overview") ? overview
        : path.endsWith("/api/runs") ? { runs: [run] } : path.includes("/api/dependencies") ? dependencies
          : path.includes("/api/skills") ? { availability: "unavailable", reasonCode: "malformed", sourceRevision: null, sources: [], skills: [] } : run;
      return jsonResponse(body);
    }));
    const user = userEvent.setup(); render(<App />); await screen.findByRole("heading", { name: "Overview" });
    await user.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByRole("heading", { name: "Inventory unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit|install|execute/i })).not.toBeInTheDocument();
  });

  it("renders an explicit empty installed inventory", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input); const body = path.includes("/api/overview") ? overview
        : path.endsWith("/api/runs") ? { runs: [run] } : path.includes("/api/dependencies") ? dependencies
          : path.includes("/api/skills") ? { ...skills, skills: [] } : run;
      return jsonResponse(body);
    }));
    const user = userEvent.setup(); render(<App />); await screen.findByRole("heading", { name: "Overview" });
    await user.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByText("No installed skills were found.")).toBeInTheDocument();
  });

  it("polls selected detail so active duration grows and new invocations appear", async () => {
    const activeRun: RunDetail = { ...run, invocations: [{ ...run.invocations[0]!, endedAt: null,
      durationMs: 500, state: "active", outcome: null }] };
    const updatedRun: RunDetail = { ...activeRun, durationMs: 2_000, invocationCount: 2, invocations: [
      { ...activeRun.invocations[0]!, durationMs: 1_500 },
      { id: 2, role: "implementer", runtime: "codex", model: null, startedAt: null, endedAt: null,
        durationMs: null, state: "active", outcome: null,
        usage: { inputTokens: null, outputTokens: null, cacheCreationTokens: null, cacheReadTokens: null, totalTokens: null } },
    ] };
    let detailCalls = 0; let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
      if (delay === 10_000) poll = () => handler(undefined);
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      const body = path.includes("/api/overview") ? overview : path.endsWith("/api/bootstrap") ? { capability: "local-trusted", csrfToken: "csrf" } : path.endsWith("/api/runs") ? { runs: [activeRun] }
        : path.includes("/api/dependencies") ? dependencies : path.includes("/api/skills") ? skills
        : detailCalls++ === 0 ? activeRun : updatedRun;
      return { ok: true, json: async () => body } as Response;
    }));
    const user = userEvent.setup(); const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "ENG-42" }));
    expect(await screen.findByRole("img", { name: /code-researcher, active, duration 0.5s/ })).toBeInTheDocument();
    await act(async () => { poll?.(); await Promise.resolve(); });
    await waitFor(() => expect(detailCalls).toBe(2));
    expect(await screen.findByRole("img", { name: /code-researcher, active, duration 1.5s/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /implementer, active, duration 0s/ })).toBeInTheDocument();
    expect(container.querySelector(".axis-x")).toHaveTextContent("1.5s");
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("discards an older selection response that finishes after run B", async () => {
    const pendingA = deferred<Response>(); const snapshot = { ...overview, recentRuns: [run, runB] };
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const path = String(input);
      if (path.includes("/api/overview")) return Promise.resolve(jsonResponse(snapshot));
      if (path.endsWith("/api/runs")) return Promise.resolve(jsonResponse({ runs: snapshot.recentRuns }));
      if (path.endsWith("/session-1")) return pendingA.promise;
      return Promise.resolve(jsonResponse(runB));
    }));
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole("button", { name: "ENG-42" }));
    await user.click(screen.getByRole("button", { name: "ENG-43" }));
    expect(await screen.findByRole("heading", { name: "ENG-43" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Linear issue" })).toHaveAttribute("href", "https://linear.example/issue/ENG-43");
    expect(screen.getByRole("link", { name: "Open Artifact bundle" })).toHaveAttribute("href", "https://artifacts.example/two");
    await act(async () => { pendingA.resolve(jsonResponse(run)); await pendingA.promise; await Promise.resolve(); });
    expect(screen.getByRole("heading", { name: "ENG-43" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Linear issue" })).toHaveAttribute("href", "https://linear.example/issue/ENG-43");
    expect(screen.getByRole("link", { name: "Open Artifact bundle" })).toHaveAttribute("href", "https://artifacts.example/two");
  });

  it("discards an older poll response that finishes after run B is selected", async () => {
    const pendingPollA = deferred<Response>(); const snapshot = { ...overview, recentRuns: [run, runB] };
    let runACalls = 0; let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
      if (delay === 10_000) poll = () => handler(undefined);
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const path = String(input);
      if (path.includes("/api/overview")) return Promise.resolve(jsonResponse(snapshot));
      if (path.endsWith("/api/runs")) return Promise.resolve(jsonResponse({ runs: snapshot.recentRuns }));
      if (path.endsWith("/session-1")) return ++runACalls === 1 ? Promise.resolve(jsonResponse(run)) : pendingPollA.promise;
      return Promise.resolve(jsonResponse(runB));
    }));
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole("button", { name: "ENG-42" }));
    expect(await screen.findByRole("heading", { name: "ENG-42" })).toBeInTheDocument();
    await act(async () => { poll?.(); await Promise.resolve(); });
    await waitFor(() => expect(runACalls).toBe(2));
    await user.click(screen.getByRole("button", { name: "ENG-43" }));
    expect(await screen.findByRole("heading", { name: "ENG-43" })).toBeInTheDocument();
    await act(async () => { pendingPollA.resolve(jsonResponse(run)); await pendingPollA.promise; await Promise.resolve(); });
    expect(screen.getByRole("heading", { name: "ENG-43" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Linear issue" })).toHaveAttribute("href", "https://linear.example/issue/ENG-43");
    expect(screen.getByRole("link", { name: "Open Artifact bundle" })).toHaveAttribute("href", "https://artifacts.example/two");
  });

  it("renders an invocation with no valid start without non-finite SVG geometry", () => {
    const { container } = render(<RunTimeline invocations={[{ id: 9, role: "unknown-start", runtime: "claude",
      model: null, startedAt: null, endedAt: null, durationMs: null, state: "active", outcome: null,
      usage: { inputTokens: null, outputTokens: null, cacheCreationTokens: null, cacheReadTokens: null, totalTokens: null } }]} />);
    expect(screen.getByRole("img", { name: /unknown-start, active, duration 0s/ })).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("renders timestamped daemon degradation and empty states", async () => {
    mockApi({ ...overview, daemon: { status: "offline", observedAt: 2_000 }, providers: [], activeRuns: 0, recentRuns: [] });
    render(<App />); expect(await screen.findByRole("heading", { name: "Daemon offline" })).toBeInTheDocument();
    expect(screen.getByText(/health probe at/)).toBeInTheDocument();
    expect(screen.getByText("No runs have been recorded yet.")).toBeInTheDocument();
    expect(screen.getByText("No provider probes have been recorded.")).toBeInTheDocument();
  });

  it("offers a retry when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); })); render(<App />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("offline"));
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});
