import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.js";
import { parseJsonNoDuplicateKeys, StrictJsonError } from "../src/strict-json.js";
import { classifyLoopOutcome, nextLoopDue, validateLoopDeclaration, type LoopDeclaration } from "../src/loops.js";
import { ConsoleLoopBroker } from "../src/console-loop-broker.js";
import { LoopScheduler } from "../src/loop-scheduler.js";

const now=1_800_000_000_000;
const declaration=(enabled=true):LoopDeclaration=>({version:1,name:"Repository health",description:"Periodic bounded review",
  trigger:{kind:"fixed-interval",everyMinutes:15,startsAt:now-60_000},task:{kind:"agent",role:"planner",objective:"Inspect repository health and summarize risks."},
  harness:{runtime:"claude",profile:"sol"},maxConcurrency:1,budgetUsd:2,timeoutMinutes:10,maxRetries:1,enabled});
describe("strict loop declarations",()=>{
  it("rejects decoded duplicates at nested depth and parser bounds",()=>{
    for(const text of ['{"name":1,"na\\u006de":2}','{"trigger":{"kind":1,"k\\u0069nd":2}}'])
      expect(()=>parseJsonNoDuplicateKeys(text)).toThrowError(expect.objectContaining({code:"duplicate_key"}));
    expect(()=>parseJsonNoDuplicateKeys(`${"[".repeat(33)}0${"]".repeat(33)}`)).toThrowError(StrictJsonError);
    expect(()=>parseJsonNoDuplicateKeys(`{${Array.from({length:65},(_,i)=>`"k${i}":${i}`).join(",")}}`)).toThrowError(expect.objectContaining({code:"too_many_keys"}));
  });
  it("enforces the exact closed schema and arithmetic",()=>{
    expect(validateLoopDeclaration(declaration(),2,now)).toEqual(declaration());
    for(const invalid of [{...declaration(),command:"rm"},{...declaration(),maxRetries:4},{...declaration(),budgetUsd:Infinity},
      {...declaration(),trigger:{kind:"fixed-interval",everyMinutes:14,startsAt:now}}]) expect(()=>validateLoopDeclaration(invalid,2,now)).toThrow();
    expect(nextLoopDue(now,15,now)).toBe(now+900_000);
  });
  it("rejects whitespace-only required names and objectives",()=>{
    expect(()=>validateLoopDeclaration({...declaration(),name:"   "},2,now)).toThrowError(expect.objectContaining({code:"invalid_name"}));
    expect(()=>validateLoopDeclaration({...declaration(),task:{...declaration().task,objective:" \t "}},2,now)).toThrowError(expect.objectContaining({code:"invalid_objective"}));
  });
  it("uses deterministic policy precedence",()=>{
    expect(classifyLoopOutcome({shutdown:true,timedOut:true,budgetStopped:true,budgetUsd:1,failed:true})).toBe("service_restart");
    expect(classifyLoopOutcome({timedOut:true,budgetStopped:true,budgetUsd:1,failed:true})).toBe("timeout");
    expect(classifyLoopOutcome({costUsd:1,budgetUsd:1,permissionDenied:true,failed:true})).toBe("budget_exhausted");
  });
});
describe("durable loop scheduling",()=>{
  let log:EventLog|undefined;afterEach(()=>log?.close());
  it("confirms once, coalesces missed intervals, deduplicates ticks, gates cleanup, and retries by policy",async()=>{
    log=new EventLog(":memory:");const wake=vi.fn();const broker=new ConsoleLoopBroker({log,globalCapacity:2,draftTtlMs:60_000,now:()=>now,notify:wake});
    const draft=broker.draft({kind:"create",reason:"bounded local maintenance",declaration:declaration()});
    expect(log.listLoops()).toEqual([]);
    const first=await broker.confirm({draftId:draft.id,digest:draft.digest,reason:draft.reason});
    const replay=await broker.confirm({draftId:draft.id,digest:draft.digest,reason:draft.reason});
    expect(first.loop.revision).toBe(1);expect(replay.deduplicated).toBe(true);expect(log.loopAudit(first.loop.id)).toHaveLength(1);
    const dueNow=now+900_000;const scheduler=new LoopScheduler(log,{now:()=>dueNow,wake,intervalMs:60_000});scheduler.start();await scheduler.trigger();await scheduler.trigger();await scheduler.stop();
    const occurrences=log.loopOccurrences(first.loop.id);expect(occurrences).toHaveLength(1);expect(occurrences[0]?.runId).toMatch(/^loop:/);
    const claimedTurn=log.claimNextTurn(dueNow)!;expect(claimedTurn.originKind).toBe("loop");
    const claimed=log.loopOccurrence(claimedTurn.loopOccurrenceId!)!;expect(claimed.snapshot.task.objective).toContain("repository health");
    log.finishLoopOccurrence(claimed.id,"retriable_failure","provider unavailable",dueNow);
    expect(log.loopOccurrence(claimed.id)?.retryCount).toBe(1);expect(log.claimNextTurn(dueNow)).toBeUndefined();
    const retryTurn=log.claimNextTurn(dueNow+1000)!;const retry=log.loopOccurrence(retryTurn.loopOccurrenceId!)!;
    log.finishLoopOccurrence(retry.id,"retriable_failure","provider unavailable",dueNow+1000);
    expect(log.loopById(first.loop.id)?.blockedReason).toBe("retries_exhausted");expect(log.hasBlockingLoopCleanup(first.loop.id)).toBe(true);
    expect(log.loopAudit(first.loop.id).map(row=>[row.kind,row.reason])).toEqual(expect.arrayContaining([
      ["occurrence.retry_scheduled","retriable_failure"],["occurrence.blocked","retries_exhausted"],["policy.blocked","retries_exhausted"]]));
  });
  it("persists only a safe durable receipt and replays it without a process draft",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"loop-receipt-"));const dbPath=join(dir,"state.sqlite");
    log=new EventLog(dbPath);const broker=new ConsoleLoopBroker({log,globalCapacity:2,now:()=>now,draftTtlMs:60_000});
    const secret="SECRET OBJECTIVE SENTINEL";const draft=broker.draft({kind:"create",reason:"durable safe receipt",declaration:{...declaration(),task:{...declaration().task,objective:secret}}});
    const first=await broker.confirm({draftId:draft.id,digest:draft.digest,reason:draft.reason});
    expect(first.loop.task).toEqual({kind:"agent",role:"planner"});
    log.close();log=undefined;
    const rawDb=new Database(dbPath,{readonly:true});const raw=(rawDb.prepare("SELECT response_json responseJson FROM loop_mutation_receipts WHERE draft_id=?").get(draft.id) as {responseJson:string}).responseJson;rawDb.close();
    expect(raw).not.toContain(secret);expect(raw).not.toContain("objective");
    log=new EventLog(dbPath);const restarted=new ConsoleLoopBroker({log,globalCapacity:2,now:()=>now,draftTtlMs:60_000});
    const replay=await restarted.confirm({draftId:draft.id,digest:draft.digest,reason:draft.reason});
    expect(replay.deduplicated).toBe(true);expect(replay.loop).toEqual(first.loop);
  });
  it("projects every public declaration-bearing draft and rejects an unsupported delete draft",async()=>{
    log=new EventLog(":memory:");const broker=new ConsoleLoopBroker({log,globalCapacity:2,now:()=>now,draftTtlMs:60_000});
    const objective="PRIVATE DRAFT OBJECTIVE";const create=broker.draft({kind:"create",reason:"safe create preview",
      declaration:{...declaration(false),task:{...declaration().task,objective}}});
    expect(JSON.stringify(create)).not.toContain(objective);expect(create.declaration?.task).toEqual({kind:"agent",role:"planner"});
    const created=await broker.confirm({draftId:create.id,digest:create.digest,reason:create.reason});
    const variants=[broker.draft({kind:"update",loopId:created.loop.id,expectedRevision:created.loop.revision,reason:"safe update preview",
      declaration:{...declaration(false),name:"Updated safely",task:{...declaration().task,objective:"UPDATED PRIVATE OBJECTIVE"}}}),
      broker.draft({kind:"enable",loopId:created.loop.id,expectedRevision:created.loop.revision,reason:"safe enable preview"}),
      broker.draft({kind:"disable",loopId:created.loop.id,expectedRevision:created.loop.revision,reason:"safe disable preview"})];
    for(const preview of variants){const serialized=JSON.stringify(preview);expect(serialized).not.toContain("objective");expect(serialized).not.toContain("PRIVATE OBJECTIVE");
      expect(preview.declaration?.task).toEqual({kind:"agent",role:"planner"});}
    expect(()=>broker.draft({kind:"delete",loopId:created.loop.id,expectedRevision:created.loop.revision,reason:"unsupported delete"}))
      .toThrowError(expect.objectContaining({code:"unsupported_kind"}));
  });
  it("advances the definition revision once when automatic policy exhaustion blocks a loop",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"loop-policy-revision-"));const dbPath=join(dir,"state.sqlite");log=new EventLog(dbPath);
    const transitionAt=now+900_001;const broker=new ConsoleLoopBroker({log,globalCapacity:2,now:()=>transitionAt,draftTtlMs:60_000});
    const created=log.mutateLoop({draftId:"draft-policy-revision",digest:"1".repeat(64),id:"loop-policy-revision",
      declaration:{...declaration(),maxRetries:0},expectedRevision:null,reason:"policy revision",kind:"create",now});
    const stale=broker.draft({kind:"update",loopId:created.loop.id,expectedRevision:created.loop.revision,reason:"pre-block edit",
      declaration:{...declaration(),maxRetries:0,name:"Edited before block"}});
    const occurrence=log.admitDueLoops(now+900_000)[0]!;log.claimNextTurn(now+900_000);
    log.finishLoopOccurrence(occurrence.id,"retriable_failure","provider unavailable",transitionAt);
    log.finishLoopOccurrence(occurrence.id,"retriable_failure","provider unavailable",transitionAt+1);
    await expect(broker.confirm({draftId:stale.id,digest:stale.digest,reason:stale.reason})).rejects.toMatchObject({code:"loop_revision_changed"});
    const rawDb=new Database(dbPath,{readonly:true});
    const definition=rawDb.prepare("SELECT revision,enabled,blocked_reason blockedReason,updated_at updatedAt FROM loop_definitions WHERE id=?").get(created.loop.id);
    const audits=rawDb.prepare("SELECT details_json detailsJson FROM loop_audit_events WHERE loop_id=? AND kind='policy.blocked'").all(created.loop.id) as Array<{detailsJson:string}>;rawDb.close();
    expect(definition).toEqual({revision:created.loop.revision+1,enabled:0,blockedReason:"retries_exhausted",updatedAt:transitionAt});
    expect(audits).toHaveLength(1);expect(JSON.parse(audits[0]!.detailsJson)).toEqual({occurrenceId:occurrence.id,revision:created.loop.revision+1});
  });
  it.each(["retained","failed"] as const)("advances the definition revision once when cleanup becomes %s",async disposition=>{
    const dir=mkdtempSync(join(tmpdir(),`loop-cleanup-${disposition}-revision-`));const dbPath=join(dir,"state.sqlite");log=new EventLog(dbPath);
    const transitionAt=now+900_002;const broker=new ConsoleLoopBroker({log,globalCapacity:2,now:()=>transitionAt,draftTtlMs:60_000});
    const created=log.mutateLoop({draftId:`draft-cleanup-${disposition}-revision`,digest:(disposition==="retained"?"2":"3").repeat(64),id:`loop-cleanup-${disposition}-revision`,
      declaration:{...declaration(),maxRetries:0},expectedRevision:null,reason:"cleanup revision",kind:"create",now});
    const stale=broker.draft(disposition==="retained"
      ?{kind:"update",loopId:created.loop.id,expectedRevision:created.loop.revision,reason:"pre-cleanup edit",declaration:{...declaration(),maxRetries:0,name:"Edited before cleanup"}}
      :{kind:"enable",loopId:created.loop.id,expectedRevision:created.loop.revision,reason:"pre-cleanup enable"});
    const occurrence=log.admitDueLoops(now+900_000)[0]!;log.claimNextTurn(now+900_000);log.finishLoopOccurrence(occurrence.id,"succeeded",null,now+900_001);
    const job=log.loopCleanups(created.loop.id)[0]!;const error=`cleanup ${disposition}`;
    if(disposition==="retained"){log.retainLoopCleanup(job.id,error,transitionAt);log.retainLoopCleanup(job.id,error,transitionAt+1);}
    else{log.failLoopCleanup(job.id,error,transitionAt);log.failLoopCleanup(job.id,error,transitionAt+1);}
    await expect(broker.confirm({draftId:stale.id,digest:stale.digest,reason:stale.reason})).rejects.toMatchObject({code:"loop_revision_changed"});
    const blockedReason=disposition==="retained"?"cleanup_retained":"cleanup_failed";const auditKind=`cleanup.${disposition}`;
    const rawDb=new Database(dbPath,{readonly:true});
    const definition=rawDb.prepare("SELECT revision,enabled,blocked_reason blockedReason,updated_at updatedAt FROM loop_definitions WHERE id=?").get(created.loop.id);
    const audits=rawDb.prepare("SELECT details_json detailsJson FROM loop_audit_events WHERE loop_id=? AND kind=?").all(created.loop.id,auditKind) as Array<{detailsJson:string}>;rawDb.close();
    expect(definition).toEqual({revision:created.loop.revision+1,enabled:0,blockedReason,updatedAt:transitionAt});
    expect(audits).toHaveLength(1);expect(JSON.parse(audits[0]!.detailsJson)).toEqual({jobId:job.id,occurrenceId:occurrence.id,revision:created.loop.revision+1});
  });
  it.each(["succeeded","timeout","budget_exhausted","policy_denied","restart_unsafe"] as const)("audits the %s occurrence transition",outcome=>{
    log=new EventLog(":memory:");const id=`loop-${outcome}`;const created=log.mutateLoop({draftId:`draft-${outcome}`,digest:"b".repeat(64),id,
      declaration:{...declaration(),maxRetries:0},expectedRevision:null,reason:"audit transition",kind:"create",now});
    const runAt=now+900_000;const occurrence=log.admitDueLoops(runAt)[0]!;expect(log.claimNextTurn(runAt)?.loopOccurrenceId).toBe(occurrence.id);
    log.finishLoopOccurrence(occurrence.id,outcome,outcome,runAt+1);
    const audit=log.loopAudit(created.loop.id);
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({kind:outcome==="succeeded"?"occurrence.succeeded":"occurrence.blocked",reason:outcome})]));
  });
  it("audits service restart without consuming retry policy",()=>{
    log=new EventLog(":memory:");const created=log.mutateLoop({draftId:"draft-restart",digest:"c".repeat(64),id:"loop-restart",declaration:declaration(),expectedRevision:null,reason:"restart",kind:"create",now});
    const runAt=now+900_000;const occurrence=log.admitDueLoops(runAt)[0]!;log.claimNextTurn(runAt);log.finishLoopOccurrence(occurrence.id,"service_restart","unsafe raw detail",runAt+1);
    expect(log.loopOccurrence(occurrence.id)?.retryCount).toBe(0);
    expect(log.loopAudit(created.loop.id)).toEqual(expect.arrayContaining([expect.objectContaining({kind:"occurrence.service_restart",reason:"service_restart"})]));
  });
  it("stores and projects only bounded sanitized cleanup errors",()=>{
    const dir=mkdtempSync(join(tmpdir(),"loop-cleanup-error-"));const dbPath=join(dir,"state.sqlite");log=new EventLog(dbPath);
    const created=log.mutateLoop({draftId:"draft-cleanup-errors",digest:"d".repeat(64),id:"loop-cleanup-errors",
      declaration:{...declaration(),maxRetries:0},expectedRevision:null,reason:"cleanup error safety",kind:"create",now});
    const occurrence=log.admitDueLoops(now+900_000)[0]!;log.claimNextTurn(now+900_000);
    log.finishLoopOccurrence(occurrence.id,"succeeded",null,now+900_001);
    const job=log.loopCleanups(created.loop.id)[0]!;
    const sensitive=`fatal:\u0000 could not read Username for 'https://ghp_supersecret@github.com/org/repo': ${"/Users/operator/private/repository/".repeat(20)} token=lin_api_hidden ${"x".repeat(1000)}`;
    log.retryLoopCleanup(job.id,sensitive,now+1);
    const retry=log.loopCleanup(job.id)!;expect(retry.error?.length).toBeLessThanOrEqual(240);
    expect(retry.error).not.toMatch(/[\x00-\x1f]|ghp_supersecret|lin_api_hidden|\/Users\/operator|github\.com/);
    log.retainLoopCleanup(job.id,sensitive,now+2);expect(log.loopCleanup(job.id)?.error).toBe(retry.error);
    log.failLoopCleanup(job.id,sensitive,now+3);expect(log.loopCleanup(job.id)?.error).toBe(retry.error);
    const rawDb=new Database(dbPath,{readonly:true});const raw=(rawDb.prepare("SELECT error FROM loop_cleanup_jobs WHERE id=?").get(job.id) as {error:string}).error;rawDb.close();
    expect(raw).toBe(retry.error);expect(raw.length).toBeLessThanOrEqual(240);
    expect(log.loopAudit(created.loop.id).filter(row=>row.kind.startsWith("cleanup.")).every(row=>row.reason===retry.error)).toBe(true);
  });
  it("atomically audits transient cleanup retry and successful completion",()=>{
    const dir=mkdtempSync(join(tmpdir(),"loop-cleanup-audit-"));const dbPath=join(dir,"state.sqlite");log=new EventLog(dbPath);
    const created=log.mutateLoop({draftId:"draft-cleanup-audit",digest:"e".repeat(64),id:"loop-cleanup-audit",
      declaration:{...declaration(),maxRetries:0},expectedRevision:null,reason:"cleanup audit",kind:"create",now});
    const occurrence=log.admitDueLoops(now+900_000)[0]!;log.claimNextTurn(now+900_000);log.finishLoopOccurrence(occurrence.id,"succeeded",null,now+900_001);
    const claimed=log.claimNextLoopCleanup(now+900_001)!;const nextAttemptAt=now+901_500;
    log.retryLoopCleanup(claimed.id,"git failed at /Users/operator/private token=ghp_hidden",nextAttemptAt,now+900_002);
    const retried=log.claimNextLoopCleanup(nextAttemptAt)!;log.completeLoopCleanup(retried.id,nextAttemptAt+1);
    const rawDb=new Database(dbPath,{readonly:true});
    const job=rawDb.prepare("SELECT status,error,next_attempt_at nextAttemptAt FROM loop_cleanup_jobs WHERE id=?").get(claimed.id) as {status:string;error:null;nextAttemptAt:number};
    const audits=rawDb.prepare("SELECT kind,reason,details_json detailsJson,created_at createdAt FROM loop_audit_events WHERE loop_id=? AND kind LIKE 'cleanup.%' ORDER BY sequence").all(created.loop.id) as Array<{kind:string;reason:string;detailsJson:string;createdAt:number}>;rawDb.close();
    expect(job).toEqual({status:"done",error:null,nextAttemptAt});
    expect(audits.map(row=>row.kind)).toEqual(["cleanup.retry_scheduled","cleanup.completed"]);
    expect(audits[0]!.reason).not.toMatch(/\/Users|ghp_hidden/);
    expect(JSON.parse(audits[0]!.detailsJson)).toEqual({jobId:claimed.id,occurrenceId:occurrence.id,nextAttemptAt});
    expect(JSON.parse(audits[1]!.detailsJson)).toEqual({jobId:claimed.id,occurrenceId:occurrence.id});
    expect(audits.map(row=>row.createdAt)).toEqual([now+900_002,nextAttemptAt+1]);
  });
  it("increments cleanup recovery revision atomically and replays it after restart while rejecting stale drafts",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"loop-cleanup-revision-"));const dbPath=join(dir,"state.sqlite");log=new EventLog(dbPath);
    const broker=new ConsoleLoopBroker({log,globalCapacity:2,now:()=>now+900_010,draftTtlMs:60_000});
    const created=log.mutateLoop({draftId:"draft-cleanup-revision",digest:"f".repeat(64),id:"loop-cleanup-revision",
      declaration:{...declaration(),maxRetries:0},expectedRevision:null,reason:"cleanup revision",kind:"create",now});
    const occurrence=log.admitDueLoops(now+900_000)[0]!;log.claimNextTurn(now+900_000);log.finishLoopOccurrence(occurrence.id,"succeeded",null,now+900_001);
    const job=log.loopCleanups(created.loop.id)[0]!;log.retainLoopCleanup(job.id,"cleanup retained: dirty worktree",now+900_002);
    const before=log.loopById(created.loop.id)!;
    expect(before).toMatchObject({revision:created.loop.revision+1,enabled:false,blockedReason:"cleanup_retained",updatedAt:now+900_002});
    expect(log.loopAudit(before.id)).toEqual(expect.arrayContaining([expect.objectContaining({kind:"cleanup.retained",
      details:{jobId:job.id,occurrenceId:occurrence.id,revision:before.revision}})]));
    const stale=broker.draft({kind:"update",loopId:before.id,expectedRevision:before.revision,reason:"stale edit",
      declaration:{...declaration(false),name:"Stale name"}});
    const recovery=broker.draft({kind:"cleanup.retry",loopId:before.id,expectedRevision:before.revision,reason:"operator revalidation"});
    expect(recovery.declaration).toBeUndefined();expect(JSON.stringify(recovery)).not.toContain("objective");
    const confirmed=await broker.confirm({draftId:recovery.id,digest:recovery.digest,reason:recovery.reason});
    expect(confirmed.loop).toMatchObject({revision:before.revision+1,updatedAt:now+900_010});
    expect(log.loopCleanup(job.id)?.status).toBe("pending");
    await expect(broker.confirm({draftId:stale.id,digest:stale.digest,reason:stale.reason})).rejects.toMatchObject({code:"loop_revision_changed"});
    const rawDb=new Database(dbPath,{readonly:true});const receipt=rawDb.prepare("SELECT revision,response_json responseJson FROM loop_mutation_receipts WHERE draft_id=?").get(recovery.id) as {revision:number;responseJson:string};
    const audit=rawDb.prepare("SELECT reason,details_json detailsJson FROM loop_audit_events WHERE loop_id=? AND kind='cleanup.retry'").get(before.id) as {reason:string;detailsJson:string};rawDb.close();
    expect(receipt.revision).toBe(before.revision+1);expect(JSON.parse(receipt.responseJson).loop.revision).toBe(before.revision+1);
    expect(audit.reason).toBe("operator revalidation");expect(JSON.parse(audit.detailsJson)).toEqual({revision:before.revision+1,jobs:1});
    log.close();log=undefined;log=new EventLog(dbPath);const restarted=new ConsoleLoopBroker({log,globalCapacity:2,now:()=>now+999_999,draftTtlMs:60_000});
    const replay=await restarted.confirm({draftId:recovery.id,digest:recovery.digest,reason:recovery.reason});
    expect(replay).toEqual({...confirmed,deduplicated:true});expect(log.loopById(before.id)?.revision).toBe(before.revision+1);
  });
});
