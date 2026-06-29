import { describe, it, expect } from 'vitest'
import { writePty } from './pty-manager'

describe('writePty', () => {
  it('does not throw for an unknown/dead pty id', () => {
    expect(() => writePty('no-such-pty', 'x')).not.toThrow()
  })
})
