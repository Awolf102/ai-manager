import { describe, it, expect } from 'vitest'
import { runGraph, resumeGraph, END, type CompiledGraph, type NodeIO } from './graph'
import type { RunState } from '../../shared/types'

function mkState(over: Partial<RunState> = {}): RunState {
  return {
    runId: 'r1',
    goal: 'g',
    orchestratorId: 'o',
    startedAt: 'S',
    updatedAt: 'S',
    status: 'running',
    phase: 'planning',
    cursor: '',
    actingMode: 'auto',
    plan: [],
    tasks: {},
    steps: {},
    reviews: [],
    reflections: [],
    final: '',
    ...over
  }
}

function fakeStore() {
  const saved = new Map<string, RunState>()
  const puts: RunState[] = []
  return {
    saved,
    puts,
    async put(s: RunState): Promise<void> {
      puts.push(structuredClone(s))
      saved.set(s.runId, structuredClone(s))
    },
    async get(id: string): Promise<RunState | null> {
      return saved.get(id) ?? null
    }
  }
}

function io(signal: AbortSignal, store: ReturnType<typeof fakeStore>): NodeIO {
  return { signal, emit: () => {}, checkpoint: (s) => store.put(s) }
}

const live = new AbortController().signal // never aborted

describe('runGraph', () => {
  it('walks the static edges from entry to END, applying each patch', async () => {
    const ran: string[] = []
    const store = fakeStore()
    const graph: CompiledGraph = {
      entry: 'a',
      edges: { a: 'b', b: END },
      nodes: {
        a: async () => {
          ran.push('a')
          return { patch: { goal: 'A' } }
        },
        b: async () => {
          ran.push('b')
          return { patch: { final: 'B' } }
        }
      }
    }
    const out = await runGraph(graph, mkState(), store, io(live, store))
    expect(ran).toEqual(['a', 'b'])
    expect(out.status).toBe('completed')
    expect(out.goal).toBe('A')
    expect(out.final).toBe('B')
    expect(store.puts.at(-1)?.status).toBe('completed')
  })

  it('checkpoints after every node', async () => {
    const store = fakeStore()
    const graph: CompiledGraph = {
      entry: 'a',
      edges: { a: 'b', b: END },
      nodes: { a: async () => ({}), b: async () => ({}) }
    }
    await runGraph(graph, mkState(), store, io(live, store))
    // a checkpoint after a, after b, plus the terminal write
    expect(store.puts.length).toBeGreaterThanOrEqual(2)
  })

  it('honors an explicit goto over the static edge', async () => {
    const ran: string[] = []
    const store = fakeStore()
    const graph: CompiledGraph = {
      entry: 'a',
      edges: { a: 'b', b: END, c: END },
      nodes: {
        a: async () => {
          ran.push('a')
          return { goto: 'c' }
        },
        b: async () => {
          ran.push('b')
          return {}
        },
        c: async () => {
          ran.push('c')
          return {}
        }
      }
    }
    await runGraph(graph, mkState(), store, io(live, store))
    expect(ran).toEqual(['a', 'c']) // b skipped
  })

  it('stops with status cancelled when the signal is already aborted', async () => {
    const ran: string[] = []
    const store = fakeStore()
    const ac = new AbortController()
    ac.abort()
    const graph: CompiledGraph = {
      entry: 'a',
      edges: { a: END },
      nodes: {
        a: async () => {
          ran.push('a')
          return {}
        }
      }
    }
    const out = await runGraph(graph, mkState(), store, io(ac.signal, store))
    expect(ran).toEqual([])
    expect(out.status).toBe('cancelled')
  })

  it('captures a thrown node as status error and stops', async () => {
    const ran: string[] = []
    const store = fakeStore()
    const graph: CompiledGraph = {
      entry: 'a',
      edges: { a: 'b', b: END },
      nodes: {
        a: async () => {
          throw new Error('boom')
        },
        b: async () => {
          ran.push('b')
          return {}
        }
      }
    }
    const out = await runGraph(graph, mkState(), store, io(live, store))
    expect(out.status).toBe('error')
    expect(out.error).toBe('boom')
    expect(ran).not.toContain('b')
    expect(store.puts.at(-1)?.status).toBe('error')
  })

  it('pauses at an interrupting node without advancing the cursor', async () => {
    const ran: string[] = []
    const store = fakeStore()
    const graph: CompiledGraph = {
      entry: 'a',
      edges: { a: 'b', b: END },
      nodes: {
        a: async () => ({ interrupt: { kind: 'approve', prompt: 'ok?' } }),
        b: async () => {
          ran.push('b')
          return {}
        }
      }
    }
    const out = await runGraph(graph, mkState(), store, io(live, store))
    expect(out.status).toBe('interrupted')
    expect(out.cursor).toBe('a') // re-enters here on resume
    expect(out.pendingInterrupt).toEqual({ kind: 'approve', prompt: 'ok?' })
    expect(ran).not.toContain('b')
  })
})

describe('resumeGraph', () => {
  it('continues from the saved cursor, not the entry', async () => {
    const ran: string[] = []
    const store = fakeStore()
    await store.put(mkState({ runId: 'r1', cursor: 'b' }))
    const graph: CompiledGraph = {
      entry: 'a',
      edges: { a: 'b', b: END },
      nodes: {
        a: async () => {
          ran.push('a')
          return {}
        },
        b: async () => {
          ran.push('b')
          return {}
        }
      }
    }
    const out = await resumeGraph(graph, 'r1', store, io(live, store))
    expect(ran).toEqual(['b']) // a already ran before the crash
    expect(out.status).toBe('completed')
  })

  it('clears the interrupt and injects the human decision on resume', async () => {
    let seen: unknown
    const store = fakeStore()
    await store.put(
      mkState({
        runId: 'r1',
        cursor: 'a',
        status: 'interrupted',
        pendingInterrupt: { kind: 'approve', prompt: 'ok?' }
      })
    )
    const graph: CompiledGraph = {
      entry: 'a',
      edges: { a: END },
      nodes: {
        a: async (s) => {
          seen = s.resumeInput
          return {}
        }
      }
    }
    const out = await resumeGraph(graph, 'r1', store, io(live, store), { approved: true })
    expect(seen).toEqual({ approved: true })
    expect(out.status).toBe('completed')
    expect(out.pendingInterrupt).toBeUndefined()
  })

  it('throws when there is no checkpoint to resume', async () => {
    const store = fakeStore()
    const graph: CompiledGraph = { entry: 'a', edges: { a: END }, nodes: { a: async () => ({}) } }
    await expect(resumeGraph(graph, 'ghost', store, io(live, store))).rejects.toThrow()
  })
})
