import { describe, it, expect } from 'vitest'
import { spawnTeamPrompt, parseSpawnedTeam } from './team-spawn'

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
})
