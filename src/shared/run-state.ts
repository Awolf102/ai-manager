// Pure helpers for the durable run state. MUST stay free of node/DOM imports so
// it can be unit-tested in plain Node and imported by either process.

import type { LiveRunStatus, RunRecord, RunState, RunStatus } from './types'

/** Collapse the live status onto the terminal History status. */
export function toRunStatus(s: LiveRunStatus): RunStatus {
  if (s === 'completed') return 'completed'
  if (s === 'cancelled') return 'cancelled'
  return 'error'
}

/** Project the live RunState onto the read-only History RunRecord shape. */
export function toRunRecord(s: RunState): RunRecord {
  return {
    runId: s.runId,
    goal: s.goal,
    orchestratorId: s.orchestratorId,
    startedAt: s.startedAt,
    finishedAt: s.updatedAt,
    status: toRunStatus(s.status),
    plan: s.plan,
    steps: Object.values(s.steps),
    reviews: s.reviews,
    reflections: s.reflections,
    final: s.final,
    ...(s.error !== undefined ? { error: s.error } : {})
  }
}
