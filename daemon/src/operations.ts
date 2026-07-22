export const OPERATION_TYPES = ["restart", "config", "update"] as const;
export type OperationType = typeof OPERATION_TYPES[number];

export const ACTIVE_OPERATION_STATES = [
  "pending", "draining", "executing", "accepting", "rolling_back", "blocked",
] as const;
export const TERMINAL_OPERATION_STATES = ["succeeded", "failed", "cancelled"] as const;
export type ActiveOperationState = typeof ACTIVE_OPERATION_STATES[number];
export type TerminalOperationState = typeof TERMINAL_OPERATION_STATES[number];
export type OperationState = ActiveOperationState | TerminalOperationState;

export interface ScheduleOperationInput {
  id: string;
  requestDigest: string;
  type: OperationType;
  reason: string;
  requestedAt?: number;
  targetRef?: string | null;
  targetCommit?: string | null;
  previousCommit?: string | null;
}

export interface OperationRow {
  id: string;
  requestDigest: string;
  type: OperationType;
  reason: string;
  requestedAt: number;
  targetRef: string | null;
  targetCommit: string | null;
  previousCommit: string | null;
  state: OperationState;
  stage: string | null;
  attempts: number;
  mutated: number;
  rollbackVerified: number;
  outcome: string | null;
  errorStage: string | null;
  updatedAt: number;
}

export interface SafeRunningTurn {
  app: "planner" | "implementer";
  issueIdentifier: string;
  runtime: "claude" | "claudex";
  state: "running";
  startedAt: number;
  elapsedMs: number;
}

export interface SafeOperationStatus {
  pending: null | {
    id: string;
    type: OperationType;
    reason: string;
    requestedAt: number;
    targetRef: string | null;
    targetCommit: string | null;
    drainState: OperationState;
    stage: string | null;
    attempts: number;
    recoveryCommand: string | null;
  };
  runningTurns: number;
  lastOutcome: null | {
    id: string;
    type: OperationType;
    state: OperationState;
    stage: string | null;
    outcome: string | null;
    errorStage: string | null;
    updatedAt: number;
  };
}

export function isOperationType(value: string): value is OperationType {
  return (OPERATION_TYPES as readonly string[]).includes(value);
}

export function isOperationState(value: string): value is OperationState {
  return ([...ACTIVE_OPERATION_STATES, ...TERMINAL_OPERATION_STATES] as readonly string[]).includes(value);
}

export function validateScheduleOperation(input: ScheduleOperationInput): void {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(input.id)) throw new Error("invalid operation id");
  if (!/^[0-9a-f]{64}$/i.test(input.requestDigest)) throw new Error("invalid request digest");
  if (!input.reason || input.reason.length > 240 || /[\x00-\x1f\x7f]/.test(input.reason)) throw new Error("invalid operation reason");
  if (input.targetRef !== undefined && input.targetRef !== null
      && !/^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,239}$/.test(input.targetRef)) throw new Error("invalid target ref");
  for (const commit of [input.targetCommit, input.previousCommit]) {
    if (commit !== undefined && commit !== null && !/^[0-9a-f]{40}$/i.test(commit)) throw new Error("invalid commit id");
  }
}
