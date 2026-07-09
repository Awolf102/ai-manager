import { describe, it, expect, vi } from 'vitest'

vi.mock('./project-store', () => ({
  readDesignPreview: vi.fn(async () => '<html>CUR</html>'),
  getGraph: () => ({ nodes: [{ id: 'orch1', kind: 'orchestrator' }] }),
  getSettings: () => ({ autonomy: 'auto' })
}))

import { enhanceDesignSystem } from './design-enhancer'
import { DESIGN_SKILLS } from '../../shared/design-enhance'

describe('enhanceDesignSystem', () => {
  it('runs the orchestrator with the enhance prompt, the design skills, and acting permission', async () => {
    let seen: any
    const runAgent = vi.fn(async (o: any) => {
      seen = o
      return { text: 'done' }
    })
    await enhanceDesignSystem(
      { directions: ['Modernize'], note: 'x', wc: {} as any, abort: new AbortController() },
      runAgent
    )
    expect(seen.agentId).toBe('orch1')
    expect(seen.prompt).toContain('<html>CUR</html>')
    expect(seen.prompt).toContain('Modernize')
    expect(seen.extraSkillNames).toEqual(DESIGN_SKILLS)
    expect(seen.permissionMode).toBeDefined() // acting mode, not 'default'
  })

  it('throws if there is no design system to enhance', async () => {
    const { readDesignPreview } = await import('./project-store')
    vi.mocked(readDesignPreview).mockResolvedValueOnce('')
    const runAgent = vi.fn(async () => ({ text: 'done' }))
    await expect(
      enhanceDesignSystem({ directions: [], note: '', wc: {} as any, abort: new AbortController() }, runAgent)
    ).rejects.toThrow(/import one first/)
    expect(runAgent).not.toHaveBeenCalled()
  })
})
