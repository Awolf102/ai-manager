import { describe, it, expect } from 'vitest'
import { mergeBrainPush, planBrainPull, mergeLessons } from './team-brain'
import type { TeamBundle, TeamMember } from './team-bundle'
import type { AgentNodeData } from './types'

const mem = (memberId: string, lessons: string[]): TeamMember => ({
  memberId, name: memberId, kind: 'worker', model: 'm', permissionMode: 'acceptEdits',
  icon: 'i', position: { x: 0, y: 0 }, role: '', lessons
})
const bundle = (members: TeamMember[], edges: { source: string; target: string }[] = [], teamId = 'T1'): TeamBundle =>
  ({ kind: 'ai-manager-team', version: 1, teamId, name: 'S', exportedAt: 'X', members, edges })

describe('mergeBrainPush', () => {
  it('unions lessons for a matching member and preserves brain-only members + teamId', () => {
    const out = mergeBrainPush(bundle([mem('a', ['t1']), mem('z', ['zl'])], [], 'T1'), bundle([mem('a', ['t1', 't2'])], [], 'T2'))
    expect(out.teamId).toBe('T1')
    expect(out.members.find((m) => m.memberId === 'a')!.lessons).toEqual(['t1', 't2'])
    expect(out.members.find((m) => m.memberId === 'z')!.lessons).toEqual(['zl'])
  })
  it('adds a project member absent from the brain (growth)', () => {
    const out = mergeBrainPush(bundle([mem('a', ['x'])]), bundle([mem('b', ['y'])]))
    expect(out.members.map((m) => m.memberId).sort()).toEqual(['a', 'b'])
  })
  it('unions edges by source+target', () => {
    const out = mergeBrainPush(
      bundle([mem('a', [])], [{ source: 'a', target: 'b' }]),
      bundle([mem('a', [])], [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }])
    )
    expect(out.edges).toEqual([{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }])
  })
  it('caps a brain member lessons union at 40 newest-first on push', () => {
    const member = (id: string, lessons: string[]) => ({ memberId: id, name: id, kind: 'worker' as const, model: 'm', permissionMode: 'acceptEdits' as const, icon: '🤖', position: { x: 0, y: 0 }, role: '', lessons })
    const brain = { kind: 'ai-manager-team' as const, version: 1 as const, name: 'b', exportedAt: 'E', members: [member('w', Array.from({ length: 30 }, (_, i) => `old ${i}`))], edges: [] }
    const proj = { kind: 'ai-manager-team' as const, version: 1 as const, name: 'p', exportedAt: 'E', members: [member('w', Array.from({ length: 30 }, (_, i) => `new ${i}`))], edges: [] }
    const out = mergeBrainPush(brain, proj)
    const merged = out.members.find((m) => m.memberId === 'w')!
    expect(merged.lessons).toHaveLength(40)              // capped (was 30+30=60)
    expect(merged.lessons).toContain('new 29')          // newest kept
    expect(merged.lessons).not.toContain('old 0')       // oldest dropped
  })
})

describe('planBrainPull', () => {
  const nodes: AgentNodeData[] = [
    { id: 'n1', name: 'A', slug: 'a', kind: 'worker', icon: 'i', model: 'm', permissionMode: 'acceptEdits', position: { x: 0, y: 0 }, memberId: 'a' },
    { id: 'n2', name: 'B', slug: 'b', kind: 'worker', icon: 'i', model: 'm', permissionMode: 'acceptEdits', position: { x: 0, y: 0 } }
  ]
  it('matches members to nodes by memberId (with id fallback) and skips unmatched', () => {
    const out = planBrainPull(bundle([mem('a', ['l1']), mem('n2', ['l2']), mem('ghost', ['l3'])]), nodes)
    expect(out).toEqual([{ agentId: 'n1', lessons: ['l1'] }, { agentId: 'n2', lessons: ['l2'] }])
  })
})

describe('mergeLessons', () => {
  it('adds new portable lessons, dedups vs existing, preserves task log + project lessons', () => {
    const memory = '# Memory\n\n## Lessons\n- [portable] write tests first\n- [project] api key in config\n\n## Task log\n### 2026 — g\n- Win: w\n'
    const next = mergeLessons(memory, ['verify renders', 'write tests first'])
    expect(next).toContain('- [portable] verify renders')
    expect((next.match(/write tests first/g) || []).length).toBe(1)
    expect(next).toContain('- [project] api key in config')
    expect(next).toContain('### 2026 — g')
  })
  it('is a no-op when nothing is new', () => {
    const memory = '## Lessons\n- [portable] x\n\n## Task log\n'
    expect(mergeLessons(memory, ['x'])).toBe(memory)
  })
})
