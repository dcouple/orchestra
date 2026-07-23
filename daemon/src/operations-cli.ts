#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { EventLog } from "./eventlog.js";
import { isOperationState, isOperationType, type OperationState, type OperationType } from "./operations.js";
import { ToolBoundaryStore } from "./tool-boundary-store.js";

function usage(): never {
  process.stderr.write("usage: operations-cli <schedule|claim|transition|get|status|running|retry|cancel|restart-intent-set|restart-intent-get|restart-intent-clear> ...\n");
  process.exit(2);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function optional(value: string | undefined): string | null { return value && value !== "-" ? value : null; }

const [command, ...args] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") usage();
const isToolHook = command === "tool-hook-open" || command === "tool-hook-complete";
const dbPath = isToolHook
  ? args[0]
  : process.env.DB_PATH ?? "/var/lib/linear-agent-daemon/events.db";
let log: EventLog | undefined;
let toolStore: ToolBoundaryStore | undefined;

try {
  if (isToolHook)
    toolStore = new ToolBoundaryStore(required(dbPath, "database path"));
  else log = new EventLog(required(dbPath, "database path"));
  let result: unknown;
  switch (command) {
    case "schedule": {
      const [id, digest, type, reason, targetRef, targetCommit, previousCommit] = args;
      if (!isOperationType(type ?? "")) throw new Error("type must be restart, config, or update");
      result = log!.scheduleOperation({ id: required(id, "id"), requestDigest: required(digest, "digest"),
        type: type as OperationType, reason: required(reason, "reason"), targetRef: optional(targetRef),
        targetCommit: optional(targetCommit), previousCommit: optional(previousCommit) });
      break;
    }
    case "claim": result = log!.claimOperation(required(args[0], "id"), required(args[1], "digest")) ?? null; break;
    case "get": result = log!.operationById(required(args[0], "id")) ?? null; break;
    case "status": result = log!.operationStatus(); break;
    case "running": result = log!.runningTurns(); break;
    case "restart-intent-set": result = log!.recordRestartIntent(required(args[0], "reason")); break;
    case "restart-intent-get": result = log!.restartIntent() ?? null; break;
    case "restart-intent-clear": result = { cleared: log!.clearRestartIntent() }; break;
    case "tool-hook-open":
    case "tool-hook-complete": {
      const turnId = Number(required(args[1], "turn id"));
      if (!Number.isSafeInteger(turnId) || turnId <= 0)
        throw new Error("turn id must be a positive integer");
      const raw = readFileSync(0);
      if (raw.byteLength === 0 || raw.byteLength > 1024 * 1024)
        throw new Error("invalid hook input");
      const input = JSON.parse(raw.toString("utf8")) as unknown;
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("invalid hook input");
      const hook = input as Record<string, unknown>;
      const toolUseId = hook.tool_use_id;
      const toolName = hook.tool_name;
      if (typeof toolUseId !== "string" || typeof toolName !== "string")
        throw new Error("invalid hook tool identity");
      if (command === "tool-hook-open") {
        if (hook.hook_event_name !== "PreToolUse")
          throw new Error("invalid pre-tool hook event");
        toolStore!.recordOpen(turnId, toolUseId, toolName);
      } else {
        if (
          hook.hook_event_name !== "PostToolUse" &&
          hook.hook_event_name !== "PostToolUseFailure"
        )
          throw new Error("invalid post-tool hook event");
        toolStore!.recordComplete(turnId, toolUseId);
      }
      result = { recorded: true };
      break;
    }
    case "retry": result = log!.retryOperation(required(args[0], "id")); break;
    case "cancel": result = log!.cancelOperation(required(args[0], "id")); break;
    case "transition": {
      const [id, state, stage, outcome, errorStage, mutated, rollbackVerified] = args;
      if (!isOperationState(state ?? "")) throw new Error("invalid operation state");
      const options: { outcome?: string | null; errorStage?: string | null; mutated?: boolean; rollbackVerified?: boolean } = {
        outcome: optional(outcome), errorStage: optional(errorStage),
      };
      if (mutated !== undefined && mutated !== "-") options.mutated = mutated === "1";
      if (rollbackVerified !== undefined && rollbackVerified !== "-") options.rollbackVerified = rollbackVerified === "1";
      result = log!.transitionOperation(required(id, "id"), state as OperationState, optional(stage), options);
      break;
    }
    default: usage();
  }
  if (!isToolHook) process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  if (command === "tool-hook-open") {
    process.stderr.write("tool call blocked: durable pre-execution record failed\n");
    process.exitCode = 2;
  } else if (command === "tool-hook-complete") {
    process.stderr.write("durable post-execution record failed\n");
    process.exitCode = 1;
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  log?.close();
  toolStore?.close();
}
