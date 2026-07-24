import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import {
  appendTurn,
  opsFixture,
  readNumber,
  stageMain,
  updateRepo,
} from "./operations-fixtures.js";

function runningFixture() {
  const fixture = opsFixture();
  const log = new EventLog(fixture.db);
  appendTurn(log, "running", "OPS-RUNNING");
  log.claimNextTurn(Date.now() - 5_000);
  log.close();
  return fixture;
}

describe("busy public operations execute immediately", () => {
  it("claims a busy restart straight through execution without polling for idle", () => {
    const f = runningFixture();
    const result = f.run(["restart"]);
    expect(result.status, result.stderr).toBe(0);
    expect(readNumber(f.restartCount)).toBe(1);
    expect(existsSync(join(f.dir, "sleep.log"))).toBe(false);
    const log = new EventLog(f.db);
    expect(log.operationStatus().lastOutcome).toMatchObject({
      type: "restart",
      state: "succeeded",
      stage: "accepted",
    });
    log.close();
  });

  it("applies a busy config immediately", () => {
    const f = runningFixture();
    const result = f.run([
      "config",
      "--planner",
      "claudex",
      "--implementer",
      "claudex",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.envFile, "utf8")).toContain(
      "PLANNER_HARNESS=claudex",
    );
    expect(readNumber(f.restartCount)).toBe(1);
    expect(existsSync(join(f.dir, "sleep.log"))).toBe(false);
  });

  it("provisions a busy reload immediately", () => {
    const f = runningFixture();
    const repo = updateRepo(f);
    stageMain(repo);
    const result = f.run(["reload"], repo.env);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.main);
    expect(readNumber(f.restartCount)).toBe(1);
    expect(existsSync(join(f.dir, "sleep.log"))).toBe(false);
  }, 15_000);

  it("parks a coherent busy config failure and releases the claim gate", () => {
    const f = runningFixture();
    writeFileSync(join(f.dir, "health.failures"), "1\n");
    const result = f.run([
      "config",
      "--planner",
      "claudex",
      "--implementer",
      "claudex",
    ]);
    expect(result.status).not.toBe(0);
    const log = new EventLog(f.db);
    expect(log.operationStatus().lastOutcome).toMatchObject({
      type: "config",
      state: "failed",
      recoveryCommand: expect.stringContaining("operation retry"),
    });
    appendTurn(log, "queued", "OPS-QUEUED");
    expect(log.claimNextTurn()).toMatchObject({ issueId: "issue-queued" });
    log.close();
  });
});
