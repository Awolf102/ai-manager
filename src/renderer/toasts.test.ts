import { describe, it, expect } from 'vitest'
import { addToast, removeToast, TOAST_CAP, type Toast } from './toasts'

const mk = (id: string): Toast => ({ id, kind: 'info', message: id, createdAt: 0 })

describe('addToast', () => {
  it('appends to the end', () => {
    expect(addToast([mk('a')], mk('b')).map((t) => t.id)).toEqual(['a', 'b'])
  })
  it('drops the oldest when over the cap', () => {
    const full = Array.from({ length: TOAST_CAP }, (_, i) => mk(`t${i}`))
    const result = addToast(full, mk('new'))
    expect(result).toHaveLength(TOAST_CAP)
    expect(result[0].id).toBe('t1') // t0 dropped
    expect(result.at(-1)!.id).toBe('new')
  })
  it('does not mutate the input', () => {
    const input = [mk('a')]
    addToast(input, mk('b'))
    expect(input).toHaveLength(1)
  })
})

describe('removeToast', () => {
  it('removes the matching id', () => {
    expect(removeToast([mk('a'), mk('b')], 'a').map((t) => t.id)).toEqual(['b'])
  })
  it('returns the list unchanged when id is absent', () => {
    expect(removeToast([mk('a')], 'z').map((t) => t.id)).toEqual(['a'])
  })
})
