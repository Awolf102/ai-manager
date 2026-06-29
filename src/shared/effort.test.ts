import { describe, it, expect } from 'vitest'
import { effortOfWorker, effortByTask, cappedFrom, cappedFromDisplay } from './effort'
import type { Assignment } from './types'

const a = (taskId: string, childId: string | null, effort?: Assignment['effort']): Assignment => ({
  taskId,
  childId,
  effort,
  reason: ''
})

const ac = (over: Partial<Assignment>): Assignment => ({ taskId: 't', childId: 'w', effort: 'max', reason: '', ...over })

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

describe('cappedFrom', () => {
  it('returns the original requested effort when a worker task was capped', () => {
    expect(cappedFrom([ac({ effort: 'max', assignedEffort: 'xhigh' })], 'w')).toBe('xhigh')
  })
  it('returns undefined when nothing was capped', () => {
    expect(cappedFrom([ac({ effort: 'high' })], 'w')).toBeUndefined()
  })
})

describe('cappedFromDisplay', () => {
  const A = (childId: string, effort?: string, assignedEffort?: string) =>
    ({ taskId: 't', childId, reason: 'r', ...(effort ? { effort } : {}), ...(assignedEffort ? { assignedEffort } : {}) }) as unknown as Assignment
  it('returns undefined when the pre-clamp effort is not above the actual effort', () => {
    // task A ran at max (no cap), task B requested xhigh→clamped to max: cappedFrom=xhigh < max → hide
    const as = [A('w', 'max'), A('w', 'max', 'xhigh')]
    expect(cappedFromDisplay(as, 'w')).toBeUndefined()
  })
  it('returns the pre-clamp effort when it is strictly above the actual effort', () => {
    // a genuine cap: ran at low, requested high
    const as = [A('w', 'low', 'high')]
    expect(cappedFromDisplay(as, 'w')).toBe('high')
  })
})
