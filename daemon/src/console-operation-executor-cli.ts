#!/usr/bin/env node
import { ConsoleOperationExecutor } from "./console-operation-executor.js";
import { EventLog } from "./eventlog.js";

if (process.argv.length !== 2) { process.stderr.write("console operation executor accepts no arguments\n"); process.exit(2); }
const dbPath = process.env.DB_PATH; const spoolDir = process.env.CONSOLE_OPERATION_SPOOL_DIR;
if (!dbPath || !spoolDir) { process.stderr.write("console operation executor is not configured\n"); process.exit(78); }
const log = new EventLog(dbPath);
try {
  await new ConsoleOperationExecutor({ log, spoolDir,
    executable: process.env.CONSOLE_DAEMONCTL_PATH ?? "/usr/local/sbin/daemonctl", argv: ["internal-console-execute"],
    ...(process.env.CONSOLE_PROTECTED_ENV_FILE ? { environmentFile: process.env.CONSOLE_PROTECTED_ENV_FILE } : {}) }).run();
} finally { log.close(); }
