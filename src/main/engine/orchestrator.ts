// Orchestration driver. The plan→route→execute→review→repair→reflect→synthesize
// logic lives in nodes.ts as a graph over RunState; this file wires the real
// engine deps (agent SDK, checkpoint store, IPC events) and runs/resumes it.

import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { OrchestrationEvent, RunState, StartRunInput } from '../../shared/types'
import { IPC } from '../../shared/types'
import { toRunRecord, toRunStatus } from '../../shared/run-state'
import { streamAgent } from './agent-runner'
import { runGraph, resumeGraph, type NodeIO } from './graph'
import { actingModeFor, buildOrchestratorGraph, seedRunState, type Eng } from './nodes'
import { createRunStore, type RunStore } from './run-store'
import { getAgent, getCheckpointDir, getSettings, saveRun } from './project-store'

const active = new Map<string, AbortController>()

export function startRun(wc: WebContents, input: StartRunInput): { runId: string } {
  const runId = randomUUID()
  getAgent(input.orchestratorId) // validate up-front — throws cleanly if unknown
  const settings = getSettings()
  const state = seedRunState({
    runId,
    goal: input.goal,
    orchestratorId: input.orchestratorId,
    actingMode: actingModeFor(settings.autonomy),
    startedAt: new Date().toISOString()
  })
  const abort = new AbortController()
  active.set(runId, abort)
  void drive(wc, state, abort).finally(() => active.delete(runId))
  return { runId }
}

/** Resume a crashed/interrupted run from its checkpoint (re-runs only unfinished work). */
export function resumeRun(wc: WebContents, runId: string): { runId: string } {
  const abort = new AbortController()
  active.set(runId, abort)
  void resumeDrive(wc, runId, abort).finally(() => active.delete(runId))
  return { runId }
}

export function stopRun(runId: string): void {
  active.get(runId)?.abort()
}

// ---------- drivers ----------

function makeDeps(
  wc: WebContents,
  runId: string,
  abort: AbortController
): { eng: Eng; io: NodeIO; store: RunStore } {
  const store = createRunStore(getCheckpointDir())
  const emitFn = (e: OrchestrationEvent): void => emit(wc, e)
  const eng: Eng = { wc, abort, runId, runAgent: streamAgent, emit: emitFn }
  const io: NodeIO = { signal: abort.signal, emit: emitFn, checkpoint: (s) => store.put(s) }
  return { eng, io, store }
}

async function drive(wc: WebContents, state: RunState, abort: AbortController): Promise<void> {
  const { eng, io, store } = makeDeps(wc, state.runId, abort)
  emit(wc, { runId: state.runId, type: 'run-started', orchestratorId: state.orchestratorId, goal: state.goal })
  try {
    await store.put(state) // initial checkpoint — survives a crash during planning
  } catch {
    // non-fatal
  }
  const final = await runGraph(buildOrchestratorGraph(eng), state, store, io)
  await finishRun(wc, final, store)
}

async function resumeDrive(wc: WebContents, runId: string, abort: AbortController): Promise<void> {
  const { eng, io, store } = makeDeps(wc, runId, abort)
  const saved = await store.get(runId)
  if (!saved) {
    emit(wc, { runId, type: 'run-finished', status: 'error', error: 'no checkpoint to resume' })
    return
  }
  emit(wc, { runId, type: 'run-started', orchestratorId: saved.orchestratorId, goal: saved.goal })
  const final = await resumeGraph(buildOrchestratorGraph(eng), runId, store, io)
  await finishRun(wc, final, store)
}

async function finishRun(wc: WebContents, final: RunState, store: RunStore): Promise<void> {
  if (final.status === 'interrupted') {
    // Paused for human input (Stage 3): keep the checkpoint for resume, don't finalize.
    return
  }
  try {
    await saveRun(toRunRecord(final))
  } catch {
    // non-fatal: failing to persist the History record shouldn't break the run
  }
  // Graceful terminal state → drop the resumable checkpoint. A crash skips this,
  // leaving the checkpoint behind so the run can be resumed.
  try {
    await store.remove(final.runId)
  } catch {
    // ignore
  }
  emit(wc, { runId: final.runId, type: 'run-finished', status: toRunStatus(final.status), error: final.error })
}

function emit(wc: WebContents, e: OrchestrationEvent): void {
  if (!wc.isDestroyed()) wc.send(IPC.orchestration, e)
}
