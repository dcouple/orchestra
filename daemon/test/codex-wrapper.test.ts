import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const wrapper = resolve("ops/codex-otel-wrapper.sh");
const owner = "a0000000-0000-0000-0000-000000000001";
const traceparent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
const relay = "http://127.0.0.1:4321/capability/v1/traces";

afterEach(() => {
  for (const directory of dirs.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const poll = (): void => {
      if (predicate()) {
        resolvePromise();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function setup(
  role = "backend-verifier",
  output = [
    '{"type":"thread.started","thread_id":"thread-1"}',
    '{"type":"turn.completed","turn_id":"turn-2","usage":{"total_tokens":42}}',
  ],
): {
  root: string;
  dispatch: string;
  report: string;
  prompt: string;
  log: string;
  fake: string;
  capture: string;
  childExit: string;
} {
  const root = mkdtempSync(join(tmpdir(), "codex-wrapper-"));
  dirs.push(root);
  const dispatch = join(root, ".codex-dispatches", owner);
  mkdirSync(dispatch, { recursive: true });
  const basename = `${role}-1700000000-1234-7`;
  const report = join(dispatch, `${basename}.md`);
  const prompt = join(dispatch, `${basename}.prompt`);
  const log = join(dispatch, `${basename}.log`);
  const capture = join(root, "capture.json");
  const childExit = join(root, "child-exit");
  writeFileSync(report, "safe report\n");
  writeFileSync(prompt, "safe prompt\n");
  writeFileSync(log, "safe log\n");
  const fake = join(root, "real-codex");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
node - "$ORCHESTRA_TEST_CAPTURE" "$@" <<'NODE'
const fs = require("fs");
const keys = [
  "TRACEPARENT", "TRACESTATE", "BAGGAGE", "OTEL_RESOURCE_ATTRIBUTES", "OTEL_PROPAGATORS",
  "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_HEADERS", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "ORCHESTRA_SELECTED_ACCOUNT", "CODEX_PROXY_ACCOUNT", "CLIPROXYAPI_ACCOUNT", "CLIPROXYAPI_API_KEY",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "ORCHESTRA_OTEL_RELAY_ENDPOINT", "ORCHESTRA_DISPATCH_OWNER",
];
const env = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
fs.writeFileSync(process.argv[2], JSON.stringify({ env, argv: process.argv.slice(3) }));
NODE
${output.map((line) => `printf '%s\\n' '${line}'`).join("\n")}
`,
  );
  chmodSync(fake, 0o755);
  return { root, dispatch, report, prompt, log, fake, capture, childExit };
}

function daemonEnv(
  value: ReturnType<typeof setup>,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ORCHESTRA_CODEX_REAL_BIN: value.fake,
    ORCHESTRA_DISPATCH_OWNER: owner,
    ORCHESTRA_OTEL_RELAY_ENDPOINT: relay,
    ORCHESTRA_TEST_CAPTURE: value.capture,
    TRACEPARENT: traceparent,
    TRACESTATE: "foreign=trace",
    BAGGAGE: "account=selected-user",
    OTEL_RESOURCE_ATTRIBUTES: "selected.account=raw-user",
    OTEL_PROPAGATORS: "baggage,tracecontext",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://attacker.invalid/common",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=common-secret",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=trace-secret",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://attacker.invalid/logs",
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=log-secret",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "grpc",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://attacker.invalid/metrics",
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: "authorization=metric-secret",
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "grpc",
    ORCHESTRA_SELECTED_ACCOUNT: "raw-selected-account",
    CODEX_PROXY_ACCOUNT: "proxy-account",
    CLIPROXYAPI_ACCOUNT: "proxy-selected",
    CLIPROXYAPI_API_KEY: "proxy-secret",
    HTTP_PROXY: "http://proxy-user:proxy-password@attacker.invalid",
    HTTPS_PROXY: "http://proxy-user:proxy-password@attacker.invalid",
    ALL_PROXY: "socks5://attacker.invalid",
    ...extra,
  };
}

function sidecar(value: ReturnType<typeof setup>): Record<string, unknown> {
  return JSON.parse(
    readFileSync(value.report.replace(/\.md$/, ".otel.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("Codex OTel wrapper", () => {
  it("parses a hyphenated ephemeral role, mints ancestry, strips every escape override, and writes a 900-second terminal sidecar", () => {
    const value = setup("backend-verifier");
    const result = spawnSync(
      "bash",
      [wrapper, "exec", "-o", value.report, "safe-user-prompt"],
      {
        cwd: value.root,
        encoding: "utf8",
        env: daemonEnv(value),
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("tokens used\n42");
    const record = sidecar(value);
    expect(record).toMatchObject({
      state: "terminal",
      owner,
      basename: "backend-verifier-1700000000-1234-7",
      role: "backend-verifier",
      provider_session_id: "thread-1",
      provider_turn_id: "turn-2",
      cumulative_tokens: 42,
      mode: "fresh",
      parse_status: "ok",
    });
    expect(Number(record.deadline_at) - Number(record.started_at)).toBe(
      900_000,
    );
    expect(record.dispatch_span_id).toMatch(/^[0-9a-f]{16}$/);

    const captured = JSON.parse(readFileSync(value.capture, "utf8")) as {
      env: Record<string, string | null>;
      argv: string[];
    };
    expect(captured.env.TRACEPARENT).toMatch(/^00-a{32}-[0-9a-f]{16}-01$/);
    expect(captured.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(relay);
    expect(captured.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL).toBe(
      "http/protobuf",
    );
    for (const [key, environmentValue] of Object.entries(captured.env)) {
      if (
        [
          "TRACEPARENT",
          "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
          "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
        ].includes(key)
      )
        continue;
      expect(environmentValue, key).toBeNull();
    }
    expect(captured.argv.at(-1)).toBe("--json");
    const boundaryEvidence = [
      result.stdout,
      result.stderr,
      JSON.stringify(record),
      JSON.stringify(captured),
      readFileSync(value.prompt, "utf8"),
      readFileSync(value.report, "utf8"),
      readFileSync(value.log, "utf8"),
    ].join("\n");
    for (const forbidden of [
      "common-secret",
      "trace-secret",
      "log-secret",
      "metric-secret",
      "proxy-secret",
      "raw-selected-account",
      "selected-user",
      "foreign=trace",
      "attacker.invalid",
      "proxy-password",
    ]) {
      expect(boundaryEvidence).not.toContain(forbidden);
    }
  });

  it("uses 2700 seconds only for implementer and preserves resume identity and cumulative usage", () => {
    const value = setup("implementer");
    const result = spawnSync(
      "bash",
      [wrapper, "exec", "resume", "thread-1", "-o", value.report, "safe"],
      {
        cwd: value.root,
        encoding: "utf8",
        env: daemonEnv(value),
      },
    );
    expect(result.status).toBe(0);
    const record = sidecar(value);
    expect(record).toMatchObject({
      role: "implementer",
      mode: "resume",
      provider_session_id: "thread-1",
      cumulative_tokens: 42,
    });
    expect(Number(record.deadline_at) - Number(record.started_at)).toBe(
      2_700_000,
    );
  });

  it("records malformed JSON as a terminal unknown parse without leaking its capture", () => {
    const value = setup("researcher", [
      "not-json",
      '{"type":"turn.completed","turn_id":"turn-only"}',
    ]);
    const result = spawnSync(
      "bash",
      [wrapper, "exec", "-o", value.report, "safe"],
      {
        cwd: value.root,
        encoding: "utf8",
        env: daemonEnv(value),
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("not-json");
    expect(sidecar(value)).toMatchObject({
      state: "terminal",
      parse_status: "unknown",
      provider_session_id: null,
      provider_turn_id: "turn-only",
      cumulative_tokens: null,
    });
  });

  for (const [signal, status] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
    ["SIGALRM", 142],
  ] as const) {
    it(`forwards ${signal} to the real child and atomically terminalizes the sidecar`, async () => {
      const value = setup("reviewer", []);
      writeFileSync(
        value.fake,
        `#!/usr/bin/env node
const fs = require("fs");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGALRM"]) {
  process.on(signal, () => {
    fs.writeFileSync(process.env.ORCHESTRA_TEST_CHILD_EXIT, signal);
    process.exit(0);
  });
}
fs.writeFileSync(process.env.ORCHESTRA_TEST_CAPTURE, "started");
setInterval(() => {}, 1_000);
`,
      );
      chmodSync(value.fake, 0o755);
      const child = spawn(
        "bash",
        [wrapper, "exec", "-o", value.report, "safe"],
        {
          cwd: value.root,
          env: daemonEnv(value, { ORCHESTRA_TEST_CHILD_EXIT: value.childExit }),
          stdio: "ignore",
        },
      );
      await waitFor(
        () =>
          existsSync(value.capture) &&
          existsSync(value.report.replace(/\.md$/, ".otel.json")),
      );
      expect(sidecar(value).state).toBe("running");
      child.kill(signal);
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolvePromise) => {
        child.once("close", (code, closeSignal) =>
          resolvePromise({ code, signal: closeSignal }),
        );
      });
      expect(result).toEqual({ code: status, signal: null });
      await waitFor(() => existsSync(value.childExit));
      expect(sidecar(value)).toMatchObject({
        state: "terminal",
        exit_code: status,
        parse_status: `signal:${signal.slice(3)}`,
      });
    });
  }

  it("rejects traversal, malformed dispatch names, and invalid owners into telemetry-free local passthrough", () => {
    const value = setup("researcher");
    const outside = join(value.root, "outside.md");
    writeFileSync(outside, "safe");
    const result = spawnSync("bash", [wrapper, "exec", "-o", outside, "safe"], {
      cwd: value.root,
      encoding: "utf8",
      env: daemonEnv(value, { ORCHESTRA_DISPATCH_OWNER: "../../escape" }),
    });
    expect(result.status).toBe(0);
    const captured = JSON.parse(readFileSync(value.capture, "utf8")) as {
      env: Record<string, string | null>;
      argv: string[];
    };
    expect(captured.argv).not.toContain("--json");
    expect(
      Object.values(captured.env).every(
        (environmentValue) => environmentValue === null,
      ),
    ).toBe(true);
    expect(existsSync(outside.replace(/\.md$/, ".otel.json"))).toBe(false);
  });

  it("passes a local non-dispatch invocation once and prevents wrapper recursion", () => {
    const value = setup("researcher");
    const local = spawnSync("bash", [wrapper, "--version"], {
      cwd: value.root,
      encoding: "utf8",
      env: {
        ...process.env,
        ORCHESTRA_CODEX_REAL_BIN: value.fake,
        ORCHESTRA_TEST_CAPTURE: value.capture,
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://local.example/v1/traces",
      },
    });
    expect(local.status).toBe(0);
    const captured = JSON.parse(readFileSync(value.capture, "utf8")) as {
      argv: string[];
      env: Record<string, string | null>;
    };
    expect(captured.argv).toEqual(["--version"]);
    expect(captured.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      "https://local.example/v1/traces",
    );
    const recursive = spawnSync("bash", [wrapper, "--version"], {
      cwd: value.root,
      encoding: "utf8",
      env: { ...process.env, ORCHESTRA_CODEX_REAL_BIN: wrapper },
    });
    expect(recursive.status).toBe(127);
    expect(recursive.stderr).toContain("real binary unavailable");
  });

  it("provisioning pins the real binary and installs the wrapper byte-identically on rerun", () => {
    const source = readFileSync(resolve("ops/provision.sh"), "utf8");
    expect(source).toContain("/opt/pnpm/bin/codex --version");
    expect(source).toContain(
      'install -m 0755 "${SOURCE_DIR}/ops/codex-otel-wrapper.sh" /usr/local/bin/codex',
    );
    const value = setup("researcher");
    const installed = join(value.root, "installed-codex");
    const install = (): string => {
      expect(
        spawnSync("install", ["-m", "0755", wrapper, installed]).status,
      ).toBe(0);
      return createHash("sha256").update(readFileSync(installed)).digest("hex");
    };
    expect(install()).toBe(install());
    expect(readFileSync(installed)).toEqual(readFileSync(wrapper));
  });
});
