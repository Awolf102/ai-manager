import { describe, it, expect } from 'vitest'
import { slugify, uniqueSlug } from './slug'

describe('slugify', () => {
  it('lowercases, replaces non-alphanumerics with dashes, trims dashes', () => {
    expect(slugify('  Data & Frontend!! ')).toBe('data-frontend')
  })
  it('falls back to "agent" for an empty result', () => {
    expect(slugify('@@@')).toBe('agent')
  })
})

describe('uniqueSlug', () => {
  it('returns the base when free', () => {
    expect(uniqueSlug('dana', new Set())).toBe('dana')
  })
  it('suffixes -2, -3 … when taken', () => {
    expect(uniqueSlug('dana', new Set(['dana', 'dana-2']))).toBe('dana-3')
  })
})
