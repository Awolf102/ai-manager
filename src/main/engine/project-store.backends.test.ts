import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))

// Spy target for deleteBackendToken — lets one test simulate a token-delete failure.
const deleteTokenSpy = vi.hoisted(() => ({ shouldFail: false }))
vi.mock('./backend-secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./backend-secrets')>()
  return {
    ...actual,
    deleteBackendToken: vi.fn(async (...args: Parameters<typeof actual.deleteBackendToken>) => {
      if (deleteTokenSpy.shouldFail) throw new Error('disk error')
      return actual.deleteBackendToken(...args)
    })
  }
})

import {
  openProject,
  getBackends,
  addBackend,
  updateBackend,
  removeBackend,
  backendsView,
  createAgent,
  updateAgent,
  getGraph
} from './project-store'
import { setBackendToken } from './backend-secrets'

let proj: string
beforeEach(async () => {
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-be-'))
  await openProject(proj)
})
afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

const input = { label: 'z.ai', baseUrl: 'https://z/api', models: [{ id: 'glm-4.6', label: 'GLM-4.6' }], presetId: 'zai-glm' }

describe('backend store', () => {
  it('defaults to [] on open', () => {
    expect(getBackends()).toEqual([])
  })

  it('adds a backend with an id + addedAt', async () => {
    await addBackend(input)
    const [b] = getBackends()
    expect(b.label).toBe('z.ai')
    expect(b.baseUrl).toBe('https://z/api')
    expect(typeof b.id).toBe('string')
    expect(typeof b.addedAt).toBe('string')
  })

  it('updates label/baseUrl/models', async () => {
    await addBackend(input)
    const id = getBackends()[0].id
    await updateBackend(id, { label: 'renamed' })
    expect(getBackends()[0].label).toBe('renamed')
  })

  it('removes a backend, unassigns referencing agents, and deletes its token', async () => {
    await addBackend(input)
    const id = getBackends()[0].id
    await setBackendToken(proj, id, 'sk-1')
    await createAgent({ name: 'W', kind: 'worker' })
    const agentId = getGraph().nodes[0].id
    await updateAgent({ id: agentId, backendId: id })
    await removeBackend(id)
    expect(getBackends()).toEqual([])
    expect(getGraph().nodes[0].backendId).toBeUndefined()
    expect((await backendsView()).length).toBe(0)
  })

  it('backendsView reports hasToken without exposing the token', async () => {
    await addBackend(input)
    const id = getBackends()[0].id
    expect((await backendsView())[0].hasToken).toBe(false)
    await setBackendToken(proj, id, 'sk-1')
    const view = await backendsView()
    expect(view[0].hasToken).toBe(true)
    expect('token' in view[0]).toBe(false)
  })

  it('removeBackend still resolves and drops the backend when deleteBackendToken rejects', async () => {
    await addBackend(input)
    const id = getBackends()[0].id
    deleteTokenSpy.shouldFail = true
    try {
      await removeBackend(id)
    } finally {
      deleteTokenSpy.shouldFail = false
    }
    expect(getBackends()).toEqual([])
  })
})
