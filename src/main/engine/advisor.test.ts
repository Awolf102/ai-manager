import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))

import { openProject, addBackend, getBackends } from './project-store'
import { setBackendToken } from './backend-secrets'
import { buildAdvisorContext, folderDigest } from './advisor'
import { advisorSystemPrompt } from '../../shared/advisor'

let proj: string
beforeEach(async () => {
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-adv-'))
  await openProject(proj)
})
afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

describe('buildAdvisorContext', () => {
  it('maps backends to label+models and NEVER includes the token or base URL', async () => {
    await addBackend({ label: 'z.ai', baseUrl: 'https://api.z.ai/secret', models: [{ id: 'glm-4.6', label: 'GLM' }] })
    await setBackendToken(proj, getBackends()[0].id, 'sk-super-secret')
    const ctx = buildAdvisorContext()
    expect(ctx.backends).toEqual([{ label: 'z.ai', models: ['glm-4.6'] }])
    const prompt = advisorSystemPrompt(ctx)
    expect(prompt).not.toContain('sk-super-secret')
    expect(prompt).not.toContain('https://api.z.ai/secret')
  })
})

describe('folderDigest', () => {
  it('lists top-level entries of a folder', async () => {
    await fs.writeFile(join(proj, 'a.txt'), 'x')
    const d = await folderDigest(proj)
    expect(d).toContain('a.txt')
  })
})
