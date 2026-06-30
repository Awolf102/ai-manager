import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LAYOUT, clampInspector, clampDockHeight, clampDockWidth,
  computeBodyGrid, serializeLayout, parseLayout, type LayoutState
} from './layout'

describe('clamps', () => {
  it('clampInspector bounds to 280..560', () => {
    expect(clampInspector(100)).toBe(280)
    expect(clampInspector(700)).toBe(560)
    expect(clampInspector(400)).toBe(400)
  })
  it('clampDockHeight bounds to 160..60% of viewport', () => {
    expect(clampDockHeight(50, 1000)).toBe(160)
    expect(clampDockHeight(900, 1000)).toBe(600)
    expect(clampDockHeight(300, 1000)).toBe(300)
  })
  it('clampDockWidth bounds to 240..640', () => {
    expect(clampDockWidth(100)).toBe(240)
    expect(clampDockWidth(900)).toBe(640)
  })
})

describe('computeBodyGrid', () => {
  it('default (inspector right, dock bottom) keeps inspector full-height right', () => {
    const g = computeBodyGrid(DEFAULT_LAYOUT)
    expect(g.columns).toBe('1fr 348px')
    expect(g.rows).toBe('1fr 300px')
    expect(g.areas).toBe('"main inspector" "dock inspector"')
  })
  it('inspector left, dock bottom', () => {
    const s: LayoutState = { ...DEFAULT_LAYOUT, inspector: { ...DEFAULT_LAYOUT.inspector, placement: 'left' } }
    const g = computeBodyGrid(s)
    expect(g.columns).toBe('348px 1fr')
    expect(g.areas).toBe('"inspector main" "inspector dock"')
  })
  it('inspector left, dock right → three columns one row', () => {
    const s: LayoutState = {
      inspector: { size: 348, collapsed: false, placement: 'left' },
      dock: { size: 300, collapsed: false, placement: 'right' }
    }
    const g = computeBodyGrid(s)
    expect(g.columns).toBe('348px 1fr 300px')
    expect(g.rows).toBe('1fr')
    expect(g.areas).toBe('"inspector main dock"')
  })
  it('both right → right column stacks inspector over dock', () => {
    const s: LayoutState = {
      inspector: { size: 348, collapsed: false, placement: 'right' },
      dock: { size: 300, collapsed: false, placement: 'right' }
    }
    const g = computeBodyGrid(s)
    expect(g.columns).toBe('1fr 348px')
    expect(g.rows).toBe('1fr 300px')
    expect(g.areas).toBe('"main inspector" "main dock"')
  })
  it('collapsed inspector yields a 0px track', () => {
    const s: LayoutState = { ...DEFAULT_LAYOUT, inspector: { ...DEFAULT_LAYOUT.inspector, collapsed: true } }
    expect(computeBodyGrid(s).columns).toBe('1fr 0px')
  })
})

describe('serialize/parse', () => {
  it('round-trips', () => {
    expect(parseLayout(serializeLayout(DEFAULT_LAYOUT))).toEqual(DEFAULT_LAYOUT)
  })
  it('falls back to default on null', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT)
  })
  it('falls back to default on garbage', () => {
    expect(parseLayout('{not json')).toEqual(DEFAULT_LAYOUT)
  })
  it('fills missing fields from default', () => {
    const partial = JSON.stringify({ inspector: { size: 400 } })
    const r = parseLayout(partial)
    expect(r.inspector.size).toBe(400)
    expect(r.inspector.placement).toBe('right') // from default
    expect(r.dock).toEqual(DEFAULT_LAYOUT.dock)
  })
})
