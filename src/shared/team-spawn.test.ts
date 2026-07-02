import { describe, it, expect } from 'vitest'
import { spawnTeamPrompt, parseSpawnedTeam, pickSpawnModel } from './team-spawn'
import { visionBias } from './team-vision'

describe('spawnTeamPrompt', () => {
  it('includes the goal, orchestrator name, existing members, and the JSON shape', () => {
    const p = spawnTeamPrompt('build a shop', 'Boss', [{ name: 'Dana', kind: 'worker', role: 'data' }])
    expect(p).toContain('build a shop')
    expect(p).toContain('Boss')
    expect(p).toContain('Dana')
    expect(p).toMatch(/distinct/i)
    expect(p).toContain('"members"')
    expect(p).toContain('reportsTo')
  })

  it('encourages a domain manager for a cluster of related roles (not only "several workers")', () => {
    const p = spawnTeamPrompt('build a big app', 'Boss', [])
    expect(p).toMatch(/cluster of (several )?related roles/i)
    expect(p).toMatch(/review|QA|test/i) // the rationale mentions dedicated review/QA
  })

  it('offers the provided skills and asks for per-member skills', () => {
    const p = spawnTeamPrompt('build it', 'Boss', [], [{ id: 'data:airflow', description: 'pipelines' }])
    expect(p).toContain('data:airflow')
    expect(p).toMatch(/skills/i)
  })
})

describe('parseSpawnedTeam', () => {
  it('parses a hierarchical team', () => {
    const text = '```json\n{"members":[{"id":"m1","name":"Lead","kind":"manager","role":"# Role: Lead","reportsTo":"orchestrator"},{"id":"w1","name":"Dev","kind":"worker","role":"# Role: Dev","reportsTo":"m1"}]}\n```'
    expect(parseSpawnedTeam(text)).toEqual([
      { id: 'm1', name: 'Lead', kind: 'manager', role: '# Role: Lead', reportsTo: 'orchestrator' },
      { id: 'w1', name: 'Dev', kind: 'worker', role: '# Role: Dev', reportsTo: 'm1' }
    ])
  })
  it('drops bad-kind / empty-role members and dedups ids', () => {
    const text = '```json\n{"members":[{"id":"w1","name":"A","kind":"worker","role":"r","reportsTo":"orchestrator"},{"id":"w1","name":"dup","kind":"worker","role":"r2","reportsTo":"orchestrator"},{"id":"x","name":"B","kind":"boss","role":"r","reportsTo":"orchestrator"},{"id":"y","name":"C","kind":"worker","role":"  ","reportsTo":"orchestrator"}]}\n```'
    expect(parseSpawnedTeam(text)!.map((m) => m.id)).toEqual(['w1'])
  })
  it('resets an unknown reportsTo to orchestrator', () => {
    const text = '```json\n{"members":[{"id":"w1","name":"A","kind":"worker","role":"r","reportsTo":"ghost"}]}\n```'
    expect(parseSpawnedTeam(text)![0].reportsTo).toBe('orchestrator')
  })
  it('breaks a reporting cycle so every member reaches the orchestrator', () => {
    const text = '```json\n{"members":[{"id":"a","name":"A","kind":"manager","role":"r","reportsTo":"b"},{"id":"b","name":"B","kind":"manager","role":"r","reportsTo":"a"}]}\n```'
    const out = parseSpawnedTeam(text)!
    const byId = new Map(out.map((m) => [m.id, m]))
    const reaches = (id: string): boolean => {
      let cur = byId.get(id)!.reportsTo
      let hops = 0
      while (cur !== 'orchestrator') {
        if (!byId.has(cur) || hops++ > 5) return false
        cur = byId.get(cur)!.reportsTo
      }
      return true
    }
    expect(reaches('a')).toBe(true)
    expect(reaches('b')).toBe(true)
  })
  it('returns null when there are no usable members', () => {
    expect(parseSpawnedTeam('no json')).toBeNull()
    expect(parseSpawnedTeam('```json\n{"members":[]}\n```')).toBeNull()
  })

  it('keeps only offered skill ids, caps at 5, drops unknown', () => {
    const valid = ['data:airflow', 'data:sql-queries', 'eng:a', 'eng:b', 'eng:c', 'eng:d']
    const text = '```json\n' + JSON.stringify({
      members: [{
        id: 'm1', name: 'Dev', kind: 'worker', role: '# Role', reportsTo: 'orchestrator',
        skills: ['data:airflow', 'ghost:x', 'data:sql-queries', 'eng:a', 'eng:b', 'eng:c', 'eng:d']
      }]
    }) + '\n```'
    const out = parseSpawnedTeam(text, valid)!
    expect(out[0].skills).toEqual(['data:airflow', 'data:sql-queries', 'eng:a', 'eng:b', 'eng:c']) // ghost dropped, capped to 5
  })

  it('omits skills when none are valid / none provided', () => {
    const text = '```json\n{"members":[{"id":"m1","name":"D","kind":"worker","role":"# R","reportsTo":"orchestrator"}]}\n```'
    expect(parseSpawnedTeam(text, ['data:airflow'])![0].skills).toBeUndefined()
  })
})

describe('spawnTeamPrompt model rubric', () => {
  it('omits the model field when assignModels is false (byte-for-byte today)', () => {
    const p = spawnTeamPrompt('g', 'Boss', [], [], false)
    expect(p).not.toMatch(/"model"/)
    expect(p).not.toMatch(/Opus/)
  })
  it('asks for a model with a tier rubric when assignModels is true', () => {
    const p = spawnTeamPrompt('g', 'Boss', [], [], true)
    expect(p).toContain('"model"')
    expect(p).toContain('claude-sonnet-4-6')
    expect(p).toContain('claude-opus-4-8')
    expect(p).not.toContain('claude-haiku-4-5') // never offered to workers
  })
})

describe('parseSpawnedTeam model', () => {
  const wrap = (m: object) => '```json\n' + JSON.stringify({ members: [m] }) + '\n```'
  it('keeps a valid model', () => {
    const r = parseSpawnedTeam(wrap({ id: 'a', name: 'A', kind: 'worker', role: 'r', model: 'claude-opus-4-8' }))
    expect(r?.[0].model).toBe('claude-opus-4-8')
  })
  it('drops an invalid model', () => {
    const r = parseSpawnedTeam(wrap({ id: 'a', name: 'A', kind: 'worker', role: 'r', model: 'gpt-5' }))
    expect(r?.[0].model).toBeUndefined()
  })
  it('rejects Haiku for a worker', () => {
    const r = parseSpawnedTeam(wrap({ id: 'a', name: 'A', kind: 'worker', role: 'r', model: 'claude-haiku-4-5' }))
    expect(r?.[0].model).toBeUndefined()
  })
  it('rejects Haiku for a manager too (never an auto-assigned tier)', () => {
    const r = parseSpawnedTeam(wrap({ id: 'a', name: 'A', kind: 'manager', role: 'r', model: 'claude-haiku-4-5' }))
    expect(r?.[0].model).toBeUndefined()
  })
})

describe('director-aware spawn', () => {
  it('is byte-for-byte when largeTeam is off', () => {
    expect(spawnTeamPrompt('g', 'Orky', [])).toBe(spawnTeamPrompt('g', 'Orky', [], [], false, false))
    expect(spawnTeamPrompt('g', 'Orky', [])).not.toContain('director')
  })
  it('mentions directors when largeTeam is on', () => {
    const p = spawnTeamPrompt('g', 'Orky', [], [], false, true)
    expect(p).toContain('director')
    expect(p).toContain('director|manager|worker')
  })
  it('parses a director member', () => {
    const text = '```json\n{ "members": [ { "id": "d1", "name": "Lead", "kind": "director", "role": "r", "reportsTo": "orchestrator" } ] }\n```'
    const members = parseSpawnedTeam(text)
    expect(members?.[0].kind).toBe('director')
  })
})

describe('vision-aware spawn', () => {
  it('is byte-for-byte when vision off', () => {
    expect(spawnTeamPrompt('g', 'O', [])).toBe(spawnTeamPrompt('g', 'O', [], [], false, false, false))
    expect(spawnTeamPrompt('g', 'O', [])).not.toMatch(/CREATIVE \/ DESIGN/)
  })
  it('injects the vision bias when on', () => {
    const p = spawnTeamPrompt('g', 'O', [], [], false, false, true)
    expect(p).toContain(visionBias().trim())
  })
})

describe('pickSpawnModel', () => {
  it('uses the proposed model when autoAssign is on and it is set', () => {
    expect(pickSpawnModel({ id: 'a', name: 'A', kind: 'worker', role: 'r', reportsTo: 'orchestrator', model: 'claude-opus-4-8' }, true)).toBe('claude-opus-4-8')
  })
  it('falls back to the kind default when autoAssign is off', () => {
    expect(pickSpawnModel({ id: 'a', name: 'A', kind: 'worker', role: 'r', reportsTo: 'orchestrator', model: 'claude-opus-4-8' }, false)).toBe('claude-sonnet-4-6')
  })
  it('falls back to the kind default when no model proposed', () => {
    expect(pickSpawnModel({ id: 'a', name: 'A', kind: 'worker', role: 'r', reportsTo: 'orchestrator' }, true)).toBe('claude-sonnet-4-6')
  })
})
