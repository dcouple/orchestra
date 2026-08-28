import type { Invocation } from "../api";
import { StatusBadge } from "./StatusBadge";

export function RunTimeline({ invocations }: { invocations: Invocation[] }) {
  if (!invocations.length) return <div className="empty">No sub-agent invocations were persisted for this run.</div>;
  const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);
  const effectiveEnd = (invocation: Invocation): number | null => {
    if (finite(invocation.endedAt)) return invocation.endedAt;
    if (finite(invocation.startedAt) && finite(invocation.durationMs))
      return invocation.startedAt + Math.max(0, invocation.durationMs);
    return finite(invocation.startedAt) ? invocation.startedAt : null;
  };
  const starts = invocations.map(item => item.startedAt).filter(finite);
  const ends = invocations.map(effectiveEnd).filter(finite);
  const min = starts.length > 0 ? Math.min(...starts) : 0;
  const max = Math.max(...ends, min + 1); const span = Math.max(1, max - min);
  return <figure className="timeline" aria-labelledby="timeline-title">
    <figcaption id="timeline-title">Sub-agent invocation timeline</figcaption>
    <div className="axis axis-x"><span>Elapsed time</span><span>0s</span><span>{formatDuration(span)}</span></div>
    <div className="timeline-grid"><div className="axis-y" aria-label="Invocation role axis">Role / runtime</div><div />
      {invocations.map(invocation => {
        const start = finite(invocation.startedAt) ? invocation.startedAt : null;
        const left = start !== null ? Math.min(98, Math.max(0, ((start - min) / span) * 100)) : 0;
        const end = effectiveEnd(invocation);
        const rawWidth = start !== null && finite(end) ? ((Math.max(end, start) - start) / span) * 100 : 2;
        const width = Math.min(Math.max(2, rawWidth), 100 - left);
        return <div className="timeline-row" key={invocation.id}>
          <div className="timeline-label"><strong>{invocation.role}</strong><small>{invocation.runtime}{invocation.model ? ` · ${invocation.model}` : ""}</small></div>
          <div className="track"><svg className="track-svg" viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label={`${invocation.role}, ${invocation.state}, duration ${formatDuration(invocation.durationMs ?? 0)}`}><title>{invocation.role}: {formatDuration(invocation.durationMs ?? 0)}</title><rect className={`bar ${invocation.state}`} x={left} y="0" width={Math.min(width, 100 - left)} height="12" rx="3" /></svg></div>
          <div className="timeline-meta"><StatusBadge status={invocation.outcome ?? invocation.state} /><span>{formatDuration(invocation.durationMs ?? 0)}</span><span>{invocation.usage.totalTokens?.toLocaleString() ?? "—"} tokens</span></div>
        </div>;
      })}
    </div>
  </figure>;
}
export function formatDuration(ms: number) { return ms < 60_000 ? `${Math.round(ms / 100) / 10}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`; }
