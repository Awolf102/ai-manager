import { describe, it, expect } from 'vitest'
import { pendingStageBoundary, mergeReplan } from './replan'
import type { RunTask, TaskExecStatus, TaskState } from './types'

function mkTask(
  id: string,
  status: TaskExecStatus,
  stage: number,
  ownerId: string | null = 'w',
  description = id
): TaskState {
  return { task: { id, title: id.toUpperCase(), description }, ownerId, status, attempts: 1, output: `out ${id}`, stage }
}

describe('pendingStageBoundary', () => {
  it('returns null on the first stage (nothing completed yet)', () => {
    const tasks = { t1: mkTask('t1', 'pending', 1), t2: mkTask('t2', 'pending', 2) }
    expect(pendingStageBoundary(tasks, 0)).toBeNull()
  })

  it('returns the next stage when a lower stage has finished', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    expect(pendingStageBoundary(tasks, 0)).toBe(2)
  })

  it('returns null when nothing is pending', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'passed', 2) }
    expect(pendingStageBoundary(tasks, 0)).toBeNull()
  })

  it('returns null when the boundary was already offered (cursor caught up)', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    expect(pendingStageBoundary(tasks, 2)).toBeNull()
  })

  it('returns null for unordered-only work (stage 0)', () => {
    const tasks = { t1: mkTask('t1', 'done', 0), t2: mkTask('t2', 'pending', 0) }
    expect(pendingStageBoundary(tasks, 0)).toBeNull()
  })

  it('ignores unowned tasks', () => {
    const tasks = {
      t1: mkTask('t1', 'done', 1),
      t2: mkTask('t2', 'pending', 2),
      x: mkTask('x', 'pending', 0, null)
    }
    expect(pendingStageBoundary(tasks, 0)).toBe(2)
  })
})

describe('mergeReplan', () => {
  const plan: RunTask[] = [
    { id: 't1', title: 'T1', description: 'research' },
    { id: 't2', title: 'T2', description: 'use postgres' }
  ]

  it('freezes executed tasks and replaces pending ones', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    const decision = { tasks: [{ id: 't2', title: 'T2', description: 'use supabase' }] }
    const out = mergeReplan(plan, tasks, decision)
    expect(out.tasks.t1).toBe(tasks.t1) // frozen, same reference
    expect(out.tasks.t2.status).toBe('pending')
    expect(out.tasks.t2.ownerId).toBeNull()
    expect(out.tasks.t2.attempts).toBe(0)
    expect(out.tasks.t2.task.description).toBe('use supabase')
    expect(out.plan.map((p) => p.id)).toEqual(['t1', 't2'])
  })

  it('adds brand-new pending tasks', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    const decision = {
      tasks: [
        { id: 't2', title: 'T2', description: 'use supabase' },
        { id: 't3', title: 'T3', description: 'add auth' }
      ]
    }
    const out = mergeReplan(plan, tasks, decision)
    expect(Object.keys(out.tasks).sort()).toEqual(['t1', 't2', 't3'])
    expect(out.tasks.t3.status).toBe('pending')
    expect(out.plan.map((p) => p.id)).toEqual(['t1', 't2', 't3'])
  })

  it('drops pending tasks the decision omits', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    const out = mergeReplan(plan, tasks, { tasks: [] })
    expect(Object.keys(out.tasks)).toEqual(['t1'])
    expect(out.plan.map((p) => p.id)).toEqual(['t1'])
  })

  it('carries dependsOn from the decision deps', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    const decision = {
      tasks: [
        { id: 't2', title: 'T2', description: 'use supabase' },
        { id: 't3', title: 'T3', description: 'add auth' }
      ],
      deps: { t3: ['t2'] }
    }
    const out = mergeReplan(plan, tasks, decision)
    expect(out.tasks.t3.dependsOn).toEqual(['t2'])
    expect(out.tasks.t2.dependsOn).toBeUndefined()
  })

  it('never touches a goal (operates only on plan + tasks)', () => {
    // mergeReplan has no goal parameter — this test documents the structural invariant.
    const tasks = { t1: mkTask('t1', 'done', 1) }
    const out = mergeReplan(plan, tasks, { tasks: [] })
    expect(out).not.toHaveProperty('goal')
  })

  it('with explicit replaceIds=failed, freezes passed and replaces only the failed', () => {
    const tasks = { t1: mkTask('t1', 'passed', 1), t2: mkTask('t2', 'failed', 2) }
    const decision = { tasks: [{ id: 't2a', title: 'T2A', description: 'split a' }, { id: 't2b', title: 'T2B', description: 'split b' }] }
    const out = mergeReplan(plan, tasks, decision, ['t2'])
    expect(out.tasks.t1).toBe(tasks.t1) // passed frozen (same reference)
    expect(out.tasks.t2).toBeUndefined() // failed dropped
    expect(out.tasks.t2a.status).toBe('pending')
    expect(out.tasks.t2a.ownerId).toBeNull()
    expect(out.plan.map((p) => p.id)).toEqual(['t1', 't2a', 't2b'])
  })

  it('with replaceIds, carries dependsOn and leaves non-listed tasks frozen even if pending', () => {
    const tasks = { t1: mkTask('t1', 'passed', 1), t2: mkTask('t2', 'failed', 2), t3: mkTask('t3', 'pending', 3) }
    const decision = { tasks: [{ id: 't2a', title: 'T2A', description: 'a' }], deps: { t2a: ['t1'] } }
    const out = mergeReplan(plan, tasks, decision, ['t2']) // only t2 replaced; t3 (pending) NOT in replaceIds → frozen
    expect(out.tasks.t3).toBe(tasks.t3) // pending but not listed → kept
    expect(out.tasks.t2a.dependsOn).toEqual(['t1'])
    expect(out.tasks.t2).toBeUndefined()
  })
})
