# Orchestrator — Durable State & a Local "LangGraph" (design)

## Context

The orchestration engine (`src/main/engine/orchestrator.ts`) runs entirely in memory and
persists **once**, at the end. `execute()` holds a `Ctx` of three `Map`s (`steps`,
`taskOwner`, `taskResult`) plus an `AbortController`, and walks a hardcoded linear path:
plan → recursive `delegate` → review → repair loop → reflect → synthesize. `saveRun()` is
called a single time after the run finishes (`orchestrator.ts:204`).

Consequences:

- **No durability.** Crash/quit mid-run loses all orchestration state (worker file edits
  survive on disk; owners, outputs, and verdicts do not).
- **Resume is at the wrong layer.** `agent.sessionId` + `--resume` (`agent-runner.ts:78`)
  resumes a single Claude Code *session*, not a *run*.
- **The graph is control flow, not data** — you can't inspect, pause, or re-enter it. The
  user-drawn canvas is data; the plan→review pipeline is `if`/`await`.

This is exactly the surface LangGraph covers (checkpointing, a serializable shared state, an
explicit node graph, interrupts/human-in-the-loop, resume/time-travel). The decision (see
the architecture memory) is **not** to adopt LangGraph — it would force a second graph layer
under the user's canvas, pull in a heavy JS dependency (or a Python sidecar), and buy nothing
the Claude Code agent layer doesn't already give. Instead we port the *ideas* into ~150 lines
of our own runtime. Our `Ctx`-plus-linear-`execute` is already an implicit state machine; we
make it explicit, serializable, checkpointed, and resumable.

## Concept mapping — LangGraph → here

| LangGraph | Local equivalent | Where |
|---|---|---|
| Shared `State` (typed, reducer-merged) | `RunState` — one serializable object | `shared/types.ts` |
| Checkpointer (SQLite/Postgres saver) | `RunStore.put/get` writing `.ai-manager/runs/<runId>.json` after every node | `engine/run-store.ts` (new) |
| `StateGraph` nodes + edges | `CompiledGraph` of named `GraphNode`s + a static `edges` map; nodes override with `goto` | `engine/graph.ts` (new) |
| Conditional edges | a node returns `goto` computed from state | nodes |
| `interrupt()` / human-in-the-loop | node returns `{ interrupt }`; run persists as `interrupted`; `resumeRun` re-enters | `graph.ts` + `ipc.ts` |
| Resume / time-travel | load the last checkpoint and continue from `state.cursor` | `resumeGraph` |
| Streaming state deltas | already done — `OrchestrationEvent` over IPC | unchanged |
| Per-node retry policy | already ad-hoc (`runStructured` 1-retry, repair loop) — formalize per node | nodes |
| Durable execution of parallel branches | per-task checkpoint inside the execute node | execute node |

Key non-goal: **don't serialize runtime handles.** `WebContents` and `AbortController` stay
in an in-memory `RunHandle` keyed by `runId`; `RunState` is pure JSON.

## Stage 1 — Checkpointer (durability, no behavior change)

Make the live state serializable and persist it after every transition. The History view
already reads `.ai-manager/runs/*.json`; in-progress runs simply appear with status
`running` / `interrupted`.

### `RunState` (replaces the `Ctx` Maps)

```ts
// shared/types.ts
export type RunPhase =
  | 'planning' | 'routing' | 'executing' | 'reviewing'
  | 'repairing' | 'reflecting' | 'synthesizing' | 'done'

export type LiveRunStatus =
  | 'running' | 'interrupted' | 'completed' | 'cancelled' | 'error'

export interface TaskState {
  task: RunTask
  ownerId: string | null              // was Ctx.taskOwner
  status: 'pending' | 'running' | 'done' | 'failed' | 'passed'
  attempts: number
  output: string                      // was Ctx.taskResult
  verdict?: { verdict: 'pass' | 'fail'; feedback: string }
  dependsOn?: string[]                // Stage 4
}

export interface RunState {
  runId: string
  goal: string
  orchestratorId: string
  startedAt: string
  updatedAt: string
  status: LiveRunStatus
  phase: RunPhase
  cursor: string                      // next graph node — the resume pointer
  actingMode: PermissionMode
  plan: RunTask[]
  tasks: Record<string, TaskState>    // the heart — flat, serializable
  assignmentsByNode: Record<string, Assignment[]>
  steps: Record<string, RunStepRecord>   // was Ctx.steps (Map → record)
  reviews: { attempt: number; tasks: TaskVerdict[] }[]
  reflections: { nodeId: string; win: string; loss: string; lessons: string[] }[]
  pendingInterrupt?: Interrupt
  resumeInput?: unknown               // human decision injected on resume; node reads+clears
  final: string
  error?: string
}
```

`RunRecord` (the persisted shape) becomes a thin view of `RunState` — keep it as a derived
projection so `loadRun`/`listRuns`/HistoryView don't change. `Map → record` everywhere is
the only churn in the existing helpers (`upsert`, `setStatus`, `formatResults`, etc.).

### `RunStore` (the checkpointer)

```ts
// engine/run-store.ts
export interface RunStore {
  put(state: RunState): Promise<void>           // debounced write to <runId>.json
  get(runId: string): Promise<RunState | null>
  listResumable(): Promise<RunState[]>          // status running|interrupted
}
```

- Reuse the `.ai-manager/runs/` directory. **Name files by `runId`** (stable across
  checkpoints) rather than `startedAt`; `listRuns` already sorts by the `startedAt` field
  *inside* the file, so the filename change is safe. One-line migration note: old runs keep
  their timestamp filenames and still load.
- **Debounce** writes (~250 ms trailing) so a burst of status updates coalesces; always
  flush on phase boundary and on terminal status.
- Writes are atomic (`write tmp` → `rename`) to avoid half-written JSON on a hard kill.

That's the whole durability win, and it can ship alone.

## Stage 2 — The local graph runtime

Replace the linear `execute()` with named nodes and a driver loop. This is the "graph as
data" idea; it makes control flow inspectable and resume trivial.

```ts
// engine/graph.ts  (~120 lines)
export const END = '__end__'

export interface Interrupt { kind: string; prompt: string; payload?: unknown }

export interface NodeIO {
  signal: AbortSignal
  emit: (e: OrchestrationEvent) => void
  checkpoint: (s: RunState) => Promise<void>   // for per-task durability inside a node
}

export interface NodeResult {
  patch?: Partial<RunState>
  goto?: string            // explicit next node; omit → use the static edge
  interrupt?: Interrupt    // pause here, persist, await human resume
}

export type GraphNode = (state: RunState, io: NodeIO) => Promise<NodeResult>

export interface CompiledGraph {
  entry: string
  nodes: Record<string, GraphNode>
  edges: Record<string, string>      // "after X, go to Y" unless a node returns goto
}

export async function runGraph(
  graph: CompiledGraph,
  initial: RunState,
  store: RunStore,
  io: NodeIO
): Promise<RunState> {
  let state = initial
  let cursor = state.cursor || graph.entry
  while (cursor !== END) {
    if (io.signal.aborted) { state = { ...state, status: 'cancelled' }; break }
    const node = graph.nodes[cursor]
    if (!node) throw new Error(`unknown node: ${cursor}`)

    let res: NodeResult
    try {
      res = await node(state, io)
    } catch (err) {
      state = { ...state, status: 'error',
                error: err instanceof Error ? err.message : String(err) }
      await store.put(state)
      return state
    }

    if (res.patch) state = { ...state, ...res.patch }
    const next = res.goto ?? graph.edges[cursor] ?? END
    state = { ...state, updatedAt: new Date().toISOString(),
              cursor: res.interrupt ? cursor : next }

    if (res.interrupt) {                                   // human-in-the-loop
      state = { ...state, status: 'interrupted', pendingInterrupt: res.interrupt }
      await store.put(state)
      return state                                         // resumeRun re-enters at cursor
    }
    await store.put(state)                                 // durability after every node
    cursor = next
  }
  if (state.status === 'running')
    state = { ...state, status: 'completed', phase: 'done' }
  await store.put(state)
  return state
}

export async function resumeGraph(
  graph: CompiledGraph,
  runId: string,
  store: RunStore,
  io: NodeIO,
  resumeInput?: unknown
): Promise<RunState> {
  const saved = await store.get(runId)
  if (!saved) throw new Error(`no checkpoint for ${runId}`)
  let state = saved
  if (state.pendingInterrupt && resumeInput !== undefined) {
    state = { ...state, status: 'running', pendingInterrupt: undefined, resumeInput }
  }
  return runGraph(graph, state, store, io)   // continues from state.cursor
}
```

### The nodes (existing steps, re-homed)

```ts
const ORCH = (s: RunState) => s.orchestratorId

const graph: CompiledGraph = {
  entry: 'plan',
  edges: {
    plan: 'route', route: 'execute', execute: 'review',
    review: 'reflect', reflect: 'synthesize', synthesize: END
  },
  nodes: {
    plan:       planNode,        // planStep → fills state.plan + seeds state.tasks (pending)
    route:      routeNode,       // recursive delegate() but only to ASSIGN owners
    execute:    executeNode,     // run pending tasks; per-task checkpoint
    review:     reviewNode,      // reviewStep; goto 'repair' if any fail & attempts left
    repair:     repairNode,      // repairWorker for failed tasks; goto 'review'
    reflect:    reflectNode,     // reflectStep; optional interrupt (Stage 3)
    synthesize: synthNode        // synthesizeStep → state.final
  }
}
```

Two structural shifts make resume and dependencies fall out for free:

1. **Routing and execution split.** `route` runs the existing recursive `delegate` logic but
   only to compute `ownerId` per task (and `assignmentsByNode` for the run view) — it does
   **not** execute. Execution becomes a flat pass over `state.tasks`.

2. **Execution is a reducer over tasks.** The execute node runs every `pending` task (deps
   satisfied) through `mapCapped(…, MAX_PARALLEL=3)` and **checkpoints after each task
   finishes**, so a crash mid-batch keeps completed tasks:

   ```ts
   const executeNode: GraphNode = async (state, io) => {
     const ready = Object.values(state.tasks)
       .filter(t => t.status === 'pending' && depsSatisfied(t, state))
     await mapCapped(ready, MAX_PARALLEL, async ts => {
       if (io.signal.aborted) return
       // single-threaded JS: mutations between awaits are atomic
       state.tasks[ts.task.id] = { ...ts, status: 'running', attempts: ts.attempts + 1 }
       const text = await runWorker(state, ts, io)      // streamAgent (unchanged)
       state.tasks[ts.task.id] = { ...state.tasks[ts.task.id],
                                   status: 'done', output: text }
       await io.checkpoint(state)                       // per-task durability
     })
     return { phase: 'reviewing' }
   }
   ```

   On **resume**, this node re-runs but `ready` is empty for already-`done` tasks — so it
   only finishes what's left. Re-entered workers also keep their own context via
   `--resume` (we already capture `sessionId`).

The review→repair loop becomes two nodes with a conditional `goto`, replacing the `for`
loop in `execute()` (`orchestrator.ts:128`). Repair attempt counting moves onto
`TaskState.attempts` + a `state.reviewNo`, both serializable, both resumable.

### Driver wiring (`startRun` / `stopRun`)

```ts
const handles = new Map<string, { abort: AbortController; wc: WebContents }>()

export function startRun(wc, input): { runId: string } {
  const runId = randomUUID()
  const abort = new AbortController()
  handles.set(runId, { abort, wc })
  const initial = seedRunState(runId, input)   // status 'running', cursor 'plan'
  const io = makeIO(wc, abort, store)
  void runGraph(graph, initial, store, io).finally(() => handles.delete(runId))
  return { runId }
}

export function resumeRun(wc, runId, input?): void {
  const abort = new AbortController()
  handles.set(runId, { abort, wc })
  const io = makeIO(wc, abort, store)
  void resumeGraph(graph, runId, store, io, input).finally(() => handles.delete(runId))
}
```

## Stage 3 — Interrupts, human-in-the-loop, resume-on-launch

- **Approval gate before memory writes** (a roadmap item): `reflectNode` computes the
  reflection, then — if a new `requireMemoryApproval` setting is on — returns
  `{ interrupt: { kind: 'approve-memory', prompt, payload: reflection } }` *before*
  `applyReflection`. The run persists as `interrupted`; the renderer shows the proposed
  memory diff with approve/edit/reject; `resumeRun(runId, decision)` re-enters `reflectNode`,
  which reads `state.resumeInput`, applies (or skips) the merge, clears it, and continues.

- **Resume-on-launch:** on project open, `store.listResumable()` finds `running` /
  `interrupted` runs; the Run view offers "Resume" (re-enters at `cursor`) or "Discard". A
  `running` run found at startup means a prior hard crash — resuming re-runs only the
  in-flight node.

- **New IPC:** add `resumeRun` and `discardRun` channels alongside `startRun`/`stopRun`
  (`shared/types.ts` `IPC`), and an `OrchestrationEvent` variant `{ type: 'interrupt';
  interrupt: Interrupt }` so the renderer can render the gate.

## Stage 4 — Task dependencies (cheap, given Stage 2)

`TaskState.dependsOn` already exists. Have `planNode` optionally emit `dependsOn` per task
(extend the plan JSON schema), and `depsSatisfied` gates the execute node. This delivers the
"cross-task dependencies/sequencing" roadmap item with no new machinery — the execute node
already loops until nothing is `ready`, so a topological wave falls out naturally. (For
cycles, cap by `attempts` and surface unresolved tasks as `failed` with a clear message.)

## What explicitly does NOT change

- The Claude Code agent layer (`agent-runner.ts`, `streamAgent`, the PTY path) — untouched.
- Auth, permission-mode-per-step (`THINK_DISALLOW`/`EDIT_TOOLS`), the Autonomy mapping.
- Prompts, the structured-JSON parse-with-retry, the memory merge (`mergeMemory`).
- The History view contract (`RunRecord`/`RunSummary`) — `RunRecord` becomes a projection of
  `RunState`, so the renderer is unaffected.

## Risks & notes

- **Parallel + single mutable state:** safe because Node is single-threaded; only interleave
  at `await`. Update `state.tasks[id]` between awaits, checkpoint after each.
- **Checkpoint write volume:** debounce + atomic rename; flush on phase boundary.
- **Don't checkpoint handles:** `WebContents`/`AbortController` live in `handles`, never in
  `RunState`.
- **Back-compat:** old timestamp-named run files still load read-only; new runs are
  `runId`-named. `listRuns` is unaffected (sorts by in-file `startedAt`).

See `docs/orchestrator-durable-state.prompts.md` for ready-to-run implementation prompts.
</content>
</invoke>
