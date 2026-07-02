import { describe, it, expect, vi } from 'vitest'

const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))

import { applyBackendToRun } from './agent-runner'

describe('applyBackendToRun', () => {
  it('for an env backend: uses agent.model, spreads process.env + backend env, sets label', () => {
    process.env.__AIM_TEST__ = 'sentinel'
    const r = applyBackendToRun(
      { kind: 'env', label: 'z.ai', env: { ANTHROPIC_BASE_URL: 'https://z', ANTHROPIC_AUTH_TOKEN: 't' } },
      'glm-4.6',
      'claude-haiku-4-5' // an override that must be IGNORED for a backend agent
    )
    expect(r.model).toBe('glm-4.6')
    expect(r.label).toBe('z.ai')
    expect(r.env!.ANTHROPIC_BASE_URL).toBe('https://z')
    expect(r.env!.__AIM_TEST__).toBe('sentinel')
    delete process.env.__AIM_TEST__
  })

  it('for none: applies the override precedence and sets no env/label', () => {
    expect(applyBackendToRun({ kind: 'none' }, 'claude-sonnet-4-6', 'claude-haiku-4-5')).toEqual({ model: 'claude-haiku-4-5' })
    expect(applyBackendToRun({ kind: 'none' }, 'claude-sonnet-4-6', undefined)).toEqual({ model: 'claude-sonnet-4-6' })
  })
})
