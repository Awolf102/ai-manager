import { describe, it, expect, vi } from 'vitest'

vi.mock('./project-store', () => ({
  getCurrentProjectPath: () => '/no/such/project-xyz',
  getAgent: (id: string) => ({ id, name: 'Boss' }),
  listRuns: async () => [],
  loadRun: async () => null
}))
vi.mock('./agent-runner', () => ({ streamAgent: async () => ({ text: '' }) }))

import { detectManifest, type AgentRunner } from './manifest-detector'

const opts = () => ({
  goal: 'build it',
  orchestratorId: 'o',
  wc: {} as never,
  abort: new AbortController(),
  runId: 'detect'
})

describe('detectManifest', () => {
  it('returns the parsed manifest from the agent output', async () => {
    const runAgent: AgentRunner = async () => ({
      text: '```json\n{"type":"web","startCommand":"npm run dev","port":5173,"path":"/"}\n```'
    })
    expect(await detectManifest(opts(), runAgent)).toEqual({
      type: 'web',
      startCommand: 'npm run dev',
      port: 5173,
      path: '/'
    })
  })

  it('retries once, then throws on persistently unparseable output', async () => {
    let calls = 0
    const runAgent: AgentRunner = async () => {
      calls++
      return { text: 'no json here' }
    }
    await expect(detectManifest(opts(), runAgent)).rejects.toThrow(/did not return a valid run manifest/)
    expect(calls).toBe(2)
  })
})
