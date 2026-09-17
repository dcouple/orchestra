import { describe, expect, it } from "vitest";
import { canonicalJson, parseOperationRequest, redactedSummary, requestDigest, validateDraftInput } from "../src/console-operation-schema.js";
import { parseManagedEnv, renderManagedEnv, shellLiteral } from "../src/managed-env.js";

describe("console operation schema and managed environment", () => {
  it("canonicalizes closed requests and never projects secret values", () => {
    const input = validateDraftInput({ kind: "config.apply", reason: "rotate", changes: { plannerHarness: "claudex" },
      secrets: { LINEAR_API_KEY: "SECRET_SENTINEL" } });
    const request = parseOperationRequest({ version: 1, kind: input.kind, snapshotRevision: "revision_123456789",
      changes: input.changes, secrets: input.secrets });
    expect(requestDigest(request)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(JSON.stringify(redactedSummary(request))).not.toContain("SECRET_SENTINEL");
    expect(() => parseOperationRequest({ ...request, executable: "/bin/sh" })).toThrow("unknown_field");
  });

  it("round-trips adversarial values as literal shell data and rejects dynamic input", () => {
    const original = "# retained\nexport PLANNER_HARNESS=claude\nUNRELATED='literal'\n";
    const value = "spaces ' quotes \\ $() `cmd` * # ;";
    const rendered = renderManagedEnv(parseManagedEnv(original), { PLANNER_HARNESS: "claudex", NTFY_URL: value });
    expect(parseManagedEnv(rendered).values).toMatchObject({ PLANNER_HARNESS: "claudex", NTFY_URL: value, UNRELATED: "literal" });
    expect(shellLiteral(value)).toContain("'\\''");
    expect(rendered).toContain("# retained\n");
    expect(() => parseManagedEnv("A=$(id)\n")).toThrow("unsupported_env_syntax");
    expect(() => parseManagedEnv("A=one\nA=two\n")).toThrow("duplicate_env_key");
  });
});
