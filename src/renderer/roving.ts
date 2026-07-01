export type Orientation = 'horizontal' | 'vertical'

/** Next index for a roving-focus widget (tabs, radiogroup, menu), or null for a
 *  non-navigation key. horizontal: ArrowRight→next, ArrowLeft→prev.
 *  vertical: ArrowDown→next, ArrowUp→prev. Home→0, End→count-1.
 *  loop wraps at the ends (default true). count<=0 → null. */
export function rovingIndex(
  key: string,
  index: number,
  count: number,
  orientation: Orientation,
  loop = true
): number | null {
  if (count <= 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
  const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
  if (key === next) {
    const i = index + 1
    return i >= count ? (loop ? 0 : count - 1) : i
  }
  if (key === prev) {
    const i = index - 1
    return i < 0 ? (loop ? count - 1 : 0) : i
  }
  return null
}
