import { useEffect, useRef } from "react";

export function ConfirmDialog({ digest, reason, busy, onCancel, onConfirm }: {
  digest: string; reason: string; busy?: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirm.current?.focus(); }, []);
  return <div className="dialog-backdrop" role="presentation"><section className="card dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
    <h2 id="confirm-title">Confirm local operation</h2>
    <p>Review the validated digest and reason. This action is recorded as <code>local-console</code>.</p>
    <dl><dt>Digest</dt><dd><code>{digest}</code></dd><dt>Reason</dt><dd>{reason}</dd></dl>
    <div className="actions"><button type="button" onClick={onCancel} disabled={busy}>Back</button>
      <button ref={confirm} type="button" onClick={onConfirm} disabled={busy}>{busy ? "Applying…" : "Confirm and apply"}</button></div>
  </section></div>;
}
