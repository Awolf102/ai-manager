// Pure helpers for surfacing the manager-assigned reasoning effort in the UI.
// No node/DOM imports so they can be unit-tested in plain Node and used by the
// renderer without pulling in the engine.

import type { Assignment, Effort } from './types'
import { EFFORT_LEVELS } from './types'

/**
 * The effort a worker actually runs at = the highest effort among the tasks
 * routed to it (mirrors `maxEffort` in the engine, which a worker's batch uses).
 */
export function effortOfWorker(assignments: Assignment[], workerId: string): Effort | undefined {
  let best: Effort | undefined
  for (const a of assignments) {
    if (a.childId !== workerId || !a.effort) continue
    if (!best || EFFORT_LEVELS.indexOf(a.effort) > EFFORT_LEVELS.indexOf(best)) best = a.effort
  }
  return best
}

/** If any of a worker's tasks had its effort capped to the model, the highest
 *  pre-clamp effort that was requested; otherwise undefined. */
export function cappedFrom(assignments: Assignment[], workerId: string): Effort | undefined {
  let best: Effort | undefined
  for (const a of assignments) {
    if (a.childId !== workerId || !a.assignedEffort) continue
    if (!best || EFFORT_LEVELS.indexOf(a.assignedEffort) > EFFORT_LEVELS.indexOf(best)) best = a.assignedEffort
  }
  return best
}

/**
 * Map each task id to the effort assigned for it, gathered from per-step
 * assignments. Steps are stored parent-before-child, so a deeper router's
 * assignment overwrites a shallower one — i.e. the effort the task ran at wins.
 */
export function effortByTask(steps: { assignments?: Assignment[] }[]): Record<string, Effort> {
  const out: Record<string, Effort> = {}
  for (const s of steps) {
    for (const a of s.assignments ?? []) {
      if (a.effort) out[a.taskId] = a.effort
    }
  }
  return out
}
