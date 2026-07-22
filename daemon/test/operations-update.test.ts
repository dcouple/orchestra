import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import { git, opsFixture, readNumber, treeSnapshot, updateRepo, type OpsFixture, type UpdateRepo } from "./operations-fixtures.js";

describe("validated Git update boundary", () => {
  function expectNoUpdateMutation(f: OpsFixture, repo: UpdateRepo): void {
    expect(git(["rev-parse", "HEAD"], repo.checkout)).toBe(readFileSync(f.accepted, "utf8").trim());
    expect(readdirSync(f.requests)).toHaveLength(0);
    expect(existsSync(f.provisionLog)).toBe(false);
    expect(readNumber(f.restartCount)).toBe(0);
    const log = new EventLog(f.db);
    expect(log.activeOperation()).toBeUndefined();
    expect(log.operationStatus().lastOutcome).toBeNull();
    log.close();
  }

  it("AC4/AC6 validates and immediately deploys a clean fast-forward immutable SHA, then no-ops on rerun", () => {
    const f = opsFixture(), repo = updateRepo(f);
    const result = f.run(["update"], repo.env);
    expect(result.status).toBe(0);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.main);
    expect(git(["rev-parse", "HEAD"], repo.checkout)).toBe(repo.main);
    expect(readFileSync(f.provisionLog, "utf8")).toContain(`${repo.main}|`);
    expect(readNumber(f.restartCount)).toBe(1);
    const pnpm = readFileSync(join(f.dir, "pnpm.log"), "utf8").trim().split("\n").map(line => line.split("|")[1]);
    expect(pnpm).toEqual(["fetch --ignore-pnpmfile --ignore-scripts --frozen-lockfile", "install --offline --frozen-lockfile", "typecheck", "build", "test"]);
    const validatorLog = readFileSync(String(f.env.FAKE_VALIDATOR_LOG), "utf8").trim().split("\n");
    expect(validatorLog[0]).toContain(`-R linear-validator:linear-validator`);
    const validatorCommands = validatorLog.filter(line => line.startsWith("--quiet"));
    expect(validatorCommands).toHaveLength(6);
    for (const command of validatorCommands) {
      expect(command).toContain("--uid=linear-validator");
      expect(command).toContain("--gid=linear-validator");
      expect(command).toContain("NoNewPrivileges=yes");
      expect(command).toContain("ProtectSystem=strict");
      expect(command).toContain("ProtectHome=yes");
      expect(command).toContain("PrivateTmp=yes");
      expect(command).toContain(`ReadWritePaths=${String(f.env.DAEMONCTL_VALIDATOR_HOME)}`);
      expect(command).toContain("/usr/bin/env -i HOME=");
      expect(command).toContain("PATH=/usr/local/bin:/usr/bin:/bin CI=1");
      expect(command).not.toMatch(/DB_PATH|SECRET_TOKEN|CLIPROXY|LINEAR|ANTHROPIC|OPENAI/);
    }
    const fetchCommand = validatorCommands[0]!;
    expect(fetchCommand).toContain("PrivateNetwork=no");
    expect(fetchCommand).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    for (const denied of ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "fe80::/10", "fc00::/7"]) {
      expect(fetchCommand).toContain(`IPAddressDeny=${denied}`);
    }
    expect(fetchCommand).not.toContain("PrivateNetwork=yes");
    expect(fetchCommand).toContain("fetch --ignore-pnpmfile --ignore-scripts --frozen-lockfile");
    for (const command of validatorCommands.slice(1)) expect(command).toContain("PrivateNetwork=yes");
    expect(validatorCommands[1]).toContain("install --offline --frozen-lockfile");
    expect(result.stdout).toContain(`deployed ${repo.accepted} -> ${repo.main}`);
    const done = join(f.requests, readdirSync(f.requests).find(name => name.endsWith(".done"))!);
    expect(JSON.parse(readFileSync(done, "utf8"))).toMatchObject({ previous_commit: repo.accepted, target_commit: repo.main, target_ref: "origin/HEAD" });
    const before = treeSnapshot([f.accepted, f.provisionLog, f.restartCount]);
    const again = f.run(["update"], repo.env);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(`already deployed and accepted: ${repo.main}`);
    expect(treeSnapshot([f.accepted, f.provisionLog, f.restartCount])).toBe(before);
  }, 15_000);

  it("AC4 applies an explicit descendant ref under the same fast-forward rule", () => {
    const f = opsFixture(), repo = updateRepo(f);
    const result = f.run(["update", "--ref", "refs/heads/release"], repo.env);
    expect(result.status).toBe(0);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.release);
    expect(git(["rev-parse", "HEAD"], repo.checkout)).toBe(repo.release);
    expect(result.stdout).toContain(`deployed ${repo.accepted} -> ${repo.release}`);
  }, 15_000);

  it("AC5 rejects dirty, absent/malformed/divergent markers, unresolved refs, candidate failure, non-FF, and committed whitespace before mutation", () => {
    {
      const f = opsFixture(), repo = updateRepo(f);
      writeFileSync(join(repo.checkout, "dirty"), "dirty\n");
      expect(f.run(["update"], repo.env).stderr).toContain("checkout is dirty");
      rmSync(join(repo.checkout, "dirty"));
      expectNoUpdateMutation(f, repo);
    }
    for (const marker of ["absent", "malformed", "divergent"] as const) {
      const f = opsFixture(), repo = updateRepo(f);
      if (marker === "absent") rmSync(f.accepted);
      else writeFileSync(f.accepted, marker === "malformed" ? "not-a-sha\n" : `${repo.main}\n`);
      const result = f.run(["update"], repo.env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/marker missing|malformed accepted commit marker|marker diverge/);
      expect(readdirSync(f.requests)).toHaveLength(0);
      expect(existsSync(f.provisionLog)).toBe(false);
      expect(readNumber(f.restartCount)).toBe(0);
    }
    {
      const f = opsFixture(), repo = updateRepo(f);
      expect(f.run(["update", "--ref", "refs/heads/missing"], repo.env).status).not.toBe(0);
      expectNoUpdateMutation(f, repo);
    }
    {
      const f = opsFixture(), repo = updateRepo(f);
      const result = f.run(["update"], { ...repo.env, FAKE_PNPM_FAIL_ACTION: "test" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("candidate gate");
      expectNoUpdateMutation(f, repo);
    }
    {
      const f = opsFixture(), repo = updateRepo(f);
      const result = f.run(["update"], { ...repo.env, FAKE_VALIDATOR_REJECT_ISOLATION: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("candidate gate");
      expectNoUpdateMutation(f, repo);
    }
    {
      const f = opsFixture(), repo = updateRepo(f);
      git(["config", "user.email", "fixture@example.test"], repo.checkout);
      git(["config", "user.name", "Fixture"], repo.checkout);
      writeFileSync(join(repo.checkout, "diverge"), "local\n");
      git(["add", "."], repo.checkout);
      git(["commit", "-m", "divergent accepted"], repo.checkout);
      const divergent = git(["rev-parse", "HEAD"], repo.checkout);
      writeFileSync(f.accepted, `${divergent}\n`);
      const result = f.run(["update"], repo.env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a fast-forward descendant");
      expectNoUpdateMutation(f, { ...repo, accepted: divergent });
    }
    {
      const f = opsFixture(), repo = updateRepo(f);
      git(["checkout", "main"], repo.seed);
      writeFileSync(join(repo.seed, "whitespace.txt"), "committed trailing space   \n");
      git(["add", "."], repo.seed);
      git(["commit", "-m", "bad whitespace"], repo.seed);
      git(["push", "origin", "main"], repo.seed);
      const result = f.run(["update"], repo.env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("candidate gate");
      expectNoUpdateMutation(f, repo);
    }
  }, 30_000);

  it("rolls back a failed update before release, blocks an unaccepted rollback, and resumes after post-provision crash", () => {
    const f = opsFixture(), repo = updateRepo(f);
    writeFileSync(join(f.dir, "provision.failures"), "1\n");
    expect(f.run(["update"], repo.env).status).not.toBe(0);
    expect(readFileSync(f.accepted, "utf8").trim()).toBe(repo.accepted);
    expect(git(["rev-parse", "HEAD"], repo.checkout)).toBe(repo.accepted);
    let log = new EventLog(f.db);
    expect(log.operationStatus().lastOutcome).toMatchObject({ state: "failed", stage: "rolled_back", errorStage: "provision" });
    log.close();

    const g = opsFixture(), blockedRepo = updateRepo(g);
    writeFileSync(join(g.dir, "provision.failures"), "2\n");
    expect(g.run(["update"], blockedRepo.env).status).not.toBe(0);
    log = new EventLog(g.db);
    expect(log.operationStatus().pending).toMatchObject({ drainState: "blocked", stage: "rollback_acceptance" });
    log.close();

    const h = opsFixture(), crashRepo = updateRepo(h);
    expect(h.run(["update"], { ...crashRepo.env, DAEMONCTL_FAULT_AFTER: "provision" }).status).toBe(99);
    expect(readFileSync(h.accepted, "utf8").trim()).toBe(crashRepo.main);
    expect(git(["rev-parse", "HEAD"], crashRepo.checkout)).toBe(crashRepo.accepted);
    expect(h.run(["internal-execute"], crashRepo.env).status).toBe(0);
    expect(git(["rev-parse", "HEAD"], crashRepo.checkout)).toBe(crashRepo.main);
    expect(readFileSync(h.provisionLog, "utf8").trim().split("\n")).toHaveLength(1);
  }, 30_000);
});
