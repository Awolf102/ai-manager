import { describe, it, expect } from 'vitest'
import { draftRolesPrompt, parseDraftedRoles, type DraftRosterAgent } from './role-draft'
import { visionBias } from './team-vision'

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

describe('draftRolesPrompt (with offered skills)', () => {
  it('offers skills when provided', () => {
    const p = draftRolesPrompt('g', [{ id: 'a', name: 'A', kind: 'worker', role: 'r' }], [], [{ id: 'data:airflow', description: 'pipelines' }])
    expect(p).toContain('data:airflow')
  })
})

describe('director-aware draft', () => {
  it('is byte-for-byte when largeTeam is off', () => {
    const roster = [{ id: 'a', name: 'A', kind: 'worker' as const, role: 'r' }]
    expect(draftRolesPrompt('g', roster, [])).toBe(draftRolesPrompt('g', roster, [], [], false))
    expect(draftRolesPrompt('g', roster, [])).toContain('(<Worker|Manager>)')
  })
  it('offers Director when largeTeam is on', () => {
    const roster = [{ id: 'a', name: 'A', kind: 'worker' as const, role: 'r' }]
    expect(draftRolesPrompt('g', roster, [], [], true)).toContain('(<Worker|Manager|Director>)')
  })
})

describe('vision-aware draft', () => {
  it('is byte-for-byte when vision off', () => {
    const roster = [{ id: 'a', name: 'A', kind: 'worker' as const, role: 'r' }]
    expect(draftRolesPrompt('g', roster, [])).toBe(draftRolesPrompt('g', roster, [], [], false, false))
    expect(draftRolesPrompt('g', roster, [])).not.toMatch(/CREATIVE \/ DESIGN/)
  })
  it('injects the vision bias when on', () => {
    const roster = [{ id: 'a', name: 'A', kind: 'worker' as const, role: 'r' }]
    expect(draftRolesPrompt('g', roster, [], [], false, true)).toContain(visionBias().trim())
  })
})

describe('parseDraftedRoles (with skill validation)', () => {
  it('reads optional per-role skills, validates + caps', () => {
    const text = '```json\n' + JSON.stringify({
      roles: [{ agentId: 'a', role: '# Role', skills: ['data:airflow', 'ghost:x', 'eng:a', 'eng:b', 'eng:c', 'eng:d'] }]
    }) + '\n```'
    const out = parseDraftedRoles(text, ['a'], ['data:airflow', 'eng:a', 'eng:b', 'eng:c', 'eng:d'])!
    expect(out[0].skills).toEqual(['data:airflow', 'eng:a', 'eng:b', 'eng:c', 'eng:d']) // ghost dropped, capped 5
  })
  it('omits skills when none valid', () => {
    const text = '```json\n{"roles":[{"agentId":"a","role":"# R"}]}\n```'
    expect(parseDraftedRoles(text, ['a'], ['data:airflow'])![0].skills).toBeUndefined()
  })
})
