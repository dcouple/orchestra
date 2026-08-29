import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Dependencies, Overview, RunDetail, Skills } from "./api";
import { RunTimeline } from "./components/RunTimeline";

const run: RunDetail = { id: "session-1", app: "planner", mode: "planner", status: "active", issueIdentifier: "ENG-42",
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
    const body = path.includes("/api/overview") ? snapshot : path.endsWith("/api/runs") ? { runs: snapshot.recentRuns }
      : path.includes("/api/dependencies") ? dependencies : path.includes("/api/skills") ? skills : run;
    return { ok: true, json: async () => body } as Response;
  }));
}

describe("Orchestra Console", () => {
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
      const body = path.includes("/api/overview") ? overview : path.endsWith("/api/runs") ? { runs: [activeRun] }
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
