#!/usr/bin/env node
import { EventLog } from "./eventlog.js";
import { isOperationState, isOperationType, type OperationState, type OperationType } from "./operations.js";

function usage(): never {
  process.stderr.write("usage: operations-cli <schedule|claim|transition|get|status|running|retry|cancel> ...\n");
  process.exit(2);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function optional(value: string | undefined): string | null { return value && value !== "-" ? value : null; }

const [command, ...args] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") usage();
const dbPath = process.env.DB_PATH ?? "/var/lib/linear-agent-daemon/events.db";
const log = new EventLog(dbPath);

try {
  let result: unknown;
  switch (command) {
    case "schedule": {
      const [id, digest, type, reason, targetRef, targetCommit, previousCommit] = args;
      if (!isOperationType(type ?? "")) throw new Error("type must be restart, config, or update");
      result = log.scheduleOperation({ id: required(id, "id"), requestDigest: required(digest, "digest"),
        type: type as OperationType, reason: required(reason, "reason"), targetRef: optional(targetRef),
        targetCommit: optional(targetCommit), previousCommit: optional(previousCommit) });
      break;
    }
    case "claim": result = log.claimOperation(required(args[0], "id"), required(args[1], "digest")) ?? null; break;
    case "get": result = log.operationById(required(args[0], "id")) ?? null; break;
    case "status": result = log.operationStatus(); break;
    case "running": result = log.runningTurns(); break;
    case "retry": result = log.retryOperation(required(args[0], "id")); break;
    case "cancel": result = log.cancelOperation(required(args[0], "id")); break;
    case "transition": {
      const [id, state, stage, outcome, errorStage, mutated, rollbackVerified] = args;
      if (!isOperationState(state ?? "")) throw new Error("invalid operation state");
      const options: { outcome?: string | null; errorStage?: string | null; mutated?: boolean; rollbackVerified?: boolean } = {
        outcome: optional(outcome), errorStage: optional(errorStage),
      };
      if (mutated !== undefined && mutated !== "-") options.mutated = mutated === "1";
      if (rollbackVerified !== undefined && rollbackVerified !== "-") options.rollbackVerified = rollbackVerified === "1";
      result = log.transitionOperation(required(id, "id"), state as OperationState, optional(stage), options);
      break;
    }
    default: usage();
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  log.close();
}
