import { describe, it, expect } from 'vitest'
import { designPreviewPrompt, INSPIRATION_GUIDE } from './design-preview'

describe('designPreviewPrompt', () => {
  it('with no guide produces a self-contained-HTML instruction and omits the exemplar block', () => {
    const p = designPreviewPrompt('Build an art shop')
    expect(p).toContain('design-preview.html')
    expect(p).toContain('SELF-CONTAINED')
    expect(p).toContain('Build an art shop')
    expect(p).not.toContain('structural exemplar')
  })

  it('with a guide injects it for FORMAT ONLY and forbids copying its styles', () => {
    const p = designPreviewPrompt('Build a B2B SaaS', INSPIRATION_GUIDE)
    expect(p).toContain('structural exemplar')
    expect(p).toContain('FORMAT ONLY')
    expect(p).toContain(INSPIRATION_GUIDE)
  })

  it('the no-guide branch is byte-identical to passing an empty guide', () => {
    expect(designPreviewPrompt('G')).toBe(designPreviewPrompt('G', ''))
  })
})

describe('INSPIRATION_GUIDE', () => {
  it('is non-empty and fully self-contained (no external resources)', () => {
    expect(INSPIRATION_GUIDE.length).toBeGreaterThan(200)
    expect(INSPIRATION_GUIDE).not.toMatch(/https?:\/\//)
    expect(INSPIRATION_GUIDE).not.toContain('@import')
  })
})
