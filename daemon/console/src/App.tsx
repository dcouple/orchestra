import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Dependencies, type Overview, type RunDetail, type RunSummary, type Skills } from "./api";
import { DataTable } from "./components/DataTable";
import { Layout, type Page } from "./components/Layout";
import { RunTimeline, formatDuration } from "./components/RunTimeline";
import { isReadyStatus, StatusBadge } from "./components/StatusBadge";

const time = (value: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);

export function App() {
  const [page, setPage] = useState<Page>("overview");
  const [overview, setOverview] = useState<Overview>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<RunDetail>();
  const [dependencies, setDependencies] = useState<Dependencies>();
  const [skills, setSkills] = useState<Skills>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
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
        ? <RunsPage runs={runs} selected={selected} onRun={chooseRun} /> : page === "dependencies"
          ? <DependenciesPage snapshot={dependencies} /> : <SkillsPage inventory={skills} />}
  </Layout>;
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
    { key: "issue", heading: "Run", render: run => <button type="button" className="link-button" onClick={() => onRun(run)}>{run.issueIdentifier ?? run.id}</button> },
    { key: "mode", heading: "Mode", render: run => <><strong>{run.mode}</strong><small>{run.app} · {run.runtime}</small></> },
    { key: "status", heading: "Status", render: run => <StatusBadge status={run.status} /> },
    { key: "duration", heading: "Duration", render: run => formatDuration(run.durationMs) },
    { key: "usage", heading: "Usage", render: run => <>{run.totalTokens.toLocaleString()}<small>{run.invocationCount} invocations</small></> },
  ]} />;
}

function RunDetailView({ run }: { run: RunDetail }) {
  return <><div className="section-head"><div><p className="eyebrow">Selected run</p><h2>{run.issueIdentifier ?? run.id}</h2><p>{time(run.startedAt)} · {formatDuration(run.durationMs)}</p></div><StatusBadge status={run.status} /></div>
    {run.resources.length > 0 && <div className="actions" aria-label="Run resources">{run.resources.map(resource => <a key={resource.label} href={resource.url} target="_blank" rel="noreferrer">Open {resource.label}</a>)}</div>}
    <dl className="run-facts"><div><dt>Runtime</dt><dd>{run.runtime}</dd></div><div><dt>Mode</dt><dd>{run.mode}</dd></div><div><dt>Total usage</dt><dd>{run.totalTokens.toLocaleString()} tokens</dd></div></dl>
    <RunTimeline invocations={run.invocations} /></>;
}
