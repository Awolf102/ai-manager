/** A short, single-line label for a goal: first non-empty line, whitespace
 *  collapsed, truncated with an ellipsis. Empty → "(no goal)". Pure. */
export function promptLabel(goal: string, maxLen = 48): string {
  const firstLine = goal.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? ''
  const collapsed = firstLine.replace(/\s+/g, ' ').trim()
  if (!collapsed) return '(no goal)'
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen).trimEnd()}…` : collapsed
}

/** Recent run goals for the picker: most-recent first (by startedAt), empties
 *  dropped, duplicates removed (keeping the most recent), capped. Pure. */
export function recentGoals(runs: { goal: string; startedAt: string }[], cap = 12): string[] {
  const sorted = [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of sorted) {
    const key = r.goal.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(r.goal)
    if (out.length >= cap) break
  }
  return out
}
