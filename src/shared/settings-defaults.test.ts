import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from './types'

describe('DEFAULT_SETTINGS', () => {
  it('defaults autoAssignModels to false (byte-for-byte off)', () => {
    expect(DEFAULT_SETTINGS.autoAssignModels).toBe(false)
  })

  it('defaults the security fields safely', () => {
    expect(DEFAULT_SETTINGS.trustAnthropicOnly).toBe(true)
    expect(DEFAULT_SETTINGS.blockPluginHooks).toBe(true)
    expect(DEFAULT_SETTINGS.lockBypassPermissions).toBe(false)
  })

  it('defaults maxOutputTokens to 0 (off — Claude Code default 32000, byte-for-byte)', () => {
    expect(DEFAULT_SETTINGS.maxOutputTokens).toBe(0)
  })
})
