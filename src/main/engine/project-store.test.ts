import { describe, it, expect, vi } from 'vitest'

// project-store.ts imports `app` from electron at module top; mock it so the module
// loads in plain Node. mergeMemory itself touches neither electron nor the fs.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { mergeMemory } from './project-store'

describe('mergeMemory — tagged lessons', () => {
  it('writes a new tagged lesson as a bullet under ## Lessons', () => {
    const next = mergeMemory('', {
      win: '',
      loss: '',
      lessons: ['[portable] write a failing test first'],
      label: 'goal'
    })
    expect(next).toContain('- [portable] write a failing test first')
  })

  it('dedups a re-learned lesson by text even when its scope tag differs', () => {
    const base = '# Memory\n\n## Lessons\n- [portable] verify renders return 200\n\n## Task log\n'
    const next = mergeMemory(base, {
      win: '',
      loss: '',
      lessons: ['[project] verify renders return 200'],
      label: 'goal'
    })
    const occurrences = (next.match(/verify renders return 200/g) || []).length
    expect(occurrences).toBe(1) // not duplicated; existing [portable] bullet wins
    expect(next).toContain('- [portable] verify renders return 200')
  })
})
