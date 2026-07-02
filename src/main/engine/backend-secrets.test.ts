import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ avail: true }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => state.avail,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))

import {
  encryptionAvailable,
  setBackendToken,
  getBackendToken,
  hasBackendToken,
  deleteBackendToken
} from './backend-secrets'

let proj: string
beforeEach(async () => {
  state.avail = true
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-sec-'))
})
afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

describe('backend secrets', () => {
  it('roundtrips a token and reports presence', async () => {
    expect(encryptionAvailable()).toBe(true)
    expect(await hasBackendToken(proj, 'b1')).toBe(false)
    await setBackendToken(proj, 'b1', 'sk-123')
    expect(await hasBackendToken(proj, 'b1')).toBe(true)
    expect(await getBackendToken(proj, 'b1')).toBe('sk-123')
  })

  it('returns undefined for an unknown id', async () => {
    expect(await getBackendToken(proj, 'nope')).toBeUndefined()
  })

  it('deletes a token', async () => {
    await setBackendToken(proj, 'b1', 'x')
    await deleteBackendToken(proj, 'b1')
    expect(await hasBackendToken(proj, 'b1')).toBe(false)
  })

  it('writes a self-contained .ai-manager/.gitignore for the secret file', async () => {
    await setBackendToken(proj, 'b1', 'x')
    const gi = await fs.readFile(join(proj, '.ai-manager', '.gitignore'), 'utf8')
    expect(gi).toContain('backend-secrets.json')
  })

  it('throws when encryption is unavailable', async () => {
    state.avail = false
    await expect(setBackendToken(proj, 'b1', 'x')).rejects.toThrow()
  })
})
