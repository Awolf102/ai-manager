import { useEffect } from 'react'
import { useStore } from './store'

export default function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm)
  const resolveConfirm = useStore((s) => s.resolveConfirm)

  useEffect(() => {
    if (!confirm) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') resolveConfirm(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, resolveConfirm])

  if (!confirm) return null
  const { title, body, confirmLabel, danger } = confirm.opts
  return (
    <div className="modal-backdrop" onClick={() => resolveConfirm(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="confirm-body">{body}</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => resolveConfirm(false)}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => resolveConfirm(true)}>
            {confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
