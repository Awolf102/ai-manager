import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, AGENT_KINDS, DEFAULT_MODEL_BY_KIND } from './types'
import { iconForName } from './icons'

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

describe('director AgentKind', () => {
  it('is in AGENT_KINDS in chain order', () => {
    expect(AGENT_KINDS).toEqual(['orchestrator', 'director', 'manager', 'worker'])
  })
  it('defaults a director to Opus', () => {
    expect(DEFAULT_MODEL_BY_KIND.director).toBe('claude-opus-4-8')
  })
  it('falls back a director icon to compass', () => {
    expect(iconForName('Delivery Lead', 'director')).toBe('compass')
  })
})
