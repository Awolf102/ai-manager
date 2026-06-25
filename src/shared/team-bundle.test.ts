import { describe, it, expect } from 'vitest'
import {
  buildTeamBundle,
  buildSeededMemory,
  validateTeamBundle,
  planTeamImport,
  type TeamBundle
} from './team-bundle'
import type { AgentNodeData, GraphEdge } from './types'

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
