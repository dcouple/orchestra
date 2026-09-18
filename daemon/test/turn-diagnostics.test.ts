import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_LIMIT, TurnDiagnostics, sanitizeDiagnostic } from "../src/turn-diagnostics.js";

const env = {
  CLIPROXY_API_KEY: "proxy-secret",
  LINEAR_API_KEY: "linear-secret",
  GH_TOKEN: "github-secret",
  ARTIFACT_HOST_TOKEN: "artifact-secret",
};

describe("turn diagnostics", () => {
  it("redacts every owned secret before truncation, strips ANSI, and treats values literally", () => {
    const values = { ...env, GH_TOKEN: "gh.$[token]" };
    const text = `\u001b[31m${Object.values(values).join(" ")}\u001b[0m ${"🌱".repeat(2048)}`;
    const clean = sanitizeDiagnostic(text, values);
    expect(clean).not.toContain("\u001b");
    for (const value of Object.values(values)) expect(clean).not.toContain(value);
    expect(clean).toContain("[REDACTED]");
    expect(clean).not.toContain("�");
    expect(Buffer.byteLength(clean)).toBeLessThanOrEqual(DIAGNOSTIC_LIMIT);
  });
  it("retains the error prefix and bounded stderr tail, including split UTF-8 and split secrets", () => {
    const diagnostics = new TurnDiagnostics(env);
    diagnostics.error(`API Error: 400 ${env.CLIPROXY_API_KEY} ${"x".repeat(4000)}`);
    diagnostics.appendStderr(Buffer.from("noise ".repeat(4000)));
    const tail = Buffer.from(`\u001b[31m${Object.values(env).join(" ")} 🌱 final stderr\u001b[0m`);
    for (const byte of tail) diagnostics.appendStderr(Buffer.from([byte]));
    const text = diagnostics.text!;
    expect(text).toMatch(/^API Error: 400 \[REDACTED\]/);
    expect(text).toContain("🌱 final stderr");
    expect(text).not.toContain("\u001b");
    for (const value of Object.values(env)) expect(text).not.toContain(value);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DIAGNOSTIC_LIMIT);
  });
  it("does not expose a retained suffix when clipping through a secret", () => {
    const secret = "secret-value-".repeat(1000);
    const diagnostics = new TurnDiagnostics({ GH_TOKEN: secret });
    diagnostics.appendStderr(Buffer.from(secret + "x".repeat(9000)));
    expect(diagnostics.text).not.toContain("secret-value-");
    expect(Buffer.byteLength(diagnostics.text!)).toBeLessThanOrEqual(DIAGNOSTIC_LIMIT);
  });
});
