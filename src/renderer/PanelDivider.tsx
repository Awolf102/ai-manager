import { useCallback } from 'react'

/** A draggable divider. `axis='x'` resizes width, `axis='y'` resizes height.
 * `invert` is true when the panel grows opposite the drag direction
 * (e.g. a right inspector grows as the mouse moves left). Calls onResize(px). */
export default function PanelDivider({
  axis,
  invert,
  getStart,
  onResize
}: {
  axis: 'x' | 'y'
  invert: boolean
  getStart: () => number // current panel size in px at drag start
  onResize: (px: number) => void
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
  return <div className={`panel-divider panel-divider-${axis}`} onMouseDown={onMouseDown} role="separator" />
}
