import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ResumableRun, RunState } from '../../shared/types'
import { atomicWrite } from './atomic-write'

/**
 * Durable checkpoint store for in-flight orchestration runs. Each run is written
 * to <dir>/<runId>.json after every transition, so a crash mid-run leaves a
 * resumable checkpoint behind. On graceful completion the engine removes the
 * checkpoint (the canonical record goes to the History runs dir instead).
 *
 * Pure node — `dir` is injected so this is unit-testable without electron.
 */
export interface RunStore {
  /** Atomically write the run's checkpoint. */
  put(state: RunState): Promise<void>
  /** Read a checkpoint, or null if absent/corrupt. */
  get(runId: string): Promise<RunState | null>
  /** Delete a checkpoint (no-op if already gone). */
  remove(runId: string): Promise<void>
  /** Checkpoints still resumable (status running|interrupted), newest first. */
  listResumable(): Promise<RunState[]>
  /** GC dead/stale checkpoints: terminal-status (any age) + resumable older than 30 days (by updatedAt). Returns count removed. */
  gcCheckpoints(nowMs: number): Promise<number>
}

const RESUMABLE = new Set(['running', 'interrupted'])
const MAX_RESUMABLE_AGE_MS = 30 * 24 * 60 * 60 * 1000 // prune resumable checkpoints abandoned > 30 days

/** Best-effort removal of orphaned temp files left by a crash mid-write. */
export async function sweepTmpFiles(dir: string): Promise<void> {
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return // dir not created yet
  }
  await Promise.all(
    files.filter((f) => f.endsWith('.tmp')).map((f) => fs.rm(join(dir, f), { force: true }))
  )
}

export function createRunStore(dir: string): RunStore {
  const fileFor = (runId: string): string => join(dir, `${runId}.json`)

  // Clean up temp files orphaned by a prior crash, ONCE at init before any write.
  // sweepTmpFiles snapshots the dir then rm's every *.tmp it saw; puts must wait for it
  // so its snapshot can never include (and delete) a live atomicWrite's in-flight tmp.
  // Best-effort — a sweep failure must never block writes.
  const swept = sweepTmpFiles(dir).catch(() => {})

  async function put(state: RunState): Promise<void> {
    await swept
    await fs.mkdir(dir, { recursive: true })
    await atomicWrite(fileFor(state.runId), JSON.stringify(state, null, 2))
  }

  async function get(runId: string): Promise<RunState | null> {
    try {
      return JSON.parse(await fs.readFile(fileFor(runId), 'utf8')) as RunState
    } catch {
      return null
    }
  }

  async function remove(runId: string): Promise<void> {
    await fs.rm(fileFor(runId), { force: true })
  }

  async function listResumable(): Promise<RunState[]> {
    let files: string[]
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
    } catch {
      return [] // dir not created yet
    }
    const out: RunState[] = []
    for (const file of files) {
      try {
        const s = JSON.parse(await fs.readFile(join(dir, file), 'utf8')) as RunState
        if (RESUMABLE.has(s.status)) out.push(s)
      } catch {
        // skip corrupt checkpoint
      }
    }
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)) // newest first
    return out
  }

  async function gcCheckpoints(nowMs: number): Promise<number> {
    let files: string[]
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
    } catch {
      return 0 // dir not created yet
    }
    let removed = 0
    for (const file of files) {
      let s: RunState
      try {
        s = JSON.parse(await fs.readFile(join(dir, file), 'utf8')) as RunState
      } catch {
        continue // leave unparseable files (rare; listResumable skips them anyway)
      }
      const terminal = !RESUMABLE.has(s.status)
      const staleResumable = !terminal && nowMs - Date.parse(s.updatedAt) > MAX_RESUMABLE_AGE_MS
      if (terminal || staleResumable) {
        await remove(s.runId)
        removed++
      }
    }
    return removed
  }

  return { put, get, remove, listResumable, gcCheckpoints }
}

/** Map resumable RunStates to lightweight summaries, excluding any currently-active run.
 *  Input is expected pre-filtered to running|interrupted (listResumable) and pre-sorted. */
export function toResumableSummaries(states: RunState[], activeIds: ReadonlySet<string>): ResumableRun[] {
  return states
    .filter((s) => !activeIds.has(s.runId))
    .map((s) => ({
      runId: s.runId,
      goal: s.goal,
      status: s.status as 'running' | 'interrupted',
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      taskCount: s.plan.length
    }))
}
