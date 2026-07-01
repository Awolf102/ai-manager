import { describe, it, expect } from 'vitest'
import { splitterResize } from './splitter-keys'

const base = { axis: 'x' as const, invert: false, size: 300, min: 280, max: 560 }

describe('splitterResize', () => {
  it('x axis grows/shrinks with right/left by step (16)', () => {
    expect(splitterResize('ArrowRight', base)).toBe(316)
    expect(splitterResize('ArrowLeft', base)).toBe(284)
  })
  it('invert mirrors the direction', () => {
    expect(splitterResize('ArrowRight', { ...base, invert: true })).toBe(284)
    expect(splitterResize('ArrowLeft', { ...base, invert: true })).toBe(316)
  })
  it('y axis uses down/up', () => {
    const y = { axis: 'y' as const, invert: false, size: 300, min: 160, max: 600 }
    expect(splitterResize('ArrowDown', y)).toBe(316)
    expect(splitterResize('ArrowUp', y)).toBe(284)
  })
  it('Page keys use the larger step (64) and clamp', () => {
    expect(splitterResize('PageDown', base)).toBe(364)
    expect(splitterResize('PageUp', base)).toBe(280) // 300-64=236 → clamp min 280
  })
  it('Home→min, End→max', () => {
    expect(splitterResize('Home', base)).toBe(280)
    expect(splitterResize('End', base)).toBe(560)
  })
  it('clamps at the bounds', () => {
    expect(splitterResize('ArrowRight', { ...base, size: 555 })).toBe(560)
    expect(splitterResize('ArrowLeft', { ...base, size: 282 })).toBe(280)
  })
  it('ignores cross-axis arrows and non-resize keys', () => {
    expect(splitterResize('ArrowUp', base)).toBeNull()
    expect(splitterResize('Enter', base)).toBeNull()
  })
})
