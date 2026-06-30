import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

type CloseFn = (after?: () => void) => void

const ModalCloseContext = createContext<CloseFn>(() => {})

/** Animated close from a component nested inside a <Modal>. Inline buttons should prefer the render-prop `close`. */
export function useModalClose(): CloseFn {
  return useContext(ModalCloseContext)
}

const EXIT_MS = 150 // must match the .modal-panel[data-closing] CSS transition

export function Modal({
  onClose,
  className,
  unstyled = false,
  dismissable = true,
  labelledBy,
  children
}: {
  onClose: () => void
  className?: string
  unstyled?: boolean
  dismissable?: boolean
  labelledBy?: string
  children: ReactNode | ((close: CloseFn) => ReactNode)
}) {
  const [closing, setClosing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevFocus = useRef<Element | null>(null)

  useEffect(() => {
    prevFocus.current = document.activeElement
    // focus the panel for Escape/AT, but don't steal an inner autoFocus (e.g. HITL textarea)
    if (panelRef.current && !panelRef.current.contains(document.activeElement)) {
      panelRef.current.focus()
    }
    return () => {
      clearTimeout(timer.current)
      if (prevFocus.current instanceof HTMLElement) prevFocus.current.focus()
    }
  }, [])

  const close: CloseFn = (after) => {
    if (closing) return
    setClosing(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => (after ?? onClose)(), EXIT_MS)
  }

  const panelClass = ['modal-panel', unstyled ? '' : 'modal', className].filter(Boolean).join(' ')
  const body = typeof children === 'function' ? children(close) : children

  return (
    <div
      className="modal-backdrop"
      data-closing={closing || undefined}
      onClick={() => {
        if (dismissable) close()
      }}
      onKeyDown={(e) => {
        if (dismissable && e.key === 'Escape') {
          e.stopPropagation()
          close()
        }
      }}
    >
      <ModalCloseContext.Provider value={close}>
        <div
          ref={panelRef}
          className={panelClass}
          data-closing={closing || undefined}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </div>
      </ModalCloseContext.Provider>
    </div>
  )
}
