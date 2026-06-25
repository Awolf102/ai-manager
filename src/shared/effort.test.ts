import { describe, it, expect } from 'vitest'
import { effortOfWorker, effortByTask } from './effort'
import type { Assignment } from './types'

const a = (taskId: string, childId: string | null, effort?: Assignment['effort']): Assignment => ({
  taskId,
  childId,
  effort,
  reason: ''
})

describe('effortOfWorker', () => {
  it('returns undefined when no assignment targets the worker', () => {
    expect(effortOfWorker([a('t1', 'w2', 'max')], 'w1')).toBeUndefined()
    expect(effortOfWorker([], 'w1')).toBeUndefined()
  })

  it('returns the effort of the assignment routed to the worker', () => {
    expect(effortOfWorker([a('t1', 'w1', 'high'), a('t2', 'w2', 'low')], 'w1')).toBe('high')
  })

  it('returns the HIGHEST effort when several tasks are routed to the worker', () => {
    expect(effortOfWorker([a('t1', 'w1', 'low'), a('t2', 'w1', 'max'), a('t3', 'w1', 'high')], 'w1')).toBe('max')
  })

  it('ignores assignments that carry no effort', () => {
    expect(effortOfWorker([a('t1', 'w1', undefined)], 'w1')).toBeUndefined()
  })
})

describe('effortByTask', () => {
  it('returns {} when there are no assignments', () => {
    expect(effortByTask([])).toEqual({})
    expect(effortByTask([{ assignments: undefined }, {}])).toEqual({})
  })

  it('maps each task id to its assigned effort across steps', () => {
    const steps = [{ assignments: [a('t1', 'w1', 'high'), a('t2', 'w2', 'low')] }]
    expect(effortByTask(steps)).toEqual({ t1: 'high', t2: 'low' })
  })

  it('lets a deeper router (later step) win for the same task — the effort it ran at', () => {
    // o assigns t1→m at 'low'; m re-assigns t1→w at 'max' (steps are parent-before-child)
    const steps = [{ assignments: [a('t1', 'm', 'low')] }, { assignments: [a('t1', 'w', 'max')] }]
    expect(effortByTask(steps).t1).toBe('max')
  })
})
