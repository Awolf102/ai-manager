import { describe, it, expect } from 'vitest'
import { rovingIndex } from './roving'

describe('rovingIndex', () => {
  it('horizontal arrows advance/retreat', () => {
    expect(rovingIndex('ArrowRight', 0, 3, 'horizontal')).toBe(1)
    expect(rovingIndex('ArrowLeft', 1, 3, 'horizontal')).toBe(0)
  })
  it('vertical arrows advance/retreat', () => {
    expect(rovingIndex('ArrowDown', 0, 3, 'vertical')).toBe(1)
    expect(rovingIndex('ArrowUp', 2, 3, 'vertical')).toBe(1)
  })
  it('wraps at the ends when loop (default)', () => {
    expect(rovingIndex('ArrowRight', 2, 3, 'horizontal')).toBe(0)
    expect(rovingIndex('ArrowLeft', 0, 3, 'horizontal')).toBe(2)
  })
  it('clamps at the ends when loop=false', () => {
    expect(rovingIndex('ArrowRight', 2, 3, 'horizontal', false)).toBe(2)
    expect(rovingIndex('ArrowLeft', 0, 3, 'horizontal', false)).toBe(0)
  })
  it('Home→0, End→count-1', () => {
    expect(rovingIndex('Home', 2, 3, 'horizontal')).toBe(0)
    expect(rovingIndex('End', 0, 3, 'horizontal')).toBe(2)
  })
  it('ignores the cross-axis arrows', () => {
    expect(rovingIndex('ArrowDown', 0, 3, 'horizontal')).toBeNull()
    expect(rovingIndex('ArrowRight', 0, 3, 'vertical')).toBeNull()
  })
  it('returns null for non-nav keys and empty lists', () => {
    expect(rovingIndex('Enter', 0, 3, 'horizontal')).toBeNull()
    expect(rovingIndex('ArrowRight', 0, 0, 'horizontal')).toBeNull()
  })
})
