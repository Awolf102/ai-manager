import { describe, it, expect } from 'vitest'
import { DEFAULT_PARALLEL, clampParallel, clampBulk, parallelCap, duplicateNames, teamSizeCaption } from './team-scale'

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

describe('teamSizeCaption', () => {
  it('summarizes counts and concurrency', () => {
    const cap = teamSizeCaption(
      [{ kind: 'orchestrator' }, { kind: 'director' }, { kind: 'manager' }, { kind: 'worker' }, { kind: 'worker' }],
      6
    )
    expect(cap).toContain('5 agents')
    expect(cap).toContain('1 director')
    expect(cap).toContain('2 workers')
    expect(cap).toContain('concurrency 6')
  })
})

describe('duplicateNames', () => {
  it('numbers clones from 2, skipping taken names', () => {
    expect(duplicateNames('Frontend Worker', 3, ['Frontend Worker'])).toEqual([
      'Frontend Worker 2', 'Frontend Worker 3', 'Frontend Worker 4'
    ])
  })
  it('strips an existing trailing number so a clone of "Worker 2" is not "Worker 2 2"', () => {
    expect(duplicateNames('Worker 2', 2, ['Worker', 'Worker 2'])).toEqual(['Worker 3', 'Worker 4'])
  })
})
