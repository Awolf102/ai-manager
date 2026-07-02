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
