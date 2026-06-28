import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { RunState } from '../../shared/types'
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
}

const RESUMABLE = new Set(['running', 'interrupted'])

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

  async function put(state: RunState): Promise<void> {
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

  void sweepTmpFiles(dir) // clean up temp files orphaned by a prior crash (init-time, before any run)
  return { put, get, remove, listResumable }
}
