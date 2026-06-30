import { useStore } from './store'
import { Modal } from './Modal'

export default function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm)
  const resolveConfirm = useStore((s) => s.resolveConfirm)

  if (!confirm) return null
  const { title, body, confirmLabel, danger } = confirm.opts
  return (
    <Modal onClose={() => resolveConfirm(false)}>
      {(close) => (
        <>
          <h2>{title}</h2>
          <p className="confirm-body">{body}</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => close()}>
              Cancel
            </button>
            <button
              className={`btn ${danger ? 'danger' : 'primary'}`}
              onClick={() => close(() => resolveConfirm(true))}
            >
              {confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
