import { describe, it, expect } from 'vitest'
import { clampMaxOutputTokens, maxOutputTokensEnv, withMaxOutputTokensEnv } from './max-output-tokens'

describe('clampMaxOutputTokens', () => {
  it('keeps 0 (off) and in-range values', () => {
    expect(clampMaxOutputTokens(0)).toBe(0)
    expect(clampMaxOutputTokens(64000)).toBe(64000)
  })
  it('bounds, floors, and rejects non-finite', () => {
    expect(clampMaxOutputTokens(200000)).toBe(128000)
    expect(clampMaxOutputTokens(-5)).toBe(0)
    expect(clampMaxOutputTokens(1000.9)).toBe(1000)
    expect(clampMaxOutputTokens(Number.NaN)).toBe(0)
    expect(clampMaxOutputTokens(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('maxOutputTokensEnv', () => {
  it('is empty when off (n <= 0)', () => {
    expect(maxOutputTokensEnv(0)).toEqual({})
    expect(maxOutputTokensEnv(-1)).toEqual({})
  })
  it('sets the stringified var when on', () => {
    expect(maxOutputTokensEnv(64000)).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' })
  })
})

describe('withMaxOutputTokensEnv', () => {
  const proc = { PATH: '/bin' }
  it('off + no base ⇒ undefined (subprocess inherits process.env, byte-for-byte)', () => {
    expect(withMaxOutputTokensEnv(undefined, proc, 0)).toBeUndefined()
  })
  it('off + base ⇒ the same base object, unchanged', () => {
    const base = { ANTHROPIC_BASE_URL: 'https://z' }
    expect(withMaxOutputTokensEnv(base, proc, 0)).toBe(base)
  })
  it('on + no base ⇒ overlays onto processEnv', () => {
    expect(withMaxOutputTokensEnv(undefined, proc, 64000)).toEqual({
      PATH: '/bin',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000'
    })
  })
  it('on + base ⇒ overlays onto base (not processEnv)', () => {
    expect(withMaxOutputTokensEnv({ ANTHROPIC_BASE_URL: 'https://z' }, proc, 64000)).toEqual({
      ANTHROPIC_BASE_URL: 'https://z',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000'
    })
  })
})
