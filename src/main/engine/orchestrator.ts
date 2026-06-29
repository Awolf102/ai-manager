// Orchestration driver. The plan→route→execute→review→repair→reflect→synthesize
// logic lives in nodes.ts as a graph over RunState; this file wires the real
// engine deps (agent SDK, checkpoint store, IPC events) and runs/resumes it.

import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { OrchestrationEvent, ResumableRun, RunState, StartRunInput } from '../../shared/types'
import { IPC } from '../../shared/types'
import { toRunRecord, toRunStatus } from '../../shared/run-state'
import { streamAgent } from './agent-runner'
import { runGraph, resumeGraph, type NodeIO } from './graph'
import { actingModeFor, buildOrchestratorGraph, seedRunState, type Eng } from './nodes'
import { createRunStore, toResumableSummaries, type RunStore } from './run-store'
import {
  autoPullFromTeam,
  autoPushToTeam,
  getAgent,
  getCheckpointDir,
  getSettings,
  saveRun
} from './project-store'

const active = new Map<string, AbortController>()

/** Whether to print an agent's "▶ name · model" banner: once per agentId per run (or an explicit choice). */
export function headerGate(seen: Set<string>, agentId: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  if (seen.has(agentId)) return false
  seen.add(agentId)
  return true
}

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

/** Resume a crashed run, or (Stage 3) resume an interrupted run with a user's answer. */
export function resumeRun(wc: WebContents, runId: string, resumeInput?: unknown): { runId: string } {
  const abort = new AbortController()
  active.set(runId, abort)
  void resumeDrive(wc, runId, abort, resumeInput).finally(() => active.delete(runId))
  return { runId }
}

export function stopRun(runId: string): void {
  active.get(runId)?.abort()
}

export async function listResumable(): Promise<ResumableRun[]> {
  const store = createRunStore(getCheckpointDir())
  return toResumableSummaries(await store.listResumable(), new Set(active.keys()))
}

export async function discardRun(runId: string): Promise<void> {
  await createRunStore(getCheckpointDir()).remove(runId)
}

export async function gcCheckpoints(): Promise<void> {
  try {
    await createRunStore(getCheckpointDir()).gcCheckpoints(Date.now())
  } catch {
    // GC is best-effort — never block project open
  }
}

// ---------- drivers ----------

function makeDeps(
  wc: WebContents,
  runId: string,
  abort: AbortController
): { eng: Eng; io: NodeIO; store: RunStore } {
  const store = createRunStore(getCheckpointDir())
  const emitFn = (e: OrchestrationEvent): void => emit(wc, e)
  const headersPrinted = new Set<string>()
  const runAgent: Eng['runAgent'] = (opts) =>
    streamAgent({ ...opts, header: headerGate(headersPrinted, opts.agentId, opts.header) })
  const eng: Eng = { wc, abort, runId, runAgent, emit: emitFn, handoffs: [] }
  const io: NodeIO = {
    signal: abort.signal,
    emit: emitFn,
    checkpoint: (s) => store.put(s),
    collectExtras: () => (eng.handoffs.length ? { handoffs: [...eng.handoffs] } : {})
  }
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
  try {
    await autoPullFromTeam() // B2b: best-effort pull of the linked team brain before the run
  } catch {
    // auto-sync must never block a run
  }
  const final = await runGraph(buildOrchestratorGraph(eng), state, store, io)
  await finishRun(wc, final, store)
}

async function resumeDrive(
  wc: WebContents,
  runId: string,
  abort: AbortController,
  resumeInput?: unknown
): Promise<void> {
  const { eng, io, store } = makeDeps(wc, runId, abort)
  const saved = await store.get(runId)
  if (!saved) {
    emit(wc, { runId, type: 'run-finished', status: 'error', error: 'no checkpoint to resume' })
    return
  }
  eng.handoffs.push(...(saved.handoffs ?? []))
  // HITL continuation (an answer was supplied) keeps the live run view — don't reset it
  // with a fresh run-started. Crash-recovery (no answer) rebuilds the view from scratch.
  if (resumeInput === undefined) {
    emit(wc, { runId, type: 'run-started', orchestratorId: saved.orchestratorId, goal: saved.goal })
  }
  const final = await resumeGraph(buildOrchestratorGraph(eng), runId, store, io, resumeInput)
  await finishRun(wc, final, store)
}

async function finishRun(wc: WebContents, final: RunState, store: RunStore): Promise<void> {
  if (final.status === 'interrupted') {
    // Paused for human input (Stage 3): keep the checkpoint for resume, don't finalize.
    if (final.pendingInterrupt) {
      emit(wc, { runId: final.runId, type: 'interrupt', interrupt: final.pendingInterrupt })
    }
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
  try {
    await autoPushToTeam() // B2b: best-effort push of this run's new portable lessons to the team brain
  } catch {
    // auto-sync must never break finishing a run
  }
  emit(wc, { runId: final.runId, type: 'run-finished', status: toRunStatus(final.status), error: final.error })
}

function emit(wc: WebContents, e: OrchestrationEvent): void {
  if (!wc.isDestroyed()) wc.send(IPC.orchestration, e)
}
