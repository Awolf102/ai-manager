import { describe, it, expect } from 'vitest'
import { DESIGN_SKILLS, ENHANCE_PRESETS, DESIGN_SYSTEM_FAQ_PROMPT, enhanceDesignPrompt } from './design-enhance'

describe('design-enhance constants', () => {
  it('curates the named design skills', () => {
    for (const s of ['emil-design-eng', 'ui-ux-pro-max', 'impeccable']) expect(DESIGN_SKILLS).toContain(s)
  })
  it('has preset directions and a self-contained FAQ prompt', () => {
    expect(ENHANCE_PRESETS.length).toBeGreaterThanOrEqual(4)
    expect(DESIGN_SYSTEM_FAQ_PROMPT).toMatch(/self-contained/i)
    expect(DESIGN_SYSTEM_FAQ_PROMPT).toMatch(/no external|do not reference/i)
  })
})

describe('enhanceDesignPrompt', () => {
  it('frames a creative team, targets the candidate file, forbids external assets, and embeds the current HTML', () => {
    const p = enhanceDesignPrompt('<html>CUR</html>', ['Modernize'], 'tighter spacing')
    expect(p).toMatch(/creative team/i)
    expect(p).toContain('.ai-manager/design-enhanced.html')
    expect(p).toMatch(/self-contained/i)
    expect(p).toContain('Modernize')
    expect(p).toContain('tighter spacing')
    expect(p).toContain('<html>CUR</html>')
  })
  it('is valid with empty directions and note', () => {
    const p = enhanceDesignPrompt('<x/>', [], '')
    expect(p).toContain('.ai-manager/design-enhanced.html')
    expect(p).toContain('<x/>')
  })
})
