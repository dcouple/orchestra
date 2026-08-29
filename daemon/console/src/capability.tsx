export type CapabilityState = "loading" | "read-only" | "local-trusted" | "unavailable";

export function CapabilityNotice({ capability }: { capability: Exclude<CapabilityState, "local-trusted"> }) {
  const message = capability === "loading" ? "Checking local console capability…"
    : capability === "read-only" ? "Read-only mode. Observation and history remain available; mutation controls are hidden."
      : "Capability could not be verified. Observation and history remain available; mutation controls are hidden.";
  return <section className="offline" role="status"><h2>{capability === "loading" ? "Capability loading" : "Read-only access"}</h2><p>{message}</p></section>;
}
