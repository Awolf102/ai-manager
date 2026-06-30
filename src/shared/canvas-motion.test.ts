import { describe, it, expect } from 'vitest'
import { entranceDelays } from './canvas-motion'

const n = (...ids: string[]) => ids.map((id) => ({ id }))

describe('entranceDelays', () => {
  it('puts roots at 0 and direct children at one step', () => {
    const d = entranceDelays(n('o', 'a', 'b'), [
      { source: 'o', target: 'a' },
      { source: 'o', target: 'b' }
    ])
    expect(d).toEqual({ o: 0, a: 50, b: 50 })
  })
  it('deepens with each level', () => {
    const d = entranceDelays(n('o', 'm', 'w'), [
      { source: 'o', target: 'm' },
      { source: 'm', target: 'w' }
    ])
    expect(d).toEqual({ o: 0, m: 50, w: 100 })
  })
  it('ignores handoff edges for depth', () => {
    const d = entranceDelays(n('o', 'a'), [{ source: 'o', target: 'a', kind: 'handoff' }])
    // no report edge → both are roots → both 0
    expect(d).toEqual({ o: 0, a: 0 })
  })
  it('honors a custom step', () => {
    const d = entranceDelays(n('o', 'a'), [{ source: 'o', target: 'a' }], 80)
    expect(d).toEqual({ o: 0, a: 80 })
  })
  it('gives a disconnected node delay 0', () => {
    const d = entranceDelays(n('o', 'x'), [])
    expect(d).toEqual({ o: 0, x: 0 })
  })
  it('clamps very deep chains to 6 steps', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] // chain a->b->...->i (depth 8)
    const edges = ids.slice(0, -1).map((s, i) => ({ source: s, target: ids[i + 1] }))
    const d = entranceDelays(n(...ids), edges)
    expect(d['i']).toBe(6 * 50) // clamped at depth 6
  })
  it('is cycle-safe (no infinite loop, no root → all 0)', () => {
    const d = entranceDelays(n('a', 'b'), [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' }
    ])
    expect(d).toEqual({ a: 0, b: 0 })
  })
})
