# Workflow-Graph Phase 3 — Lateral Peer Handoffs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent (worker mid-task, or a reviewer) consult a connected peer via a lateral "handoff" edge — the engine runs that peer with the ask and resumes the asker's session with the answer — with handoff edges kept entirely out of the reporting tree and the whole feature dormant by default.

**Architecture:** A new `GraphEdge.kind` ('report'|'handoff') that the reporting machinery (`childrenOf`/`parentOf`/`deriveOrderDeps`/`deriveStages`) ignores. A pure `parseHandoff` extracts a `{to,ask}` block from agent output; a `runWithHandoffs` consult-loop (used by the worker call and, via `runStructured`, by the review steps) dispatches the peer as a single agent call and resumes the asker. Bounded by `maxHandoffs` (default 0); the peer's answer is terminal (never re-parsed) so there are no cycles.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React 19, zustand, Vitest, @xyflow/react. Pure shared modules are node/DOM-free.

## Global Constraints

- **Byte-for-byte when off:** `maxHandoffs === 0` (default) OR an agent with no handoff peers → agents aren't told of peers, no handoff block is parsed, each agent runs exactly once un-augmented; `childrenOf`/`parentOf`/`deriveOrderDeps`/`deriveStages` exclude handoff edges. Output/events/history identical to today. Pin with an explicit "off" test.
- **No cycles / termination:** `maxHandoffs` caps consults per agent-run; the dispatched **peer's answer is terminal** — never parsed for further handoffs. A handoff edge is never traversed by routing (tree-only).
- **Goal/plan untouched:** handoffs happen inside a task/review; the orchestrator still owns plan+goal and runs the final integration review. No per-handoff approval.
- **Session hygiene:** the peer consult runs `resume:false` and its `sessionId` is NOT persisted (don't clobber the peer's own task session).
- **Pure shared modules stay node/DOM-free** (`src/shared/*.ts`).
- **Test files excluded from `tsc`** (`exclude: ["src/**/*.test.ts"]`).
- **Commands:** tests `npm run test`; types `npm run typecheck`; build `npm run build`.
- **Renderer house precedent:** `store.ts`, `*.tsx`, `styles.css` verified by `npm run typecheck` + `npm run build`, not unit tests.
- **Commit footer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Branch:** `feat/workflow-handoffs` (already created; spec committed there).

---

### Task 1: Data model — `GraphEdge.kind`, `maxHandoffs`, handoff event, `handoffs` records

**Files:**
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces: `GraphEdge.kind?: 'report' | 'handoff'`; `ProjectSettings.maxHandoffs: number` (default `0`); `OrchestrationEvent` += `{ runId: string; type: 'handoff'; askerId: string; peerId: string; ask: string }`; `RunState.handoffs?: { askerId: string; peerId: string; ask: string }[]`; `RunRecord.handoffs?: { askerId: string; peerId: string; ask: string }[]`.

- [ ] **Step 1: Add the type changes in `src/shared/types.ts`**

In `GraphEdge` (after `order?: number`):
```ts
  /** edge role: absent/'report' = the reporting tree (routing/order/review); 'handoff' = a lateral consult line (Phase 3) */
  kind?: 'report' | 'handoff'
```
In `ProjectSettings` (after `maxReplans: number`):
```ts
  /** max lateral peer consults a single agent-run may make (0 = off) */
  maxHandoffs: number
```
In `DEFAULT_SETTINGS` (after `maxReplans: 0`):
```ts
  maxHandoffs: 0
```
In the `OrchestrationEvent` union (after the `replan` member):
```ts
  | { runId: string; type: 'handoff'; askerId: string; peerId: string; ask: string }
```
In `RunState` (after `replans?: …`):
```ts
  /** lateral peer consults performed this run, for the Run view + History */
  handoffs?: { askerId: string; peerId: string; ask: string }[]
```
In `RunRecord` (after `replans?: …`):
```ts
  handoffs?: { askerId: string; peerId: string; ask: string }[]
```

- [ ] **Step 2: Verify (additive types — gated by typecheck + full suite, no behavior change)**

Run: `npm run typecheck`
Expected: PASS (additive optional fields + one required `maxHandoffs` with a default; the only full `ProjectSettings`/`RunState` construction sites — `DEFAULT_SETTINGS` and `seedRunState` — are unaffected because `maxHandoffs` lives in `DEFAULT_SETTINGS` and `handoffs` is optional).
Run: `npm run test`
Expected: PASS — all existing tests green (no behavior change).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "$(cat <<'EOF'
feat(workflow): Phase 3 data model — GraphEdge.kind, maxHandoffs, handoff event

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Pure `parseHandoff` — `src/shared/handoff.ts`

**Files:**
- Create: `src/shared/handoff.ts`
- Test: `src/shared/handoff.test.ts`

**Interfaces:**
- Produces: `parseHandoff(text, peers) => { peerId: string; ask: string } | null` and `HandoffRequest`.
- Consumes (Task 6/7): the engine consult-loop.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/handoff.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseHandoff } from './handoff'

const peers = [
  { id: 'w2', name: 'Research' },
  { id: 'c1', name: 'Compliance' }
]

describe('parseHandoff', () => {
  it('parses a ```handoff block and resolves the target by name (case-insensitive)', () => {
    const text = 'Sure.\n```handoff\n{ "to": "research", "ask": "expressive UI ideas" }\n```'
    expect(parseHandoff(text, peers)).toEqual({ peerId: 'w2', ask: 'expressive UI ideas' })
  })

  it('resolves the target by id', () => {
    const text = '```handoff\n{"to":"c1","ask":"is this compliant?"}\n```'
    expect(parseHandoff(text, peers)).toEqual({ peerId: 'c1', ask: 'is this compliant?' })
  })

  it('returns null when there is no handoff block', () => {
    expect(parseHandoff('Just my normal answer, no consult.', peers)).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseHandoff('```handoff\n{ to: research, ask }\n```', peers)).toBeNull()
  })

  it('returns null when ask is empty', () => {
    expect(parseHandoff('```handoff\n{"to":"research","ask":""}\n```', peers)).toBeNull()
  })

  it('returns null when the target is not a reachable peer', () => {
    expect(parseHandoff('```handoff\n{"to":"nobody","ask":"x"}\n```', peers)).toBeNull()
  })

  it('does not treat a verdict JSON block as a handoff', () => {
    const verdict = '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```'
    expect(parseHandoff(verdict, peers)).toBeNull()
  })

  it('takes the last handoff block when several are present', () => {
    const text =
      '```handoff\n{"to":"research","ask":"first"}\n```\nthen\n```handoff\n{"to":"compliance","ask":"second"}\n```'
    expect(parseHandoff(text, peers)).toEqual({ peerId: 'c1', ask: 'second' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/shared/handoff.test.ts`
Expected: FAIL — cannot find module `./handoff`.

- [ ] **Step 3: Implement `src/shared/handoff.ts`**

```ts
// Pure parsing for lateral peer handoffs (Phase 3). No node/DOM imports — unit-tested
// in plain Node. Extracts a {to, ask} consult request from an agent's output and
// resolves the target against the asker's reachable handoff peers.

export interface HandoffRequest {
  peerId: string
  ask: string
}

/**
 * Parse a handoff request from agent output, or null. Prefers a ```handoff fenced
 * block; resolves `to` to a peer id by exact id then case-insensitive name. Returns
 * null when absent, malformed, `ask` is empty, or `to` is not a reachable peer.
 */
export function parseHandoff(
  text: string,
  peers: { id: string; name: string }[]
): HandoffRequest | null {
  const obj = extractHandoffObject(text)
  if (!obj) return null
  const to = String(obj.to ?? '').trim()
  const ask = String(obj.ask ?? '').trim()
  if (!to || !ask) return null
  const peer =
    peers.find((p) => p.id === to) ?? peers.find((p) => p.name.toLowerCase() === to.toLowerCase())
  if (!peer) return null
  return { peerId: peer.id, ask }
}

/** The last ```handoff fenced JSON object that has a `to` or `ask` field, or null. */
function extractHandoffObject(text: string): { to?: unknown; ask?: unknown } | null {
  const blocks = [...text.matchAll(/```handoff\s*([\s\S]*?)```/gi)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    const parsed = tryParseObject(blocks[i])
    if (parsed && ('to' in parsed || 'ask' in parsed)) return parsed
  }
  return null
}

function tryParseObject(s: string): { to?: unknown; ask?: unknown } | null {
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const o = JSON.parse(s.slice(start, end + 1))
    return o && typeof o === 'object' ? (o as { to?: unknown; ask?: unknown }) : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test -- src/shared/handoff.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Commit**

```bash
git add src/shared/handoff.ts src/shared/handoff.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): pure parseHandoff — extract + resolve a peer consult request

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `deriveOrderDeps` / `deriveStages` ignore handoff edges

**Files:**
- Modify: `src/shared/workflow-order.ts`
- Test: `src/shared/workflow-order.test.ts`

**Interfaces:**
- Consumes: `GraphEdge.kind` (Task 1).
- Produces: `deriveOrderDeps`/`deriveStages` treat `kind === 'handoff'` edges as absent.

- [ ] **Step 1: Write the failing tests**

Add to `src/shared/workflow-order.test.ts`:
```ts
describe('handoff edges are ignored by ordering', () => {
  it('deriveOrderDeps ignores a handoff edge from the orchestrator', () => {
    const edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'w2', order: 2 },
      { source: 'o', target: 'x', order: 3, kind: 'handoff' as const } // must NOT become an ordered team
    ]
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 't2', ownerId: 'w2' },
      { id: 'tx', ownerId: 'x' }
    ]
    const deps = deriveOrderDeps(edges, 'o', tasks)
    expect(deps.tx).toBeUndefined() // x is reached only by a handoff edge → unordered
    expect(deps.t2).toEqual(['t1'])
  })

  it('deriveStages gives a handoff-only target stage 0', () => {
    const edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'x', order: 2, kind: 'handoff' as const }
    ]
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 'tx', ownerId: 'x' }
    ]
    expect(deriveStages(edges, 'o', tasks)).toEqual({ t1: 1, tx: 0 })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/shared/workflow-order.test.ts -t "handoff edges are ignored"`
Expected: FAIL — `deps.tx` is `['t1']` and `tx` stage is `2` (handoff edge wrongly treated as an ordered team).

- [ ] **Step 3: Filter handoff edges in `src/shared/workflow-order.ts`**

Widen the `edges` parameter types of BOTH `deriveOrderDeps` and `deriveStages` to include `kind?: string`:
```ts
  edges: { source: string; target: string; order?: number; kind?: string }[],
```
At the top of `deriveOrderDeps`'s body (replace `const children = childMapOf(edges)` and the `teams` filter source):
```ts
  const reportEdges = edges.filter((e) => e.kind !== 'handoff')
  const children = childMapOf(reportEdges)
  const teams = reportEdges
    .filter((e) => e.source === orchestratorId && typeof e.order === 'number')
    .map((e) => ({ root: e.target, order: e.order as number }))
    .sort((a, b) => a.order - b.order)
```
Do the same in `deriveStages`:
```ts
  const reportEdges = edges.filter((e) => e.kind !== 'handoff')
  const children = childMapOf(reportEdges)
  const teams = reportEdges
    .filter((e) => e.source === orchestratorId && typeof e.order === 'number')
    .map((e) => ({ order: e.order as number, nodes: subtreeOf(children, e.target) }))
    .sort((a, b) => a.order - b.order)
```

- [ ] **Step 4: Run to verify pass (incl. existing ordering tests)**

Run: `npm run test -- src/shared/workflow-order.test.ts`
Expected: PASS — new handoff-ignore tests + all existing `deriveOrderDeps`/`deriveStages`/`applyOrderClick` tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/workflow-order.ts src/shared/workflow-order.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): ordering ignores handoff edges (tree stays a tree)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `toRunRecord` projects `handoffs`

**Files:**
- Modify: `src/shared/run-state.ts`
- Test: `src/shared/run-state.test.ts`

**Interfaces:**
- Consumes: `RunState.handoffs?` (Task 1).
- Produces: `RunRecord.handoffs?` populated by `toRunRecord` (consumed by Task 10 HistoryView).

- [ ] **Step 1: Write the failing test**

Add to the `describe('toRunRecord', …)` block in `src/shared/run-state.test.ts`:
```ts
  it('projects handoffs when present and omits them when absent', () => {
    expect(toRunRecord(mkState()).handoffs).toBeUndefined()
    const withHandoffs = toRunRecord(
      mkState({ handoffs: [{ askerId: 'w1', peerId: 'w2', ask: 'UI ideas' }] })
    )
    expect(withHandoffs.handoffs).toEqual([{ askerId: 'w1', peerId: 'w2', ask: 'UI ideas' }])
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/shared/run-state.test.ts -t "projects handoffs"`
Expected: FAIL — `withHandoffs.handoffs` is `undefined`.

- [ ] **Step 3: Project `handoffs` in `toRunRecord` (`src/shared/run-state.ts`)**

In the returned object, after the `replans` projection line:
```ts
    ...(s.handoffs !== undefined ? { handoffs: s.handoffs } : {}),
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test -- src/shared/run-state.test.ts`
Expected: PASS (incl. the existing round-trip test).

- [ ] **Step 5: Commit**

```bash
git add src/shared/run-state.ts src/shared/run-state.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): project run handoffs into the History RunRecord

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: project-store — exclude handoff edges from the tree + `handoffPeersOf`

**Files:**
- Modify: `src/main/engine/project-store.ts:382-394` (`childrenOf`, `parentOf`), add `handoffPeersOf`
- Test: `src/main/engine/project-store.test.ts`

**Interfaces:**
- Consumes: `GraphEdge.kind` (Task 1).
- Produces: `childrenOf`/`parentOf` exclude `kind === 'handoff'`; NEW `handoffPeersOf(nodeId): AgentNodeData[]` returns targets of this node's outgoing handoff edges.

- [ ] **Step 1: Write the failing test**

Add to `src/main/engine/project-store.test.ts` (import `childrenOf`, `handoffPeersOf`, `parentOf` at the top — `parentOf` is already imported; add the other two to the import list):
```ts
describe('handoff edges and the reporting tree', () => {
  it('childrenOf/parentOf ignore handoff edges; handoffPeersOf returns handoff targets', async () => {
    await openProject(await tmpProject())
    await createAgent({ name: 'Lead', kind: 'manager' })
    await createAgent({ name: 'Dev', kind: 'worker' })
    const graph = await createAgent({ name: 'Research', kind: 'worker' })
    const lead = graph.nodes.find((n) => n.name === 'Lead')!
    const dev = graph.nodes.find((n) => n.name === 'Dev')!
    const research = graph.nodes.find((n) => n.name === 'Research')!
    await setEdges([
      { id: 'e1', source: lead.id, target: dev.id }, // reporting (no kind = report)
      { id: 'e2', source: dev.id, target: research.id, kind: 'handoff' } // lateral
    ])

    expect(childrenOf(lead.id).map((n) => n.id)).toEqual([dev.id]) // dev only
    expect(childrenOf(dev.id)).toEqual([]) // research is a handoff peer, NOT a child
    expect(parentOf(research.id)).toBeNull() // handoff edge is not a reporting parent
    expect(parentOf(dev.id)?.id).toBe(lead.id)
    expect(handoffPeersOf(dev.id).map((n) => n.id)).toEqual([research.id])
    expect(handoffPeersOf(lead.id)).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/main/engine/project-store.test.ts -t "handoff edges and the reporting tree"`
Expected: FAIL — `childrenOf(dev.id)` includes Research, and `handoffPeersOf` is not exported.

- [ ] **Step 3: Update `childrenOf`/`parentOf` + add `handoffPeersOf` (`src/main/engine/project-store.ts`)**

Replace `childrenOf` and `parentOf` (lines ~382-394) and add `handoffPeersOf`:
```ts
/** Agents this node delegates to via the reporting tree (handoff edges excluded). */
export function childrenOf(nodeId: string): AgentNodeData[] {
  const { graph } = requireCurrent()
  const childIds = new Set(
    graph.edges.filter((e) => e.source === nodeId && e.kind !== 'handoff').map((e) => e.target)
  )
  return graph.nodes.filter((n) => childIds.has(n.id))
}

/** The single node this one reports to (reporting edge only), or null for a root. */
export function parentOf(nodeId: string): AgentNodeData | null {
  const { graph } = requireCurrent()
  const edge = graph.edges.find((e) => e.target === nodeId && e.kind !== 'handoff')
  if (!edge) return null
  return graph.nodes.find((n) => n.id === edge.source) ?? null
}

/** Peers this node may CONSULT via outgoing handoff edges (Phase 3). */
export function handoffPeersOf(nodeId: string): AgentNodeData[] {
  const { graph } = requireCurrent()
  const ids = new Set(
    graph.edges.filter((e) => e.source === nodeId && e.kind === 'handoff').map((e) => e.target)
  )
  return graph.nodes.filter((n) => ids.has(n.id))
}
```

- [ ] **Step 4: Run to verify pass + full suite**

Run: `npm run test -- src/main/engine/project-store.test.ts`
Expected: PASS.
Run: `npm run test`
Expected: PASS — existing tests green (existing edges have no `kind` → `kind !== 'handoff'` is true → unchanged).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): childrenOf/parentOf exclude handoff edges; add handoffPeersOf

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Handoff runtime + WORKER site (executeNode)

**Files:**
- Modify: `src/main/engine/nodes.ts` (imports; `runWithHandoffs` + `consultFor` + `handoffSection`/`peerConsultPrompt`/`resumePrompt`; wire `runGroup`)
- Test: `src/main/engine/nodes.test.ts`

**Interfaces:**
- Consumes: `parseHandoff` (Task 2), `handoffPeersOf` (Task 5), `getSettings().maxHandoffs` (Task 1), `StreamAgentOptions` (already imported).
- Produces: `runWithHandoffs(eng, base, consult)` + `consultFor(agentId, goal, actingMode) => Consult | null` (used by Task 7's review wiring); the `handoff` event.

- [ ] **Step 1: Add `handoffPeersOf` to the test mock + `maxHandoffs` to hoisted settings**

In `src/main/engine/nodes.test.ts`: add `maxHandoffs: 0` to the `vi.hoisted` `settings` object (after `maxReplans: 0`), and add this line to the `vi.mock('./project-store', …)` object (after `getEdges`):
```ts
  handoffPeersOf: (id: string) =>
    h.edges.filter((e) => e.source === id && e.kind === 'handoff').map((e) => h.agents[e.target]),
```

- [ ] **Step 2: Write the failing tests (worker consult / cap / off / peer-terminal)**

Add a new describe block to `src/main/engine/nodes.test.ts`:
```ts
describe('orchestrator node graph — peer handoffs (worker site)', () => {
  // one task t1 -> w1; w1 may consult w2 via a handoff edge.
  function fake(order: string[], capture: { ask?: string }, w2Answer: string) {
    const runAgent: AgentRunner = async (opts) => {
      const p = opts.prompt
      if (p.includes('Produce a concise, ordered list'))
        return { text: '```json\n{"tasks":[{"id":"t1","title":"Build UI","description":"build the ui"}]}\n```' }
      if (p.includes('You route planned tasks'))
        return { text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","effort":"high","reason":"r"}]}\n```' }
      if (p.includes('responded to your request')) {
        order.push('w1-resume')
        return { text: 'Built the UI using the teal palette', sessionId: 's-w1' }
      }
      if (p.includes('You have been assigned')) {
        order.push('w1-task')
        return p.includes('You may CONSULT')
          ? { text: '```handoff\n{"to":"W2","ask":"expressive colorful UI ideas"}\n```', sessionId: 's-w1' }
          : { text: 'Built the UI (no consult)', sessionId: 's-w1' }
      }
      if (p.includes('asked for your help')) {
        order.push('w2-consult')
        capture.ask = p
        return { text: w2Answer }
      }
      if (p.includes('Judge each task'))
        return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'DONE' }
      return { text: '' }
    }
    return runAgent
  }

  function run(runAgent: AgentRunner, events: unknown[]) {
    const e = eng(runAgent)
    ;(e as { emit: (ev: unknown) => void }).emit = (ev) => events.push(ev)
    const store = fakeStore()
    return runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
  }

  it('a worker consults a connected peer and continues with the answer', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const order: string[] = []
      const capture: { ask?: string } = {}
      const events: unknown[] = []
      const out = await run(fake(order, capture, 'Use a teal/amber palette'), events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1-task', 'w2-consult', 'w1-resume']) // consult happened mid-task
      expect(capture.ask).toContain('expressive colorful UI ideas') // ask threaded to the peer
      expect(out.tasks.t1.output).toBe('Built the UI using the teal palette') // resumed output
      const handoffs = (events as { type: string; askerId: string; peerId: string; ask: string }[]).filter(
        (ev) => ev.type === 'handoff'
      )
      expect(handoffs).toEqual([{ runId: 'run1', type: 'handoff', askerId: 'w1', peerId: 'w2', ask: 'expressive colorful UI ideas' }])
    } finally {
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })

  it('off control: maxHandoffs=0 → no consult, byte-for-byte', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 0
    try {
      const order: string[] = []
      const events: unknown[] = []
      const out = await run(fake(order, {}, 'unused'), events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1-task']) // worker ran once, not augmented, no consult
      expect(out.tasks.t1.output).toBe('Built the UI (no consult)')
      expect((events as { type: string }[]).some((ev) => ev.type === 'handoff')).toBe(false)
    } finally {
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })

  it('caps consults at maxHandoffs (asker keeps asking)', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      // w2's answer is itself a handoff block; the resumed worker also re-asks — but the cap is 1.
      const out = await run(fake(order, {}, '```handoff\n{"to":"W2","ask":"again"}\n```'), events)
      expect(out.status).toBe('completed')
      expect(order.filter((o) => o === 'w2-consult')).toHaveLength(1) // exactly one consult
      const handoffs = (events as { type: string }[]).filter((ev) => ev.type === 'handoff')
      expect(handoffs).toHaveLength(1)
    } finally {
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })

  it('peer answer is terminal: a handoff block in the peer reply is not re-dispatched', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 3 // budget to spare; terminal-peer is what prevents a second consult
    try {
      const order: string[] = []
      const events: unknown[] = []
      // w2 replies with a handoff-looking block; the worker's RESUME then finishes normally.
      const out = await run(fake(order, {}, '```handoff\n{"to":"W2","ask":"chain"}\n```'), events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1-task', 'w2-consult', 'w1-resume']) // peer reply NOT re-parsed
      expect((events as { type: string }[]).filter((ev) => ev.type === 'handoff')).toHaveLength(1)
    } finally {
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "peer handoffs (worker site)"`
Expected: FAIL — no consult happens (the worker's handoff block becomes the task output; no `w2-consult`).

- [ ] **Step 4: Add the imports + runtime helpers in `src/main/engine/nodes.ts`**

Add to the `project-store` import block: `handoffPeersOf`. Add a new import near the workflow-order import:
```ts
import { parseHandoff } from '../../shared/handoff'
```
Add the consult helpers (near the other Claude steps, e.g. just before `runStructured`):
```ts
/** Per-agent-run consult config; null = handoffs off / no peers (→ a plain single call). */
interface Consult {
  peers: { id: string; name: string }[]
  max: number
  asker: string
  goal: string
  actingMode: PermissionMode
}

/** Build a Consult for an agent, or null when handoffs are off or it has no peers. */
function consultFor(agentId: string, goal: string, actingMode: PermissionMode): Consult | null {
  const max = getSettings().maxHandoffs ?? 0
  if (max <= 0) return null
  const peers = handoffPeersOf(agentId).map((p) => ({ id: p.id, name: p.name }))
  if (peers.length === 0) return null
  return { peers, max, asker: agentId, goal, actingMode }
}

function handoffSection(peers: { id: string; name: string }[]): string {
  const list = peers.map((p) => `- ${p.name} (id: ${p.id})`).join('\n')
  return `\n\nYou may CONSULT these connected teammates for help while you work:
${list}
To consult one, reply with ONLY this block and nothing else:
\`\`\`handoff
{ "to": "<teammate name or id>", "ask": "<exactly what you need from them>" }
\`\`\`
You'll receive their answer and can then continue. Consult only when it genuinely helps; otherwise just finish normally.`
}

function peerConsultPrompt(askerName: string, goal: string, ask: string): string {
  return `Your teammate ${askerName} is working toward this goal:
${goal}

They have asked for your help:
${ask}

Provide exactly what they need, concisely, using your expertise. You may read files and do focused work to answer, but keep it scoped to their request.`
}

function resumePrompt(peerName: string, answer: string): string {
  return `Your teammate ${peerName} responded to your request:

${answer}

Continue your task using this. If you need another consult, emit another handoff block; otherwise finish and report what you did.`
}

/**
 * Run an agent, letting it CONSULT connected peers (Phase 3). With no consult config
 * (off / no peers) this is a single un-augmented runAgent call → byte-for-byte. The
 * dispatched peer's answer is TERMINAL (never re-parsed) so there are no cycles.
 */
async function runWithHandoffs(
  eng: Eng,
  base: StreamAgentOptions,
  consult: Consult | null
): Promise<{ text: string; sessionId?: string }> {
  if (!consult) return eng.runAgent(base)
  let result = await eng.runAgent({ ...base, prompt: base.prompt + handoffSection(consult.peers) })
  for (let n = 0; n < consult.max && !eng.abort.signal.aborted; n++) {
    const req = parseHandoff(result.text, consult.peers)
    if (!req) break
    const peer = consult.peers.find((p) => p.id === req.peerId)!
    eng.emit({ runId: eng.runId, type: 'status', nodeId: peer.id, status: 'working' })
    eng.emit({ runId: eng.runId, type: 'handoff', askerId: consult.asker, peerId: peer.id, ask: req.ask })
    let answer: string
    try {
      const r = await eng.runAgent({
        wc: eng.wc,
        agentId: peer.id,
        prompt: peerConsultPrompt(getAgent(consult.asker).name, consult.goal, req.ask),
        runId: eng.runId,
        stepId: peer.id,
        permissionMode: consult.actingMode,
        resume: false,
        abort: eng.abort
      })
      answer = r.text || '(no answer)'
    } catch (err) {
      answer = `ERROR: ${err instanceof Error ? err.message : String(err)}`
    }
    eng.emit({ runId: eng.runId, type: 'status', nodeId: peer.id, status: 'done' })
    // resume the ASKER's session with the peer's answer (peer sessionId is NOT persisted)
    result = await eng.runAgent({ ...base, prompt: resumePrompt(peer.name, answer), resume: true })
  }
  return result
}
```

- [ ] **Step 5: Wire the worker call in `executeNode`'s `runGroup`**

In `src/main/engine/nodes.ts`, in `runGroup`, replace the `const { text, sessionId } = await eng.runAgent({...})` worker call with a `base` + `runWithHandoffs`:
```ts
      const base: StreamAgentOptions = {
        wc: eng.wc,
        agentId: ownerId,
        prompt: workerPrompt(state.goal, group.map((t) => t.task)),
        runId: eng.runId,
        stepId: ownerId,
        permissionMode: state.actingMode,
        effort,
        resume: false,
        abort: eng.abort
      }
      const { text, sessionId } = await runWithHandoffs(
        eng,
        base,
        consultFor(ownerId, state.goal, state.actingMode)
      )
```
(Everything after — `if (sessionId) await updateAgent(...)`, setting `out`, statuses — is unchanged.)

- [ ] **Step 6: Run the handoff tests**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "peer handoffs (worker site)"`
Expected: PASS — worker consult / off / cap / peer-terminal all green.

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npm run test`
Expected: PASS — existing tests green (every existing test has `h.settings.maxHandoffs === 0` → `consultFor` returns null → single un-augmented call).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): handoff consult runtime + worker site (executeNode)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: REVIEW site — handoffs in `runStructured` (managers + orchestrator)

**Files:**
- Modify: `src/main/engine/nodes.ts` (`runStructured` gains an optional `consult`; `reviewStep` + `integrationReviewStep` pass it)
- Test: `src/main/engine/nodes.test.ts`

**Interfaces:**
- Consumes: `runWithHandoffs` + `consultFor` (Task 6).
- Produces: review agents (manager `domainReview`, orchestrator `integrationReview`) can consult peers; `plan`/`assign`/`reflect`/`replan` are unaffected (they pass no consult).

- [ ] **Step 1: Write the failing test (a manager consults during review)**

Add to `src/main/engine/nodes.test.ts`:
```ts
describe('orchestrator node graph — peer handoffs (review site)', () => {
  it('a manager consults a peer during domain review, then returns its verdict', async () => {
    // two-tier: o -> m -> w1 ; m may consult w2 via a handoff edge.
    h.children = { o: ['m'], m: ['w1'], w1: [], w2: [] }
    h.edges = [{ source: 'm', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d"}]}\n```' }
        if (p.includes('You route planned tasks'))
          return { text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","effort":"high","reason":"r"}]}\n```' }
        if (p.includes('You have been assigned')) return { text: 'did t1', sessionId: 's-w1' }
        if (p.includes('responded to your request')) {
          order.push('m-resume')
          return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        }
        if (p.includes('Judge each task')) {
          order.push('m-review')
          return { text: '```handoff\n{"to":"W2","ask":"is this compliant?"}\n```' }
        }
        if (p.includes('asked for your help')) {
          order.push('w2-consult')
          return { text: 'Yes, compliant.' }
        }
        if (p.includes('final INTEGRATION review'))
          return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('Reflect on your REVIEW work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }
      const e = eng(runAgent)
      ;(e as { emit: (ev: unknown) => void }).emit = (ev) => events.push(ev)
      const store = fakeStore()
      const out = await runGraph(
        buildOrchestratorGraph(e),
        seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
        store,
        makeIO(e.abort.signal, store)
      )
      expect(out.status).toBe('completed')
      expect(order).toEqual(['m-review', 'w2-consult', 'm-resume']) // consult mid-review, then verdict
      expect(out.tasks.t1.status).toBe('passed') // verdict still parsed after the consult
      const handoffs = (events as { type: string; askerId: string; peerId: string }[]).filter(
        (ev) => ev.type === 'handoff'
      )
      expect(handoffs).toEqual([{ runId: 'run1', type: 'handoff', askerId: 'm', peerId: 'w2', ask: 'is this compliant?' }])
    } finally {
      h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "peer handoffs (review site)"`
Expected: FAIL — the manager's handoff block isn't a valid verdict JSON, so `runStructured` retries/throws; no `w2-consult`.

- [ ] **Step 3: Add `consult` to `runStructured` (`src/main/engine/nodes.ts`)**

Change the signature and the per-attempt agent call (consult only on attempt 0; the JSON-retry runs bare):
```ts
async function runStructured<T>(
  eng: Eng,
  agentId: string,
  basePrompt: string,
  validate: (v: unknown) => v is T,
  perm: { permissionMode: PermissionMode; disallowedTools?: string[] },
  consult: Consult | null = null
): Promise<T> {
  let lastText = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (eng.abort.signal.aborted) throw new Error('cancelled')
    const prompt = attempt === 0 ? basePrompt : basePrompt + STRICT_REMINDER
    const base: StreamAgentOptions = {
      wc: eng.wc,
      agentId,
      prompt,
      runId: eng.runId,
      stepId: agentId,
      permissionMode: perm.permissionMode,
      disallowedTools: perm.disallowedTools,
      abort: eng.abort
    }
    const { text } = attempt === 0 ? await runWithHandoffs(eng, base, consult) : await eng.runAgent(base)
    lastText = text
    const parsed = parseJsonBlock(text)
    if (parsed && validate(parsed)) return parsed
  }
  throw new Error(`${getAgent(agentId).name} did not return valid JSON. Last output:\n${lastText.slice(0, 400)}`)
}
```

- [ ] **Step 4: Pass `consult` from the review steps**

In `reviewStep`, add the consult as the 6th arg to `runStructured` (the 4th param `orchestratorId` is the reviewer id):
```ts
  const parsed = await runStructured(
    eng,
    orchestratorId,
    reviewPrompt(goal, items),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: actingMode, disallowedTools: EDIT_TOOLS },
    consultFor(orchestratorId, goal, actingMode)
  )
```
In `integrationReviewStep`, likewise:
```ts
  const parsed = await runStructured(
    eng,
    orchestratorId,
    integrationReviewPrompt(goal, plan, items),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: actingMode, disallowedTools: EDIT_TOOLS },
    consultFor(orchestratorId, goal, actingMode)
  )
```
(`planStep`, `assignStep`, `reflectStep`, `replanStep` keep calling `runStructured` with five args → `consult` defaults to `null` → unaffected.)

- [ ] **Step 5: Run the review-handoff test + full suite + typecheck**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "peer handoffs (review site)"`
Expected: PASS.
Run: `npm run test`
Expected: PASS — full suite green (review consults only fire when `maxHandoffs>0` AND the reviewer has handoff peers).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): handoffs at the review site (managers + orchestrator via runStructured)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Renderer store — handle the `handoff` event

**Files:**
- Modify: `src/renderer/store.ts` (RunState interface, `emptyRun`, `applyOrchestration`)

**Interfaces:**
- Consumes: the `handoff` `OrchestrationEvent` (Task 1).
- Produces: `run.handoffs: { askerId; peerId; ask }[]` (consumed by Task 10 RunView).

- [ ] **Step 1: Add `handoffs` to the store RunState + empty state**

In `src/renderer/store.ts`, in the `RunState` interface (after `replans: …`):
```ts
  handoffs: { askerId: string; peerId: string; ask: string }[]
```
In `emptyRun` (after `replans: [],`):
```ts
  handoffs: [],
```

- [ ] **Step 2: Handle the `handoff` event in `applyOrchestration`**

In the `switch (e.type)` block, after the `replan` case:
```ts
        case 'handoff':
          run.handoffs = [...run.handoffs, { askerId: e.askerId, peerId: e.peerId, ask: e.ask }]
          return { run }
```

- [ ] **Step 3: Verify (typecheck + build)**

Run: `npm run typecheck`
Expected: PASS (the `handoff` event narrows; `e.askerId`/`e.peerId`/`e.ask` are typed).
Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store.ts
git commit -m "$(cat <<'EOF'
feat(workflow): store reduces the handoff event

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Canvas — draw/distinguish handoff edges (select + convert)

**Files:**
- Modify: `src/renderer/canvas/OrgChart.tsx`, `src/renderer/styles.css`

**Interfaces:**
- Consumes: `GraphEdge.kind` (Task 1); `setEdges` (existing).

- [ ] **Step 1: Render handoff edges + include `kind` in the signature (`OrgChart.tsx`)**

Update `toEdges` so a handoff edge is dashed/distinct and reporting edges are unchanged:
```ts
function toEdges(graph: ProjectGraph): Edge[] {
  return graph.edges.map((e) => {
    if (e.kind === 'handoff') {
      return { id: e.id, source: e.source, target: e.target, animated: false, className: 'edge-handoff' }
    }
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.order == null,
      label: e.order != null ? String(e.order) : undefined,
      className: e.order != null ? 'edge-ordered' : undefined
    }
  })
}
```
Update `edgeSig` to re-render on a kind change:
```ts
  const edgeSig = useMemo(
    () => graph.edges.map((e) => `${e.id}:${e.order ?? ''}:${e.kind ?? ''}`).join('|'),
    [graph.edges]
  )
```

- [ ] **Step 2: Add edge selection + a convert toolbar (`OrgChart.tsx`)**

Add a `selectedEdgeId` state and update `onEdgeClick` to select (when not in Order mode); clear on pane click; render a `<Panel>` with the convert button. Insert after the `orderMode` state:
```ts
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  const onEdgeClick = useCallback<EdgeMouseHandler<Edge>>(
    (_, edge) => {
      if (orderMode) {
        if (orchIds.has(edge.source)) void persistEdges(applyOrderClick(graph.edges, edge.id))
        return
      }
      setSelectedEdgeId(edge.id)
    },
    [orderMode, orchIds, graph.edges, persistEdges]
  )

  const selectedEdge = graph.edges.find((e) => e.id === selectedEdgeId) ?? null
  const convertSelected = useCallback(() => {
    if (!selectedEdge) return
    const nextKind = selectedEdge.kind === 'handoff' ? 'report' : 'handoff'
    void persistEdges(
      graph.edges.map((e) => (e.id === selectedEdge.id ? { ...e, kind: nextKind, order: undefined } : e))
    )
  }, [selectedEdge, graph.edges, persistEdges])
```
(Note the existing `onEdgeClick` block is replaced by the one above.) Add `setSelectedEdgeId(null)` to the `onPaneClick` handler:
```ts
      onPaneClick={() => {
        select(null)
        setSelectedEdgeId(null)
      }}
```
Add a Panel (next to the existing Order panel) that shows the convert button only when an edge is selected and not in Order mode:
```tsx
      {selectedEdge && !orderMode && (
        <Panel position="top-left">
          <button className="btn" onClick={convertSelected}>
            {selectedEdge.kind === 'handoff' ? 'Make reporting' : 'Make handoff'}
          </button>
        </Panel>
      )}
```

- [ ] **Step 3: Style handoff edges (`styles.css`)**

After the existing `.edge-ordered` rule (or near the other React Flow edge styles), add:
```css
.react-flow__edge.edge-handoff .react-flow__edge-path {
  stroke: #d6a44c;
  stroke-dasharray: 6 4;
}
```

- [ ] **Step 4: Verify (typecheck + build)**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/OrgChart.tsx src/renderer/styles.css
git commit -m "$(cat <<'EOF'
feat(workflow): canvas — select an edge and convert report<->handoff (dashed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Surface handoffs — RunView line + History section

**Files:**
- Modify: `src/renderer/run/RunView.tsx`, `src/renderer/run/HistoryView.tsx`, `src/renderer/styles.css`

**Interfaces:**
- Consumes: `run.handoffs` (Task 8), `record.handoffs` (Task 4).

- [ ] **Step 1: Add the live handoff line to `RunView.tsx`**

In `src/renderer/run/RunView.tsx`, inside `<div className="run-tree">`, after the `run.replans.map(...)` banner block (added in Phase 2), add:
```tsx
        {run.handoffs.map((hnd, i) => (
          <div key={i} className="run-handoff" title={hnd.ask}>
            ↪ Handoff: {nameOf(hnd.askerId)} → {nameOf(hnd.peerId)}: {hnd.ask}
          </div>
        ))}
```
(`nameOf` already exists in this component.)

- [ ] **Step 2: Add the History section to `HistoryView.tsx`**

In `src/renderer/run/HistoryView.tsx`, in `RunDetail`, after the Re-plans section (added in Phase 2) and before the Agents section, add:
```tsx
      {(record.handoffs ?? []).length > 0 && (
        <div className="hist-section">
          <h4>Handoffs ({record.handoffs!.length})</h4>
          <ul>
            {record.handoffs!.map((hnd, i) => (
              <li key={i}>
                <b>{nameOf(hnd.askerId)} → {nameOf(hnd.peerId)}</b>: {hnd.ask}
              </li>
            ))}
          </ul>
        </div>
      )}
```
(`nameOf` in `RunDetail` resolves via `record.steps` and falls back to the id — a consult-only peer may not be a step, so the id is the fallback.)

- [ ] **Step 3: Style the handoff line (`styles.css`)**

After the `.run-replan` rule (added in Phase 2), add:
```css
.run-handoff {
  padding: 6px 12px;
  font-size: 11px;
  color: #d6a44c;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
```

- [ ] **Step 4: Verify (typecheck + build)**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/run/RunView.tsx src/renderer/run/HistoryView.tsx src/renderer/styles.css
git commit -m "$(cat <<'EOF'
feat(workflow): surface handoffs — Run view line + History section

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Settings — `maxHandoffs` field + final verification

**Files:**
- Modify: `src/renderer/SettingsModal.tsx`

**Interfaces:**
- Consumes: `ProjectSettings.maxHandoffs` (Task 1) via `updateSettings`.

- [ ] **Step 1: Add the numeric field to `SettingsModal.tsx`**

In `src/renderer/SettingsModal.tsx`, after the `maxReplans` field (added in Phase 2) and before the `autoSyncTeam` field, add:
```tsx
        <div className="field">
          <label>Max peer handoffs per step (0 = off)</label>
          <input
            type="number"
            min={0}
            max={3}
            value={s.maxHandoffs}
            onChange={(e) =>
              void update({ maxHandoffs: Math.max(0, Math.min(3, Number(e.target.value) || 0)) })
            }
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            When you draw a handoff edge (select an edge → Make handoff), an agent may consult that
            connected teammate mid-step and continue with their answer. The reporting tree is unaffected.
          </div>
        </div>
```

- [ ] **Step 2: Verify (typecheck + build)**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Final full verification**

Run: `npm run test`
Expected: PASS — full suite green (≈205 tests: +9 handoff parse, +2 ordering-ignore, +1 run-state, +1 project-store, +4 worker-handoff, +1 review-handoff).
Run: `npm run typecheck && npm run build`
Expected: PASS — both clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/SettingsModal.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): Settings — Max peer handoffs per step (0 = off)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## After all tasks

Use **superpowers:requesting-code-review** on the whole branch, then **superpowers:finishing-a-development-branch** to merge `feat/workflow-handoffs` into `main` (`--no-ff`). Update memory (`ai-manager-workflow-graph`, `ai-manager-status-roadmap`, `ai-manager-two-tier-review`, `MEMORY.md`) + `docs/roadmap-checklist.md`: **Phase 3 (edge types + handoff runtime) SHIPPED**, the workflow-graph arc complete except the **two-tier-review v2 escalation** follow-on (reuses the `replan` node from the review exit). **live smoke pending** (eyeball: draw a handoff edge dev→research, set `maxHandoffs≥1`, run a goal where the worker needs help — confirm the `↪ Handoff` line appears, the peer runs with the ask, and the worker's output reflects the answer; `maxHandoffs=0` or no handoff edge = unchanged).

## Self-Review

**Spec coverage:**
- `GraphEdge.kind`, `maxHandoffs`, `handoff` event, `RunState`/`RunRecord.handoffs` → Task 1. ✓
- Pure `parseHandoff` (block extraction, id/name resolution, verdict-not-handoff, last-wins) → Task 2. ✓
- Tree ignores handoff edges (`deriveOrderDeps`/`deriveStages`) → Task 3; (`childrenOf`/`parentOf`) → Task 5. ✓
- `handoffPeersOf` → Task 5. ✓
- `toRunRecord` projects handoffs → Task 4. ✓
- Consult runtime (`runWithHandoffs`, `consultFor`, prompts, peer-terminal, cap, off, session hygiene) + worker site → Task 6. ✓
- Review site (managers + orchestrator via `runStructured`; plan/assign/reflect/replan unaffected) → Task 7. ✓
- Surfacing (store reducer, RunView line, History section) → Tasks 8, 10. ✓
- Canvas select+convert + dashed render → Task 9. ✓
- `maxHandoffs` setting → Tasks 1, 11. ✓
- Byte-for-byte off-control → Task 6 (explicit test) + Tasks 3/5 (suite green). ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code; every test step shows assertions. ✓

**Type consistency:** `parseHandoff(text, peers) → {peerId, ask}|null` (Task 2) matches its use in `runWithHandoffs` (Task 6). `Consult` shape `{peers, max, asker, goal, actingMode}` and `consultFor(agentId, goal, actingMode)` are defined in Task 6 and reused in Task 7. `handoffPeersOf` (Task 5) is consumed by `consultFor` (Task 6) and the nodes.test mock (Task 6 Step 1). The `handoff` event `{type:'handoff', askerId, peerId, ask}` is identical in Task 1 (type), Task 6 (emit), Task 8 (reducer), and the tests. `run.handoffs`/`record.handoffs` element `{askerId, peerId, ask}` is consistent across Tasks 1, 4, 6, 8, 10. ✓
