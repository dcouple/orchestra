import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookPayload = Record<string, unknown>;
export type VerificationResult =
  | { ok: true; payload: WebhookPayload }
  | { ok: false; reason: "signature" | "timestamp" | "malformed" };

export function verifyWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  nowMs: number,
  replayWindowMs: number,
): VerificationResult {
  try {
    const signature = signatureHeader ?? "";
    if (!/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, reason: "signature" };
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    const actual = Buffer.from(signature, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { ok: false, reason: "signature" };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody.toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "malformed" };
    }
    const payload = parsed as WebhookPayload;
    const timestamp = payload.webhookTimestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || Math.abs(nowMs - timestamp) > replayWindowMs) {
      return { ok: false, reason: "timestamp" };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
