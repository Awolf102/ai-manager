import { describe, it, expect } from 'vitest'
import { activeDockAfterOpenTerminal } from './dock'

describe('activeDockAfterOpenTerminal', () => {
  it('focuses the new terminal when no run is active', () => {
    expect(activeDockAfterOpenTerminal({ running: false, currentActive: 'run', newTermId: 'term-2' })).toBe('term-2')
  })
  it('keeps the current view (does not steal) when a run is active', () => {
    expect(activeDockAfterOpenTerminal({ running: true, currentActive: 'run', newTermId: 'term-2' })).toBe('run')
  })
  it('keeps a non-run current view while running too', () => {
    expect(activeDockAfterOpenTerminal({ running: true, currentActive: 'term-1', newTermId: 'term-2' })).toBe('term-1')
  })
  it('focuses the new terminal if running but nothing is active yet', () => {
    expect(activeDockAfterOpenTerminal({ running: true, currentActive: null, newTermId: 'term-2' })).toBe('term-2')
  })
})
