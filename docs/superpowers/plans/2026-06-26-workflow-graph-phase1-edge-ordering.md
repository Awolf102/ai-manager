# Workflow-Graph Phase 1: Clickable Edge Ordering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user stamp a top-level execution order onto the canvas's flow lines; the engine runs the ordered teams in that order by deriving it onto the existing `dependsOn` wave machinery (no `executeNode` changes; no-order = byte-for-byte today).

**Architecture:** A pure, node-free `shared/workflow-order.ts` holds the order logic — `deriveOrderDeps(edges, orchestratorId, tasks)` (run-time: order → task deps) and `applyOrderClick(edges, clickedId)` (UI: stamp/clear+re-pack). `routeNode` merges the derived deps into `tasks[*].dependsOn` after routing. `OrgChart` gets an "Order" mode toggle + edge-click stamping + numbered/solid ordered edges. Approach A from the spec.

**Tech Stack:** TypeScript, Electron, React + @xyflow/react (React Flow), Zustand, vitest. No new dependencies.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-26-workflow-graph-phase1-edge-ordering-design.md`.
- **No new dependencies.**
- **`GraphEdge.order?: number`** — a 1..N sequence; consumed only on edges whose `source` is the run's orchestrator. Additive; rides `graph.json` via the existing `setEdges`.
- **Engine approach (A):** derive task `dependsOn` from ordered top-level subtrees and ride the existing wave loop. **`executeNode` is NOT modified.**
- **Sequencing semantics:** a later team waits for earlier teams' tasks to be *executed* (`depsSatisfied` gates on owned, not-yet-executed deps) — "stage before stage."
- **Backward compatibility:** no ordered edges → `deriveOrderDeps` returns `{}` → no added deps → identical to today.
- **Scope:** only the orchestrator's direct-child edges are orderable (one global sequence). No deeper ordering, no output-prompt threading (Phase 1 non-goals).
- **House testing precedent:** pure `shared/*` + engine logic unit-tested; renderer (OrgChart/CSS) verified by `npm run typecheck` + `npm run build`.
- **Test runner:** `npx vitest run <file>`; `npm test`; `npm run typecheck` + `npm run build`.
- **Commits:** every commit message ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: `GraphEdge.order` + pure `workflow-order.ts`

The additive type field and the fully-unit-tested pure core: the run-time order→deps derivation and the UI stamp/clear logic. No behavior change elsewhere yet.

**Files:**
- Modify: `src/shared/types.ts` (add `GraphEdge.order?`)
- Create: `src/shared/workflow-order.ts`
- Create: `src/shared/workflow-order.test.ts`

**Interfaces:**
- Produces: `GraphEdge.order?: number`
- Produces: `deriveOrderDeps(edges: { source: string; target: string; order?: number }[], orchestratorId: string, tasks: { id: string; ownerId: string | null }[]): Record<string, string[]>`
- Produces: `applyOrderClick<E extends { id: string; order?: number }>(edges: E[], clickedId: string): E[]`

- [ ] **Step 1: Add the field (`src/shared/types.ts`)**

Find the `GraphEdge` interface and add `order?`:

```ts
export interface GraphEdge {
  id: string
  source: string
  target: string
  /** 1..N execution sequence; consumed only on edges whose source is the run's orchestrator */
  order?: number
}
```

- [ ] **Step 2: Write the failing tests (`src/shared/workflow-order.test.ts`)**

```ts
import { describe, it, expect } from 'vitest'
import { deriveOrderDeps, applyOrderClick } from './workflow-order'

// Helpers
const T = (id: string, ownerId: string | null) => ({ id, ownerId })
const E = (source: string, target: string, order?: number) => ({ source, target, order })

describe('deriveOrderDeps', () => {
  it('returns {} when no edges carry an order', () => {
    const edges = [E('o', 'w1'), E('o', 'w2')]
    expect(deriveOrderDeps(edges, 'o', [T('t1', 'w1'), T('t2', 'w2')])).toEqual({})
  })

  it('makes a later team depend on every earlier team task (two teams)', () => {
    const edges = [E('o', 'w1', 1), E('o', 'w2', 2)]
    const out = deriveOrderDeps(edges, 'o', [T('t1', 'w1'), T('t2', 'w2')])
    expect(out).toEqual({ t2: ['t1'] })
  })

  it('chains three teams: team 3 depends on teams 1 and 2', () => {
    const edges = [E('o', 'wa', 1), E('o', 'wb', 2), E('o', 'wc', 3)]
    const out = deriveOrderDeps(edges, 'o', [T('a', 'wa'), T('b', 'wb'), T('c', 'wc')])
    expect(out.b).toEqual(['a'])
    expect(out.c?.sort()).toEqual(['a', 'b'])
    expect(out.a).toBeUndefined()
  })

  it('gates a whole subtree: a manager+workers team ahead of a second team', () => {
    // team1 root = m (manager); m -> w1, w2 ; team2 root = w3
    const edges = [E('o', 'm', 1), E('m', 'w1'), E('m', 'w2'), E('o', 'w3', 2)]
    const tasks = [T('t1', 'w1'), T('t2', 'w2'), T('t3', 'w3')]
    const out = deriveOrderDeps(edges, 'o', tasks)
    expect(out.t3?.sort()).toEqual(['t1', 't2']) // team2 waits for ALL of team1's subtree
    expect(out.t1).toBeUndefined()
    expect(out.t2).toBeUndefined()
  })

  it('an empty earlier team adds no deps to the later team', () => {
    const edges = [E('o', 'w1', 1), E('o', 'w2', 2)]
    const out = deriveOrderDeps(edges, 'o', [T('t2', 'w2')]) // team1 (w1) owns no tasks
    expect(out).toEqual({}) // nothing earlier to wait on
  })

  it('ignores unordered sibling teams (they stay parallel)', () => {
    const edges = [E('o', 'w1', 1), E('o', 'w2'), E('o', 'w3', 2)]
    const out = deriveOrderDeps(edges, 'o', [T('t1', 'w1'), T('t2', 'w2'), T('t3', 'w3')])
    expect(out.t3).toEqual(['t1']) // only ordered teams chain
    expect(out.t2).toBeUndefined() // unordered team unaffected
  })
})

describe('applyOrderClick', () => {
  const mk = (id: string, order?: number) => ({ id, order })

  it('assigns the next number to an unordered edge', () => {
    const out = applyOrderClick([mk('a', 1), mk('b'), mk('c', 2)], 'b')
    expect(out.find((e) => e.id === 'b')!.order).toBe(3)
  })

  it('assigns 1 to the first ordered edge', () => {
    const out = applyOrderClick([mk('a'), mk('b')], 'a')
    expect(out.find((e) => e.id === 'a')!.order).toBe(1)
  })

  it('clears an order and re-packs the higher ones', () => {
    const out = applyOrderClick([mk('a', 1), mk('b', 2), mk('c', 3)], 'b')
    expect(out.find((e) => e.id === 'b')!.order).toBeUndefined()
    expect(out.find((e) => e.id === 'a')!.order).toBe(1) // unchanged (below cleared)
    expect(out.find((e) => e.id === 'c')!.order).toBe(2) // re-packed down
  })

  it('returns edges unchanged for an unknown id', () => {
    const edges = [mk('a', 1)]
    expect(applyOrderClick(edges, 'ghost')).toBe(edges)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/shared/workflow-order.test.ts`
Expected: FAIL — `./workflow-order` cannot be resolved.

- [ ] **Step 4: Implement the pure module (`src/shared/workflow-order.ts`)**

```ts
// Pure workflow-ordering logic for the canvas (Phase 1). No node/DOM imports —
// unit-tested in plain Node. `deriveOrderDeps` runs at route time (order → task deps);
// `applyOrderClick` runs in the canvas (stamp/clear + re-pack).

/**
 * Turn top-level edge ordering into task dependencies. For the orchestrator's
 * direct-child edges that carry an `order`, every task under the team ordered k
 * gains a dependency on every task under teams ordered < k. Returns a map of
 * taskId -> extra dependency taskIds (only tasks that gain deps). {} when nothing
 * is ordered, so callers add no deps and behavior is unchanged.
 */
export function deriveOrderDeps(
  edges: { source: string; target: string; order?: number }[],
  orchestratorId: string,
  tasks: { id: string; ownerId: string | null }[]
): Record<string, string[]> {
  const children = new Map<string, string[]>()
  for (const e of edges) {
    const list = children.get(e.source) ?? []
    list.push(e.target)
    children.set(e.source, list)
  }
  const teams = edges
    .filter((e) => e.source === orchestratorId && typeof e.order === 'number')
    .map((e) => ({ root: e.target, order: e.order as number }))
    .sort((a, b) => a.order - b.order)
  if (teams.length === 0) return {}

  const subtree = (root: string): Set<string> => {
    const seen = new Set<string>([root])
    const queue = [root]
    while (queue.length) {
      const n = queue.shift()!
      for (const c of children.get(n) ?? []) {
        if (!seen.has(c)) {
          seen.add(c)
          queue.push(c)
        }
      }
    }
    return seen
  }

  const teamTasks = teams.map((t) => {
    const nodes = subtree(t.root)
    const ids = tasks.filter((x) => x.ownerId !== null && nodes.has(x.ownerId)).map((x) => x.id)
    return ids
  })

  const out: Record<string, string[]> = {}
  for (let k = 0; k < teamTasks.length; k++) {
    const earlier = [...new Set(teamTasks.slice(0, k).flat())]
    if (earlier.length === 0) continue
    for (const id of teamTasks[k]) out[id] = earlier
  }
  return out
}

/**
 * Stamp execution order onto a top-level edge by id. If the edge is unordered,
 * it gets the next number (max existing + 1). If it already has an order, the
 * order is cleared and higher orders re-pack down to stay contiguous (1..N).
 * Caller must pre-validate that `clickedId` is an orderable (top-level) edge.
 */
export function applyOrderClick<E extends { id: string; order?: number }>(
  edges: E[],
  clickedId: string
): E[] {
  const clicked = edges.find((e) => e.id === clickedId)
  if (!clicked) return edges
  if (typeof clicked.order === 'number') {
    const cleared = clicked.order
    return edges.map((e) =>
      e.id === clickedId
        ? { ...e, order: undefined }
        : typeof e.order === 'number' && e.order > cleared
          ? { ...e, order: e.order - 1 }
          : e
    )
  }
  const max = edges.reduce((m, e) => (typeof e.order === 'number' && e.order > m ? e.order : m), 0)
  return edges.map((e) => (e.id === clickedId ? { ...e, order: max + 1 } : e))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/shared/workflow-order.test.ts`
Expected: PASS (all in this file).

- [ ] **Step 6: Typecheck + full suite + commit**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite green (additions are additive/unused so far).
```bash
git add src/shared/types.ts src/shared/workflow-order.ts src/shared/workflow-order.test.ts
git commit -m "feat(workflow): GraphEdge.order + pure deriveOrderDeps/applyOrderClick"
```

---

### Task 2: Engine — merge order-deps in `routeNode`

Wire `deriveOrderDeps` into the run: a `getEdges()` accessor + a merge in `routeNode` after routing. `executeNode`'s wave loop then sequences the teams. Integration-tested via the deterministic node-graph seam.

**Files:**
- Modify: `src/main/engine/project-store.ts` (`getEdges`)
- Modify: `src/main/engine/nodes.ts` (`routeNode` merge + import)
- Modify: `src/main/engine/nodes.test.ts` (mock `getEdges`; ordered-teams integration test + no-order control)

**Interfaces:**
- Consumes: `deriveOrderDeps` (Task 1); `GraphEdge` (Task 1).
- Produces: `getEdges(): GraphEdge[]`.

- [ ] **Step 1: Add the `getEdges` accessor (`src/main/engine/project-store.ts`)**

Add next to `childrenOf`/`parentOf` (the orchestration helpers, ≈ line 308):

```ts
/** The project's raw edges (with any `order`), for run-time ordering. */
export function getEdges(): GraphEdge[] {
  return requireCurrent().graph.edges
}
```

(`GraphEdge` is already imported in `project-store.ts`.)

- [ ] **Step 2: Add the ordered-teams integration test + mock (`src/main/engine/nodes.test.ts`)**

In the hoisted `h` object (the `vi.hoisted(() => { ... })` block), add an `edges` field after `children`:

```ts
    children: { o: ['w1', 'w2'], w1: [], w2: [] } as Record<string, string[]>,
    edges: [] as { source: string; target: string; order?: number }[],
```

In the `vi.mock('./project-store', () => ({ ... }))` object, add a `getEdges` entry (after `parentOf`):

```ts
  getEdges: () => h.edges,
```

Add this describe block at the end of the file:

```ts
describe('top-level edge ordering', () => {
  afterEach(() => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    h.edges = []
  })

  it('runs an earlier-ordered team before a later one (derived from edge order)', async () => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    h.edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'w2', order: 2 }
    ]
    const order: string[] = []
    const runAgent: AgentRunner = async (opts) => {
      const p = opts.prompt
      if (p.includes('Produce a concise, ordered list'))
        return {
          text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d"},{"id":"t2","title":"T2","description":"d"}]}\n```'
        }
      if (p.includes('You route planned tasks'))
        return {
          text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","effort":"high","reason":"r"},{"taskId":"t2","childId":"w2","effort":"high","reason":"r"}]}\n```'
        }
      if (p.includes('You have been assigned the following task')) {
        // delay w1 so that WITHOUT ordering, w2 would finish first
        if (opts.agentId === 'w1') await new Promise((r) => setTimeout(r, 15))
        order.push(opts.agentId)
        return { text: `worked ${opts.agentId}` }
      }
      if (p.includes('Judge each task'))
        return {
          text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```'
        }
      if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'DONE' }
      return { text: '' }
    }
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    expect(out.tasks.t2.dependsOn).toEqual(['t1']) // order → dep
    expect(order).toEqual(['w1', 'w2']) // earlier team executed first despite the delay
  })

  it('adds no deps when edges carry no order (today behavior)', async () => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    h.edges = [
      { source: 'o', target: 'w1' },
      { source: 'o', target: 'w2' }
    ]
    const { runAgent } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    expect(out.tasks.t1.dependsOn).toBeUndefined()
    expect(out.tasks.t2.dependsOn).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: FAIL — the ordered test fails (`out.tasks.t2.dependsOn` is `undefined`; `order` may be `['w2','w1']`) because `routeNode` doesn't merge order-deps yet. (`getEdges` mock may also be flagged as unused until Step 4 wires it.)

- [ ] **Step 4: Merge order-deps in `routeNode` (`src/main/engine/nodes.ts`)**

Add `getEdges` to the project-store import block:

```ts
import {
  applyReflection,
  childrenOf,
  getAgent,
  getEdges,
  getSettings,
  parentOf,
  readMemory,
  rolesOf,
  updateAgent
} from './project-store'
```

Add the import for the pure helper near the other `../../shared/*` imports (e.g. after the `lessons` import):

```ts
import { deriveOrderDeps } from '../../shared/workflow-order'
```

Replace `routeNode` with:

```ts
async function routeNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }
  await routeTasks(eng, tasks, steps, state.orchestratorId, Object.keys(tasks), true)

  // Top-level edge ordering → task deps (Phase 1). No-op when no edge carries an order.
  const owned = Object.values(tasks).map((t) => ({ id: t.task.id, ownerId: t.ownerId }))
  const orderDeps = deriveOrderDeps(getEdges(), state.orchestratorId, owned)
  for (const [taskId, deps] of Object.entries(orderDeps)) {
    const t = tasks[taskId]
    if (!t) continue
    t.dependsOn = [...new Set([...(t.dependsOn ?? []), ...deps])]
  }

  return { patch: { tasks, steps, phase: 'executing' } }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS — the ordered test now sequences `w1` before `w2` and sets `t2.dependsOn = ['t1']`; the no-order control still adds nothing; all existing tests stay green (they leave `h.edges = []`, so `deriveOrderDeps` returns `{}`).

- [ ] **Step 6: Full suite + typecheck + commit**

Run: `npm test && npm run typecheck`
Expected: all green.
```bash
git add src/main/engine/project-store.ts src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(workflow): routeNode sequences ordered top-level teams via dependsOn"
```

---

### Task 3: Canvas — Order mode + ordered-edge rendering

The user-facing surface: an "Order" toggle, click-in-sequence stamping (using `applyOrderClick`), and numbered/solid ordered edges. Verified by typecheck + build (renderer house precedent).

**Files:**
- Modify: `src/renderer/canvas/OrgChart.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `applyOrderClick` (Task 1); `GraphEdge.order` (Task 1); existing `persistEdges`/`setEdges`.

- [ ] **Step 1: Wire ordering into `OrgChart.tsx`**

Update the imports (add `useState`, and `Panel` + `EdgeMouseHandler` from React Flow, and `applyOrderClick`):

```ts
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type NodeTypes
} from '@xyflow/react'
import AgentNode, { type AgentFlowNode } from './AgentNode'
import { useStore } from '../store'
import { applyOrderClick } from '../../shared/workflow-order'
import type { GraphEdge, ProjectGraph } from '../../shared/types'
```

Change `toEdges` so order drives the label + style (ordered = solid+numbered, unordered = animated):

```ts
function toEdges(graph: ProjectGraph): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: e.order == null,
    label: e.order != null ? String(e.order) : undefined,
    className: e.order != null ? 'edge-ordered' : undefined
  }))
}
```

In `edgeSig`, include `order` so the canvas re-seeds when an order changes (ids alone don't change on a re-stamp):

```ts
  const edgeSig = useMemo(() => graph.edges.map((e) => `${e.id}:${e.order ?? ''}`).join('|'), [graph.edges])
```

Add order-mode state + the orchestrator-id set + the edge-click handler (place after the existing `persistEdges`/`onConnect`/etc. callbacks):

```ts
  const [orderMode, setOrderMode] = useState(false)
  const orchIds = useMemo(
    () => new Set(graph.nodes.filter((n) => n.kind === 'orchestrator').map((n) => n.id)),
    [graph.nodes]
  )

  const onEdgeClick = useCallback<EdgeMouseHandler<Edge>>(
    (_, edge) => {
      if (!orderMode || !orchIds.has(edge.source)) return
      void persistEdges(applyOrderClick(graph.edges, edge.id))
    },
    [orderMode, orchIds, graph.edges, persistEdges]
  )
```

On the `<ReactFlow>` element, add `onEdgeClick={onEdgeClick}` and add the toggle as a `<Panel>` child (alongside `<Background>`/`<Controls>`):

```tsx
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onEdgesDelete={onEdgesDelete}
      onNodesDelete={onNodesDelete}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={(_, n) => select(n.id)}
      onEdgeClick={onEdgeClick}
      onPaneClick={() => select(null)}
      fitView
      colorMode="dark"
      proOptions={{ hideAttribution: true }}
    >
      <Panel position="top-right">
        <button
          className={`btn order-toggle ${orderMode ? 'active' : ''}`}
          onClick={() => setOrderMode((v) => !v)}
          title="Click top-level flow lines in the order their teams should run"
        >
          {orderMode ? 'Ordering — click edges in run order' : 'Order'}
        </button>
      </Panel>
      <Background gap={22} color="#1d2230" />
      <Controls showInteractive={false} />
    </ReactFlow>
```

- [ ] **Step 2: Style the ordered edges + toggle (`src/renderer/styles.css`)**

Append:

```css
/* ---- workflow edge ordering ---- */
.react-flow__edge.edge-ordered .react-flow__edge-path {
  stroke: var(--accent);
  stroke-width: 2;
}
.react-flow__edge.edge-ordered .react-flow__edge-text {
  fill: var(--text);
  font-weight: 700;
  font-size: 11px;
}
.react-flow__edge.edge-ordered .react-flow__edge-textbg {
  fill: var(--panel-2);
}
.order-toggle.active {
  border-color: var(--accent);
  background: var(--accent-dim);
  color: var(--text);
}
```

- [ ] **Step 3: Typecheck + build + full suite + commit**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green — the canvas compiles and bundles; tests unchanged.
```bash
git add src/renderer/canvas/OrgChart.tsx src/renderer/styles.css
git commit -m "feat(workflow): Order-mode canvas toggle + click-in-sequence edge ordering"
```

---

## Self-Review

**Spec coverage:**
- `GraphEdge.order?` additive field riding `graph.json` → Task 1. ✓
- Order-mode toggle + click-in-sequence + clear/re-pack + numbered/solid edges, top-level only → Task 3 (`applyOrderClick`, `onEdgeClick` gated on `orchIds`, `toEdges` label/animated/className) + Task 1 (`applyOrderClick` logic + tests). ✓
- Engine approach A: derive deps from ordered top-level subtrees, merge into `dependsOn`, `executeNode` unchanged → Task 2 (`routeNode` merge) + Task 1 (`deriveOrderDeps`). ✓
- `getEdges()` accessor → Task 2. ✓
- No-order = byte-for-byte today → `deriveOrderDeps` returns `{}` (Task 1 test) + the no-order control (Task 2). ✓
- Subtree gating (manager+workers team) → Task 1 test. ✓
- Error/edge cases (empty earlier team, unordered siblings, errors flip to done so no permanent block, flat orchestrator → no top-level edges) → `deriveOrderDeps` tests + the wave loop's existing semantics. ✓
- `setEdges` preserves `order` → it rebuilds `graph.edges` from the passed `GraphEdge[]` (filter keeps whole objects), and `persistEdges` passes the `applyOrderClick` result; confirmed by Task 3 build + the order round-tripping through the canvas. ✓
- `edgeSig` includes `order` so re-stamps re-seed the canvas → Task 3. ✓
- Testing: pure unit (`workflow-order.test.ts`), engine integration (`nodes.test.ts` ordered + control), renderer typecheck/build → Tasks 1–3. ✓
- Non-goals (deeper ordering, output threading, typed edges, mid-run re-plan, run-view) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code + exact commands.

**Type consistency:** `deriveOrderDeps(edges, orchestratorId, tasks)` and `applyOrderClick(edges, clickedId)` signatures (Task 1) match their call sites in `routeNode` (Task 2) and `OrgChart.onEdgeClick` (Task 3). `getEdges(): GraphEdge[]` (Task 2) is mocked in `nodes.test.ts` (`getEdges: () => h.edges`) and consumed in `routeNode`. `GraphEdge.order?` (Task 1) is read by `deriveOrderDeps`, `applyOrderClick`, `toEdges`, and `edgeSig`. The `nodes.test.ts` `h.edges` shape (`{source,target,order?}[]`) matches what `getEdges`/`deriveOrderDeps` expect. ✓
