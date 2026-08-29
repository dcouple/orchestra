import type { ReactNode } from "react";

export type Page = "overview" | "runs" | "dependencies" | "skills" | "configuration" | "operations";
export function Layout({ page, onPage, children }: { page: Page; onPage: (page: Page) => void; children: ReactNode }) {
  const browserHost = typeof window === "undefined" || !window.location.host ? "local browser" : window.location.host;
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">O</span><span><strong>Orchestra</strong><small>Local console</small></span></div>
      <nav aria-label="Primary navigation">
        <button type="button" aria-current={page === "overview" ? "page" : undefined} onClick={() => onPage("overview")}>Overview</button>
        <button type="button" aria-current={page === "runs" ? "page" : undefined} onClick={() => onPage("runs")}>Runs</button>
        <button type="button" aria-current={page === "dependencies" ? "page" : undefined} onClick={() => onPage("dependencies")}>MCP</button>
        <button type="button" aria-current={page === "skills" ? "page" : undefined} onClick={() => onPage("skills")}>Skills</button>
        <button type="button" aria-current={page === "configuration" ? "page" : undefined} onClick={() => onPage("configuration")}>Configuration</button>
        <button type="button" aria-current={page === "operations" ? "page" : undefined} onClick={() => onPage("operations")}>Operations</button>
      </nav><div className="local-only">Loopback only<br /><code>{browserHost}</code></div></aside>
    <main id="main-content">{children}</main>
  </div>;
}
