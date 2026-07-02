import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from './types'

describe('DEFAULT_SETTINGS token-efficiency fields', () => {
  it('defaults every token-efficiency lever to off/neutral', () => {
    expect(DEFAULT_SETTINGS.outputMode).toBe('normal')
    expect(DEFAULT_SETTINGS.effortThrift).toBe(false)
    expect(DEFAULT_SETTINGS.effortThriftCeiling).toBe('medium')
    expect(DEFAULT_SETTINGS.cheapModelWorkers).toBe(false)
    expect(DEFAULT_SETTINGS.cheapModelTier).toBe('claude-haiku-4-5')
    expect(DEFAULT_SETTINGS.lightPrompts).toBe(false)
  })
})

describe('follow-through setting', () => {
  it('defaults followThrough to off', () => {
    expect(DEFAULT_SETTINGS.followThrough).toBe('off')
  })
})

describe('follow-through ask settings', () => {
  it('defaults maxFollowThrough to 0', () => {
    expect(DEFAULT_SETTINGS.maxFollowThrough).toBe(0)
  })
})
