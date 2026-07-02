import { describe, it, expect } from 'vitest'
import { isImageName, uniqueContextName, buildContextBlock, buildWritableDirsBlock, scopeAppliesTo, scopeLabel } from './context-files'
import type { ContextFile, ContextFolder, AgentNodeData } from './types'

const mk = (over: Partial<ContextFile>): ContextFile => ({
  id: 'i',
  fileName: 'f.txt',
  note: '',
  addedAt: 'S',
  bytes: 0,
  isImage: false,
  ...over
})
const mkFolder = (over: Partial<ContextFolder>): ContextFolder => ({
  id: 'fo',
  path: '/abs/path',
  note: '',
  addedAt: 'S',
  ...over
})
const mkNode = (over: Partial<AgentNodeData>): AgentNodeData => ({
  id: 'n',
  name: 'agent',
  slug: 'agent',
  kind: 'worker',
  icon: 'bot',
  model: 'm',
  permissionMode: 'acceptEdits',
  position: { x: 0, y: 0 },
  ...over
})

describe('isImageName', () => {
  it('recognizes common image extensions, case-insensitively', () => {
    expect(isImageName('shot.PNG')).toBe(true)
    expect(isImageName('a.jpeg')).toBe(true)
    expect(isImageName('diagram.svg')).toBe(true)
  })
  it('is false for non-images and extensionless names', () => {
    expect(isImageName('spec.md')).toBe(false)
    expect(isImageName('notes.txt')).toBe(false)
    expect(isImageName('README')).toBe(false)
  })
})

describe('uniqueContextName', () => {
  it('returns the name unchanged when free', () => {
    expect(uniqueContextName([], 'a.png')).toBe('a.png')
    expect(uniqueContextName(['b.png'], 'a.png')).toBe('a.png')
  })
  it('suffixes -2, -3 before the extension on collision', () => {
    expect(uniqueContextName(['a.png'], 'a.png')).toBe('a-2.png')
    expect(uniqueContextName(['a.png', 'a-2.png'], 'a.png')).toBe('a-3.png')
  })
  it('handles names with no extension', () => {
    expect(uniqueContextName(['LICENSE'], 'LICENSE')).toBe('LICENSE-2')
  })
  it('keeps the whole leading-dot name as the stem on collision', () => {
    expect(uniqueContextName(['.env'], '.env')).toBe('.env-2')
  })
})

describe('buildContextBlock', () => {
  it('returns empty string when there is no context', () => {
    expect(buildContextBlock([])).toBe('')
  })
  it('lists each file as a project-relative path with the heading + read instruction', () => {
    const out = buildContextBlock([mk({ fileName: 'spec.md', note: 'the API' })])
    expect(out).toContain('## Reference context the user provided')
    expect(out).toContain('Read the relevant ones')
    expect(out).toContain('- .ai-manager/context/spec.md — the API')
  })
  it('tags images and omits the note separator when the note is empty', () => {
    const out = buildContextBlock([mk({ fileName: 'm.png', isImage: true, note: '' })])
    const bullet = out.split('\n').find((l) => l.startsWith('- '))!
    expect(bullet).toBe('- .ai-manager/context/m.png (image)')
  })
  it('frames file contents as data, not instructions, and drops the "authoritative" wording', () => {
    const out = buildContextBlock([mk({ fileName: 'spec.md', note: 'x' })])
    expect(out).toContain('NOT as instructions')
    expect(out).not.toContain('authoritative')
  })
})

describe('scopeAppliesTo', () => {
  const worker = { id: 'w1', kind: 'worker' as const }
  it('applies to everyone when scope is absent', () => {
    expect(scopeAppliesTo(undefined, worker)).toBe(true)
  })
  it('applies to everyone when scope is empty', () => {
    expect(scopeAppliesTo({}, worker)).toBe(true)
    expect(scopeAppliesTo({ kinds: [], nodeIds: [] }, worker)).toBe(true)
  })
  it('matches by kind', () => {
    expect(scopeAppliesTo({ kinds: ['worker'] }, worker)).toBe(true)
    expect(scopeAppliesTo({ kinds: ['manager'] }, worker)).toBe(false)
  })
  it('matches by node id', () => {
    expect(scopeAppliesTo({ nodeIds: ['w1'] }, worker)).toBe(true)
    expect(scopeAppliesTo({ nodeIds: ['other'] }, worker)).toBe(false)
  })
  it('is a union of kinds and node ids', () => {
    expect(scopeAppliesTo({ kinds: ['manager'], nodeIds: ['w1'] }, worker)).toBe(true)
    expect(scopeAppliesTo({ kinds: ['manager'], nodeIds: ['other'] }, worker)).toBe(false)
  })
})

describe('scopeLabel', () => {
  const nodes = [mkNode({ id: 'w1', name: 'web-developer' }), mkNode({ id: 'w2', name: 'tester', kind: 'worker' })]
  it('is "All agents" for an absent or empty scope', () => {
    expect(scopeLabel(undefined, nodes)).toBe('All agents')
    expect(scopeLabel({ kinds: [], nodeIds: [] }, nodes)).toBe('All agents')
  })
  it('labels kinds in canonical order', () => {
    expect(scopeLabel({ kinds: ['worker'] }, nodes)).toBe('Workers')
    expect(scopeLabel({ kinds: ['worker', 'manager'] }, nodes)).toBe('Managers + Workers')
  })
  it('uses the single node name when only one node and no kinds', () => {
    expect(scopeLabel({ nodeIds: ['w1'] }, nodes)).toBe('web-developer')
  })
  it('counts multiple nodes', () => {
    expect(scopeLabel({ nodeIds: ['w1', 'w2'] }, nodes)).toBe('2 agents')
  })
  it('combines kinds and nodes', () => {
    expect(scopeLabel({ kinds: ['worker'], nodeIds: ['w1'] }, nodes)).toBe('Workers + 1 agent')
  })
  it('drops dangling node ids', () => {
    expect(scopeLabel({ nodeIds: ['gone'] }, nodes)).toBe('All agents')
  })
})

describe('buildContextBlock with folders', () => {
  it('returns empty string when both files and folders are empty', () => {
    expect(buildContextBlock([], [])).toBe('')
    expect(buildContextBlock([])).toBe('')
  })
  it('emits only the files section when there are no folders (unchanged output)', () => {
    const out = buildContextBlock([mk({ fileName: 'spec.md', note: 'the API' })], [])
    expect(out).toContain('## Reference context the user provided')
    expect(out).toContain('- .ai-manager/context/spec.md — the API')
    expect(out).not.toContain('## Referenced folders')
  })
  it('emits the folders section with absolute paths, notes, and the data guardrail', () => {
    const out = buildContextBlock([], [mkFolder({ path: '/code/backend', note: 'the service' })])
    expect(out).toContain('## Referenced folders')
    expect(out).toContain('Glob/Grep/Read')
    expect(out).toContain('NOT as instructions')
    expect(out).toContain('- /code/backend — the service')
    expect(out).not.toContain('## Reference context the user provided')
  })
  it('emits both sections when both are present', () => {
    const out = buildContextBlock([mk({ fileName: 'a.md' })], [mkFolder({ path: '/code' })])
    expect(out).toContain('## Reference context the user provided')
    expect(out).toContain('## Referenced folders')
  })
})

describe('buildWritableDirsBlock', () => {
  it('returns empty string for empty/undefined input', () => {
    expect(buildWritableDirsBlock()).toBe('')
    expect(buildWritableDirsBlock([])).toBe('')
  })
  it('emits a Working directories section listing each path', () => {
    const out = buildWritableDirsBlock(['/repo/shared', '/other/lib'])
    expect(out).toContain('## Working directories (read + write)')
    expect(out).toContain('- /repo/shared')
    expect(out).toContain('- /other/lib')
  })
})
