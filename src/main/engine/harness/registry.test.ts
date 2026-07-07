import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { StreamAgentOptions } from '../agent-runner'
import type { HarnessId } from '../../../shared/types'
import type { Harness } from './types'

const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))
// Mock the Claude-SDK harness so no test path touches the real SDK; the mock IS the registered
// 'claude-sdk' harness's run (registry.ts imports { streamAgent } from '../agent-runner').
vi.mock('../agent-runner', () => ({
  streamAgent: vi.fn(async () => ({ text: 'claude-ran', sessionId: 'sid-claude' }))
}))

import { openProject, createAgent, updateAgent, getGraph } from '../project-store'
import { streamAgent } from '../agent-runner'
import { harnessFor, dispatchAgent, harnessRegistry } from './registry'

let proj: string
beforeEach(async () => {
  vi.clearAllMocks() // clears call history; keeps the streamAgent mock implementation
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-harness-'))
  await openProject(proj)
  await createAgent({ name: 'W', kind: 'worker' })
})
afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

const worker = () => getGraph().nodes.find((n) => n.name === 'W')!
const opts = (agentId: string): StreamAgentOptions => ({
  wc: {} as unknown as WebContents,
  agentId,
  prompt: 'hi',
  runId: 'r1'
})

describe('harnessFor', () => {
  it('resolves claude-sdk, undefined, and unknown ids all to the claude-sdk harness', () => {
    expect(harnessFor('claude-sdk').run).toBe(streamAgent)
    expect(harnessFor(undefined).run).toBe(streamAgent)
    expect(harnessFor('nope' as HarnessId).run).toBe(streamAgent)
  })
})

describe('dispatchAgent', () => {
  it('routes an agent with no harness to the claude-sdk harness, passing opts through and returning its result', async () => {
    const o = opts(worker().id)
    const res = await dispatchAgent(o)
    expect(streamAgent).toHaveBeenCalledTimes(1)
    expect(streamAgent).toHaveBeenCalledWith(o) // same opts object — byte-for-byte passthrough
    expect(res).toEqual({ text: 'claude-ran', sessionId: 'sid-claude' })
  })

  it('routes on the harness field to a registered alternate harness', async () => {
    const fakeRun = vi.fn(async () => ({ text: 'fake-ran' }))
    const fake: Harness = { run: fakeRun }
    harnessRegistry['openai' as HarnessId] = fake
    try {
      await updateAgent({ id: worker().id, harness: 'openai' as HarnessId })
      const res = await dispatchAgent(opts(worker().id))
      expect(fakeRun).toHaveBeenCalledTimes(1)
      expect(streamAgent).not.toHaveBeenCalled()
      expect(res).toEqual({ text: 'fake-ran' })
    } finally {
      delete harnessRegistry['openai' as HarnessId]
    }
  })

  it('falls back to the claude-sdk harness (never throws) when the agent id does not resolve', async () => {
    const res = await dispatchAgent(opts('ghost-id'))
    expect(streamAgent).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ text: 'claude-ran', sessionId: 'sid-claude' })
  })
})
