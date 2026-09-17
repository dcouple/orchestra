import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LoopDeclaration, type LoopDetail, type LoopDraft, type LoopSummary } from "./api";
import { type CapabilityState, CapabilityNotice } from "./capability";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { DataTable } from "./components/DataTable";
import { Modal } from "./components/Modal";
import { StatusBadge } from "./components/StatusBadge";

const time = (value: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
type ReasonKind="enable"|"disable"|"cleanup.retry";

function useLoopController(){
  const [loops,setLoops]=useState<LoopSummary[]>([]);const [selected,setSelected]=useState<LoopDetail>();
  const [preview,setPreview]=useState<LoopDraft>();const [error,setError]=useState<string>();const [busy,setBusy]=useState(false);
  const selectedId=useRef<string|undefined>(undefined);const generation=useRef(0);const active=useRef<AbortController|undefined>(undefined);
  const refresh=useCallback(async(signal?:AbortSignal)=>{const request=++generation.current;const id=selectedId.current;
    const [list,detail]=await Promise.allSettled([api.loops(signal),id?api.loop(id,signal):Promise.resolve(undefined)]);
    if(signal?.aborted||request!==generation.current)return;
    let failed=false;
    if(list.status==="fulfilled")setLoops(list.value.loops);else if((list.reason as Error).name!=="AbortError"){failed=true;setError(list.reason instanceof Error?list.reason.message:"Loops unavailable");}
    if(detail.status==="fulfilled"&&detail.value&&selectedId.current===id)setSelected(detail.value);
    else if(detail.status==="rejected"&&(detail.reason as Error).name!=="AbortError"){failed=true;setError(detail.reason instanceof Error?detail.reason.message:"History unavailable");}
    if(!failed)setError(undefined);
  },[]);
  useEffect(()=>{const poll=()=>{active.current?.abort();const controller=new AbortController();active.current=controller;void refresh(controller.signal)};poll();const interval=window.setInterval(poll,3_000);
    return()=>{active.current?.abort();window.clearInterval(interval);generation.current+=1};},[refresh]);
  const inspect=useCallback(async(loop:LoopSummary)=>{selectedId.current=loop.id;const request=++generation.current;
    try{const detail=await api.loop(loop.id);if(request===generation.current&&selectedId.current===loop.id){setSelected(detail);setError(undefined)}}
    catch(value){if(request===generation.current)setError(value instanceof Error?value.message:"History unavailable")}},[]);
  const draft=useCallback(async(body:unknown,surfaceError=true)=>{setBusy(true);if(surfaceError)setError(undefined);try{const next=await api.loopDraft(body);setPreview(next);return next}
    catch(value){if(surfaceError)setError(value instanceof Error?value.message:"Draft failed");throw value}finally{setBusy(false)}},[]);
  const confirm=useCallback(async()=>{if(!preview)return;setBusy(true);try{await api.loopConfirm({draftId:preview.id,digest:preview.digest,reason:preview.reason});setPreview(undefined);await refresh()}
    catch(value){setError(value instanceof Error?value.message:"Confirm failed")}finally{setBusy(false)}},[preview,refresh]);
  return{loops,selected,preview,error,busy,setPreview,refresh,inspect,draft,confirm};
}

function LoopDefinitionForm({editing,busy,reviewRef,onDraft,onCancel}:{editing?:LoopDetail;busy:boolean;reviewRef:React.RefObject<HTMLButtonElement|null>;
  onDraft:(declaration:LoopDeclaration,reason:string,opener:HTMLElement|null)=>void;onCancel:()=>void}){
  const submit=(event:React.FormEvent<HTMLFormElement>)=>{event.preventDefault();const data=new FormData(event.currentTarget);
    const declaration:LoopDeclaration={version:1,name:String(data.get("name")),description:String(data.get("description")),trigger:{kind:"fixed-interval",everyMinutes:Number(data.get("everyMinutes")),startsAt:new Date(String(data.get("startsAt"))).getTime()},
      task:{kind:"agent",role:String(data.get("role")) as "planner"|"implementer",objective:String(data.get("objective"))},harness:{runtime:String(data.get("runtime")) as "claude"|"claudex",profile:String(data.get("profile")) as "fable"|"sol"},
      maxConcurrency:Number(data.get("maxConcurrency")),budgetUsd:Number(data.get("budgetUsd")),timeoutMinutes:Number(data.get("timeoutMinutes")),maxRetries:Number(data.get("maxRetries")),enabled:editing?.enabled??false};
    onDraft(declaration,String(data.get("reason")),((event.nativeEvent as SubmitEvent).submitter as HTMLElement|null)??null)};
  return <form key={editing?.id??"new"} className="card section loop-form" onSubmit={submit}><h2>{editing?"Edit loop":"Define loop"}</h2>
    <label>Name <input name="name" required maxLength={80} defaultValue={editing?.name}/></label><label>Description <input name="description" maxLength={500} defaultValue={editing?.description}/></label>
    <label>Every minutes <input name="everyMinutes" type="number" min="15" max="10080" defaultValue={editing?.trigger.everyMinutes??60} required/></label><label>Starts at <input name="startsAt" type="datetime-local" defaultValue={editing?new Date(editing.trigger.startsAt).toISOString().slice(0,16):undefined} required/></label>
    <label>Task role <select name="role" defaultValue={editing?.task.role??"planner"}><option value="planner">Planner</option><option value="implementer">Implementer</option></select></label><label>Objective <textarea aria-label="Objective" name="objective" required maxLength={4000}/><small>{editing?"Re-enter the objective to edit this definition; stored execution text is never returned by the API.":"Required execution objective; omitted from read projections."}</small></label>
    <label>Runtime <select name="runtime" defaultValue={editing?.harness.runtime??"claude"}><option value="claude">Claude</option><option value="claudex">Claudex</option></select></label><label>Profile <select name="profile" defaultValue={editing?.harness.profile??"sol"}><option value="sol">Sol</option><option value="fable">Fable</option></select></label>
    <label>Concurrency <input name="maxConcurrency" type="number" min="1" max="4" defaultValue={editing?.maxConcurrency??1}/></label><label>Budget USD <input name="budgetUsd" type="number" min="0.01" max="100" step="0.01" defaultValue={editing?.budgetUsd??5}/></label>
    <label>Timeout minutes <input name="timeoutMinutes" type="number" min="1" max="120" defaultValue={editing?.timeoutMinutes??30}/></label><label>Retries <input name="maxRetries" type="number" min="0" max="3" defaultValue={editing?.maxRetries??0}/></label><label>Reason <input name="reason" required maxLength={240}/></label>
    <button ref={reviewRef} disabled={busy}>Review definition</button>{editing&&<button type="button" onClick={onCancel}>Cancel edit</button>}</form>;
}

function LoopDefinitionsTable({loops,busy,canMutate,onInspect,onReason}:{loops:LoopSummary[];busy:boolean;canMutate:boolean;onInspect:(loop:LoopSummary)=>void;onReason:(kind:ReasonKind,loop:LoopSummary)=>void}){
  return <section className="card section"><h2>Definitions</h2><DataTable caption="Loop definitions" rows={loops} rowKey={row=>row.id} empty="No loops defined." columns={[
    {key:"name",heading:"Loop",render:row=><button className="link-button" onClick={()=>onInspect(row)}>{row.name}</button>},{key:"schedule",heading:"Schedule",render:row=><>{row.trigger.everyMinutes} minutes<small>Next {time(row.nextDueAt)}</small></>},
    {key:"policy",heading:"Policy",render:row=>`$${row.budgetUsd} · ${row.timeoutMinutes}m · ${row.maxRetries} retries`},{key:"state",heading:"State",render:row=><><StatusBadge status={row.blockedReason??(row.enabled?"enabled":"disabled")}/>{canMutate&&<button disabled={busy} onClick={()=>onReason(row.enabled?"disable":"enable",row)}>{row.enabled?"Disable":"Enable"}</button>}</>}]}/></section>;
}

function LoopOccurrenceDetail({loop,canMutate,onEdit,onReason,onRunId}:{loop:LoopDetail;canMutate:boolean;onEdit:()=>void;onReason:(kind:ReasonKind,loop:LoopSummary)=>void;onRunId:(id:string)=>void}){
  return <section className="card section"><h2>{loop.name} occurrence history</h2>{canMutate&&<button type="button" onClick={onEdit}>Edit definition</button>}{canMutate&&loop.cleanups?.some(row=>row.status==="retained"||row.status==="failed")&&<button type="button" onClick={()=>onReason("cleanup.retry",loop)}>Retry cleanup</button>}{loop.blockedReason&&<p role="status">Blocked: {loop.blockedReason}</p>}<DataTable caption="Loop occurrence history" rows={loop.occurrences} rowKey={row=>row.id} empty="No occurrences yet." columns={[
    {key:"run",heading:"Run",render:row=><button className="link-button" onClick={()=>onRunId(row.runId)}>{time(row.scheduledFor)}</button>},{key:"status",heading:"Status",render:row=><StatusBadge status={row.status}/>},{key:"outcome",heading:"Outcome",render:row=>row.outcome??row.error??"Pending"}]}/></section>;
}

export function LoopsPage({capability,onRunId}:{capability:CapabilityState;onRunId:(id:string)=>void}){
  const controller=useLoopController();const [editing,setEditing]=useState<LoopDetail>();const [reasonAction,setReasonAction]=useState<{kind:ReasonKind;loop:LoopSummary}>();
  const [actionReason,setActionReason]=useState("");const [reasonError,setReasonError]=useState<string>();const confirmationOpener=useRef<HTMLElement|null>(null);const reviewRef=useRef<HTMLButtonElement|null>(null);
  const canMutate=capability==="local-trusted";
  const requestReason=(kind:ReasonKind,loop:LoopSummary)=>{confirmationOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setActionReason("");setReasonError(undefined);setReasonAction({kind,loop})};
  const reasonSubmit=async(event:React.FormEvent)=>{event.preventDefault();if(!reasonAction)return;const reason=actionReason.trim();if(!reason){setReasonError("A reason is required");return}if(reason.length>240){setReasonError("Reason must be 240 characters or fewer");return}
    try{await controller.draft({kind:reasonAction.kind,loopId:reasonAction.loop.id,expectedRevision:reasonAction.loop.revision,reason},false);setReasonAction(undefined);setActionReason("")}catch(value){setReasonError(value instanceof Error?value.message:"Draft failed")}};
  return <><header className="page-head"><div><p className="eyebrow">Define → Enable → Observe</p><h1>Loops</h1><p>Bounded fixed-interval local agent work.</p></div></header>{controller.error&&<div role="alert" className="alert">{controller.error}</div>}
    {!canMutate&&<CapabilityNotice capability={capability}/>}<div className="loops-layout">{canMutate&&<LoopDefinitionForm editing={editing} busy={controller.busy} reviewRef={reviewRef} onCancel={()=>setEditing(undefined)} onDraft={(declaration,reason,opener)=>{confirmationOpener.current=opener;void controller.draft({kind:editing?"update":"create",...(editing?{loopId:editing.id,expectedRevision:editing.revision}:{}),reason,declaration})}}/>}
      <LoopDefinitionsTable loops={controller.loops} busy={controller.busy} canMutate={canMutate} onInspect={loop=>void controller.inspect(loop)} onReason={requestReason}/></div>
    {controller.selected&&<LoopOccurrenceDetail loop={controller.selected} canMutate={canMutate} onEdit={()=>setEditing(controller.selected)} onReason={requestReason} onRunId={onRunId}/>}
    {reasonAction&&canMutate&&<Modal titleId="loop-reason-title" busy={controller.busy} onDismiss={()=>{setReasonAction(undefined);setReasonError(undefined)}}><form onSubmit={event=>void reasonSubmit(event)}><h2 id="loop-reason-title">Reason to {reasonAction.kind==="cleanup.retry"?"retry cleanup":reasonAction.kind} {reasonAction.loop.name}</h2><p>This bounded reason is recorded in immutable loop audit history.</p>{reasonError&&<div className="alert" role="alert">{reasonError}</div>}<label>Operator reason <input data-modal-initial-focus value={actionReason} onChange={event=>setActionReason(event.target.value)} maxLength={240} aria-describedby="loop-reason-help"/></label><small id="loop-reason-help">Required · 240 characters maximum</small><div className="actions"><button type="button" disabled={controller.busy} onClick={()=>{setReasonAction(undefined);setReasonError(undefined)}}>Cancel</button><button type="submit" disabled={controller.busy}>{controller.busy?"Reviewing…":"Review change"}</button></div></form></Modal>}
    {controller.preview&&canMutate&&<ConfirmDialog digest={controller.preview.digest} reason={controller.preview.reason} busy={controller.busy} returnFocus={()=>confirmationOpener.current?.isConnected?confirmationOpener.current:reviewRef.current} onCancel={()=>controller.setPreview(undefined)} onConfirm={()=>void controller.confirm()}/>}</>;
}
