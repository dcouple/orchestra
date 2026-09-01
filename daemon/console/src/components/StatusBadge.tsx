export function isReadyStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "ready" || normalized === "online" || normalized === "healthy" || normalized === "available";
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const tone = /^(offline|not_ready|unavailable|fail|error|blocked)/.test(normalized) ? "bad"
    : isReadyStatus(normalized) || /^(active|succeed(?:ed)?|done|terminal)$/.test(normalized) ? "good" : "warn";
  return <span className={`status status-${tone}`}><span aria-hidden="true" className="status-dot" />{status.replaceAll("_", " ")}</span>;
}
