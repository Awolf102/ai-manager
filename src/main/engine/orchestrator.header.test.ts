import { describe, it, expect } from 'vitest'
import { headerGate } from './orchestrator'

describe('headerGate', () => {
  it('prints the header only on the first call per agent in a run', () => {
    const seen = new Set<string>()
    expect(headerGate(seen, 'a')).toBe(true)
    expect(headerGate(seen, 'a')).toBe(false)
    expect(headerGate(seen, 'b')).toBe(true)
  })
  it('respects an explicit header choice', () => {
    const seen = new Set<string>()
    expect(headerGate(seen, 'a', false)).toBe(false) // explicit false wins
    expect(headerGate(seen, 'a')).toBe(true)         // still first real print for a
  })
})
