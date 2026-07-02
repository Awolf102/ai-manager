import { describe, it, expect } from 'vitest'
import { BACKEND_PRESETS, backendEnv, parseModelIds } from './model-backends'

describe('backendEnv', () => {
  it('maps base URL + token to the Anthropic env vars', () => {
    expect(backendEnv('https://x/api', 'tok')).toEqual({
      ANTHROPIC_BASE_URL: 'https://x/api',
      ANTHROPIC_AUTH_TOKEN: 'tok'
    })
  })
})

describe('BACKEND_PRESETS', () => {
  it('has unique preset ids including custom, and the expected flags', () => {
    const ids = BACKEND_PRESETS.map((p) => p.presetId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('custom')
    expect(BACKEND_PRESETS.find((p) => p.presetId === 'zai-glm')!.baseUrl).not.toBe('')
    expect(BACKEND_PRESETS.find((p) => p.presetId === 'chatgpt-gateway')!.gateway).toBe(true)
    expect(BACKEND_PRESETS.find((p) => p.presetId === 'chatgpt-gateway')!.baseUrl).toBe('')
  })
})

describe('parseModelIds', () => {
  it('parses comma/newline lists, supports id|Label, trims, drops blanks', () => {
    expect(parseModelIds('glm-4.6, glm-4.5-air')).toEqual([
      { id: 'glm-4.6', label: 'glm-4.6' },
      { id: 'glm-4.5-air', label: 'glm-4.5-air' }
    ])
    expect(parseModelIds('a|Alpha\n b ')).toEqual([
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'b' }
    ])
    expect(parseModelIds('  ')).toEqual([])
  })
})
