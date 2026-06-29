import { describe, it, expect } from 'vitest'
import { deriveOrderDeps, applyOrderClick, deriveStages } from './workflow-order'

// Helpers
const T = (id: string, ownerId: string | null) => ({ id, ownerId })
const E = (source: string, target: string, order?: number) => ({ source, target, order })

describe('deriveOrderDeps', () => {
  it('returns {} when no edges carry an order', () => {
    const edges = [E('o', 'w1'), E('o', 'w2')]
    expect(deriveOrderDeps(edges, 'o', [T('t1', 'w1'), T('t2', 'w2')])).toEqual({})
  })

  it('makes a later team depend on every earlier team task (two teams)', () => {
    const edges = [E('o', 'w1', 1), E('o', 'w2', 2)]
    const out = deriveOrderDeps(edges, 'o', [T('t1', 'w1'), T('t2', 'w2')])
    expect(out).toEqual({ t2: ['t1'] })
  })

  it('chains three teams: team 3 depends on teams 1 and 2', () => {
    const edges = [E('o', 'wa', 1), E('o', 'wb', 2), E('o', 'wc', 3)]
    const out = deriveOrderDeps(edges, 'o', [T('a', 'wa'), T('b', 'wb'), T('c', 'wc')])
    expect(out.b).toEqual(['a'])
    expect(out.c?.sort()).toEqual(['a', 'b'])
    expect(out.a).toBeUndefined()
  })

  it('gates a whole subtree: a manager+workers team ahead of a second team', () => {
    // team1 root = m (manager); m -> w1, w2 ; team2 root = w3
    const edges = [E('o', 'm', 1), E('m', 'w1'), E('m', 'w2'), E('o', 'w3', 2)]
    const tasks = [T('t1', 'w1'), T('t2', 'w2'), T('t3', 'w3')]
    const out = deriveOrderDeps(edges, 'o', tasks)
    expect(out.t3?.sort()).toEqual(['t1', 't2']) // team2 waits for ALL of team1's subtree
    expect(out.t1).toBeUndefined()
    expect(out.t2).toBeUndefined()
  })

  it('an empty earlier team adds no deps to the later team', () => {
    const edges = [E('o', 'w1', 1), E('o', 'w2', 2)]
    const out = deriveOrderDeps(edges, 'o', [T('t2', 'w2')]) // team1 (w1) owns no tasks
    expect(out).toEqual({}) // nothing earlier to wait on
  })

  it('ignores unordered sibling teams (they stay parallel)', () => {
    const edges = [E('o', 'w1', 1), E('o', 'w2'), E('o', 'w3', 2)]
    const out = deriveOrderDeps(edges, 'o', [T('t1', 'w1'), T('t2', 'w2'), T('t3', 'w3')])
    expect(out.t3).toEqual(['t1']) // only ordered teams chain
    expect(out.t2).toBeUndefined() // unordered team unaffected
  })

  it('never emits a self-dependency when one worker is shared across two ordered teams', () => {
    // w1 is under BOTH team-1 (order 1) and team-2 (order 2); it owns t1 (in team 2's slot)
    const edges = [E('o', 'w1', 1), E('o', 'w2', 2), E('o', 'w1', 2)]
    const out = deriveOrderDeps(edges, 'o', [T('t1', 'w1'), T('t2', 'w2')])
    for (const [id, deps] of Object.entries(out)) {
      expect(deps).not.toContain(id) // no task depends on itself
    }
  })
})

describe('applyOrderClick', () => {
  const mk = (id: string, order?: number) => ({ id, order })

  it('assigns the next number to an unordered edge', () => {
    const out = applyOrderClick([mk('a', 1), mk('b'), mk('c', 2)], 'b')
    expect(out.find((e) => e.id === 'b')!.order).toBe(3)
  })

  it('assigns 1 to the first ordered edge', () => {
    const out = applyOrderClick([mk('a'), mk('b')], 'a')
    expect(out.find((e) => e.id === 'a')!.order).toBe(1)
  })

  it('clears an order and re-packs the higher ones', () => {
    const out = applyOrderClick([mk('a', 1), mk('b', 2), mk('c', 3)], 'b')
    expect(out.find((e) => e.id === 'b')!.order).toBeUndefined()
    expect(out.find((e) => e.id === 'a')!.order).toBe(1) // unchanged (below cleared)
    expect(out.find((e) => e.id === 'c')!.order).toBe(2) // re-packed down
  })

  it('returns edges unchanged for an unknown id', () => {
    const edges = [mk('a', 1)]
    expect(applyOrderClick(edges, 'ghost')).toBe(edges)
  })
})

describe('deriveStages', () => {
  it('assigns each task its top-level team order (flat teams)', () => {
    const edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'w2', order: 2 }
    ]
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 't2', ownerId: 'w2' }
    ]
    expect(deriveStages(edges, 'o', tasks)).toEqual({ t1: 1, t2: 2 })
  })

  it("gives every task under a nested ordered team that team's stage", () => {
    const edges = [
      { source: 'o', target: 'm', order: 1 },
      { source: 'm', target: 'w1' },
      { source: 'm', target: 'w2' }
    ]
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 't2', ownerId: 'w2' }
    ]
    expect(deriveStages(edges, 'o', tasks)).toEqual({ t1: 1, t2: 1 })
  })

  it('assigns stage 0 to unordered teams and unowned tasks', () => {
    const edges = [{ source: 'o', target: 'w1' }] // no order anywhere
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 't2', ownerId: null }
    ]
    expect(deriveStages(edges, 'o', tasks)).toEqual({ t1: 0, t2: 0 })
  })

  it('mixes ordered and unordered teams', () => {
    const edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'w2' } // unordered
    ]
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 't2', ownerId: 'w2' }
    ]
    expect(deriveStages(edges, 'o', tasks)).toEqual({ t1: 1, t2: 0 })
  })
})

describe('handoff edges are ignored by ordering', () => {
  it('deriveOrderDeps ignores a handoff edge from the orchestrator', () => {
    const edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'w2', order: 2 },
      { source: 'o', target: 'x', order: 3, kind: 'handoff' as const } // must NOT become an ordered team
    ]
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 't2', ownerId: 'w2' },
      { id: 'tx', ownerId: 'x' }
    ]
    const deps = deriveOrderDeps(edges, 'o', tasks)
    expect(deps.tx).toBeUndefined() // x is reached only by a handoff edge → unordered
    expect(deps.t2).toEqual(['t1'])
  })

  it('deriveStages gives a handoff-only target stage 0', () => {
    const edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'x', order: 2, kind: 'handoff' as const }
    ]
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 'tx', ownerId: 'x' }
    ]
    expect(deriveStages(edges, 'o', tasks)).toEqual({ t1: 1, tx: 0 })
  })
})
