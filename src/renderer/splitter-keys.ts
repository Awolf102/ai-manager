export interface SplitterOpts {
  axis: 'x' | 'y' // 'x' = vertical separator (resizes width); 'y' = horizontal (resizes height)
  invert: boolean // panel grows opposite the increase direction (mirrors the drag invert)
  size: number
  min: number
  max: number
  step?: number // arrow increment (default 16)
  pageStep?: number // Page increment (default 64)
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n))

/** New clamped size px for a keyboard resize, or null for a non-resize key.
 *  decrease-screen keys (dir -1): ArrowLeft (x), ArrowUp (y), PageUp (both).
 *  increase-screen keys (dir +1): ArrowRight (x), ArrowDown (y), PageDown (both).
 *  sizeDelta = screenDelta * (invert ? -1 : 1). Home→min, End→max. */
export function splitterResize(key: string, opts: SplitterOpts): number | null {
  const { axis, invert, size, min, max } = opts
  const step = opts.step ?? 16
  const pageStep = opts.pageStep ?? 64
  if (key === 'Home') return min
  if (key === 'End') return max
  const decArrow = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
  const incArrow = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
  let dir = 0
  let mag = step
  if (key === decArrow) dir = -1
  else if (key === incArrow) dir = 1
  else if (key === 'PageUp') { dir = -1; mag = pageStep }
  else if (key === 'PageDown') { dir = 1; mag = pageStep }
  else return null
  const sizeDelta = dir * mag * (invert ? -1 : 1)
  return clamp(size + sizeDelta, min, max)
}
