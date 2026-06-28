import { describe, it, expect } from 'vitest'
import { createMutex, createKeyedMutex } from './mutex'

describe('createMutex', () => {
  it('runs bodies one at a time, in call order', async () => {
    const run = createMutex()
    const events: string[] = []
    let active = 0
    const body = (id: string) =>
      run(async () => {
        active++
        expect(active).toBe(1) // never two bodies at once
        events.push(`start-${id}`)
        await Promise.resolve()
        await Promise.resolve()
        events.push(`end-${id}`)
        active--
      })
    await Promise.all([body('a'), body('b'), body('c')])
    expect(events).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c'])
  })

  it('keeps the chain alive after a rejected body', async () => {
    const run = createMutex()
    await expect(run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await run(async () => 42)).toBe(42)
  })
})

describe('createKeyedMutex', () => {
  it('serializes same-key calls in call order even when an earlier body yields longer', async () => {
    const run = createKeyedMutex()
    const order: string[] = []
    const body = (key: string, label: string, ticks: number) =>
      run(key, async () => {
        for (let i = 0; i < ticks; i++) await Promise.resolve()
        order.push(label)
      })
    await Promise.all([body('x', 'x1', 3), body('x', 'x2', 0)])
    expect(order).toEqual(['x1', 'x2']) // x1 first despite more ticks (serialized by key)
  })

  it('keeps a key chain alive after a rejected body', async () => {
    const run = createKeyedMutex()
    await expect(run('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await run('k', async () => 1)).toBe(1)
  })

  it('runs different keys independently (they can overlap)', async () => {
    const run = createKeyedMutex()
    let aRunning = false
    let overlapped = false
    const a = run('a', async () => {
      aRunning = true
      await Promise.resolve()
      await Promise.resolve()
      aRunning = false
    })
    const b = run('b', async () => {
      if (aRunning) overlapped = true
    })
    await Promise.all([a, b])
    expect(overlapped).toBe(true)
  })
})
