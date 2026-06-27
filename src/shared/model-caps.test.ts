import { describe, it, expect } from 'vitest'
import { clampEffort, MODEL_EFFORT_CAPS } from './model-caps'

describe('clampEffort', () => {
  it('passes through a supported level unchanged', () => {
    expect(clampEffort('claude-opus-4-8', 'xhigh')).toBe('xhigh')
    expect(clampEffort('claude-sonnet-4-6', 'high')).toBe('high')
    expect(clampEffort('claude-sonnet-4-6', 'max')).toBe('max')
  })
  it('rounds an unsupported level UP to the nearest supported (Sonnet xhigh -> max)', () => {
    expect(clampEffort('claude-sonnet-4-6', 'xhigh')).toBe('max')
  })
  it('returns undefined for a model with no effort parameter (Haiku)', () => {
    expect(clampEffort('claude-haiku-4-5', 'high')).toBeUndefined()
    expect(clampEffort('claude-haiku-4-5', 'max')).toBeUndefined()
  })
  it('returns undefined when no effort was requested', () => {
    expect(clampEffort('claude-sonnet-4-6', undefined)).toBeUndefined()
  })
  it('passes through unchanged for an unknown model (no clamp data)', () => {
    expect(clampEffort('some-future-model', 'xhigh')).toBe('xhigh')
  })
  it('caps a request above the ceiling to the ceiling', () => {
    // a hypothetical model whose ceiling is medium
    MODEL_EFFORT_CAPS['test-tiny'] = ['low', 'medium']
    expect(clampEffort('test-tiny', 'xhigh')).toBe('medium')
    delete MODEL_EFFORT_CAPS['test-tiny']
  })
})
