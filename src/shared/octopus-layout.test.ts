import { describe, it, expect } from 'vitest'
import { octopusLayout, type LayoutNode, type LayoutEdge } from './octopus-layout'

const nodes: LayoutNode[] = [
  { id: 'O', kind: 'orchestrator' },
  { id: 'DW', kind: 'worker' },
  { id: 'M1', kind: 'manager' },
  { id: 'M2', kind: 'manager' },
  { id: 'W1', kind: 'worker' },
  { id: 'W2', kind: 'worker' },
  { id: 'W3', kind: 'worker' },
  { id: 'W4', kind: 'worker' }
]
const edges: LayoutEdge[] = [
  { source: 'O', target: 'DW' },
  { source: 'O', target: 'M1' },
  { source: 'O', target: 'M2' },
  { source: 'M1', target: 'W1' },
  { source: 'M1', target: 'W2' },
  { source: 'M2', target: 'W3' },
  { source: 'M2', target: 'W4' }
]
const byId = (r: ReturnType<typeof octopusLayout>) => new Map(r.map((p) => [p.id, p.position]))

describe('octopusLayout', () => {
  it('layers orchestrator above managers above workers', () => {
    const p = byId(octopusLayout(nodes, edges))
    expect(p.get('O')!.y).toBeLessThan(p.get('M1')!.y)
    expect(p.get('M1')!.y).toBeLessThan(p.get('W1')!.y)
  })
  it('places managers on one row', () => {
    const p = byId(octopusLayout(nodes, edges))
    expect(p.get('M1')!.y).toBe(p.get('M2')!.y)
  })
  it('centers the orchestrator over its managers', () => {
    const p = byId(octopusLayout(nodes, edges))
    const mid = (p.get('M1')!.x + p.get('M2')!.x) / 2
    expect(p.get('O')!.x).toBeCloseTo(mid, 5)
  })
  it('places a direct leaf worker above the orchestrator (the arch)', () => {
    const p = byId(octopusLayout(nodes, edges))
    expect(p.get('DW')!.y).toBeLessThan(p.get('O')!.y)
  })
  it('staggers sibling workers on a layer', () => {
    const p = byId(octopusLayout(nodes, edges))
    expect(p.get('W1')!.y).not.toBe(p.get('W2')!.y)
  })
  it('ignores handoff edges for layout', () => {
    const withHandoff = [...edges, { source: 'W1', target: 'W3', kind: 'handoff' as const }]
    const a = byId(octopusLayout(nodes, edges))
    const b = byId(octopusLayout(nodes, withHandoff))
    expect(b.get('W3')).toEqual(a.get('W3'))
  })
  it('is deterministic', () => {
    expect(octopusLayout(nodes, edges)).toEqual(octopusLayout(nodes, edges))
  })
  it('positions an orphan node (no edges) without NaN', () => {
    const r = octopusLayout([...nodes, { id: 'ORPH', kind: 'worker' }], edges)
    const orph = r.find((p) => p.id === 'ORPH')!.position
    expect(Number.isFinite(orph.x) && Number.isFinite(orph.y)).toBe(true)
  })
})
