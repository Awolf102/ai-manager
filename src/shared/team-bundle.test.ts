import { describe, it, expect } from 'vitest'
import {
  buildTeamBundle,
  buildSeededMemory,
  validateTeamBundle,
  planTeamImport,
  previewOf,
  type TeamBundle
} from './team-bundle'
import type { AgentNodeData, GraphEdge } from './types'
import { MODELS } from './types'

const node = (over: Partial<AgentNodeData>): AgentNodeData => ({
  id: 'id1', name: 'Dana', slug: 'dana', kind: 'worker', icon: 'i',
  model: 'm', permissionMode: 'acceptEdits', position: { x: 10, y: 20 }, ...over
})

describe('buildSeededMemory', () => {
  it('seeds portable lessons as [portable] bullets with an empty task log', () => {
    const mem = buildSeededMemory('Dana', ['write tests first', 'verify renders'])
    expect(mem).toContain('## Lessons')
    expect(mem).toContain('- [portable] write tests first')
    expect(mem).toContain('- [portable] verify renders')
    expect(mem).toContain('## Task log')
    expect(mem).not.toMatch(/###/) // no log entries
  })
  it('uses the (none yet) placeholder when there are no lessons', () => {
    expect(buildSeededMemory('Dana', [])).toContain('- (none yet)')
  })
})

describe('buildTeamBundle', () => {
  const nodes = [node({ id: 'a', name: 'Dana', skills: ['data:analyze'] }), node({ id: 'b', name: 'Quinn', slug: 'quinn' })]
  const edges: GraphEdge[] = [{ id: 'e1', source: 'a', target: 'b' }]
  const files = {
    a: { role: 'role A', memory: '## Lessons\n- [portable] write tests first\n- [project] secret path\n' },
    b: { role: 'role B', memory: '## Lessons\n- (none yet)\n' }
  }

  it('carries roster fields, role, and portable-only lessons', () => {
    const bundle = buildTeamBundle({ name: 'Squad', exportedAt: 'T', nodes, edges, files })
    expect(bundle.kind).toBe('ai-manager-team')
    expect(bundle.version).toBe(1)
    const dana = bundle.members.find((m) => m.name === 'Dana')!
    expect(dana.role).toBe('role A')
    expect(dana.lessons).toEqual(['write tests first']) // project + untagged excluded
    expect(dana.skills).toEqual(['data:analyze'])
  })

  it('derives memberId as node.memberId ?? node.id and keys edges by memberId', () => {
    const withMember = [node({ id: 'a', name: 'Dana', memberId: 'mem-a' }), node({ id: 'b', name: 'Quinn', slug: 'quinn' })]
    const bundle = buildTeamBundle({ name: 'Squad', exportedAt: 'T', nodes: withMember, edges, files })
    expect(bundle.members.find((m) => m.name === 'Dana')!.memberId).toBe('mem-a')
    expect(bundle.members.find((m) => m.name === 'Quinn')!.memberId).toBe('b')
    expect(bundle.edges).toEqual([{ source: 'mem-a', target: 'b' }])
  })
})

describe('validateTeamBundle', () => {
  const good: TeamBundle = {
    kind: 'ai-manager-team', version: 1, name: 'S', exportedAt: 'T',
    members: [{ memberId: 'm', name: 'Dana', kind: 'worker', model: 'm', permissionMode: 'acceptEdits', icon: 'i', position: { x: 0, y: 0 }, role: '', lessons: [] }],
    edges: []
  }
  it('accepts a well-formed bundle', () => {
    const r = validateTeamBundle(good)
    expect(r.ok).toBe(true)
  })
  it('rejects wrong kind / version / shape with a message', () => {
    expect(validateTeamBundle({ ...good, kind: 'nope' }).ok).toBe(false)
    expect(validateTeamBundle({ ...good, version: 2 }).ok).toBe(false)
    expect(validateTeamBundle({ ...good, members: 'x' }).ok).toBe(false)
    expect(validateTeamBundle(null).ok).toBe(false)
  })
})

describe('planTeamImport', () => {
  const bundle: TeamBundle = {
    kind: 'ai-manager-team', version: 1, name: 'S', exportedAt: 'T',
    members: [
      { memberId: 'm1', name: 'Dana', kind: 'worker', model: 'm', permissionMode: 'acceptEdits', skills: ['data:analyze'], icon: 'i', position: { x: 10, y: 20 }, role: 'role A', lessons: ['write tests first'] }
    ],
    edges: []
  }
  it('uniquifies slugs against existing, offsets positions, seeds memory, carries memberId/skills', () => {
    const plan = planTeamImport(bundle, ['dana'])
    const m = plan.members[0]
    expect(m.slug).toBe('dana-2') // 'dana' taken
    expect(m.memberId).toBe('m1')
    expect(m.skills).toEqual(['data:analyze'])
    expect(m.position).toEqual({ x: 58, y: 68 }) // +48 offset
    expect(m.memory).toContain('- [portable] write tests first')
  })
})

function rawBundle(members: unknown[]): unknown {
  return { kind: 'ai-manager-team', version: 1, name: 't', exportedAt: 'x', members, edges: [] }
}

describe('validateTeamBundle (normalize)', () => {
  it('clamps oversized role + lessons and whitelists model/permissionMode, never throws', () => {
    const r = validateTeamBundle(rawBundle([{
      memberId: 'm1', name: 'A', kind: 'worker', icon: 'x',
      model: 'evil-model', permissionMode: 'bypassPermissions',
      position: { x: Number.NaN, y: 3 },
      role: 'z'.repeat(60000),
      lessons: Array.from({ length: 500 }, () => 'L'.repeat(5000))
    }]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const m = r.bundle.members[0]
    expect(m.model).toBe('claude-sonnet-4-6') // unknown → worker default
    expect(MODELS.some((x) => x.id === m.model)).toBe(true)
    expect(m.permissionMode).toBe('bypassPermissions') // valid enum value kept here; planTeamImport forces acceptEdits
    expect(m.position).toEqual({ x: 0, y: 3 })
    expect(m.role.length).toBe(50000)
    expect(m.lessons.length).toBe(200)
    expect(m.lessons[0].length).toBe(2000)
  })

  it('coerces an unknown permissionMode to acceptEdits', () => {
    const r = validateTeamBundle(rawBundle([{ memberId: 'm', name: 'A', kind: 'worker', icon: 'x', model: 'claude-sonnet-4-6', permissionMode: 'sudo', position: { x: 0, y: 0 }, role: '', lessons: [] }]))
    expect(r.ok && r.bundle.members[0].permissionMode).toBe('acceptEdits')
  })

  it('rejects a member missing memberId/name and a too-large team', () => {
    expect(validateTeamBundle(rawBundle([{ name: 'A', kind: 'worker' }])).ok).toBe(false)
    const many = Array.from({ length: 1001 }, (_, i) => ({ memberId: `m${i}`, name: 'A', kind: 'worker', icon: 'x', model: 'claude-sonnet-4-6', permissionMode: 'acceptEdits', position: { x: 0, y: 0 }, role: '', lessons: [] }))
    expect(validateTeamBundle(rawBundle(many)).ok).toBe(false)
  })

  it('keeps a well-formed exported bundle valid (round-trip) and reports warnings', () => {
    const good = validateTeamBundle(rawBundle([{ memberId: 'm', name: 'A', kind: 'manager', icon: 'x', model: 'claude-opus-4-8', permissionMode: 'acceptEdits', position: { x: 1, y: 2 }, role: 'hi', lessons: ['a'] }]))
    expect(good.ok).toBe(true)
    if (good.ok) expect(Array.isArray(good.warnings)).toBe(true)
  })
})

describe('planTeamImport (force safe mode)', () => {
  it('forces acceptEdits regardless of the bundle value', () => {
    const v = validateTeamBundle(rawBundle([{ memberId: 'm', name: 'A', kind: 'worker', icon: 'x', model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions', position: { x: 0, y: 0 }, role: '', lessons: [] }]))
    if (!v.ok) throw new Error('precondition')
    const plan = planTeamImport(v.bundle, [])
    expect(plan.members[0].permissionMode).toBe('acceptEdits')
  })
})

describe('validateTeamBundle (duplicate memberId)', () => {
  it('drops a member with a duplicate memberId (keeps the first) with a warning', () => {
    const raw = {
      kind: 'ai-manager-team', version: 1, name: 't', exportedAt: 'E',
      members: [
        { memberId: 'x', name: 'First', kind: 'worker' },
        { memberId: 'x', name: 'Second', kind: 'worker' }
      ],
      edges: []
    }
    const res = validateTeamBundle(raw)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.bundle.members).toHaveLength(1)
    expect(res.bundle.members[0].name).toBe('First')
    expect(res.warnings.some((w) => w.toLowerCase().includes('duplicate'))).toBe(true)
  })
})

describe('previewOf', () => {
  it('summarizes members with their forced mode', () => {
    const v = validateTeamBundle(rawBundle([{ memberId: 'm', name: 'A', kind: 'worker', icon: 'x', model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions', position: { x: 0, y: 0 }, role: 'do x', lessons: [] }]))
    if (!v.ok) throw new Error('precondition')
    const p = previewOf(v.bundle, v.warnings)
    expect(p.members[0]).toEqual({ name: 'A', kind: 'worker', role: 'do x' })
    expect(Array.isArray(p.warnings)).toBe(true)
  })
})
