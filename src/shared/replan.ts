// Pure re-planning logic (Phase 2). No node/DOM imports — unit-tested in plain Node.
// pendingStageBoundary decides WHERE execution pauses for a re-plan; mergeReplan folds
// the orchestrator's decision into the run (freeze executed, replace pending). Neither
// reads or writes a goal — the goal-locked invariant is structural.

import type { RunTask, TaskExecStatus, TaskState } from './types'

/**
 * The next ordered stage execution is about to start, AFTER a lower stage finished —
 * i.e. a re-plan boundary — or null when there is nothing to pause at: still on the
 * first stage (no completed lower stage), nothing left pending, the boundary was
 * already offered (cursor caught up), or the work is unordered (stage 0). Stages come
 * from deriveStages.
 */
export function pendingStageBoundary(
  tasks: Record<string, { status: TaskExecStatus; stage?: number; ownerId: string | null }>,
  replanStageCursor: number
): number | null {
  const owned = Object.values(tasks).filter((t) => t.ownerId !== null)
  const pending = owned.filter((t) => t.status === 'pending')
  if (pending.length === 0) return null
  const executedStages = owned.filter((t) => t.status !== 'pending').map((t) => t.stage ?? 0)
  const nextStage = Math.min(...pending.map((t) => t.stage ?? 0))
  const maxExecuted = executedStages.length ? Math.max(...executedStages) : 0
  if (nextStage >= 1 && nextStage > replanStageCursor && maxExecuted >= 1 && nextStage > maxExecuted) {
    return nextStage
  }
  return null
}

/**
 * Apply a re-plan decision. Executed tasks (status !== 'pending') are frozen verbatim;
 * ALL pending tasks are dropped and replaced by the decision's revised set (each a fresh
 * pending, un-owned TaskState, optional dependsOn from `deps`). The plan is rebuilt as the
 * frozen tasks (in original plan order) followed by the revised tasks.
 */
export function mergeReplan(
  plan: RunTask[],
  tasks: Record<string, TaskState>,
  decision: { tasks: RunTask[]; deps?: Record<string, string[]> }
): { plan: RunTask[]; tasks: Record<string, TaskState> } {
  const deps = decision.deps ?? {}
  const frozen: Record<string, TaskState> = {}
  for (const [id, t] of Object.entries(tasks)) {
    if (t.status !== 'pending') frozen[id] = t
  }
  const next: Record<string, TaskState> = { ...frozen }
  for (const rt of decision.tasks) {
    next[rt.id] = {
      task: { id: rt.id, title: rt.title, description: rt.description },
      ownerId: null,
      status: 'pending',
      attempts: 0,
      output: '',
      ...(deps[rt.id]?.length ? { dependsOn: deps[rt.id] } : {})
    }
  }
  const frozenInOrder = plan.filter((p) => frozen[p.id]).map((p) => frozen[p.id].task)
  const newTasks = decision.tasks.map((rt) => ({ id: rt.id, title: rt.title, description: rt.description }))
  return { plan: [...frozenInOrder, ...newTasks], tasks: next }
}
