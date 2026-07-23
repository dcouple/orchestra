import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import { appendTurn, git, opsFixture, readNumber, stageMain, updateRepo } from "./operations-fixtures.js";

function runningFixture(identifier = "OPS-RUNNING") {
  const fixture = opsFixture();
  const log = new EventLog(fixture.db);
  appendTurn(log, "running", identifier);
  const running = log.claimNextTurn(Date.now() - 5_000)!;
  log.close();
  return { fixture, running };
}

function assertBusyDrain(db: string, type: "restart" | "config" | "update", runningId: number): void {
  const log = new EventLog(db);
  expect(log.activeOperation()).toMatchObject({ type, state: "pending" });
  expect(log.turnStates()).toContainEqual(expect.objectContaining({ id: runningId, status: "running" }));
  appendTurn(log, `queued-${type}`, `OPS-${type.toUpperCase()}-QUEUED`);
  expect(log.claimNextTurn()).toBeUndefined();
  expect(log.turnStates()).toContainEqual(expect.objectContaining({ issueId: `issue-queued-${type}`, status: "pending" }));
  log.close();
}

describe("busy public operation drain and executor", () => {
  it("AC7 persists restart while a durable turn remains running and leaves new work pending", () => {
    const { fixture: f, running } = runningFixture();
    const result = f.run(["restart"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("running turns: 1");
    expect(readNumber(f.restartCount)).toBe(0);
    assertBusyDrain(f.db, "restart", running.id);
  });

  it("AC7/AC9 drains busy config, survives an apply crash, accepts exactly one restart, then releases queued work", () => {
    const { fixture: f, running } = runningFixture();
    const original = readFileSync(f.envFile, "utf8");
    const scheduled = f.run(["config", "--planner", "claudex", "--implementer", "claudex"]);
    expect(scheduled.status).toBe(0);
    expect(readFileSync(f.envFile, "utf8")).toBe(original);
    expect(readNumber(f.restartCount)).toBe(0);
    assertBusyDrain(f.db, "config", running.id);

    let log = new EventLog(f.db);
    log.finishTurn(running.id, "response", "completed");
    log.close();
    const crashed = f.run(["internal-execute"], { DAEMONCTL_FAULT_AFTER: "replace_environment" });
    expect(crashed.status).toBe(99);
    expect(readNumber(f.restartCount)).toBe(0);
    log = new EventLog(f.db);
    expect(log.claimNextTurn()).toBeUndefined();
    expect(log.activeOperation()).toMatchObject({ type: "config", state: "executing", stage: "replace_environment" });
    log.close();

    expect(f.run(["internal-execute"]).status).toBe(0);
    expect(readNumber(f.restartCount)).toBe(1);
    expect(readFileSync(f.envFile, "utf8")).toContain("PLANNER_HARNESS=claudex");
    log = new EventLog(f.db);
    expect(log.operationStatus().lastOutcome).toMatchObject({ type: "config", state: "succeeded", stage: "accepted" });
    expect(log.claimNextTurn()).toMatchObject({ issueId: "issue-queued-config", status: "running" });
    log.close();
  }, 15_000);

  it("AC7/AC9 drains busy update, resumes after provision crash without replay, accepts health, and only then releases work", () => {
    const { fixture: f, running } = runningFixture();
    const repo = updateRepo(f);
    stageMain(repo);
    const scheduled = f.run(["reload"], repo.env);
    expect(scheduled.status).toBe(0);
    expect(git(["rev-parse", "HEAD"], repo.checkout)).toBe(repo.main);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.accepted);
    expect(existsSync(f.provisionLog)).toBe(false);
    expect(readNumber(f.restartCount)).toBe(0);
    assertBusyDrain(f.db, "update", running.id);

    let log = new EventLog(f.db);
    log.finishTurn(running.id, "response", "completed");
    log.close();
    expect(f.run(["internal-execute"], { ...repo.env, DAEMONCTL_FAULT_AFTER: "provision" }).status).toBe(99);
    expect(readFileSync(f.provisionLog, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readNumber(f.restartCount)).toBe(1);
    log = new EventLog(f.db);
    expect(log.claimNextTurn()).toBeUndefined();
    expect(log.activeOperation()).toMatchObject({ type: "update", state: "executing", stage: "provision" });
    log.close();

    expect(f.run(["internal-execute"], repo.env).status).toBe(0);
    expect(readFileSync(f.provisionLog, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readNumber(f.restartCount)).toBe(1);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.main);
    expect(git(["rev-parse", "HEAD"], repo.checkout)).toBe(repo.main);
    log = new EventLog(f.db);
    expect(log.operationStatus().lastOutcome).toMatchObject({ type: "update", state: "succeeded", stage: "accepted" });
    expect(log.claimNextTurn()).toMatchObject({ issueId: "issue-queued-update", status: "running" });
    log.close();
  }, 20_000);

  it("AC9 keeps a busy config failure drained until rollback acceptance, then archives failure without a retry storm", () => {
    const { fixture: f, running } = runningFixture();
    expect(f.run(["config", "--planner", "claudex", "--implementer", "claudex"]).status).toBe(0);
    assertBusyDrain(f.db, "config", running.id);
    let log = new EventLog(f.db);
    log.finishTurn(running.id, "response", "completed");
    log.close();
    writeFileSync(join(f.dir, "health.failures"), "1\n");
    expect(f.run(["internal-execute"]).status).not.toBe(0);
    expect(readNumber(f.restartCount)).toBe(2);
    log = new EventLog(f.db);
    expect(log.operationStatus().lastOutcome).toMatchObject({ type: "config", state: "failed", stage: "rolled_back", errorStage: "health" });
    expect(log.claimNextTurn()).toMatchObject({ issueId: "issue-queued-config" });
    log.close();
    const restarts = readNumber(f.restartCount);
    expect(f.run(["internal-execute"]).status).toBe(0);
    expect(readNumber(f.restartCount)).toBe(restarts);
  }, 15_000);
});
