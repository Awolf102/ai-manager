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

import { openProject, addBackend, getBackends, createAgent, updateAgent, getGraph } from './project-store'
import { setBackendToken } from './backend-secrets'
import { resolveBackendEnv } from './backend-resolve'

let proj: string
beforeEach(async () => {
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-res-'))
  await openProject(proj)
  await createAgent({ name: 'W', kind: 'worker' })
})
afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

const agent = () => getGraph().nodes[0]

describe('resolveBackendEnv', () => {
  it('returns none when the agent has no backend', async () => {
    expect(await resolveBackendEnv(agent())).toEqual({ kind: 'none' })
  })

  it('returns env + label when the backend and token resolve', async () => {
    await addBackend({ label: 'z.ai', baseUrl: 'https://z/api', models: [{ id: 'glm-4.6', label: 'GLM' }] })
    const id = getBackends()[0].id
    await setBackendToken(proj, id, 'sk-1')
    await updateAgent({ id: agent().id, backendId: id })
    const r = await resolveBackendEnv(agent())
    expect(r).toEqual({
      kind: 'env',
      label: 'z.ai',
      env: { ANTHROPIC_BASE_URL: 'https://z/api', ANTHROPIC_AUTH_TOKEN: 'sk-1' }
    })
  })

  it('errors when the backend is missing', async () => {
    await updateAgent({ id: agent().id, backendId: 'ghost' })
    const r = await resolveBackendEnv(agent())
    expect(r.kind).toBe('error')
  })

  it('errors when the token is missing', async () => {
    await addBackend({ label: 'z.ai', baseUrl: 'https://z/api', models: [] })
    const id = getBackends()[0].id
    await updateAgent({ id: agent().id, backendId: id })
    const r = await resolveBackendEnv(agent())
    expect(r.kind).toBe('error')
  })
})
