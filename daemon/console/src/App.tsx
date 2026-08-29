import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ConfigurationSnapshot, type Dependencies, type DraftPreview, type LoopDeclaration, type LoopDraft, type LoopSummary, type Operation, type Overview, type RunDetail, type RunSummary, type Skills } from "./api";
import { DataTable } from "./components/DataTable";
import { Layout, type Page } from "./components/Layout";
import { RunTimeline, formatDuration } from "./components/RunTimeline";
import { isReadyStatus, StatusBadge } from "./components/StatusBadge";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Modal } from "./components/Modal";
import "./write.css";

const time = (value: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
const secretFields = [
  ["LINEAR_API_KEY", "Linear API key"], ["ARTIFACT_TOKEN", "Artifact token"],
  ["PLANNER_WEBHOOK_SECRET", "Planner webhook secret"], ["IMPLEMENTER_WEBHOOK_SECRET", "Implementer webhook secret"],
  ["PLANNER_LINEAR_CLIENT_SECRET", "Planner Linear client secret"],
  ["IMPLEMENTER_LINEAR_CLIENT_SECRET", "Implementer Linear client secret"],
] as const;
type CapabilityState = "loading" | "read-only" | "local-trusted" | "unavailable";

function CapabilityNotice({ capability }: { capability: Exclude<CapabilityState, "local-trusted"> }) {
  const message = capability === "loading" ? "Checking local console capability…"
    : capability === "read-only" ? "Read-only mode. Observation and history remain available; mutation controls are hidden."
      : "Capability could not be verified. Observation and history remain available; mutation controls are hidden.";
  return <section className="offline" role="status"><h2>{capability === "loading" ? "Capability loading" : "Read-only access"}</h2><p>{message}</p></section>;
}

export function App() {
  const [page, setPage] = useState<Page>("overview");
  const [overview, setOverview] = useState<Overview>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<RunDetail>();
  const [dependencies, setDependencies] = useState<Dependencies>();
  const [skills, setSkills] = useState<Skills>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [capability, setCapability] = useState<CapabilityState>("loading");
  const selectedId = useRef<string | undefined>(undefined);
  const detailRequest = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const id = selectedId.current;
    const request = id ? ++detailRequest.current : 0;
    const detail = id ? api.run(id, signal).then(
      value => ({ ok: true as const, value }),
      reason => ({ ok: false as const, reason }),
    ) : Promise.resolve(undefined);
    try {
      const [nextOverview, nextRuns, nextDependencies, nextSkills, nextDetail] = await Promise.all([
        api.overview(signal), api.runs(signal), api.dependencies(signal), api.skills(signal), detail,
      ]);
      setOverview(nextOverview); setRuns(nextRuns.runs); setDependencies(nextDependencies); setSkills(nextSkills); setError(undefined);
      if (id && nextDetail && selectedId.current === id && detailRequest.current === request) {
        if (nextDetail.ok) {
          if (nextDetail.value.id === id) setSelected(nextDetail.value);
        } else if ((nextDetail.reason as Error).name !== "AbortError") {
          setError(nextDetail.reason instanceof Error ? nextDetail.reason.message : "Run detail is unavailable");
        }
      }
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setError(reason instanceof Error ? reason.message : "Console data is unavailable");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController(); void refresh(controller.signal);
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    void api.bootstrap(controller.signal).then(value => setCapability(value.capability), reason => {
      if ((reason as Error).name !== "AbortError") setCapability("unavailable");
    });
    return () => controller.abort();
  }, []);

  const chooseRun = async (run: RunSummary) => {
    const id = run.id; const request = ++detailRequest.current;
    selectedId.current = id; setSelected(current => current?.id === id ? current : undefined);
    setPage("runs"); setError(undefined);
    try {
      const nextSelected = await api.run(id);
      if (selectedId.current === id && detailRequest.current === request && nextSelected.id === id)
        setSelected(nextSelected);
    } catch (reason) {
      if (selectedId.current === id && detailRequest.current === request && (reason as Error).name !== "AbortError")
        setError(reason instanceof Error ? reason.message : "Run detail is unavailable");
    }
  };

  return <Layout page={page} onPage={setPage}>
    {error && <div className="alert" role="alert"><strong>Console data unavailable.</strong> {error} <button type="button" onClick={() => void refresh()}>Retry</button></div>}
    {overview?.dependencies.status === "degraded" && <section className="offline" role="status" aria-labelledby="dependency-warning-title">
      <h2 id="dependency-warning-title">Dependency health degraded</h2>
      <p>One or more configured dependencies is unavailable, stale, future-dated, or has not been observed.</p>
    </section>}
    {loading && !overview ? <div className="loading" role="status">Loading console…</div> : page === "overview"
      ? <OverviewPage overview={overview} onRun={chooseRun} /> : page === "runs"
        ? <RunsPage runs={runs} selected={selected} onRun={chooseRun} /> : page === "loops" ? <LoopsPage capability={capability} onRunId={id=>void chooseRun({id} as RunSummary)} /> : page === "dependencies"
          ? <DependenciesPage snapshot={dependencies} /> : page === "skills" ? <SkillsPage inventory={skills} />
            : page === "configuration" ? <ConfigurationPage capability={capability} /> : <OperationsPage capability={capability} />}
  </Layout>;
}

function LoopsPage({capability,onRunId}:{capability:CapabilityState;onRunId:(id:string)=>void}){
  const [loops,setLoops]=useState<LoopSummary[]>([]);const [selected,setSelected]=useState<Awaited<ReturnType<typeof api.loop>>>();
  const [editing,setEditing]=useState<Awaited<ReturnType<typeof api.loop>>>();
  const [preview,setPreview]=useState<LoopDraft>();const [error,setError]=useState<string>();const [busy,setBusy]=useState(false);
  const confirmationOpener=useRef<HTMLElement|null>(null);
  const definitionReviewOpener=useRef<HTMLButtonElement|null>(null);
  const [reasonAction,setReasonAction]=useState<{kind:"enable"|"disable"|"cleanup.retry";loop:LoopSummary}>();const [actionReason,setActionReason]=useState("");const [reasonError,setReasonError]=useState<string>();
  const load=useCallback(()=>api.loops().then(value=>{setLoops(value.loops);setError(undefined)},value=>setError(value instanceof Error?value.message:"Loops unavailable")),[]);
  useEffect(()=>{void load();},[load]);
  const draft=async(event:React.FormEvent<HTMLFormElement>)=>{event.preventDefault();confirmationOpener.current=((event.nativeEvent as SubmitEvent).submitter as HTMLElement|null)??(document.activeElement instanceof HTMLElement?document.activeElement:null);setBusy(true);setError(undefined);const data=new FormData(event.currentTarget);
    const declaration:LoopDeclaration={version:1,name:String(data.get("name")),description:String(data.get("description")),trigger:{kind:"fixed-interval",everyMinutes:Number(data.get("everyMinutes")),startsAt:new Date(String(data.get("startsAt"))).getTime()},
      task:{kind:"agent",role:String(data.get("role")) as "planner"|"implementer",objective:String(data.get("objective"))},harness:{runtime:String(data.get("runtime")) as "claude"|"claudex",profile:String(data.get("profile")) as "fable"|"sol"},
      maxConcurrency:Number(data.get("maxConcurrency")),budgetUsd:Number(data.get("budgetUsd")),timeoutMinutes:Number(data.get("timeoutMinutes")),maxRetries:Number(data.get("maxRetries")),enabled:editing?.enabled??false};
    try{setPreview(await api.loopDraft({kind:editing?"update":"create",...(editing?{loopId:editing.id,expectedRevision:editing.revision}:{}),reason:String(data.get("reason")),declaration}));}catch(value){setError(value instanceof Error?value.message:"Draft failed");}finally{setBusy(false)}};
  const confirm=async()=>{if(!preview)return;setBusy(true);try{await api.loopConfirm({draftId:preview.id,digest:preview.digest,reason:preview.reason});const loopId=preview.loopId;setPreview(undefined);await load();if(selected?.id===loopId)setSelected(await api.loop(loopId));}catch(value){setError(value instanceof Error?value.message:"Confirm failed");}finally{setBusy(false)}};
  const requestReason=(kind:"enable"|"disable"|"cleanup.retry",loop:LoopSummary)=>{confirmationOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setActionReason("");setReasonError(undefined);setReasonAction({kind,loop});};
  const draftReasoned=async(event:React.FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!reasonAction)return;const reason=actionReason.trim();
    if(!reason){setReasonError("A reason is required");return;}if(reason.length>240){setReasonError("Reason must be 240 characters or fewer");return;}
    setBusy(true);setError(undefined);setReasonError(undefined);try{setPreview(await api.loopDraft({kind:reasonAction.kind,loopId:reasonAction.loop.id,expectedRevision:reasonAction.loop.revision,reason}));setReasonAction(undefined);setActionReason("");}
    catch(value){setReasonError(value instanceof Error?value.message:"Draft failed");}finally{setBusy(false)}};
  const inspect=async(loop:LoopSummary)=>{try{setSelected(await api.loop(loop.id));}catch(value){setError(value instanceof Error?value.message:"History unavailable")}};
  return <><header className="page-head"><div><p className="eyebrow">Define → Enable → Observe</p><h1>Loops</h1><p>Bounded fixed-interval local agent work.</p></div></header>{error&&<div role="alert" className="alert">{error}</div>}
    {capability!=="local-trusted"&&<CapabilityNotice capability={capability}/>}<div className="loops-layout">{capability==="local-trusted"&&<form key={editing?.id??"new"} className="card section loop-form" onSubmit={event=>void draft(event)}><h2>{editing?"Edit loop":"Define loop"}</h2>
      <label>Name <input name="name" required maxLength={80} defaultValue={editing?.name}/></label><label>Description <input name="description" maxLength={500} defaultValue={editing?.description}/></label>
      <label>Every minutes <input name="everyMinutes" type="number" min="15" max="10080" defaultValue={editing?.trigger.everyMinutes??60} required/></label><label>Starts at <input name="startsAt" type="datetime-local" defaultValue={editing?new Date(editing.trigger.startsAt).toISOString().slice(0,16):undefined} required/></label>
      <label>Task role <select name="role" defaultValue={editing?.task.role??"planner"}><option value="planner">Planner</option><option value="implementer">Implementer</option></select></label><label>Objective <textarea aria-label="Objective" name="objective" required maxLength={4000}/><small>{editing?"Re-enter the objective to edit this definition; stored execution text is never returned by the API.":"Required execution objective; omitted from read projections."}</small></label>
      <label>Runtime <select name="runtime" defaultValue={editing?.harness.runtime??"claude"}><option value="claude">Claude</option><option value="claudex">Claudex</option></select></label><label>Profile <select name="profile" defaultValue={editing?.harness.profile??"sol"}><option value="sol">Sol</option><option value="fable">Fable</option></select></label>
      <label>Concurrency <input name="maxConcurrency" type="number" min="1" max="4" defaultValue={editing?.maxConcurrency??1}/></label><label>Budget USD <input name="budgetUsd" type="number" min="0.01" max="100" step="0.01" defaultValue={editing?.budgetUsd??5}/></label>
      <label>Timeout minutes <input name="timeoutMinutes" type="number" min="1" max="120" defaultValue={editing?.timeoutMinutes??30}/></label><label>Retries <input name="maxRetries" type="number" min="0" max="3" defaultValue={editing?.maxRetries??0}/></label><label>Reason <input name="reason" required maxLength={240}/></label>
      <button ref={definitionReviewOpener} disabled={busy}>Review definition</button>{editing&&<button type="button" onClick={()=>setEditing(undefined)}>Cancel edit</button>}</form>}<section className="card section"><h2>Definitions</h2><DataTable caption="Loop definitions" rows={loops} rowKey={row=>row.id} empty="No loops defined." columns={[
        {key:"name",heading:"Loop",render:row=><button className="link-button" onClick={()=>void inspect(row)}>{row.name}</button>},{key:"schedule",heading:"Schedule",render:row=><>{row.trigger.everyMinutes} minutes<small>Next {time(row.nextDueAt)}</small></>},
        {key:"policy",heading:"Policy",render:row=>`$${row.budgetUsd} · ${row.timeoutMinutes}m · ${row.maxRetries} retries`},{key:"state",heading:"State",render:row=><><StatusBadge status={row.blockedReason??(row.enabled?"enabled":"disabled")}/>{capability==="local-trusted"&&<button disabled={busy} onClick={()=>requestReason(row.enabled?"disable":"enable",row)}>{row.enabled?"Disable":"Enable"}</button>}</>}]}/></section></div>
    {selected&&<section className="card section"><h2>{selected.name} occurrence history</h2>{capability==="local-trusted"&&<button type="button" onClick={()=>setEditing(selected)}>Edit definition</button>}{capability==="local-trusted"&&selected.cleanups?.some(row=>row.status==="retained"||row.status==="failed")&&<button type="button" onClick={()=>requestReason("cleanup.retry",selected)}>Retry cleanup</button>}{selected.blockedReason&&<p role="status">Blocked: {selected.blockedReason}</p>}<DataTable caption="Loop occurrence history" rows={selected.occurrences} rowKey={row=>row.id} empty="No occurrences yet." columns={[
      {key:"run",heading:"Run",render:row=><button className="link-button" onClick={()=>onRunId(row.runId)}>{time(row.scheduledFor)}</button>},{key:"status",heading:"Status",render:row=><StatusBadge status={row.status}/>},{key:"outcome",heading:"Outcome",render:row=>row.outcome??row.error??"Pending"}]}/></section>}
    {reasonAction&&capability==="local-trusted"&&<Modal titleId="loop-reason-title" busy={busy} onDismiss={()=>{setReasonAction(undefined);setReasonError(undefined)}}><form onSubmit={event=>void draftReasoned(event)}>
      <h2 id="loop-reason-title">Reason to {reasonAction.kind==="cleanup.retry"?"retry cleanup":reasonAction.kind} {reasonAction.loop.name}</h2><p>This bounded reason is recorded in immutable loop audit history.</p>
      {reasonError&&<div className="alert" role="alert">{reasonError}</div>}<label>Operator reason <input data-modal-initial-focus value={actionReason} onChange={event=>setActionReason(event.target.value)} maxLength={240} aria-describedby="loop-reason-help"/></label><small id="loop-reason-help">Required · 240 characters maximum</small>
      <div className="actions"><button type="button" disabled={busy} onClick={()=>{setReasonAction(undefined);setReasonError(undefined)}}>Cancel</button><button type="submit" disabled={busy}>{busy?"Reviewing…":"Review change"}</button></div></form></Modal>}
    {preview&&capability==="local-trusted"&&<ConfirmDialog digest={preview.digest} reason={preview.reason} busy={busy} returnFocus={()=>confirmationOpener.current?.isConnected?confirmationOpener.current:definitionReviewOpener.current} onCancel={()=>setPreview(undefined)} onConfirm={()=>void confirm()}/>}</>;
}

function ConfigurationPage({capability}:{capability:CapabilityState}) {
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>(); const [preview, setPreview] = useState<DraftPreview>();
  const [reason, setReason] = useState(""); const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>(); const [busy, setBusy] = useState(false);
  const confirmationOpener=useRef<HTMLElement|null>(null);
  useEffect(() => { void api.configuration().then(setSnapshot, value => setError(value instanceof Error ? value.message : "Configuration unavailable")); }, []);
  const draft = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!snapshot) return; confirmationOpener.current=((event.nativeEvent as SubmitEvent).submitter as HTMLElement|null)??(document.activeElement instanceof HTMLElement?document.activeElement:null);setBusy(true); setError(undefined);
    const data = new FormData(event.currentTarget); const changes: Record<string, unknown> = {};
    for (const key of ["plannerHarness", "implementerHarness"]) { const value = data.get(key); if (value && value !== snapshot.settings[key]) changes[key] = value; }
    for (const key of ["sessionConcurrency", "iosSimMaxConcurrent", "claudeMaxTurns", "doMaxTurns"]) {
      const value = Number(data.get(key)); if (value !== snapshot.settings[key]) changes[key] = value;
    }
    const budget = String(data.get("doMaxBudgetUsd") ?? "").trim(); const budgetValue = budget ? Number(budget) : null;
    if (budgetValue !== snapshot.settings.doMaxBudgetUsd) changes.doMaxBudgetUsd = budgetValue;
    const mcp = String(data.get("mcpEnvPassthrough") ?? "").split(",").map(value => value.trim()).filter(Boolean);
    if (JSON.stringify(mcp) !== JSON.stringify(snapshot.settings.mcpEnvPassthrough)) changes.mcpEnvPassthrough = mcp;
    for (const key of ["browserEnabled", "iosSimEnabled", "attachmentsEnabled"]) { const value = data.get(key) === "on"; if (value !== snapshot.settings[key]) changes[key] = value; }
    const ntfyUrl = String(data.get("ntfyUrl") ?? "").trim() || null; if (ntfyUrl !== snapshot.settings.ntfyUrl) changes.ntfyUrl = ntfyUrl;
    const submittedSecrets = Object.fromEntries(secretFields.flatMap(([name]) => secrets[name] ? [[name, secrets[name]]] : []));
    try { const next = await api.draft({ kind: "config.apply", reason, changes,
      secrets: submittedSecrets }); setPreview(next); setSecrets({}); }
    catch (value) { setError(value instanceof Error ? value.message : "Preview failed"); } finally { setBusy(false); } };
  const draftOperation = async (kind: "daemon.restart" | "daemon.reload") => { confirmationOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;if (!reason) { setError("A reason is required"); return; }
    setBusy(true); try { setPreview(await api.draft({ kind, reason })); } catch (value) { setError(value instanceof Error ? value.message : "Preview failed"); } finally { setBusy(false); } };
  const confirm = async () => { if (!preview) return; setBusy(true); try { await api.confirm({ draftId: preview.id, digest: preview.digest, reason: preview.reason }); setPreview(undefined); setReason(""); setSnapshot(await api.configuration()); }
    catch (value) { setError(value instanceof Error ? value.message : "Apply failed"); } finally { setBusy(false); } };
  if (!snapshot) return <><header className="page-head"><div><h1>Configuration</h1></div></header>
    {capability!=="local-trusted"&&<CapabilityNotice capability={capability}/>} {error ? <div role="alert" className="alert">{error}</div> : <div className="loading">Loading configuration…</div>}</>;
  return <><header className="page-head"><div><p className="eyebrow">Validated local settings</p><h1>Configuration</h1><p>Snapshot generated {time(snapshot.generatedAt)} · fresh until {time(snapshot.staleAt)}</p></div></header>
    {error && <div className="alert" role="alert">{error}</div>}{capability!=="local-trusted"&&<CapabilityNotice capability={capability}/>} {capability!=="local-trusted"&&<section className="card section"><h2>Current configuration</h2><dl><dt>Planner harness</dt><dd>{String(snapshot.settings.plannerHarness)}</dd><dt>Implementer harness</dt><dd>{String(snapshot.settings.implementerHarness)}</dd><dt>Session concurrency</dt><dd>{String(snapshot.settings.sessionConcurrency)}</dd><dt>Snapshot revision</dt><dd><code>{snapshot.revision}</code></dd></dl></section>}{capability==="local-trusted"&&<form className="card section" onSubmit={event => void draft(event)}>
      <h2>Harnesses</h2><label>Planner harness <select name="plannerHarness" defaultValue={String(snapshot.settings.plannerHarness)}><option value="claude">Claude</option><option value="claudex">Claudex</option></select></label>
      <label>Implementer harness <select name="implementerHarness" defaultValue={String(snapshot.settings.implementerHarness)}><option value="claude">Claude</option><option value="claudex">Claudex</option></select></label>
      <h2>Concurrency &amp; budgets</h2>
      <label>Session concurrency <input name="sessionConcurrency" type="number" min="1" max="32" defaultValue={Number(snapshot.settings.sessionConcurrency)} /></label>
      <label>Simulator concurrency <input name="iosSimMaxConcurrent" type="number" min="1" max="16" defaultValue={Number(snapshot.settings.iosSimMaxConcurrent)} /></label>
      <label>Claude max turns <input name="claudeMaxTurns" type="number" min="1" max="1000" defaultValue={Number(snapshot.settings.claudeMaxTurns)} /></label>
      <label>/do max turns <input name="doMaxTurns" type="number" min="1" max="1000" defaultValue={Number(snapshot.settings.doMaxTurns)} /></label>
      <label>/do budget USD <input name="doMaxBudgetUsd" type="number" min="0.01" step="0.01" defaultValue={snapshot.settings.doMaxBudgetUsd === null ? "" : Number(snapshot.settings.doMaxBudgetUsd)} /></label>
      <h2>MCP environment</h2><label>Allowed variable names <input name="mcpEnvPassthrough" defaultValue={(snapshot.settings.mcpEnvPassthrough as string[]).join(", ")} /></label>
      <h2>Browser &amp; simulator</h2>
      <label><input name="browserEnabled" type="checkbox" defaultChecked={Boolean(snapshot.settings.browserEnabled)} /> Browser enabled</label>
      <label><input name="iosSimEnabled" type="checkbox" defaultChecked={Boolean(snapshot.settings.iosSimEnabled)} /> iOS simulator enabled</label>
      <label><input name="attachmentsEnabled" type="checkbox" defaultChecked={Boolean(snapshot.settings.attachmentsEnabled)} /> Attachments enabled</label>
      <h2>Notifications</h2><label>Notification URL <input name="ntfyUrl" type="url" defaultValue={String(snapshot.settings.ntfyUrl ?? "")} /></label>
      <h2>Secrets</h2><p>Current values are never displayed. Entering a new value rotates only that secret.</p>
      {secretFields.map(([name, label]) => <div key={name} className="secret-field">
        <p>{label}: {snapshot.secrets[name]?.configured ? "Configured" : "Not configured"}</p>
        <label>New {label} <input type="password" autoComplete="off" value={secrets[name] ?? ""}
          onChange={event => setSecrets(current => ({ ...current, [name]: event.target.value }))} /></label>
      </div>)}
      <label>Reason <input required maxLength={240} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button type="submit" disabled={busy}>Review changes</button>
      <div className="actions"><button type="button" disabled={busy} onClick={() => void draftOperation("daemon.restart")}>Review restart</button>
        <button type="button" disabled={busy} onClick={() => void draftOperation("daemon.reload")}>Review reload</button></div></form>}
    {preview && capability==="local-trusted" && <section className="card section"><h2>Redacted preview</h2><p>{preview.changedFields.join(", ") || "Secret change"} · {preview.restartRequired ? "Restart required" : "Reload"}</p>
      {Object.entries(preview.secrets).map(([name, state]) => <p key={name}>{name}: {state}</p>)}</section>}
    {preview && capability==="local-trusted" && <ConfirmDialog digest={preview.digest} reason={preview.reason} busy={busy} returnFocus={confirmationOpener.current} onCancel={() => setPreview(undefined)} onConfirm={() => void confirm()} />}</>;
}

function OperationsPage({capability}:{capability:CapabilityState}) {
  const [operations, setOperations] = useState<Operation[]>([]); const [error, setError] = useState<string>();
  const load = useCallback(() => api.operations().then(value => { setOperations(value.operations); setError(undefined); }, value => setError(value instanceof Error ? value.message : "Operations unavailable")), []);
  useEffect(() => { void load(); const interval = window.setInterval(() => void load(), 3_000); return () => window.clearInterval(interval); }, [load]);
  const control = async (operation: Operation, kind: "retry" | "cancel") => { try { await api.control(operation, kind, `${kind} requested from local console`); await load(); }
    catch (value) { setError(value instanceof Error ? value.message : "Control failed"); } };
  return <><header className="page-head"><div><p className="eyebrow">Durable audit</p><h1>Operations</h1><p>Progress, health acceptance, rollback, and recovery for local maintenance.</p></div></header>
    {error && <div className="alert" role="alert">{error}</div>}{capability!=="local-trusted"&&<CapabilityNotice capability={capability}/>}<section className="card section"><DataTable caption="Operation history" rows={operations} rowKey={row => row.id} empty="No operations have been recorded." columns={[
      { key: "kind", heading: "Operation", render: row => <><strong>{row.kind}</strong><small>{row.actor} · {row.reason}</small></> },
      { key: "state", heading: "Progress", render: row => <><StatusBadge status={row.state} /><small>{row.stage ?? "scheduled"} · {row.events.length} stages</small></> },
      { key: "outcome", heading: "Outcome", render: row => row.outcome ?? "In progress" },
      { key: "actions", heading: "Recovery", render: row => capability==="local-trusted"?<div className="actions">{row.recoveryActions.includes("retry") && <button type="button" onClick={() => void control(row, "retry")}>Retry</button>}{row.recoveryActions.includes("cancel") && <button type="button" onClick={() => void control(row, "cancel")}>Cancel</button>}</div>:"Read-only" },
    ]} /></section></>;
}

function OverviewPage({ overview, onRun }: { overview?: Overview; onRun: (run: RunSummary) => void }) {
  if (!overview) return <div className="empty">No console snapshot is available.</div>;
  return <>
    <header className="page-head"><div><p className="eyebrow">System snapshot</p><h1>Overview</h1><p>Observed {time(overview.observedAt)}</p></div><StatusBadge status={overview.daemon.status} /></header>
    {overview.daemon.status === "offline" && <section className="offline" aria-labelledby="offline-title"><h2 id="offline-title">Daemon offline</h2><p>The console is available, but the webhook daemon did not answer its local health probe at {time(overview.daemon.observedAt)}.</p></section>}
    <section className="metric-grid" aria-label="Current status">
      <article className="card metric"><span>Daemon</span><strong>{overview.daemon.status}</strong><small>Local health probe</small></article>
      <article className="card metric"><span>Active runs</span><strong>{overview.activeRuns}</strong><small>{overview.operations.runningTurns} running turns</small></article>
      <article className="card metric"><span>Providers</span><strong>{overview.providers.filter(provider => isReadyStatus(provider.status)).length}/{overview.providers.length}</strong><small>Ready now</small></article>
      <article className="card metric"><span>Operation</span><strong>{overview.operations.pending?.type ?? "Idle"}</strong><small>{overview.operations.pending?.stage ?? "No active mutation"}</small></article>
      <article className="card metric"><span>Dependencies</span><strong>{overview.dependencies.status}</strong><small>{overview.dependencies.configured} configured · {overview.dependencies.total} known</small></article>
    </section>
    <div className="overview-grid">
      <section className="card section"><div className="section-head"><div><p className="eyebrow">Activity</p><h2>Recent runs</h2></div></div><RunsTable runs={overview.recentRuns} onRun={onRun} /></section>
      <section className="card section"><p className="eyebrow">Providers</p><h2>Provider readiness</h2>{overview.providers.length ? <ul className="provider-list">{overview.providers.map(provider => <li key={provider.provider}><div><strong>{provider.provider}</strong><small>{provider.reason ?? `Updated ${time(provider.updatedAt)}`}</small></div><StatusBadge status={provider.status} /></li>)}</ul> : <div className="empty">No provider probes have been recorded.</div>}</section>
    </div>
  </>;
}

function DependenciesPage({ snapshot }: { snapshot?: Dependencies }) {
  if (!snapshot) return <div className="empty">No dependency snapshot is available.</div>;
  return <><header className="page-head"><div><p className="eyebrow">Read-only health</p><h1>MCP &amp; Harnesses</h1><p>Observed {time(snapshot.observedAt)}. Configuration and execution are unavailable here.</p></div><StatusBadge status={snapshot.status} /></header>
    {snapshot.daemon.status === "offline" && <section className="offline"><h2>Daemon offline</h2><p>Saved observations remain visible, but current dependency health is degraded.</p></section>}
    <section className="card section"><h2>MCP and harness readiness</h2><DataTable caption="Dependency readiness" rows={snapshot.dependencies}
      rowKey={row => `${row.kind}:${row.name}`} empty="No dependency observations are available." columns={[
        { key: "name", heading: "Dependency", render: row => <><strong>{row.name}</strong><small>{row.kind.toUpperCase()}</small></> },
        { key: "status", heading: "Current status", render: row => <><StatusBadge status={row.status} /><small>Last probe: {row.lastStatus.replaceAll("_", " ")}{row.reasonCode ? ` · ${row.reasonCode.replaceAll("_", " ")}` : ""}</small></> },
        { key: "configured", heading: "Configured", render: row => row.configured === null ? "Unknown" : row.configured ? "Yes" : "No" },
        { key: "capabilities", heading: "Capabilities", render: row => capabilitySummary(row.capabilities) },
        { key: "observed", heading: "Freshness", render: row => row.observedAt === null ? "Never observed" : <>{time(row.observedAt)}<small>{row.staleAt === null ? "No deadline" : `Stale after ${time(row.staleAt)}`}</small></> },
      ]} /></section></>;
}

function capabilitySummary(capabilities: Record<string, string | number | boolean | null>) {
  const values = Object.entries(capabilities);
  return values.length ? values.map(([key, value]) => `${key}: ${String(value)}`).join(" · ") : "—";
}

function SkillsPage({ inventory }: { inventory?: Skills }) {
  if (!inventory) return <div className="empty">No skills inventory is available.</div>;
  if (inventory.availability === "unavailable") return <><header className="page-head"><div><p className="eyebrow">Installed metadata</p><h1>Skills</h1></div><StatusBadge status="unavailable" /></header>
    <section className="offline"><h2>Inventory unavailable</h2><p>The bounded installed manifest could not be read ({inventory.reasonCode.replaceAll("_", " ")}).</p></section></>;
  return <><header className="page-head"><div><p className="eyebrow">Installed metadata</p><h1>Skills</h1><p>Read-only inventory at source revision <code>{inventory.sourceRevision}</code></p></div><StatusBadge status="available" /></header>
    <section className="metric-grid" aria-label="Inventory sources">{inventory.sources.map(source => <article className="card metric" key={source.id}><span>{source.label}</span><strong>{source.skillCount}</strong><small>{source.available ? "Inventory available" : "Source unavailable"}</small></article>)}</section>
    <section className="card section"><h2>Available skills</h2><DataTable caption="Installed skill inventory" rows={inventory.skills}
      rowKey={skill => skill.name} empty="No installed skills were found." columns={[
        { key: "name", heading: "Skill", render: skill => <><strong>{skill.name}</strong><small>{skill.description}</small></> },
        { key: "version", heading: "Version", render: skill => skill.version ?? "Not versioned" },
        { key: "compatibility", heading: "Compatibility", render: skill => skill.compatibility.map(value => value === "claude" ? "Claude Code" : "Codex").join(", ") },
        { key: "provenance", heading: "Provenance", render: skill => skill.provenance.join(", ") },
        { key: "availability", heading: "Availability", render: skill => <StatusBadge status={skill.availability} /> },
      ]} /></section></>;
}

function RunsPage({ runs, selected, onRun }: { runs: RunSummary[]; selected?: RunDetail; onRun: (run: RunSummary) => void }) {
  return <><header className="page-head"><div><p className="eyebrow">History</p><h1>Runs</h1><p>Safe, read-only execution records</p></div></header>
    <div className="runs-layout"><section className="card section"><h2>Run history</h2><RunsTable runs={runs} onRun={onRun} /></section>
      <section className="card section detail">{selected ? <RunDetailView run={selected} /> : <div className="empty">Select a run to inspect its invocation timeline and resources.</div>}</section></div></>;
}

function RunsTable({ runs, onRun }: { runs: RunSummary[]; onRun: (run: RunSummary) => void }) {
  return <DataTable caption="Run history" rows={runs} rowKey={run => run.id} empty="No runs have been recorded yet." columns={[
    { key: "issue", heading: "Run", render: run => <button type="button" className="link-button" onClick={() => onRun(run)}>{run.loopName ?? run.issueIdentifier ?? run.id}</button> },
    { key: "mode", heading: "Mode", render: run => <><strong>{run.mode}</strong><small>{run.app} · {run.runtime}</small></> },
    { key: "status", heading: "Status", render: run => <StatusBadge status={run.status} /> },
    { key: "duration", heading: "Duration", render: run => formatDuration(run.durationMs) },
    { key: "usage", heading: "Usage", render: run => <>{run.totalTokens.toLocaleString()}<small>{run.invocationCount} invocations</small></> },
  ]} />;
}

function RunDetailView({ run }: { run: RunDetail }) {
  return <><div className="section-head"><div><p className="eyebrow">Selected run</p><h2>{run.loopName ?? run.issueIdentifier ?? run.id}</h2><p>{time(run.startedAt)} · {formatDuration(run.durationMs)}</p></div><StatusBadge status={run.status} /></div>
    {run.resources.length > 0 && <div className="actions" aria-label="Run resources">{run.resources.map(resource => <a key={resource.label} href={resource.url} target="_blank" rel="noreferrer">Open {resource.label}</a>)}</div>}
    <dl className="run-facts"><div><dt>Runtime</dt><dd>{run.runtime}</dd></div><div><dt>Mode</dt><dd>{run.mode}</dd></div><div><dt>Total usage</dt><dd>{run.totalTokens.toLocaleString()} tokens</dd></div></dl>
    <RunTimeline invocations={run.invocations} /></>;
}
