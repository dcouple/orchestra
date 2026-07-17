import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhook } from "../src/verify.js";

const secret = "secret";
const now = 1_700_000_000_000;
const sign = (body: Buffer, key = secret) => createHmac("sha256", key).update(body).digest("hex");

describe("verifyWebhook", () => {
  it("accepts a valid signed fresh payload", () => {
    const body = Buffer.from(JSON.stringify({ webhookTimestamp: now }));
    expect(verifyWebhook(body, sign(body), secret, now, 60_000)).toEqual({ ok: true, payload: { webhookTimestamp: now } });
  });

  it.each([
    ["tampered body", Buffer.from(JSON.stringify({ webhookTimestamp: now, changed: true })), "0".repeat(64), "signature"],
    ["wrong secret", Buffer.from(JSON.stringify({ webhookTimestamp: now })), "wrong", "signature"],
    ["missing signature", Buffer.from(JSON.stringify({ webhookTimestamp: now })), undefined, "signature"],
    ["non-hex signature", Buffer.from(JSON.stringify({ webhookTimestamp: now })), "z".repeat(64), "signature"],
  ])("rejects %s", (_name, body, signatureOrKey, reason) => {
    const signature = signatureOrKey === "wrong" ? sign(body as Buffer, "wrong") : signatureOrKey as string | undefined;
    expect(verifyWebhook(body as Buffer, signature, secret, now, 60_000)).toEqual({ ok: false, reason });
  });

  it.each([
    ["malformed JSON", Buffer.from("{"), "malformed"],
    ["missing timestamp", Buffer.from("{}"), "timestamp"],
    ["string timestamp", Buffer.from(JSON.stringify({ webhookTimestamp: String(now) })), "timestamp"],
    ["null timestamp", Buffer.from(JSON.stringify({ webhookTimestamp: null })), "timestamp"],
    ["stale timestamp", Buffer.from(JSON.stringify({ webhookTimestamp: now - 60_001 })), "timestamp"],
    ["future timestamp", Buffer.from(JSON.stringify({ webhookTimestamp: now + 60_001 })), "timestamp"],
  ])("rejects %s", (_name, body, reason) => {
    expect(verifyWebhook(body, sign(body), secret, now, 60_000)).toEqual({ ok: false, reason });
  });
});
