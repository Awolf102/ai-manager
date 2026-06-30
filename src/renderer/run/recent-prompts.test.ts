import { describe, it, expect } from 'vitest'
import { promptLabel, recentGoals } from './recent-prompts'

describe('promptLabel', () => {
  it('uses the first non-empty line with whitespace collapsed', () => {
    expect(promptLabel('  add   dark   mode  \nmore detail')).toBe('add dark mode')
  })
  it('skips leading blank lines', () => {
    expect(promptLabel('\n\n  hello')).toBe('hello')
  })
  it('returns (no goal) for empty/whitespace', () => {
    expect(promptLabel('   \n  ')).toBe('(no goal)')
  })
  it('truncates long goals with an ellipsis', () => {
    expect(promptLabel('x'.repeat(60), 10)).toBe('xxxxxxxxxx…')
  })
  it('leaves short goals unchanged', () => {
    expect(promptLabel('hello')).toBe('hello')
  })
})

describe('recentGoals', () => {
  const runs = [
    { goal: 'first', startedAt: '2026-06-01T10:00:00Z' },
    { goal: 'second', startedAt: '2026-06-03T10:00:00Z' },
    { goal: 'first', startedAt: '2026-06-02T10:00:00Z' },
    { goal: '   ', startedAt: '2026-06-04T10:00:00Z' }
  ]
  it('sorts most-recent first, drops empties, dedups keeping the most recent', () => {
    expect(recentGoals(runs)).toEqual(['second', 'first'])
  })
  it('caps the count', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      goal: `g${i}`,
      startedAt: `2026-06-01T00:00:${String(i).padStart(2, '0')}Z`
    }))
    expect(recentGoals(many, 5)).toHaveLength(5)
  })
})
