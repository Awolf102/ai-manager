import { describe, it, expect } from 'vitest'
import { isGoalSubmitKey } from './goalbar-keys'

describe('isGoalSubmitKey', () => {
  it('Enter without Shift submits', () => {
    expect(isGoalSubmitKey('Enter', false)).toBe(true)
  })
  it('Shift+Enter does NOT submit (newline)', () => {
    expect(isGoalSubmitKey('Enter', true)).toBe(false)
  })
  it('other keys do not submit', () => {
    expect(isGoalSubmitKey('a', false)).toBe(false)
    expect(isGoalSubmitKey('Tab', false)).toBe(false)
    expect(isGoalSubmitKey('NotEnter', false)).toBe(false)
  })
})
