import { describe, it, expect, vi } from 'vitest'

const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({ app: { getPath: () => USERDATA } }))

import { composeAppend } from './agent-runner'
import type { PairedDir } from '../../shared/types'

const d = (path: string, writable: boolean): PairedDir => ({ id: path, path, writable, addedAt: '' })

describe('composeAppend paired dirs', () => {
  it('is byte-for-byte identical with no paired dirs', () => {
    const base = composeAppend('Role', 'Mem', [], [])
    const withEmpty = composeAppend('Role', 'Mem', [], [], [])
    expect(withEmpty).toBe(base)
    expect(withEmpty).not.toContain('Working directories')
    expect(withEmpty).not.toContain('Referenced folders')
  })
  it('lists a read-only paired dir under Referenced folders', () => {
    const out = composeAppend('Role', 'Mem', [], [], [d('/ro/lib', false)])
    expect(out).toContain('## Referenced folders')
    expect(out).toContain('- /ro/lib')
    expect(out).not.toContain('Working directories')
  })
  it('lists a writable paired dir under Working directories', () => {
    const out = composeAppend('Role', 'Mem', [], [], [d('/rw/lib', true)])
    expect(out).toContain('## Working directories (read + write)')
    expect(out).toContain('- /rw/lib')
  })
})
