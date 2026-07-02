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
