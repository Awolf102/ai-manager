import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunStore } from './run-store'
import type { LiveRunStatus, RunState } from '../../shared/types'

function mkState(over: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-1',
    goal: 'ship it',
    orchestratorId: 'orch',
    startedAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:01:00.000Z',
    status: 'running',
    phase: 'executing',
    cursor: 'executing',
    actingMode: 'auto',
    plan: [{ id: 't1', title: 'T1', description: 'd' }],
    tasks: {},
    steps: {},
    reviews: [],
    reflections: [],
    final: '',
    ...over
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createRunStore', () => {
  it('put then get round-trips the state', async () => {
    const store = createRunStore(dir)
    const state = mkState({ runId: 'abc', final: 'done' })
    await store.put(state)
    expect(await store.get('abc')).toEqual(state)
  })

  it('writes atomically — no leftover .tmp files after put', async () => {
    const store = createRunStore(dir)
    await store.put(mkState({ runId: 'abc' }))
    const files = await fs.readdir(dir)
    expect(files).toContain('abc.json')
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('a second put overwrites the same file (one file per run)', async () => {
    const store = createRunStore(dir)
    await store.put(mkState({ runId: 'abc', phase: 'planning' }))
    await store.put(mkState({ runId: 'abc', phase: 'synthesizing' }))
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
    expect(files).toEqual(['abc.json'])
    expect((await store.get('abc'))?.phase).toBe('synthesizing')
  })

  it('get returns null for an unknown run', async () => {
    const store = createRunStore(dir)
    expect(await store.get('nope')).toBeNull()
  })

  it('remove deletes the checkpoint', async () => {
    const store = createRunStore(dir)
    await store.put(mkState({ runId: 'abc' }))
    await store.remove('abc')
    expect(await store.get('abc')).toBeNull()
  })

  it('remove is a no-op when the checkpoint is already gone', async () => {
    const store = createRunStore(dir)
    await expect(store.remove('ghost')).resolves.toBeUndefined()
  })

  it('listResumable returns only running|interrupted runs, newest first', async () => {
    const store = createRunStore(dir)
    const cases: [string, LiveRunStatus, string][] = [
      ['a', 'completed', '2026-06-24T00:00:00.000Z'],
      ['b', 'running', '2026-06-24T01:00:00.000Z'],
      ['c', 'interrupted', '2026-06-24T03:00:00.000Z'],
      ['d', 'cancelled', '2026-06-24T02:00:00.000Z'],
      ['e', 'error', '2026-06-24T04:00:00.000Z']
    ]
    for (const [runId, status, startedAt] of cases) {
      await store.put(mkState({ runId, status, startedAt }))
    }
    const resumable = await store.listResumable()
    expect(resumable.map((s) => s.runId)).toEqual(['c', 'b'])
  })

  it('listResumable returns [] when the directory does not exist yet', async () => {
    const store = createRunStore(join(dir, 'not-created-yet'))
    expect(await store.listResumable()).toEqual([])
  })

  it('survives concurrent puts of the same run (parallel workers): valid file, no tmp leftovers', async () => {
    const store = createRunStore(dir)
    const phases = ['planning', 'routing', 'executing', 'reviewing', 'reflecting'] as const
    // simulate parallel workers all checkpointing the same run at once
    await Promise.all(
      phases.map((phase) => store.put(mkState({ runId: 'abc', phase })))
    )
    const files = await fs.readdir(dir)
    expect(files.filter((f) => f.endsWith('.json'))).toEqual(['abc.json'])
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false) // every tmp got renamed away
    const final = await store.get('abc') // file is a complete, parseable state
    expect(final).not.toBeNull()
    expect(phases).toContain(final!.phase as (typeof phases)[number])
  })
})
