import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  roster: { agents: [{ id: 'w1', name: 'Dana', kind: 'worker', role: 'r' }], edges: [] }
}))
vi.mock('./project-store', () => ({
  rosterForDrafting: async () => h.roster,
  getAgent: (id: string) => ({ id, name: 'Boss' }),
  getSettings: () => ({ skillInstallThreshold: 100000 })
}))
vi.mock('./agent-runner', () => ({ streamAgent: async () => ({ text: '' }) }))
vi.mock('./skill-discovery', () => ({ discoverSkills: async () => [] }))
vi.mock('../../shared/skill-trust', () => ({ offeredSkills: () => [] }))

import { spawnTeam, type AgentRunner } from './team-spawner'

const opts = () => ({
  goal: 'g',
  orchestratorId: 'o',
  wc: {} as never,
  abort: new AbortController(),
  runId: 's'
})

describe('spawnTeam', () => {
  it('returns the validated proposed team', async () => {
    const runAgent: AgentRunner = async () => ({
      text: '```json\n{"members":[{"id":"m1","name":"Lead","kind":"manager","role":"# Role","reportsTo":"orchestrator"}]}\n```'
    })
    expect(await spawnTeam(opts(), runAgent)).toEqual([
      { id: 'm1', name: 'Lead', kind: 'manager', role: '# Role', reportsTo: 'orchestrator' }
    ])
  })

  it('retries once, then throws on persistently unparseable output', async () => {
    let calls = 0
    const runAgent: AgentRunner = async () => {
      calls++
      return { text: 'nope' }
    }
    await expect(spawnTeam(opts(), runAgent)).rejects.toThrow(/did not return a valid team/)
    expect(calls).toBe(2)
  })
})
