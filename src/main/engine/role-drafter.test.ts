import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  roster: {
    agents: [
      { id: 'w1', name: 'Dana', kind: 'worker', role: 'general' },
      { id: 'w2', name: 'Quinn', kind: 'worker', role: 'general' }
    ],
    edges: [{ source: 'm1', target: 'w1' }]
  }
}))

vi.mock('./project-store', () => ({
  rosterForDrafting: async () => h.roster,
  getAgent: (id: string) => ({ id, name: 'Boss' }),
  getSettings: () => ({ skillInstallThreshold: 100000, largeTeamMode: false })
}))
vi.mock('./agent-runner', () => ({ streamAgent: async () => ({ text: '' }) }))
vi.mock('./skill-discovery', () => ({ discoverSkills: async () => [] }))
vi.mock('../../shared/skill-trust', () => ({ offeredSkills: () => [] }))

import { draftRoles, type AgentRunner } from './role-drafter'

const opts = () => ({
  goal: 'build it',
  orchestratorId: 'o',
  wc: {} as never,
  abort: new AbortController(),
  runId: 'draft'
})

describe('draftRoles', () => {
  it('returns a named role draft for each roster agent', async () => {
    const runAgent: AgentRunner = async () => ({
      text: '```json\n{"roles":[{"agentId":"w1","role":"# Role: Dana\\nA"},{"agentId":"w2","role":"# Role: Quinn\\nB"}]}\n```'
    })
    expect(await draftRoles(opts(), runAgent)).toEqual([
      { agentId: 'w1', name: 'Dana', role: '# Role: Dana\nA' },
      { agentId: 'w2', name: 'Quinn', role: '# Role: Quinn\nB' }
    ])
  })

  it('retries once, then throws on persistently unparseable output', async () => {
    let calls = 0
    const runAgent: AgentRunner = async () => {
      calls++
      return { text: 'no json here' }
    }
    await expect(draftRoles(opts(), runAgent)).rejects.toThrow(/did not return valid role drafts/)
    expect(calls).toBe(2)
  })
})
