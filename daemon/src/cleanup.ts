import type { EventLog, CleanupJobRow, CleanupNotificationRow } from "./eventlog.js";
import type { LinearGateway } from "./linear.js";
import { WorktreeManager } from "./worktrees.js";

interface Logger { log(...args: unknown[]): void; error(...args: unknown[]): void; }
export interface CleanupWorkerOptions { pollMs?: number; reconcileMs?: number; leaseMs?: number; retryWindowMs?: number; now?:()=>number; logger?:Logger; }

export class CleanupWorker {
  private timer?:NodeJS.Timeout; private reconcileTimer?:NodeJS.Timeout; private stopped=false; private draining:Promise<void>|undefined;
  private readonly now:()=>number; private readonly logger:Logger;
  constructor(private readonly log:EventLog, private readonly gateway:LinearGateway,
    worktreesRoot:string, targetRepoPath:string, private readonly options:CleanupWorkerOptions={}) {
    this.now=options.now??Date.now; this.logger=options.logger??console;
    this.worktrees=new WorktreeManager(worktreesRoot,targetRepoPath);
  }
  private readonly worktrees:WorktreeManager;
  start():void {
    this.stopped=false; this.log.reclaimRunningCleanups();
    this.timer=setInterval(()=>void this.trigger(),this.options.pollMs??250);
    this.reconcileTimer=setInterval(()=>void this.reconcile(),this.options.reconcileMs??60_000);
    this.timer.unref(); this.reconcileTimer.unref(); void this.reconcile();
  }
  trigger():Promise<void> { if(this.stopped)return Promise.resolve(); return this.draining??=this.drain().finally(()=>{this.draining=undefined;}); }
  private async reconcile():Promise<void> { await this.trigger(); }
  private async drain():Promise<void> {
    for (;;) { const job=this.log.claimNextCleanup(this.now()); if(!job)break; await this.process(job); }
    for(const note of this.log.pendingCleanupNotifications(this.now())) await this.postNotification(note);
  }
  private async process(job:CleanupJobRow):Promise<void> {
    try {
      const session=this.log.sessionByIssueIdentifier(job.issueIdentifier);
      if(!session?.worktreePath || !(await this.worktrees.isPresent(session.worktreePath))) {
        await this.worktrees.remove(job.issueIdentifier); this.log.markCleanupDone(job.id); return;
      }
      if(await this.worktrees.isClean(session.worktreePath)) {
        if(!this.log.hasExternalUrl(job.linearSessionId)) {
          this.log.retainCleanup(job.id,`Worktree retained because no pull request was recorded; possible unpushed work is preserved: ${session.worktreePath}`,this.now());
          return;
        }
        await this.worktrees.remove(job.issueIdentifier); this.log.markCleanupDone(job.id);
      }
      else this.log.retainCleanup(job.id,`Worktree retained because it is dirty: ${session.worktreePath}`,this.now());
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      if(this.now()<job.createdAt+(this.options.retryWindowMs??30*60_000)) this.log.retryCleanup(job.id,message,this.now()+Math.min(60_000,1000*2**Math.min(job.attempts,6)));
      else { this.log.failCleanup(job.id,message); this.logger.error(JSON.stringify({event:"cleanup_failed",jobId:job.id,error:message})); }
    }
  }
  private async postNotification(note:CleanupNotificationRow):Promise<void> {
    const result=await this.gateway.postActivity(note.app,note.linearSessionId,note.activityId,{type:"thought",body:note.body},true,this.now()+10_000);
    if(result.ok){this.log.markCleanupNotificationPosted(note.jobId);return;}
    if(result.retriable&&this.now()<note.createdAt+30*60_000){this.log.retryCleanupNotification(note.jobId,result.error,this.now()+Math.max(1000,result.retryAfterMs??0));return;}
    this.log.failCleanupNotification(note.jobId,result.error);
    this.logger.error(JSON.stringify({event:"cleanup_notification_failed",jobId:note.jobId,error:result.error}));
  }
  async stop():Promise<void>{this.stopped=true;if(this.timer)clearInterval(this.timer);if(this.reconcileTimer)clearInterval(this.reconcileTimer);await this.draining;}
}
