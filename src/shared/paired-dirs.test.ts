import { describe, it, expect } from 'vitest'
import type { PairedDir } from './types'
import { splitPairedDirs, pairedDirCliArgs } from './paired-dirs'

const d = (path: string, writable: boolean): PairedDir => ({ id: path, path, writable, addedAt: '' })

describe('splitPairedDirs', () => {
  it('partitions writable vs read-only, preserving order', () => {
    const r = splitPairedDirs([d('/w1', true), d('/r1', false), d('/w2', true)])
    expect(r.writablePaths).toEqual(['/w1', '/w2'])
    expect(r.readOnlyPaths).toEqual(['/r1'])
  })
  it('returns empty arrays for empty/undefined input', () => {
    expect(splitPairedDirs()).toEqual({ writablePaths: [], readOnlyPaths: [] })
    expect(splitPairedDirs([])).toEqual({ writablePaths: [], readOnlyPaths: [] })
  })
})

describe('pairedDirCliArgs', () => {
  it('emits --add-dir per writable path only', () => {
    expect(pairedDirCliArgs([d('/w1', true), d('/r1', false), d('/w2', true)]))
      .toEqual(['--add-dir', '/w1', '--add-dir', '/w2'])
  })
  it('returns [] for empty/undefined input', () => {
    expect(pairedDirCliArgs()).toEqual([])
    expect(pairedDirCliArgs([])).toEqual([])
  })
})
