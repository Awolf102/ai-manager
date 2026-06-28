import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from './types'

describe('DEFAULT_SETTINGS', () => {
  it('defaults autoAssignModels to false (byte-for-byte off)', () => {
    expect(DEFAULT_SETTINGS.autoAssignModels).toBe(false)
  })
})
