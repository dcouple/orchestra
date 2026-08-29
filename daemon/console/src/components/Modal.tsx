import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const focusableSelector = [
  "a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Modal({ titleId, busy = false, returnFocus, onDismiss, children }: {
  titleId: string; busy?: boolean; returnFocus?: HTMLElement | null | (() => HTMLElement | null); onDismiss: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLElement>(null);
  const busyRef = useRef(busy); busyRef.current = busy;
  const dismissRef = useRef(onDismiss); dismissRef.current = onDismiss;

  useLayoutEffect(() => {
    const resolveOpener = () => typeof returnFocus === "function" ? returnFocus() : returnFocus;
    const opener = resolveOpener() ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const backdrop = dialog.current?.parentElement;
    const inert = [...document.body.children].filter(element => element !== backdrop)
      .map(element => ({ element, value: element.getAttribute("inert") }));
    for (const { element } of inert) element.setAttribute("inert", "");

    const focusables = () => [...(dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])]
      .filter(element => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const initial = dialog.current?.querySelector<HTMLElement>("[data-modal-initial-focus]") ?? focusables()[0] ?? dialog.current;
    initial?.focus();

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (!busyRef.current) dismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) { event.preventDefault(); dialog.current?.focus(); return; }
      const first = items[0]!; const last = items.at(-1)!; const active = document.activeElement;
      if (!dialog.current?.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    const focusin = (event: FocusEvent) => {
      if (dialog.current && !dialog.current.contains(event.target as Node)) (focusables()[0] ?? dialog.current).focus();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin, true);
      for (const { element, value } of inert) value === null ? element.removeAttribute("inert") : element.setAttribute("inert", value);
      const currentOpener = resolveOpener() ?? opener;
      queueMicrotask(() => {
        const latestOpener = resolveOpener() ?? currentOpener;
        if (latestOpener?.isConnected) latestOpener.focus();
      });
    };
  }, []);

  return createPortal(<div className="dialog-backdrop" role="presentation">
    <section ref={dialog} className="card dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      {children}
    </section>
  </div>, document.body);
}
