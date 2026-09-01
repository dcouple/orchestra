import { Modal } from "./Modal";

export function ConfirmDialog({ digest, reason, busy, returnFocus, onCancel, onConfirm }: {
  digest: string; reason: string; busy?: boolean; returnFocus?: HTMLElement | null | (() => HTMLElement | null); onCancel: () => void; onConfirm: () => void;
}) {
  return <Modal titleId="confirm-title" busy={busy} returnFocus={returnFocus} onDismiss={onCancel}>
    <h2 id="confirm-title">Confirm local operation</h2>
    <p>Review the validated digest and reason. This action is recorded as <code>local-console</code>.</p>
    <dl><dt>Digest</dt><dd><code>{digest}</code></dd><dt>Reason</dt><dd>{reason}</dd></dl>
    <div className="actions"><button type="button" onClick={onCancel} disabled={busy}>Back</button>
      <button data-modal-initial-focus type="button" onClick={onConfirm} disabled={busy}>{busy ? "Applying…" : "Confirm and apply"}</button></div>
  </Modal>;
}
