import { describe, it, expect } from 'vitest'
import { actingModeFor, launchMode } from './acting-mode'

describe('actingModeFor', () => {
  it('full → bypassPermissions', () => expect(actingModeFor('full')).toBe('bypassPermissions'))
  it('cautious → acceptEdits', () => expect(actingModeFor('cautious')).toBe('acceptEdits'))
  it('auto → auto', () => expect(actingModeFor('auto')).toBe('auto'))
})

describe('launchMode', () => {
  it('full + lock → acceptEdits (lock clamps bypass)', () => expect(launchMode('full', true)).toBe('acceptEdits'))
  it('full + no lock → bypassPermissions', () => expect(launchMode('full', false)).toBe('bypassPermissions'))
  it('cautious + lock → acceptEdits (nothing to clamp)', () => expect(launchMode('cautious', true)).toBe('acceptEdits'))
  it('auto + lock → auto (nothing to clamp)', () => expect(launchMode('auto', true)).toBe('auto'))
})
