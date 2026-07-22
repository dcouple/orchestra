import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";
import { EventLog } from "../src/eventlog.js";

const dirs: string[] = [];
export function fixture(): { dir: string; db: string } { const dir = mkdtempSync(join(tmpdir(), "daemon-operations-")); dirs.push(dir); return { dir, db: join(dir, "events.db") }; }
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
export function appendTurn(log: EventLog, id: string, identifier: string): void {
  log.append({ deliveryId: `delivery-${id}`, app: "planner", action: "created", agentSessionId: `session-${id}`,
    issueId: `issue-${id}`, issueIdentifier: identifier, receivedAt: 1_000, rawBody: Buffer.from(`secret-prompt-${id}`) });
}
export function executable(path: string, body: string): string { writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`); chmodSync(path, 0o755); return path; }
export function readNumber(path: string): number { return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0; }
export function treeSnapshot(paths: string[]): string {
  const rows: string[] = []; const visit = (path: string): void => {
    if (!existsSync(path)) { rows.push(`${path}:absent`); return; } const stat = lstatSync(path); const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) { rows.push(`${path}:link:${mode}:${readlinkSync(path)}`); return; }
    if (stat.isDirectory()) { rows.push(`${path}:dir:${mode}`); for (const name of readdirSync(path).sort()) visit(join(path, name)); return; }
    rows.push(`${path}:file:${mode}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
  }; for (const path of paths) visit(path); return rows.join("\n");
}
export interface OpsFixture {
  dir: string; db: string; envFile: string; state: string; requests: string; accepted: string; serviceLog: string; provisionLog: string;
  healthCount: string; restartCount: string; pidFile: string; env: NodeJS.ProcessEnv;
  run(args: string[], extra?: NodeJS.ProcessEnv): ReturnType<typeof spawnSync>;
}
export function opsFixture(): OpsFixture {
  const { dir, db } = fixture(), bin = join(dir, "bin"), state = join(dir, "state"), requests = join(state, "requests"); mkdirSync(bin); mkdirSync(requests, { recursive: true });
  const envFile = join(dir, "daemon.env"), serviceLog = join(dir, "systemctl.log"), provisionLog = join(dir, "provision.log");
  const healthCount = join(dir, "health.count"), restartCount = join(dir, "restart.count"), pidFile = join(dir, "pid");
  writeFileSync(envFile, "SECRET_TOKEN=fixture-secret-never-output\nPLANNER_HARNESS=claude\nUNRELATED=value with spaces\nIMPLEMENTER_HARNESS=claude\n");
  chmodSync(envFile, 0o640); writeFileSync(pidFile, "100\n"); writeFileSync(restartCount, "0\n"); writeFileSync(healthCount, "0\n"); new EventLog(db).close();
  const daemonctl = resolve("ops/daemonctl");
  const systemctl = executable(join(bin, "systemctl"), `
printf '%s\\n' "$*" >> "$FAKE_SERVICE_LOG"; action="\${1:-}"
if [[ "$action" == show && "$*" == *MainPID* ]]; then cat "$FAKE_PID_FILE"; exit 0; fi
if [[ "$action" == show ]]; then printf 'ActiveState=active\\nCPUUsageNSec=1200\\nMemoryCurrent=4096\\n'; exit 0; fi
if [[ "$action" == is-active ]]; then [[ "\${FAKE_SERVICE_INACTIVE:-0}" != 1 ]]; exit; fi
if [[ "$action" == restart ]]; then n=$(<"$FAKE_RESTART_COUNT"); printf '%s\\n' "$((n+1))" > "$FAKE_RESTART_COUNT"; failures=$(<"$FAKE_RESTART_FAILURES"); if (( failures > 0 )); then printf '%s\\n' "$((failures-1))" > "$FAKE_RESTART_FAILURES"; exit 1; fi; pid=$(<"$FAKE_PID_FILE"); printf '%s\\n' "$((pid+1))" > "$FAKE_PID_FILE"; exit 0; fi
if [[ "$action" == start && "$*" == *linear-agent-operation.service* ]]; then [[ "$*" == *--no-block* && "\${FAKE_EXECUTE_NO_BLOCK:-0}" != 1 ]] && exit 0; "$DAEMONCTL_BIN" internal-execute; fi`);
  const curl = executable(join(bin, "curl"), `n=$(<"$FAKE_HEALTH_COUNT"); printf '%s\\n' "$((n+1))" > "$FAKE_HEALTH_COUNT"; failures=$(<"$FAKE_HEALTH_FAILURES"); if (( failures > 0 )); then printf '%s\\n' "$((failures-1))" > "$FAKE_HEALTH_FAILURES"; echo 'health fixture failure' >&2; exit 22; fi; printf '{"ok":true}\\n'`);
  const stat = executable(join(bin, "stat"), `if [[ "$2" == %a ]]; then echo 600; else id -u; fi`), flock = executable(join(bin, "flock"), `exit 0`), sleep = executable(join(bin, "sleep"), `exit 0`);
  const uptime = executable(join(bin, "uptime"), `echo '14:00 up 3 days, load averages: 1.00 0.50 0.25'`);
  const ps = executable(join(bin, "ps"), `if [[ "$*" == *'pid=,ppid='* ]]; then printf '101 1 3.5 1.2 claude planted-secret-argv-token raw-session-id\\n102 1 2.0 0.8 claudex another-secret\\n103 1 1.0 0.5 codex prompt-secret\\n104 1 9.0 9.0 bash shell-secret\\n'; else printf '%%CPU %%MEM PID PPID COMMAND\\n3.5 1.2 101 1 claude\\n'; fi`);
  const df = executable(join(bin, "df"), `printf 'Filesystem Size Used Avail Capacity Mounted on\\nfixture 100G 10G 90G 10%% /fixture\\n'`);
  const pnpmLog = join(dir, "pnpm.log"), validatorLog = join(dir, "validator.log"), validatorHome = join(dir, "validator-home");
  mkdirSync(validatorHome);
  const pnpm = executable(join(bin, "pnpm"), `printf '%s|%s\\n' "$PWD" "$*" >> '${pnpmLog}'`);
  const validatorRun = executable(join(bin, "validator-run"), `
printf '%s\\n' "$*" >> '${validatorLog}'
args=("$@"); workdir=""; command_index=-1
for ((i=0; i<\${#args[@]}; i++)); do
  case "\${args[$i]}" in --working-directory=*) workdir="\${args[$i]#*=}" ;; /usr/bin/env) command_index=$i; break ;; esac
done
[[ "$*" == *'--uid=linear-validator'* && "$*" == *'--gid=linear-validator'* && "$*" == *'NoNewPrivileges=yes'* && "$*" == *'ProtectSystem=strict'* ]]
(( command_index >= 0 )); cd "$workdir"
candidate=("\${args[@]:$command_index}")
if [[ "\${FAKE_PNPM_FAIL_ACTION:-}" != "" ]]; then
  for value in "\${candidate[@]}"; do [[ "$value" == "$FAKE_PNPM_FAIL_ACTION" ]] && exit 1; done
fi
exec "\${candidate[@]}"
`);
  const chown = executable(join(bin, "chown"), `printf '%s\\n' "$*" >> '${validatorLog}'`);
  const provision = executable(join(bin, "provision"), `printf '%s|%s\\n' "$SOURCE_COMMIT" "$1" >> "$FAKE_PROVISION_LOG"; failures=$(<"$FAKE_PROVISION_FAILURES"); if (( failures > 0 )); then printf '%s\\n' "$((failures-1))" > "$FAKE_PROVISION_FAILURES"; exit 1; fi; "$SYSTEMCTL" restart linear-agent-daemon.service; printf '%s\\n' "$SOURCE_COMMIT" > "$ACCEPTED_COMMIT_FILE"`);
  const runuser = executable(join(bin, "runuser"), `printf '%s\\n' "$*" >> "$FAKE_RUNUSER_LOG"; [[ "$1" == -u && "$2" == linear-daemon && "$3" == -- ]]; shift 3; exec "$@"`);
  const restartFailures = join(dir, "restart.failures"), healthFailures = join(dir, "health.failures"), provisionFailures = join(dir, "provision.failures"); for (const path of [restartFailures, healthFailures, provisionFailures]) writeFileSync(path, "0\n");
  const env: NodeJS.ProcessEnv = { ...process.env, DAEMONCTL_ALLOW_NON_ROOT: "1", DB_PATH: db, DAEMONCTL_ENV_FILE: envFile, DAEMONCTL_STATE_DIR: state,
    DAEMONCTL_REQUEST_DIR: requests, DAEMONCTL_ACCEPTED_COMMIT_FILE: join(state, "accepted-commit"), DAEMONCTL_OPS_CLI: resolve("dist/operations-cli.js"), DAEMONCTL_PROVISION: provision,
    DAEMONCTL_BIN: daemonctl, SYSTEMCTL: systemctl, CURL: curl, STAT_BIN: stat, FLOCK_BIN: flock, SLEEP_BIN: sleep, UPTIME_BIN: uptime, PS_BIN: ps, DF_BIN: df,
    PNPM_BIN: pnpm, RUNUSER: runuser, CHOWN_BIN: chown, DAEMONCTL_VALIDATOR_RUN: validatorRun, DAEMONCTL_VALIDATOR_HOME: validatorHome,
    FAKE_SERVICE_LOG: serviceLog, FAKE_PROVISION_LOG: provisionLog, FAKE_HEALTH_COUNT: healthCount, FAKE_RESTART_COUNT: restartCount,
    FAKE_PID_FILE: pidFile, FAKE_RESTART_FAILURES: restartFailures, FAKE_HEALTH_FAILURES: healthFailures, FAKE_PROVISION_FAILURES: provisionFailures,
    FAKE_PNPM_LOG: pnpmLog, FAKE_VALIDATOR_LOG: validatorLog, FAKE_RUNUSER_LOG: join(dir, "runuser.log") };
  return { dir, db, envFile, state, requests, accepted: join(state, "accepted-commit"), serviceLog, provisionLog, healthCount, restartCount, pidFile, env,
    run: (args, extra = {}) => spawnSync(daemonctl, args, { env: { ...env, ...extra }, encoding: "utf8" }) };
}
export interface UpdateRepo { checkout: string; seed: string; origin: string; accepted: string; main: string; release: string; env: NodeJS.ProcessEnv }
export function git(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string { return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
export function updateRepo(f: OpsFixture): UpdateRepo {
  const seed = join(f.dir, "source-seed"), origin = join(f.dir, "source-origin.git"), checkout = join(f.dir, "source-checkout"); mkdirSync(seed); git(["init", "-b", "main"], seed); git(["config", "user.email", "fixture@example.test"], seed); git(["config", "user.name", "Fixture"], seed); mkdirSync(join(seed, "daemon", "ops"), { recursive: true });
  writeFileSync(join(seed, "daemon", "package.json"), '{"name":"fixture","version":"1.0.0"}\n'); writeFileSync(join(seed, "daemon", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const name of ["provision.sh", "daemonctl", "proxy-accounts.sh", "claudex", "claudex-fable", "codex-provider-gate.sh"]) writeFileSync(join(seed, "daemon", "ops", name), "#!/usr/bin/env bash\nset -euo pipefail\n");
  writeFileSync(join(seed, "release.txt"), "accepted\n"); git(["add", "."], seed); git(["commit", "-m", "accepted"], seed); const accepted = git(["rev-parse", "HEAD"], seed); git(["clone", "--bare", seed, origin]); git(["clone", origin, checkout]); git(["remote", "set-url", "origin", "https://fixture/orchestra.git"], checkout);
  writeFileSync(join(seed, "release.txt"), "main candidate\n"); git(["add", "."], seed); git(["commit", "-m", "main candidate"], seed); const main = git(["rev-parse", "HEAD"], seed); git(["remote", "add", "origin", origin], seed); git(["push", "origin", "main"], seed);
  git(["checkout", "-b", "release"], seed); writeFileSync(join(seed, "release.txt"), "explicit descendant\n"); git(["add", "."], seed); git(["commit", "-m", "release candidate"], seed); const release = git(["rev-parse", "HEAD"], seed); git(["push", "origin", "release"], seed); git(["checkout", "main"], seed);
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`, GIT_CONFIG_VALUE_0: "https://fixture/orchestra.git",
    GIT_CONFIG_KEY_1: "protocol.file.allow", GIT_CONFIG_VALUE_1: "always", DAEMONCTL_SOURCE_CHECKOUT: checkout }; writeFileSync(f.accepted, `${accepted}\n`);
  return { checkout, seed, origin, accepted, main, release, env };
}
