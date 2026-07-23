import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AckWorker } from "../src/ack.js";
import type { Config } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import { LinearGateway } from "../src/linear.js";
import { WebhookServer } from "../src/server.js";
import { appendTurn, opsFixture, readNumber } from "./operations-fixtures.js";

describe("operation drain through signed webhook ingress", () => {
  it("AC8 acknowledges a valid webhook while drained, persists its turn, and starts it only after public executor acceptance", async () => {
    const f = opsFixture();
    let log = new EventLog(f.db);
    appendTurn(log, "running-ingress", "OPS-INGRESS-RUNNING");
    const running = log.claimNextTurn(Date.now() - 2_000)!;
    log.close();
    expect(f.run(["restart"]).status).toBe(0);
    expect(readNumber(f.restartCount)).toBe(0);

    const gatewayRequests: Array<Record<string, unknown>> = [];
    const gatewayServer = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        gatewayRequests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { agentActivityCreate: { success: true, lastSyncId: 1, agentActivity: { id: "ack" } } } }));
      });
    });
    await new Promise<void>(resolveListen => gatewayServer.listen(0, "127.0.0.1", resolveListen));
    const gatewayPort = (gatewayServer.address() as { port: number }).port;
    const cliproxyEnvFile = join(f.dir, "ingress-proxy.env");
    writeFileSync(cliproxyEnvFile, "CLIPROXY_MANAGEMENT_KEY=ingress-management-secret\n");
    log = new EventLog(f.db);
    log.markAcked(log.ackStates()[0]!.eventId);
    const config: Config = {
      port: 0,
      bindAddr: "127.0.0.1",
      dbPath: f.db,
      dispatchQuarantineDir: join(f.dir, "dispatch-quarantine"),
      dispatchQuarantineAgeMs: 86_400_000,
      replayWindowMs: 60_000,
      linearGraphqlUrl: `http://127.0.0.1:${gatewayPort}/graphql`,
      linearTokenUrl: "http://unused",
      cliproxyEnvFile,
      apps: {
        planner: { name: "planner", webhookSecret: "drain-webhook-secret", staticToken: "planner-token" },
        implementer: { name: "implementer", webhookSecret: "implementer-secret", staticToken: "implementer-token" },
      },
    };
    const gateway = new LinearGateway(log, config.apps, config.linearGraphqlUrl, config.linearTokenUrl);
    const worker = new AckWorker(log, gateway, { pollMs: 10, reconcileMs: 100, attemptTimeoutMs: 500 });
    const server = new WebhookServer({ config, log, onInserted: () => worker.trigger(), logger: { log: vi.fn(), error: vi.fn() } });
    worker.start();
    try {
      const address = await server.listen();
      const body = JSON.stringify({
        webhookTimestamp: Date.now(), webhookId: "drain-webhook", action: "created",
        agentSession: { id: "session-drained-webhook", issue: { id: "issue-drained-webhook", identifier: "OPS-WEBHOOK" } },
      });
      const signature = createHmac("sha256", "drain-webhook-secret").update(body).digest("hex");
      const response = await fetch(`http://127.0.0.1:${address.port}/webhook/planner`, {
        method: "POST",
        headers: { "Linear-Signature": signature, "Linear-Delivery": "drain-delivery" },
        body,
      });
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(gatewayRequests).toHaveLength(1));
      expect(log.ackStates()).toContainEqual(expect.objectContaining({ status: "acked", attempts: 1 }));
      expect(JSON.stringify(gatewayRequests[0])).toContain("session-drained-webhook");
      expect(log.count()).toBe(2);
      expect(log.turnStates()).toContainEqual(expect.objectContaining({ issueId: "issue-drained-webhook", status: "pending" }));
      expect(log.claimNextTurn()).toBeUndefined();
      expect(log.turnStates()).toContainEqual(expect.objectContaining({ id: running.id, status: "running" }));

      log.finishTurn(running.id, "response", "completed");
      expect(log.claimNextTurn()).toBeUndefined();
      expect(f.run(["internal-execute"]).status).toBe(0);
      expect(readNumber(f.restartCount)).toBe(1);
      expect(log.operationStatus().lastOutcome).toMatchObject({ type: "restart", state: "succeeded", stage: "accepted" });
      expect(log.claimNextTurn()).toMatchObject({ issueId: "issue-drained-webhook", status: "running" });
    } finally {
      await worker.stop();
      await server.close();
      log.close();
      await new Promise<void>(resolveClose => gatewayServer.close(() => resolveClose()));
    }
  }, 15_000);
});
