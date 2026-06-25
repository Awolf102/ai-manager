import { describe, it, expect } from 'vitest'
import { toRunRecord, toRunStatus } from './run-state'
import type { LiveRunStatus, RunState, RunStepRecord } from './types'

function mkState(over: Partial<RunState> = {}): RunState {
  return {
    runId: 'r1',
    goal: 'ship it',
    orchestratorId: 'orch',
    startedAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:05:00.000Z',
    status: 'completed',
    phase: 'done',
    cursor: '__end__',
    actingMode: 'auto',
    plan: [{ id: 't1', title: 'T1', description: 'd' }],
    tasks: {},
    steps: {},
    reviews: [],
    reflections: [],
    final: 'all done',
    ...over
  }
}

describe('toRunStatus', () => {
  const cases: [LiveRunStatus, string][] = [
    ['completed', 'completed'],
    ['cancelled', 'cancelled'],
    ['error', 'error'],
    ['running', 'error'], // non-terminal collapses to error in the History record
    ['interrupted', 'error']
  ]
  it.each(cases)('maps %s -> %s', (live, expected) => {
    expect(toRunStatus(live)).toBe(expected)
  })
})

describe('toRunRecord', () => {
  it('projects RunState onto the History RunRecord shape', () => {
    const stepA: RunStepRecord = { nodeId: 'o', nodeName: 'Orch', kind: 'orchestrator', status: 'done' }
    const stepB: RunStepRecord = { nodeId: 'w', nodeName: 'W', kind: 'worker', status: 'done' }
    const rec = toRunRecord(mkState({ steps: { o: stepA, w: stepB } }))
    expect(rec.runId).toBe('r1')
    expect(rec.goal).toBe('ship it')
    expect(rec.status).toBe('completed')
    expect(rec.finishedAt).toBe('2026-06-24T00:05:00.000Z') // = updatedAt
    expect(rec.steps).toEqual([stepA, stepB]) // steps record -> array
    expect(rec.final).toBe('all done')
  })

  it('omits error when there is none, includes it when present', () => {
    expect(toRunRecord(mkState()).error).toBeUndefined()
    const failed = toRunRecord(mkState({ status: 'error', error: 'boom' }))
    expect(failed.status).toBe('error')
    expect(failed.error).toBe('boom')
  })

  it('survives a JSON round-trip', () => {
    const rec = toRunRecord(mkState())
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec)
  })
})
