export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error'
  message: string
  createdAt: number
}

export const TOAST_CAP = 4

/** Append a toast, dropping the oldest when over the cap. Pure. */
export function addToast(list: Toast[], toast: Toast, cap: number = TOAST_CAP): Toast[] {
  const next = [...list, toast]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/** Remove a toast by id. Pure. */
export function removeToast(list: Toast[], id: string): Toast[] {
  return list.filter((t) => t.id !== id)
}
