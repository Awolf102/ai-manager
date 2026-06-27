// A tiny local state-graph runtime — the "LangGraph without LangGraph" engine.
// Nodes are async functions over a single serializable RunState; the driver
// checkpoints after every node, so a run survives a crash and resumes from its
// saved cursor. Pure of electron/SDK imports → unit-testable with fake nodes.

import type { Interrupt, OrchestrationEvent, RunState } from '../../shared/types'

export const END = '__end__'

export interface NodeIO {
  signal: AbortSignal
  emit: (e: OrchestrationEvent) => void
  /** mid-node durability (e.g. after each task in a parallel batch) */
  checkpoint: (state: RunState) => Promise<void>
}

export interface NodeResult {
  /** shallow-merged into the run state */
  patch?: Partial<RunState>
  /** explicit next node; omit to follow the static edge */
  goto?: string
  /** pause the run here for human input; persisted, re-entered on resume */
  interrupt?: Interrupt
}

export type GraphNode = (state: RunState, io: NodeIO) => Promise<NodeResult>

export interface CompiledGraph {
  entry: string
  nodes: Record<string, GraphNode>
  /** "after node X, go to Y" — a node may override with its own goto */
  edges: Record<string, string>
}

/** The slice of RunStore the runtime needs (put for checkpoints, get for resume). */
export interface GraphStore {
  put(state: RunState): Promise<void>
  get(runId: string): Promise<RunState | null>
}

const now = (): string => new Date().toISOString()

/** Drive `state` through the graph from its current cursor until END or a stop. */
export async function runGraph(
  graph: CompiledGraph,
  initial: RunState,
  store: GraphStore,
  io: NodeIO
): Promise<RunState> {
  let state = initial
  let cursor = state.cursor || graph.entry

  while (cursor !== END) {
    if (io.signal.aborted) {
      state = { ...state, status: 'cancelled', updatedAt: now() }
      break
    }
    const node = graph.nodes[cursor]
    if (!node) throw new Error(`graph has no node "${cursor}"`)

    let res: NodeResult
    try {
      res = await node(state, io)
    } catch (err) {
      state = {
        ...state,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        resumeInput: undefined,
        updatedAt: now()
      }
      await store.put(state)
      return state
    }

    if (res.patch) state = { ...state, ...res.patch }
    const next = res.goto ?? graph.edges[cursor] ?? END

    if (res.interrupt) {
      // pause: keep the cursor here so resume re-enters this node
      state = {
        ...state,
        status: 'interrupted',
        pendingInterrupt: res.interrupt,
        cursor,
        updatedAt: now()
      }
      await store.put(state)
      return state
    }

    state = { ...state, cursor: next, updatedAt: now() }
    await store.put(state) // durability after every node
    cursor = next
  }

  if (state.status === 'running') state = { ...state, status: 'completed', phase: 'done' }
  await store.put(state)
  return state
}

/**
 * Resume a run from its last checkpoint. If it was paused on an interrupt and a
 * decision is supplied, clear the interrupt and inject `resumeInput` for the
 * paused node to read.
 */
export async function resumeGraph(
  graph: CompiledGraph,
  runId: string,
  store: GraphStore,
  io: NodeIO,
  resumeInput?: unknown
): Promise<RunState> {
  const saved = await store.get(runId)
  if (!saved) throw new Error(`no checkpoint to resume for run "${runId}"`)

  let state = saved
  if (resumeInput !== undefined) {
    state = { ...state, status: 'running', pendingInterrupt: undefined, resumeInput }
  } else if (state.status === 'interrupted') {
    state = { ...state, status: 'running' }
  }
  return runGraph(graph, state, store, io)
}
