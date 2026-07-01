import { useCallback } from 'react'
import { splitterResize } from './splitter-keys'

/** A draggable + keyboard-resizable divider. `axis='x'` resizes width, `axis='y'`
 * resizes height. `invert` is true when the panel grows opposite the drag
 * direction (e.g. a right inspector grows as the mouse moves left). */
export default function PanelDivider({
  axis,
  invert,
  getStart,
  onResize,
  size,
  min,
  max,
  label
}: {
  axis: 'x' | 'y'
  invert: boolean
  getStart: () => number
  onResize: (px: number) => void
  size: number
  min: number
  max: number
  label: string
}) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startPos = axis === 'x' ? e.clientX : e.clientY
      const startSize = getStart()
      const move = (ev: MouseEvent): void => {
        const pos = axis === 'x' ? ev.clientX : ev.clientY
        const delta = (pos - startPos) * (invert ? -1 : 1)
        onResize(startSize + delta)
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [axis, invert, getStart, onResize]
  )
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const next = splitterResize(e.key, { axis, invert, size, min, max })
      if (next != null) {
        e.preventDefault()
        onResize(next)
      }
    },
    [axis, invert, size, min, max, onResize]
  )
  return (
    <div
      className={`panel-divider panel-divider-${axis}`}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
    />
  )
}
