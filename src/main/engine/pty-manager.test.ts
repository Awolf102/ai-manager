import { describe, it, expect } from 'vitest'
import { writePty, buildClaudeArgs, mergeBackendEnv } from './pty-manager'
import type { PairedDir } from '../../shared/types'

describe('writePty', () => {
  it('does not throw for an unknown/dead pty id', () => {
    expect(() => writePty('no-such-pty', 'x')).not.toThrow()
  })
})

const pd = (path: string, writable: boolean): PairedDir => ({ id: path, path, writable, addedAt: '' })

describe('mergeBackendEnv', () => {
  it('merges backend env over the base for an env result', () => {
    const out = mergeBackendEnv({ PATH: '/bin', ANTHROPIC_BASE_URL: 'old' }, { kind: 'env', label: 'z', env: { ANTHROPIC_BASE_URL: 'new', ANTHROPIC_AUTH_TOKEN: 't' } })
    expect(out).toEqual({ PATH: '/bin', ANTHROPIC_BASE_URL: 'new', ANTHROPIC_AUTH_TOKEN: 't' })
  })
  it('leaves the base unchanged for none/error', () => {
    const base = { PATH: '/bin' }
    expect(mergeBackendEnv(base, { kind: 'none' })).toEqual(base)
    expect(mergeBackendEnv(base, { kind: 'error', message: 'x' })).toEqual(base)
  })
})

describe('buildClaudeArgs', () => {
  const base = { append: 'APP', model: 'claude-sonnet-4-6', mode: 'acceptEdits' }

  it('matches the baseline arg order with no paired dirs', () => {
    expect(buildClaudeArgs(base)).toEqual([
      '--append-system-prompt', 'APP',
      '--model', 'claude-sonnet-4-6',
      '--permission-mode', 'acceptEdits'
    ])
  })
  it('appends --add-dir for writable paired dirs only, before --resume', () => {
    const args = buildClaudeArgs({ ...base, resumeSessionId: 'sess1', pairedDirs: [pd('/rw', true), pd('/ro', false)] })
    expect(args).toEqual([
      '--append-system-prompt', 'APP',
      '--model', 'claude-sonnet-4-6',
      '--permission-mode', 'acceptEdits',
      '--add-dir', '/rw',
      '--resume', 'sess1'
    ])
  })
})
