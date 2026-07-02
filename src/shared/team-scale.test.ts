import { describe, it, expect } from 'vitest'
import { DEFAULT_PARALLEL, clampParallel, clampBulk, parallelCap } from './team-scale'

describe('team-scale concurrency', () => {
  it('parallelCap is the default when largeTeamMode is off', () => {
    expect(parallelCap({ largeTeamMode: false, largeTeamParallel: 12 })).toBe(DEFAULT_PARALLEL)
    expect(DEFAULT_PARALLEL).toBe(3)
  })
  it('parallelCap uses the (clamped) largeTeamParallel when on', () => {
    expect(parallelCap({ largeTeamMode: true, largeTeamParallel: 6 })).toBe(6)
    expect(parallelCap({ largeTeamMode: true, largeTeamParallel: 999 })).toBe(24)
    expect(parallelCap({ largeTeamMode: true, largeTeamParallel: 0 })).toBe(1)
  })
  it('clampers bound their ranges', () => {
    expect(clampParallel(30)).toBe(24)
    expect(clampParallel(0)).toBe(1)
    expect(clampBulk(500)).toBe(100)
    expect(clampBulk(-1)).toBe(1)
    expect(clampBulk(Number.NaN)).toBe(1)
  })
})
