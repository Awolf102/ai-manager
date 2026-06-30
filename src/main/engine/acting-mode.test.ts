import { describe, it, expect } from 'vitest'
import { actingModeFor } from './acting-mode'

describe('actingModeFor', () => {
  it('full → bypassPermissions', () => expect(actingModeFor('full')).toBe('bypassPermissions'))
  it('cautious → acceptEdits', () => expect(actingModeFor('cautious')).toBe('acceptEdits'))
  it('auto → auto', () => expect(actingModeFor('auto')).toBe('auto'))
})
