import type { AppName, Config } from "./config.js";
import type { TurnRow } from "./eventlog.js";
import type {
  PostResult,
  ProgressContent,
  TerminalContent,
} from "./linear.js";

export interface WorkProvider {
  postAckActivity(
    app: AppName,
    sessionId: string,
    activityId: string,
    deadlineAt: number,
  ): Promise<PostResult>;
  postActivity(
    app: AppName,
    sessionId: string,
    activityId: string,
    content: ProgressContent | TerminalContent,
    ephemeral: boolean,
    deadlineAt: number,
  ): Promise<PostResult>;
  setSessionExternalUrl(
    app: AppName,
    sessionId: string,
    label: string,
    url: string,
    deadlineAt: number,
  ): Promise<PostResult>;
  turnPrompt?(
    turn: TurnRow,
    identifier: string,
    implementer: boolean,
    resuming: boolean,
  ): string;
  mcpConfigJson?(config: Config): string;
}
