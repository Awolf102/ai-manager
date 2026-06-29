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

/** A deterministic id not already in `used`: returns `base`, else `base~2`, `base~3`, … */
function freshId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}~${n}`)) n++
  return `${base}~${n}`
}

/**
 * Apply a re-plan decision. `replaceIds` selects which existing tasks the decision
 * replaces (defaults to all `pending` ids — Phase-2 proactive behavior); every task
 * NOT in that set is frozen verbatim. The replaced tasks are dropped and the decision's
 * revised set is added (each a fresh pending, un-owned TaskState, optional dependsOn from
 * `deps`). The plan is rebuilt as the frozen tasks (in original plan order) then the
 * revised tasks. Never reads or writes a goal — the goal-locked invariant is structural.
 */
export function mergeReplan(
  plan: RunTask[],
  tasks: Record<string, TaskState>,
  decision: { tasks: RunTask[]; deps?: Record<string, string[]> },
  replaceIds?: string[]
): { plan: RunTask[]; tasks: Record<string, TaskState> } {
  const deps = decision.deps ?? {}
  const replace = new Set(
    replaceIds ?? Object.keys(tasks).filter((id) => tasks[id].status === 'pending')
  )
  const frozen: Record<string, TaskState> = {}
  for (const [id, t] of Object.entries(tasks)) {
    if (!replace.has(id)) frozen[id] = t
  }

  // Assign each decision task a collision-free final id (re-id, never clobber a frozen task or an
  // earlier decision task). `used` seeds from FROZEN ids only — reusing a replaced id is legitimate.
  const used = new Set(Object.keys(frozen))
  const remap: Record<string, string> = {}
  const finalIds = decision.tasks.map((rt) => {
    const finalId = freshId(rt.id, used)
    used.add(finalId)
    if (finalId !== rt.id) remap[rt.id] = finalId
    return finalId
  })

  // Every id that will exist after the merge — used to drop dangling deps.
  const present = new Set<string>([...Object.keys(frozen), ...finalIds])

  const next: Record<string, TaskState> = {}
  // Frozen tasks: kept verbatim, but re-filter dependsOn so a dropped target no longer dangles.
  // Keep the same object reference when nothing changes (shape parity with the pre-fix output).
  for (const [id, t] of Object.entries(frozen)) {
    const cleaned = (t.dependsOn ?? []).filter((d) => present.has(d))
    if (t.dependsOn && cleaned.length !== t.dependsOn.length) {
      const { dependsOn: _drop, ...rest } = t
      next[id] = cleaned.length ? { ...rest, dependsOn: cleaned } : rest
    } else {
      next[id] = t
    }
  }
  // Decision tasks: fresh pending, un-owned, with deps remapped to final ids and danglers dropped.
  decision.tasks.forEach((rt, i) => {
    const finalId = finalIds[i]
    const cleaned = (deps[rt.id] ?? [])
      .map((d) => remap[d] ?? d)
      .filter((d) => d !== finalId && present.has(d))
    next[finalId] = {
      task: { id: finalId, title: rt.title, description: rt.description },
      ownerId: null,
      status: 'pending',
      attempts: 0,
      output: '',
      ...(cleaned.length ? { dependsOn: cleaned } : {})
    }
  })

  const frozenInOrder = plan.filter((p) => frozen[p.id]).map((p) => frozen[p.id].task)
  const newTasks = decision.tasks.map((rt, i) => ({ id: finalIds[i], title: rt.title, description: rt.description }))
  return { plan: [...frozenInOrder, ...newTasks], tasks: next }
}
