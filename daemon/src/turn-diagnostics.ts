import { stripVTControlCharacters } from "node:util";
import { StringDecoder } from "node:string_decoder";

const SECRET_KEYS = ["CLIPROXY_API_KEY", "LINEAR_API_KEY", "GH_TOKEN", "ARTIFACT_HOST_TOKEN"] as const;
export const DIAGNOSTIC_LIMIT = 2048;

function secrets(envs: (NodeJS.ProcessEnv | undefined)[]): string[] {
  return [...new Set([process.env, ...envs].flatMap(env =>
    SECRET_KEYS.map(key => env?.[key]).filter((value): value is string => !!value)))]
    .sort((a, b) => b.length - a.length);
}

function bound(value: string, limit: number, tail = false): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return value;
  if (tail) {
    let start = bytes.length - limit;
    while ((bytes[start]! & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  }
  let end = limit;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function redact(value: string, values: string[]): string {
  let clean = stripVTControlCharacters(value);
  for (const secret of values) clean = clean.split(secret).join("[REDACTED]");
  return clean;
}

export function sanitizeDiagnostic(value: string, ...envs: (NodeJS.ProcessEnv | undefined)[]): string {
  return bound(redact(value, secrets(envs)), DIAGNOSTIC_LIMIT);
}

// Capture diagnostics separately: raw stderr and capacity evidence keep their
// existing classification semantics and never become externally visible here.
export class TurnDiagnostics {
  private readonly values: string[];
  private readonly decoder = new StringDecoder("utf8");
  private readonly retention: number;
  private harnessError = "";
  private stderr = "";
  private clipped = false;

  constructor(...envs: (NodeJS.ProcessEnv | undefined)[]) {
    this.values = secrets(envs);
    this.retention = 8192 + (this.values[0]?.length ?? 0);
  }

  error(message: string): void {
    this.harnessError = bound(redact(message, this.values), 1024);
  }

  appendStderr(chunk: Buffer): void {
    this.stderr += this.decoder.write(chunk);
    if (this.stderr.length > this.retention) {
      this.stderr = this.stderr.slice(-this.retention);
      this.clipped = true;
    }
  }

  get text(): string | undefined {
    let stderr = stripVTControlCharacters(this.stderr);
    // If retention cut through a secret, remove its remaining suffix before
    // redaction and the final byte cap. Complete values are redacted first.
    if (this.clipped) for (const secret of this.values) {
      for (let start = 1; start < secret.length; start++) {
        if (stderr.startsWith(secret.slice(start))) {
          stderr = "[REDACTED]" + stderr.slice(secret.length - start);
          break;
        }
      }
    }
    stderr = bound(redact(stderr, this.values), this.harnessError ? 1000 : 2000, true);
    return [this.harnessError, stderr ? `stderr:\n${stderr}` : ""].filter(Boolean).join("\n") || undefined;
  }
}

export function harnessErrorText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value
    && typeof value.message === "string") return value.message;
  return undefined;
}
