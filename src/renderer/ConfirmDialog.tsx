import { useStore } from './store'
import { Modal } from './Modal'

export default function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm)
  const resolveConfirm = useStore((s) => s.resolveConfirm)

  if (!confirm) return null
  const { title, body, confirmLabel, danger } = confirm.opts
  return (
    <Modal onClose={() => resolveConfirm(false)} labelledBy="confirm-title">
      {(close) => (
        <>
          <div className="modal-header">
            <h2 id="confirm-title" className="modal-title">{title}</h2>
          </div>
          <div className="modal-body">
            <p className="confirm-body">{body}</p>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => close()}>Cancel</button>
            <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => close(() => resolveConfirm(true))}>
              {confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
