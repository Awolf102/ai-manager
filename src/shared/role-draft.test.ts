import { describe, it, expect } from 'vitest'
import { draftRolesPrompt, parseDraftedRoles, type DraftRosterAgent } from './role-draft'

const roster: DraftRosterAgent[] = [
  { id: 'w1', name: 'Dana', kind: 'worker', role: 'general' },
  { id: 'w2', name: 'Quinn', kind: 'worker', role: 'general' }
]

describe('draftRolesPrompt', () => {
  it('includes the goal, every roster agent, the topology, and the JSON shape', () => {
    const p = draftRolesPrompt('build a data app', roster, [{ source: 'm1', target: 'w1' }])
    expect(p).toContain('build a data app')
    expect(p).toContain('id: w1')
    expect(p).toContain('Dana')
    expect(p).toContain('Quinn')
    expect(p).toMatch(/distinct/i)
    expect(p).toContain('"roles"')
  })
})

describe('parseDraftedRoles', () => {
  it('parses roles for known agents', () => {
    const text = '```json\n{"roles":[{"agentId":"w1","role":"# Role: Dana"},{"agentId":"w2","role":"# Role: Quinn"}]}\n```'
    expect(parseDraftedRoles(text, ['w1', 'w2'])).toEqual([
      { agentId: 'w1', role: '# Role: Dana' },
      { agentId: 'w2', role: '# Role: Quinn' }
    ])
  })
  it('drops unknown agent ids and empty roles', () => {
    const text = '```json\n{"roles":[{"agentId":"ghost","role":"x"},{"agentId":"w1","role":"   "},{"agentId":"w2","role":"ok"}]}\n```'
    expect(parseDraftedRoles(text, ['w1', 'w2'])).toEqual([{ agentId: 'w2', role: 'ok' }])
  })
  it('returns null when there is no roles array', () => {
    expect(parseDraftedRoles('no json here', ['w1'])).toBeNull()
    expect(parseDraftedRoles('```json\n{"nope":1}\n```', ['w1'])).toBeNull()
  })
})
