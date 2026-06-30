import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useStore } from './store'
import type { Toast } from './toasts'

const AUTO_DISMISS_MS: Record<Toast['kind'], number> = {
  info: 5000,
  success: 5000,
  error: 0 // 0 = persist until dismissed
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast)
  useEffect(() => {
    const ms = AUTO_DISMISS_MS[toast.kind]
    if (ms <= 0) return
    const t = setTimeout(() => dismiss(toast.id), ms)
    return () => clearTimeout(t)
  }, [toast.id, toast.kind, dismiss])
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <span className="toast-msg">{toast.message}</span>
      <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
        <X size={13} />
      </button>
    </div>
  )
}

export default function ToastViewport() {
  const toasts = useStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="toast-viewport">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
