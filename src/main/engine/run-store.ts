import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { RunState } from '../../shared/types'

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

export function createRunStore(dir: string): RunStore {
  const fileFor = (runId: string): string => join(dir, `${runId}.json`)
  let seq = 0 // unique-tmp counter so concurrent puts for one run don't collide

  async function put(state: RunState): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    const target = fileFor(state.runId)
    const tmp = `${target}.${process.pid}.${seq++}.tmp`
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await fs.rename(tmp, target) // atomic swap — readers never see a partial file
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

  return { put, get, remove, listResumable }
}
