import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  LinearMcpMonitor,
  normalizeLinearMcpError,
  probeLinearMcp,
  type LinearMcpScheduler,
} from "../src/linear-mcp-monitor.js";

function logged(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String(call[0])) as Record<string, unknown>;
}

describe("probeLinearMcp", () => {
  it("authenticates and bounds connect, listTools, and close without exposing results", async () => {
    const calls: string[] = [];
    let capturedInit: RequestInit | undefined;
    const transport = {
      start: vi.fn(),
      send: vi.fn(),
      close: vi.fn(async () => {
        calls.push("transport.close");
      }),
    } as unknown as Transport & { close(): Promise<void> };
    const client = {
      connect: vi.fn(async () => {
        calls.push("connect");
      }),
      listTools: vi.fn(async () => {
        calls.push("listTools");
        return { tools: [{ name: "secret", inputSchema: { token: "schema-secret" } }] };
      }),
      close: vi.fn(async () => {
        calls.push("client.close");
      }),
    };

    await probeLinearMcp(
      {
        url: "https://mcp.linear.app/mcp",
        token: "bearer-secret",
        timeoutMs: 1_000,
      },
      {
        createClient: () => client,
        createTransport: (_url, init) => {
          capturedInit = init;
          return transport;
        },
      },
    );

    expect(capturedInit?.headers).toEqual({
      Authorization: "Bearer bearer-secret",
    });
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(calls.slice(0, 2)).toEqual(["connect", "listTools"]);
    expect(calls).toEqual(
      expect.arrayContaining(["client.close", "transport.close"]),
    );
  });

  it("times out a stuck SDK operation and still attempts both closes", async () => {
    const clientClose = vi.fn(async () => {});
    const transportClose = vi.fn(async () => {});
    await expect(
      probeLinearMcp(
        {
          url: "https://mcp.linear.app/mcp",
          token: "secret",
          timeoutMs: 10,
        },
        {
          createClient: () => ({
            connect: () => new Promise<void>(() => {}),
            listTools: vi.fn(),
            close: clientClose,
          }),
          createTransport: () =>
            ({
              start: vi.fn(),
              send: vi.fn(),
              close: transportClose,
            }) as unknown as Transport & { close(): Promise<void> },
        },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(clientClose).toHaveBeenCalledOnce();
    expect(transportClose).toHaveBeenCalledOnce();
  });

  it("uses an independent cleanup deadline and reports hanging closes", async () => {
    const deadlines: AbortController[] = [];
    const timeoutSignal = () => {
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    };
    const clientClose = vi.fn(() => new Promise<void>(() => {}));
    const transportClose = vi.fn(() => new Promise<void>(() => {}));
    const pending = probeLinearMcp(
      {
        url: "https://mcp.linear.app/mcp",
        token: "bearer-secret",
        timeoutMs: 1_000,
      },
      {
        timeoutSignal,
        createClient: () => ({
          connect: () => new Promise<void>(() => {}),
          listTools: vi.fn(),
          close: clientClose,
        }),
        createTransport: () =>
          ({
            start: vi.fn(),
            send: vi.fn(),
            close: transportClose,
          }) as unknown as Transport & { close(): Promise<void> },
      },
    );
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(deadlines).toHaveLength(1);
    deadlines[0]!.abort(
      Object.assign(new Error("operation timeout bearer-secret"), {
        name: "TimeoutError",
      }),
    );
    await vi.waitFor(() => {
      expect(clientClose).toHaveBeenCalledOnce();
      expect(transportClose).toHaveBeenCalledOnce();
      expect(deadlines).toHaveLength(2);
    });
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    deadlines[1]!.abort(
      Object.assign(new Error("cleanup timeout bearer-secret"), {
        name: "TimeoutError",
      }),
    );
    const error = await outcome;
    expect(error).toMatchObject({
      name: "LinearMcpCleanupTimeoutError",
      code: "LINEAR_MCP_CLEANUP_TIMEOUT",
    });
    expect(normalizeLinearMcpError(error)).toEqual({
      category: "timeout",
      code: "cleanup_timeout",
    });
    expect(JSON.stringify(normalizeLinearMcpError(error))).not.toContain(
      "bearer-secret",
    );
  });
});

describe("LinearMcpMonitor", () => {
  it("tracks failures, retries, recovery, transitions, and durations", async () => {
    let time = 100;
    const logger = { log: vi.fn(), error: vi.fn() };
    const outcomes = [
      Object.assign(new Error("request included bearer-secret"), {
        code: "ECONNREFUSED",
      }),
      Object.assign(new Error("still bearer-secret"), { code: 401 }),
      undefined,
    ];
    const monitor = new LinearMcpMonitor({
      url: "https://mcp.linear.app/mcp",
      token: "bearer-secret",
      intervalMs: 60_000,
      timeoutMs: 1_000,
      now: () => time,
      logger,
      probe: async () => {
        time += 25;
        const outcome = outcomes.shift();
        if (outcome) throw outcome;
      },
    });

    monitor.start();
    await monitor.trigger();
    expect(monitor.snapshot()).toEqual({
      state: "unhealthy",
      consecutiveFailures: 1,
      retryCount: 1,
    });
    await monitor.trigger();
    expect(monitor.snapshot().consecutiveFailures).toBe(2);
    await monitor.trigger();
    expect(monitor.snapshot()).toEqual({
      state: "healthy",
      consecutiveFailures: 0,
      retryCount: 0,
    });
    await monitor.stop();

    const first = logged(logger.error.mock.calls[0]!);
    const second = logged(logger.error.mock.calls[1]!);
    const recovered = logged(logger.log.mock.calls[0]!);
    expect(first).toMatchObject({
      previousState: "unknown",
      state: "unhealthy",
      transitioned: true,
      consecutiveFailures: 1,
      retryCount: 1,
      durationMs: 25,
      errorCategory: "transport",
      errorCode: "econnrefused",
    });
    expect(second).toMatchObject({
      previousState: "unhealthy",
      transitioned: false,
      consecutiveFailures: 2,
      errorCategory: "authentication",
      errorCode: "http_401",
    });
    expect(recovered).toMatchObject({
      previousState: "unhealthy",
      state: "healthy",
      transitioned: true,
      durationMs: 25,
    });
    expect(JSON.stringify([...logger.log.mock.calls, ...logger.error.mock.calls]))
      .not.toContain("bearer-secret");
  });

  it("does not overlap probes and aborts an active probe on stop without logging an outage", async () => {
    let scheduled: (() => void) | undefined;
    const clearInterval = vi.fn();
    const scheduler: LinearMcpScheduler = {
      setInterval: (callback) => {
        scheduled = callback;
        return "timer";
      },
      clearInterval,
    };
    const logger = { log: vi.fn(), error: vi.fn() };
    let calls = 0;
    const monitor = new LinearMcpMonitor({
      url: "https://mcp.linear.app/mcp",
      token: "secret",
      intervalMs: 10,
      timeoutMs: 1_000,
      scheduler,
      logger,
      probe: ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          calls += 1;
          signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })),
            { once: true },
          );
        }),
    });

    monitor.start();
    const first = monitor.trigger();
    scheduled?.();
    expect(calls).toBe(1);
    await monitor.stop();
    await first;
    expect(clearInterval).toHaveBeenCalledWith("timer");
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps cleanup in flight, then blocks later probes after cleanup timeout", async () => {
    const deadlines: AbortController[] = [];
    const timeoutSignal = () => {
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    };
    let scheduled: (() => void) | undefined;
    const scheduler: LinearMcpScheduler = {
      setInterval: (callback) => {
        scheduled = callback;
        return "timer";
      },
      clearInterval: vi.fn(),
    };
    const logger = { log: vi.fn(), error: vi.fn() };
    const clientClose = vi.fn(() => new Promise<void>(() => {}));
    const transportClose = vi.fn(() => new Promise<void>(() => {}));
    const createClient = vi.fn(() => ({
      connect: () => new Promise<void>(() => {}),
      listTools: vi.fn(),
      close: clientClose,
    }));
    const monitor = new LinearMcpMonitor({
      url: "https://mcp.linear.app/mcp",
      token: "bearer-secret",
      intervalMs: 10,
      timeoutMs: 1_000,
      scheduler,
      logger,
      probe: (input) =>
        probeLinearMcp(input, {
          timeoutSignal,
          createClient,
          createTransport: () =>
            ({
              start: vi.fn(),
              send: vi.fn(),
              close: transportClose,
            }) as unknown as Transport & { close(): Promise<void> },
        }),
    });

    monitor.start();
    const first = monitor.trigger();
    expect(createClient).toHaveBeenCalledOnce();
    deadlines[0]!.abort(
      Object.assign(new Error("operation timeout bearer-secret"), {
        name: "TimeoutError",
      }),
    );
    await vi.waitFor(() => expect(deadlines).toHaveLength(2));

    expect(monitor.trigger()).toBe(first);
    scheduled?.();
    expect(createClient).toHaveBeenCalledOnce();
    expect(clientClose).toHaveBeenCalledOnce();
    expect(transportClose).toHaveBeenCalledOnce();

    deadlines[1]!.abort(
      Object.assign(new Error("cleanup timeout bearer-secret"), {
        name: "TimeoutError",
      }),
    );
    await first;
    expect(logged(logger.error.mock.calls[0]!)).toMatchObject({
      errorCategory: "timeout",
      errorCode: "cleanup_timeout",
    });
    await monitor.trigger();
    scheduled?.();
    expect(createClient).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "bearer-secret",
    );
    await monitor.stop();
  });
});

describe("normalizeLinearMcpError", () => {
  it("returns bounded categories and never reflects raw error text", () => {
    expect(
      normalizeLinearMcpError(
        Object.assign(new Error("token=secret response body"), {
          name: "McpError",
          code: -32603,
        }),
      ),
    ).toEqual({ category: "protocol", code: "mcp_protocol" });
    expect(
      normalizeLinearMcpError(new Error("token=secret response body")),
    ).toEqual({ category: "unknown", code: "unknown" });
  });
});
