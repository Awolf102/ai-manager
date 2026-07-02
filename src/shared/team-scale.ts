// Pure helpers for large-team scaling. No node/DOM imports.

export const DEFAULT_PARALLEL = 3

export function clampParallel(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PARALLEL
  return Math.max(1, Math.min(24, Math.floor(n)))
}

export function clampBulk(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(100, Math.floor(n)))
}

/** The concurrency cap for a run: raised (adjustable) only in large-team mode. */
export function parallelCap(settings: { largeTeamMode?: boolean; largeTeamParallel?: number }): number {
  return settings.largeTeamMode ? clampParallel(settings.largeTeamParallel ?? DEFAULT_PARALLEL) : DEFAULT_PARALLEL
}

/** A plain-English team-size + concurrency caption for the pre-run heads-up. */
export function teamSizeCaption(nodes: { kind: string }[], cap: number): string {
  const c: Record<string, number> = { orchestrator: 0, director: 0, manager: 0, worker: 0 }
  for (const n of nodes) c[n.kind] = (c[n.kind] ?? 0) + 1
  const parts: string[] = []
  if (c.director) parts.push(`${c.director} director${c.director > 1 ? 's' : ''}`)
  if (c.manager) parts.push(`${c.manager} manager${c.manager > 1 ? 's' : ''}`)
  if (c.worker) parts.push(`${c.worker} worker${c.worker > 1 ? 's' : ''}`)
  const breakdown = parts.length ? ` (${parts.join(' · ')})` : ''
  return `${nodes.length} agents${breakdown} · concurrency ${cap} · large teams cost more and run longer — cheap-model workers recommended.`
}

/** Unique display names for N clones of a base name: "<base> 2", "<base> 3", … skipping taken names.
 *  A trailing " <number>" on the base is stripped first so cloning "Worker 2" yields "Worker 3", not "Worker 2 2". */
export function duplicateNames(baseName: string, count: number, takenNames: string[] = []): string[] {
  const taken = new Set(takenNames)
  const base = baseName.replace(/\s+\d+$/, '').trim() || baseName
  const out: string[] = []
  let n = 2
  while (out.length < count) {
    const name = `${base} ${n}`
    if (!taken.has(name)) {
      out.push(name)
      taken.add(name)
    }
    n++
  }
  return out
}
