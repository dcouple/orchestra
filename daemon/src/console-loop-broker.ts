import { randomUUID, createHash } from "node:crypto";
import type { EventLog, LoopMutationResult } from "./eventlog.js";
import { canonicalLoopJson, validateLoopDeclaration, type LoopDeclaration } from "./loops.js";
import { projectConsoleLoopDeclaration, type ConsoleLoopDeclaration } from "./console-projections.js";

export class ConsoleLoopBrokerError extends Error { constructor(readonly code: string, readonly status = 409) { super(code); this.name="ConsoleLoopBrokerError"; } }
export interface LoopDraftPreview { id: string; digest: string; kind: "create"|"update"|"enable"|"disable"|"cleanup.retry"; loopId: string;
  expectedRevision: number | null; reason: string; expiresAt: number; changedFields: string[]; declaration?: ConsoleLoopDeclaration;
  policy: { maxConcurrency: number; budgetUsd: number; timeoutMinutes: number; maxRetries: number } | null; }
interface Draft { preview: LoopDraftPreview; declaration: LoopDeclaration | undefined }
export class ConsoleLoopBroker {
  private drafts = new Map<string,Draft>(); private now: () => number;
  constructor(private options: { log: EventLog; globalCapacity: number; draftTtlMs: number; now?: () => number; notify?: () => void|Promise<void> }) { this.now=options.now??Date.now; }
  draft(value: unknown): LoopDraftPreview {
    const row = exact(value,["kind","loopId","expectedRevision","reason","declaration"]); const kind = row.kind;
    if (!(["create","update","enable","disable","cleanup.retry"] as unknown[]).includes(kind)) throw new ConsoleLoopBrokerError("unsupported_kind",400);
    const reason=string(row.reason,"invalid_reason",240); const current=typeof row.loopId === "string" ? this.options.log.loopById(row.loopId) : undefined;
    const loopId=kind === "create" ? randomUUID() : string(row.loopId,"invalid_loop_id",80);
    const expectedRevision=kind === "create" ? null : integer(row.expectedRevision,"invalid_revision");
    if (kind !== "create" && (!current || current.revision !== expectedRevision)) throw new ConsoleLoopBrokerError("loop_revision_changed",409);
    let declaration: LoopDeclaration | undefined;
    if (kind === "create" || kind === "update") declaration=validateLoopDeclaration(row.declaration,this.options.globalCapacity,this.now());
    else if (kind === "enable" || kind === "disable") declaration={ ...strip(current!), enabled: kind === "enable" };
    const canonical={version:1,kind,loopId,expectedRevision,...(declaration?{declaration}:{})};
    const digest=createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    const changedFields=current&&declaration ? Object.keys(declaration).filter(key=>canonicalLoopJson((strip(current) as unknown as Record<string,unknown>)[key] as never)!==canonicalLoopJson((declaration as unknown as Record<string,unknown>)[key] as never)) : declaration ? Object.keys(declaration) : ["cleanup"];
    const preview: LoopDraftPreview={id:randomUUID(),digest,kind:kind as LoopDraftPreview["kind"],loopId,expectedRevision,reason,
      expiresAt:this.now()+this.options.draftTtlMs,changedFields,...(declaration?{declaration:projectConsoleLoopDeclaration(declaration)}:{}),
      policy:declaration?{maxConcurrency:declaration.maxConcurrency,budgetUsd:declaration.budgetUsd,timeoutMinutes:declaration.timeoutMinutes,maxRetries:declaration.maxRetries}:null};
    this.drafts.set(preview.id,{preview,declaration}); return preview;
  }
  async confirm(value: unknown): Promise<LoopMutationResult> {
    const row=exact(value,["draftId","digest","reason"]); const draftId=string(row.draftId,"invalid_draft",80); const digest=string(row.digest,"invalid_digest",128);
    const receipt=this.options.log.loopReceipt(draftId); if(receipt){if(receipt.digest!==digest)throw new ConsoleLoopBrokerError("confirmation_mismatch");return {...receipt.result,deduplicated:true};}
    const draft=this.drafts.get(draftId); if(!draft)throw new ConsoleLoopBrokerError("draft_not_found",404);
    if(draft.preview.expiresAt<this.now()){this.drafts.delete(draftId);throw new ConsoleLoopBrokerError("draft_expired");}
    if(digest!==draft.preview.digest||row.reason!==draft.preview.reason)throw new ConsoleLoopBrokerError("confirmation_mismatch");
    if(draft.preview.kind==="cleanup.retry"){try{const result=this.options.log.confirmLoopCleanupRetry({draftId,digest,loopId:draft.preview.loopId,expectedRevision:draft.preview.expectedRevision!,reason:draft.preview.reason,now:this.now()});
      await this.options.notify?.();return result;}catch(error){throw new ConsoleLoopBrokerError(error instanceof Error?error.message:"cleanup_retry_failed");}}
    try { const result=this.options.log.mutateLoop({draftId,digest,id:draft.preview.loopId,declaration:draft.declaration!,expectedRevision:draft.preview.expectedRevision,
      reason:draft.preview.reason,kind:draft.preview.kind,now:this.now()}); await this.options.notify?.(); return result; }
    catch(error){throw new ConsoleLoopBrokerError(error instanceof Error?error.message:"loop_mutation_failed");}
  }
}
function exact(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new ConsoleLoopBrokerError("invalid_object",400);const row=value as Record<string,unknown>;if(Object.keys(row).some(k=>!keys.includes(k)))throw new ConsoleLoopBrokerError("unknown_field",400);return row;}
function string(value:unknown,code:string,max:number):string{if(typeof value!=="string"||value.length<1||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw new ConsoleLoopBrokerError(code,400);return value;}
function integer(value:unknown,code:string):number{if(!Number.isSafeInteger(value)||(value as number)<1)throw new ConsoleLoopBrokerError(code,400);return value as number;}
function strip(row: ReturnType<EventLog["loopById"]> extends infer T ? NonNullable<T> : never):LoopDeclaration{return {version:1,name:row.name,description:row.description,trigger:row.trigger,task:row.task,harness:row.harness,maxConcurrency:row.maxConcurrency,budgetUsd:row.budgetUsd,timeoutMinutes:row.timeoutMinutes,maxRetries:row.maxRetries,enabled:row.enabled};}
