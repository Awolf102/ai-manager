import { describe, it, expect } from 'vitest'
import { outputModeInstruction, capEffort } from './token-efficiency'

describe('outputModeInstruction', () => {
  it('returns empty string for normal (byte-for-byte when off)', () => {
    expect(outputModeInstruction('normal')).toBe('')
  })
  it('terse and code-only return non-empty instructions', () => {
    expect(outputModeInstruction('terse').length).toBeGreaterThan(0)
    expect(outputModeInstruction('code-only').length).toBeGreaterThan(0)
  })
  it('both non-normal modes exempt required structured/JSON output', () => {
    for (const m of ['terse', 'code-only'] as const) {
      expect(outputModeInstruction(m).toLowerCase()).toContain('json')
    }
  })
})

describe('capEffort', () => {
  it('caps a higher effort down to the ceiling', () => {
    expect(capEffort('max', 'medium')).toBe('medium')
    expect(capEffort('xhigh', 'high')).toBe('high')
  })
  it('leaves an effort at or below the ceiling unchanged', () => {
    expect(capEffort('low', 'medium')).toBe('low')
    expect(capEffort('medium', 'medium')).toBe('medium')
  })
  it('undefined in -> undefined out', () => {
    expect(capEffort(undefined, 'medium')).toBeUndefined()
  })
})
