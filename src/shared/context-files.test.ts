import { describe, it, expect } from 'vitest'
import { isImageName, uniqueContextName, buildContextBlock } from './context-files'
import type { ContextFile } from './types'

const mk = (over: Partial<ContextFile>): ContextFile => ({
  id: 'i',
  fileName: 'f.txt',
  note: '',
  addedAt: 'S',
  bytes: 0,
  isImage: false,
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
})
