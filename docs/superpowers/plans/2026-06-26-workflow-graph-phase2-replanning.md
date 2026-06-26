# Workflow-Graph Phase 2 — Goal-Locked Mid-Run Re-Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the orchestrator pause between Phase-1 ordered stages and rewrite the not-yet-run plan based on what came back (e.g. research → re-plan the build), with the goal immutable and the whole feature dormant by default.

**Architecture:** `executeNode` keeps its wave loop but, when enabled, pauses at an ordered-stage boundary and routes to a new goal-locked `replan` node; the orchestrator judges (read-only, conservative) and either rewrites the pending tasks (`goto:'route'`) or declines (`goto:'execute'`). Sequencing still rides Phase-1 `deriveOrderDeps` + the existing `dependsOn` waves. Pure logic (`deriveStages`, `pendingStageBoundary`, `mergeReplan`) lives in `src/shared/` and carries the real test coverage.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React 19, zustand, Vitest. Main builds CJS; pure shared modules are node/DOM-free.

## Global Constraints

- **Byte-for-byte when off:** `maxReplans === 0` (the default) → `executeNode` never pauses, `replanNode` makes no agent call, run output + history identical to today. Pin this with an explicit test.
- **Goal is immutable:** no node writes `state.goal`; `replanNode`'s patch never includes `goal`; `replanPrompt` never asks for one.
- **Pure shared modules stay node/DOM-free** (`src/shared/*.ts`) — unit-tested in plain Node.
- **Test files are excluded from `tsc`** (`exclude: ["src/**/*.test.ts"]`) — adding required `RunState` fields won't break test fixtures at typecheck, but `seedRunState` MUST set them.
- **Commands:** tests `npm run test` (vitest run); types `npm run typecheck` (node + web); build `npm run build`.
- **Renderer house precedent:** renderer files (`store.ts`, `*.tsx`, `styles.css`) are verified by `npm run typecheck` + `npm run build`, not unit tests.
- **Commit message footer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Branch:** `feat/workflow-replanning` (already created; the spec is committed there).

---

### Task 1: Data model + settings default + seed counters

**Files:**
- Modify: `src/shared/types.ts` (ProjectSettings, DEFAULT_SETTINGS, TaskState, RunState, RunRecord, RunPhase, OrchestrationEvent)
- Modify: `src/main/engine/nodes.ts:63-88` (`seedRunState`)
- Test: `src/main/engine/nodes.test.ts` (one seed assertion)

**Interfaces:**
- Produces: `ProjectSettings.maxReplans: number` (default `0`); `TaskState.stage?: number`; `RunState.replanAttempts: number`, `RunState.replanStageCursor: number`, `RunState.replans?: { attempt: number; reason: string }[]`; `RunRecord.replans?: { attempt: number; reason: string }[]`; `RunPhase` adds `'replanning'`; `OrchestrationEvent` adds `{ runId: string; type: 'replan'; attempt: number; reason: string; tasks: RunTask[] }`.

- [ ] **Step 1: Write the failing seed test**

Add to `src/main/engine/nodes.test.ts` (e.g. just after the existing `describe('maxEffort', …)` block):

```ts
describe('seedRunState', () => {
  it('seeds the re-plan counters at zero', () => {
    const s = seedRunState({ runId: 'r', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' })
    expect(s.replanAttempts).toBe(0)
    expect(s.replanStageCursor).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "seeds the re-plan counters"`
Expected: FAIL — `expected undefined to be 0`.

- [ ] **Step 3: Add the type changes in `src/shared/types.ts`**

In `ProjectSettings` (after `skillInstallThreshold: number`):
```ts
  /** max proactive mid-run re-plans the orchestrator may perform (0 = off) */
  maxReplans: number
```
In `DEFAULT_SETTINGS` (after `skillInstallThreshold: 100000`):
```ts
  maxReplans: 0
```
In `TaskState` (after `dependsOn?: string[]`):
```ts
  /** Phase-1 ordered-stage of this task (0/undefined = unordered); set in routeNode */
  stage?: number
```
In `RunState` (after `repairAttempts: number`):
```ts
  /** proactive re-plans performed this run (bounds the outer loop) */
  replanAttempts: number
  /** highest ordered-stage boundary already offered for re-plan (ask-once) */
  replanStageCursor: number
  /** one entry per performed re-plan, for the Run view + History */
  replans?: { attempt: number; reason: string }[]
```
In `RunRecord` (after `reflections: …`):
```ts
  replans?: { attempt: number; reason: string }[]
```
In `RunPhase` union, add `'replanning'`:
```ts
export type RunPhase =
  | 'planning'
  | 'routing'
  | 'executing'
  | 'reviewing'
  | 'repairing'
  | 'replanning'
  | 'reflecting'
  | 'synthesizing'
  | 'done'
```
In `OrchestrationEvent` union (after the `verdict` member):
```ts
  | { runId: string; type: 'replan'; attempt: number; reason: string; tasks: RunTask[] }
```

- [ ] **Step 4: Set the counters in `seedRunState` (`src/main/engine/nodes.ts`)**

In the object returned by `seedRunState`, after `repairAttempts: 0,`:
```ts
    replanAttempts: 0,
    replanStageCursor: 0,
```

- [ ] **Step 5: Run the seed test + full suite + typecheck**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "seeds the re-plan counters"`
Expected: PASS.
Run: `npm run test`
Expected: PASS — all existing tests still green (no behavior change).
Run: `npm run typecheck`
Expected: PASS (the only full `RunState` builder is `seedRunState`, now updated).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): Phase 2 data model — maxReplans, replan counters, replan event

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `deriveStages` (per-task ordered-stage) + DRY subtree helpers

**Files:**
- Modify: `src/shared/workflow-order.ts` (extract `childMapOf`/`subtreeOf`, add `deriveStages`)
- Test: `src/shared/workflow-order.test.ts`

**Interfaces:**
- Produces: `deriveStages(edges, orchestratorId, tasks) => Record<string, number>` — every task id → its top-level team's `order` (0 = unordered/unowned).
- Consumes (Task 5): `routeNode` calls it to stamp `tasks[id].stage`.

- [ ] **Step 1: Write the failing tests**

Add to `src/shared/workflow-order.test.ts`:

```ts
import { deriveStages } from './workflow-order'

describe('deriveStages', () => {
  it('assigns each task its top-level team order (flat teams)', () => {
    const edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'w2', order: 2 }
    ]
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 't2', ownerId: 'w2' }
    ]
    expect(deriveStages(edges, 'o', tasks)).toEqual({ t1: 1, t2: 2 })
  })

  it('gives every task under a nested ordered team that team’s stage', () => {
    const edges = [
      { source: 'o', target: 'm', order: 1 },
      { source: 'm', target: 'w1' },
      { source: 'm', target: 'w2' }
    ]
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 't2', ownerId: 'w2' }
    ]
    expect(deriveStages(edges, 'o', tasks)).toEqual({ t1: 1, t2: 1 })
  })

  it('assigns stage 0 to unordered teams and unowned tasks', () => {
    const edges = [{ source: 'o', target: 'w1' }] // no order anywhere
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 't2', ownerId: null }
    ]
    expect(deriveStages(edges, 'o', tasks)).toEqual({ t1: 0, t2: 0 })
  })

  it('mixes ordered and unordered teams', () => {
    const edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'w2' } // unordered
    ]
    const tasks = [
      { id: 't1', ownerId: 'w1' },
      { id: 't2', ownerId: 'w2' }
    ]
    expect(deriveStages(edges, 'o', tasks)).toEqual({ t1: 1, t2: 0 })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/shared/workflow-order.test.ts -t deriveStages`
Expected: FAIL — `deriveStages is not a function` / not exported.

- [ ] **Step 3: Extract shared helpers and implement `deriveStages` in `src/shared/workflow-order.ts`**

Add these two module-private helpers near the top of the file (after the header comment, before `deriveOrderDeps`):

```ts
function childMapOf(edges: { source: string; target: string }[]): Map<string, string[]> {
  const children = new Map<string, string[]>()
  for (const e of edges) {
    const list = children.get(e.source) ?? []
    list.push(e.target)
    children.set(e.source, list)
  }
  return children
}

function subtreeOf(children: Map<string, string[]>, root: string): Set<string> {
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
```

In `deriveOrderDeps`, replace the inline child-map build and the inline `subtree` closure with the helpers. The body becomes:

```ts
export function deriveOrderDeps(
  edges: { source: string; target: string; order?: number }[],
  orchestratorId: string,
  tasks: { id: string; ownerId: string | null }[]
): Record<string, string[]> {
  const children = childMapOf(edges)
  const teams = edges
    .filter((e) => e.source === orchestratorId && typeof e.order === 'number')
    .map((e) => ({ root: e.target, order: e.order as number }))
    .sort((a, b) => a.order - b.order)
  if (teams.length === 0) return {}

  const teamTasks = teams.map((t) => {
    const nodes = subtreeOf(children, t.root)
    return tasks.filter((x) => x.ownerId !== null && nodes.has(x.ownerId)).map((x) => x.id)
  })

  const out: Record<string, string[]> = {}
  for (let k = 0; k < teamTasks.length; k++) {
    const earlier = [...new Set(teamTasks.slice(0, k).flat())]
    if (earlier.length === 0) continue
    for (const id of teamTasks[k]) out[id] = earlier
  }
  return out
}
```

Then add `deriveStages` after `deriveOrderDeps`:

```ts
/**
 * Each owned task's ordered-stage = the Phase-1 `order` of its top-level team
 * (the orchestrator's direct-child edge whose subtree contains the owner), or 0
 * when the task's team is unordered or the task is unowned. Used to decide where
 * execution pauses for a re-plan (Phase 2).
 */
export function deriveStages(
  edges: { source: string; target: string; order?: number }[],
  orchestratorId: string,
  tasks: { id: string; ownerId: string | null }[]
): Record<string, number> {
  const children = childMapOf(edges)
  const teams = edges
    .filter((e) => e.source === orchestratorId && typeof e.order === 'number')
    .map((e) => ({ order: e.order as number, nodes: subtreeOf(children, e.target) }))
    .sort((a, b) => a.order - b.order)

  const out: Record<string, number> = {}
  for (const x of tasks) {
    const team = x.ownerId === null ? undefined : teams.find((t) => t.nodes.has(x.ownerId!))
    out[x.id] = team ? team.order : 0
  }
  return out
}
```

- [ ] **Step 4: Run to verify pass (incl. existing `deriveOrderDeps` tests after the refactor)**

Run: `npm run test -- src/shared/workflow-order.test.ts`
Expected: PASS — both the new `deriveStages` tests and all existing `deriveOrderDeps`/`applyOrderClick` tests (proving the helper extraction didn't regress Phase 1).

- [ ] **Step 5: Commit**

```bash
git add src/shared/workflow-order.ts src/shared/workflow-order.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): deriveStages — per-task ordered-stage from canvas order

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `shared/replan.ts` — `pendingStageBoundary` + `mergeReplan`

**Files:**
- Create: `src/shared/replan.ts`
- Test: `src/shared/replan.test.ts`

**Interfaces:**
- Produces:
  - `pendingStageBoundary(tasks, replanStageCursor) => number | null` — the next ordered stage about to start after a lower stage finished, else null.
  - `mergeReplan(plan, tasks, decision) => { plan, tasks }` where `decision: { tasks: RunTask[]; deps?: Record<string, string[]> }`.
- Consumes (Task 6): `executeNode` (pause check), `replanNode` (boundary + merge).

- [ ] **Step 1: Write the failing tests**

Create `src/shared/replan.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { pendingStageBoundary, mergeReplan } from './replan'
import type { RunTask, TaskExecStatus, TaskState } from './types'

function mkTask(
  id: string,
  status: TaskExecStatus,
  stage: number,
  ownerId: string | null = 'w',
  description = id
): TaskState {
  return { task: { id, title: id.toUpperCase(), description }, ownerId, status, attempts: 1, output: `out ${id}`, stage }
}

describe('pendingStageBoundary', () => {
  it('returns null on the first stage (nothing completed yet)', () => {
    const tasks = { t1: mkTask('t1', 'pending', 1), t2: mkTask('t2', 'pending', 2) }
    expect(pendingStageBoundary(tasks, 0)).toBeNull()
  })

  it('returns the next stage when a lower stage has finished', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    expect(pendingStageBoundary(tasks, 0)).toBe(2)
  })

  it('returns null when nothing is pending', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'passed', 2) }
    expect(pendingStageBoundary(tasks, 0)).toBeNull()
  })

  it('returns null when the boundary was already offered (cursor caught up)', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    expect(pendingStageBoundary(tasks, 2)).toBeNull()
  })

  it('returns null for unordered-only work (stage 0)', () => {
    const tasks = { t1: mkTask('t1', 'done', 0), t2: mkTask('t2', 'pending', 0) }
    expect(pendingStageBoundary(tasks, 0)).toBeNull()
  })

  it('ignores unowned tasks', () => {
    const tasks = {
      t1: mkTask('t1', 'done', 1),
      t2: mkTask('t2', 'pending', 2),
      x: mkTask('x', 'pending', 0, null)
    }
    expect(pendingStageBoundary(tasks, 0)).toBe(2)
  })
})

describe('mergeReplan', () => {
  const plan: RunTask[] = [
    { id: 't1', title: 'T1', description: 'research' },
    { id: 't2', title: 'T2', description: 'use postgres' }
  ]

  it('freezes executed tasks and replaces pending ones', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    const decision = { tasks: [{ id: 't2', title: 'T2', description: 'use supabase' }] }
    const out = mergeReplan(plan, tasks, decision)
    expect(out.tasks.t1).toBe(tasks.t1) // frozen, same reference
    expect(out.tasks.t2.status).toBe('pending')
    expect(out.tasks.t2.ownerId).toBeNull()
    expect(out.tasks.t2.attempts).toBe(0)
    expect(out.tasks.t2.task.description).toBe('use supabase')
    expect(out.plan.map((p) => p.id)).toEqual(['t1', 't2'])
  })

  it('adds brand-new pending tasks', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    const decision = {
      tasks: [
        { id: 't2', title: 'T2', description: 'use supabase' },
        { id: 't3', title: 'T3', description: 'add auth' }
      ]
    }
    const out = mergeReplan(plan, tasks, decision)
    expect(Object.keys(out.tasks).sort()).toEqual(['t1', 't2', 't3'])
    expect(out.tasks.t3.status).toBe('pending')
    expect(out.plan.map((p) => p.id)).toEqual(['t1', 't2', 't3'])
  })

  it('drops pending tasks the decision omits', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    const out = mergeReplan(plan, tasks, { tasks: [] })
    expect(Object.keys(out.tasks)).toEqual(['t1'])
    expect(out.plan.map((p) => p.id)).toEqual(['t1'])
  })

  it('carries dependsOn from the decision deps', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    const decision = {
      tasks: [
        { id: 't2', title: 'T2', description: 'use supabase' },
        { id: 't3', title: 'T3', description: 'add auth' }
      ],
      deps: { t3: ['t2'] }
    }
    const out = mergeReplan(plan, tasks, decision)
    expect(out.tasks.t3.dependsOn).toEqual(['t2'])
    expect(out.tasks.t2.dependsOn).toBeUndefined()
  })

  it('never touches a goal (operates only on plan + tasks)', () => {
    // mergeReplan has no goal parameter — this test documents the structural invariant.
    const tasks = { t1: mkTask('t1', 'done', 1) }
    const out = mergeReplan(plan, tasks, { tasks: [] })
    expect(out).not.toHaveProperty('goal')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/shared/replan.test.ts`
Expected: FAIL — cannot find module `./replan`.

- [ ] **Step 3: Implement `src/shared/replan.ts`**

```ts
// Pure re-planning logic (Phase 2). No node/DOM imports — unit-tested in plain Node.
// pendingStageBoundary decides WHERE execution pauses for a re-plan; mergeReplan folds
// the orchestrator's decision into the run (freeze executed, replace pending). Neither
// reads or writes a goal — the goal-locked invariant is structural.

import type { RunTask, TaskExecStatus, TaskState } from './types'

/**
 * The next ordered stage execution is about to start, AFTER a lower stage finished —
 * i.e. a re-plan boundary — or null when there is nothing to pause at: still on the
 * first stage (no completed lower stage), nothing left pending, the boundary was
 * already offered (cursor caught up), or the work is unordered (stage 0). Stages come
 * from deriveStages.
 */
export function pendingStageBoundary(
  tasks: Record<string, { status: TaskExecStatus; stage?: number; ownerId: string | null }>,
  replanStageCursor: number
): number | null {
  const owned = Object.values(tasks).filter((t) => t.ownerId !== null)
  const pending = owned.filter((t) => t.status === 'pending')
  if (pending.length === 0) return null
  const executedStages = owned.filter((t) => t.status !== 'pending').map((t) => t.stage ?? 0)
  const nextStage = Math.min(...pending.map((t) => t.stage ?? 0))
  const maxExecuted = executedStages.length ? Math.max(...executedStages) : 0
  if (nextStage >= 1 && nextStage > replanStageCursor && maxExecuted >= 1 && nextStage > maxExecuted) {
    return nextStage
  }
  return null
}

/**
 * Apply a re-plan decision. Executed tasks (status !== 'pending') are frozen verbatim;
 * ALL pending tasks are dropped and replaced by the decision's revised set (each a fresh
 * pending, un-owned TaskState, optional dependsOn from `deps`). The plan is rebuilt as the
 * frozen tasks (in original plan order) followed by the revised tasks.
 */
export function mergeReplan(
  plan: RunTask[],
  tasks: Record<string, TaskState>,
  decision: { tasks: RunTask[]; deps?: Record<string, string[]> }
): { plan: RunTask[]; tasks: Record<string, TaskState> } {
  const deps = decision.deps ?? {}
  const frozen: Record<string, TaskState> = {}
  for (const [id, t] of Object.entries(tasks)) {
    if (t.status !== 'pending') frozen[id] = t
  }
  const next: Record<string, TaskState> = { ...frozen }
  for (const rt of decision.tasks) {
    next[rt.id] = {
      task: { id: rt.id, title: rt.title, description: rt.description },
      ownerId: null,
      status: 'pending',
      attempts: 0,
      output: '',
      ...(deps[rt.id]?.length ? { dependsOn: deps[rt.id] } : {})
    }
  }
  const frozenInOrder = plan.filter((p) => frozen[p.id]).map((p) => frozen[p.id].task)
  const newTasks = decision.tasks.map((rt) => ({ id: rt.id, title: rt.title, description: rt.description }))
  return { plan: [...frozenInOrder, ...newTasks], tasks: next }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test -- src/shared/replan.test.ts`
Expected: PASS (all `pendingStageBoundary` + `mergeReplan` cases).

- [ ] **Step 5: Commit**

```bash
git add src/shared/replan.ts src/shared/replan.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): pure replan core — pendingStageBoundary + mergeReplan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `toRunRecord` projects `replans` (History)

**Files:**
- Modify: `src/shared/run-state.ts` (`toRunRecord`)
- Test: `src/shared/run-state.test.ts`

**Interfaces:**
- Consumes: `RunState.replans?` (Task 1).
- Produces: `RunRecord.replans?` populated by `toRunRecord` (consumed by Task 8 HistoryView).

- [ ] **Step 1: Write the failing test + update the fixture**

In `src/shared/run-state.test.ts`, update `mkState` to include the new required counters (they're not read by `toRunRecord`, but keep the fixture honest), adding inside the returned object after `reflections: [],`:
```ts
    replanAttempts: 0,
    replanStageCursor: 0,
```
Then add a test in the `describe('toRunRecord', …)` block:
```ts
  it('projects replans when present and omits them when absent', () => {
    expect(toRunRecord(mkState()).replans).toBeUndefined()
    const withReplans = toRunRecord(mkState({ replans: [{ attempt: 1, reason: 'research changed the plan' }] }))
    expect(withReplans.replans).toEqual([{ attempt: 1, reason: 'research changed the plan' }])
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/shared/run-state.test.ts -t "projects replans"`
Expected: FAIL — `withReplans.replans` is `undefined`.

- [ ] **Step 3: Project `replans` in `toRunRecord` (`src/shared/run-state.ts`)**

In the returned object, after `reflections: s.reflections,`:
```ts
    ...(s.replans !== undefined ? { replans: s.replans } : {}),
```

- [ ] **Step 4: Run to verify pass (+ round-trip test still green)**

Run: `npm run test -- src/shared/run-state.test.ts`
Expected: PASS (incl. the existing JSON round-trip test).

- [ ] **Step 5: Commit**

```bash
git add src/shared/run-state.ts src/shared/run-state.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): project run replans into the History RunRecord

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `routeNode` — route only un-owned tasks + stamp `stage`

**Files:**
- Modify: `src/main/engine/nodes.ts:26` (import), `:134-149` (`routeNode`)
- Test: `src/main/engine/nodes.test.ts`

**Interfaces:**
- Consumes: `deriveStages` (Task 2), `TaskState.stage` (Task 1).
- Produces: after routing, every owned task carries `tasks[id].stage`; only un-owned tasks are (re-)routed, so a re-plan pass (Task 6) keeps frozen owners.

- [ ] **Step 1: Write the failing test**

Add to `src/main/engine/nodes.test.ts` inside `describe('orchestrator node graph — end to end', …)`:
```ts
  it('stamps each task with its ordered stage and sequences by canvas order', async () => {
    h.edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'w2', order: 2 }
    ]
    try {
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
      expect(out.tasks.t1.stage).toBe(1)
      expect(out.tasks.t2.stage).toBe(2)
      // Phase-1 ordering still derives the dependency (t2 after t1)
      expect(out.tasks.t2.dependsOn).toContain('t1')
    } finally {
      h.edges = []
    }
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "stamps each task with its ordered stage"`
Expected: FAIL — `out.tasks.t1.stage` is `undefined`.

- [ ] **Step 3: Update the import + `routeNode` in `src/main/engine/nodes.ts`**

Change the workflow-order import (line 26) to also pull in `deriveStages`:
```ts
import { deriveOrderDeps, deriveStages } from '../../shared/workflow-order'
```
Replace `routeNode` (lines 134-149) with:
```ts
async function routeNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }
  // Route only un-owned tasks: the first pass routes everything; a re-plan pass routes
  // just the new/revised tasks, leaving frozen (already-owned) work in place.
  const toRoute = Object.keys(tasks).filter((id) => tasks[id].ownerId === null)
  await routeTasks(eng, tasks, steps, state.orchestratorId, toRoute, true)

  // Top-level edge ordering → task deps + per-task stage (Phase 1 + Phase 2). No-ops when
  // no edge carries an order.
  const owned = Object.values(tasks).map((t) => ({ id: t.task.id, ownerId: t.ownerId }))
  const orderDeps = deriveOrderDeps(getEdges(), state.orchestratorId, owned)
  for (const [taskId, deps] of Object.entries(orderDeps)) {
    const t = tasks[taskId]
    if (!t) continue
    t.dependsOn = [...new Set([...(t.dependsOn ?? []), ...deps])]
  }
  const stages = deriveStages(getEdges(), state.orchestratorId, owned)
  for (const [taskId, stage] of Object.entries(stages)) {
    if (tasks[taskId]) tasks[taskId].stage = stage
  }

  return { patch: { tasks, steps, phase: 'executing' } }
}
```

- [ ] **Step 4: Run the new test + full suite**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "stamps each task with its ordered stage"`
Expected: PASS.
Run: `npm run test`
Expected: PASS — all existing tests green (first-pass routing unchanged: every task is un-owned, so `toRoute` = all tasks as before).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): routeNode stamps task.stage and re-routes only un-owned tasks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The re-plan loop — `executeNode` pause + `replanNode`/`replanStep` + graph wiring

**Files:**
- Modify: `src/main/engine/nodes.ts:27` (import), `:92-116` (`buildOrchestratorGraph`), `:205-273` (`executeNode`), add `replanNode`/`replanStep`/`replanPrompt`
- Test: `src/main/engine/nodes.test.ts`

**Interfaces:**
- Consumes: `pendingStageBoundary`, `mergeReplan` (Task 3); `getSettings().maxReplans`; `task.stage` (Task 5).
- Produces: a `replan` graph node; `executeNode` returns `goto:'replan'` at a boundary; `replanNode` emits the `replan` event and either `goto:'route'` (rewrite) or `goto:'execute'` (decline).

- [ ] **Step 1: Add `maxReplans` to the test's hoisted settings**

In `src/main/engine/nodes.test.ts`, in the `vi.hoisted` `settings` object, add `maxReplans: 0` (after `adaptiveEffort: true`):
```ts
    settings: {
      reviewMode: 'once',
      maxRepairAttempts: 1,
      reflection: true,
      autonomy: 'auto',
      adaptiveEffort: true,
      maxReplans: 0
    },
```

- [ ] **Step 2: Write the failing tests (off / proactive / decline / cap)**

Add a new describe block to `src/main/engine/nodes.test.ts`:

```ts
describe('orchestrator node graph — proactive re-plan', () => {
  // research = w1 (stage 1), build = w2 (stage 2), sequenced by canvas order.
  const orderedEdges = [
    { source: 'o', target: 'w1', order: 1 },
    { source: 'o', target: 'w2', order: 2 }
  ]

  // A fake that assigns t1->w1, t2->w2 on every route, records work order, and runs the
  // given replan decision when the orchestrator is asked to re-plan.
  function fake(order: string[], replan: () => object) {
    const runAgent: AgentRunner = async (opts) => {
      const p = opts.prompt
      if (p.includes('Produce a concise, ordered list'))
        return {
          text: '```json\n{"tasks":[{"id":"t1","title":"Research","description":"research db"},{"id":"t2","title":"Build","description":"use postgres"}]}\n```'
        }
      if (p.includes('You route planned tasks')) {
        const taskIds = [...p.matchAll(/- id: (t\d+) —/g)].map((mm) => mm[1])
        const map: Record<string, string> = { t1: 'w1', t2: 'w2' }
        const assignments = taskIds.map((tid) => ({ taskId: tid, childId: map[tid] ?? 'w1', effort: 'high', reason: 'r' }))
        return { text: '```json\n' + JSON.stringify({ assignments }) + '\n```' }
      }
      if (p.includes('Based ONLY on what the completed work actually revealed')) {
        order.push('replan')
        return { text: '```json\n' + JSON.stringify(replan()) + '\n```' }
      }
      if (p.includes('You have been assigned the following task')) {
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

  it('does not pause or re-plan when maxReplans is 0 (byte-for-byte)', async () => {
    h.edges = orderedEdges
    h.settings.maxReplans = 0
    try {
      const order: string[] = []
      const events: unknown[] = []
      const out = await run(fake(order, () => ({ replan: false })), events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1', 'w2']) // sequenced, but NO replan pause
      expect(out.replanAttempts).toBe(0)
      expect((events as { type: string }[]).some((ev) => ev.type === 'replan')).toBe(false)
    } finally {
      h.edges = []
      h.settings.maxReplans = 0
    }
  })

  it('pauses at the stage boundary and rewrites the not-yet-run plan', async () => {
    h.edges = orderedEdges
    h.settings.maxReplans = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      const replanPrompts: string[] = []
      const runAgent: AgentRunner = async (opts) => {
        if (opts.prompt.includes('Based ONLY on what the completed work actually revealed'))
          replanPrompts.push(opts.prompt)
        return fake(order, () => ({
          replan: true,
          reason: 'research shows supabase is better',
          tasks: [{ id: 't2', title: 'Build', description: 'use supabase', dependsOn: [] }]
        }))(opts)
      }
      const out = await run(runAgent, events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1', 'replan', 'w2']) // research -> re-plan -> build
      expect(replanPrompts[0]).toContain('worked w1') // re-plan saw the research output
      expect(out.tasks.t2.task.description).toBe('use supabase') // build re-planned
      expect(out.replanAttempts).toBe(1)
      expect(out.replans).toEqual([{ attempt: 1, reason: 'research shows supabase is better' }])
      const replanEvents = (events as { type: string; tasks: { id: string }[] }[]).filter((ev) => ev.type === 'replan')
      expect(replanEvents).toHaveLength(1)
      expect(replanEvents[0].tasks.map((t) => t.id)).toEqual(['t1', 't2']) // full new plan
    } finally {
      h.edges = []
      h.settings.maxReplans = 0
    }
  })

  it('declines: asks once, then resumes the original plan unchanged', async () => {
    h.edges = orderedEdges
    h.settings.maxReplans = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      const out = await run(fake(order, () => ({ replan: false, reason: 'plan still holds', tasks: [] })), events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1', 'replan', 'w2']) // paused + asked, then ran the original build
      expect(out.tasks.t2.task.description).toBe('use postgres') // unchanged
      expect(out.replanAttempts).toBe(0)
      expect(out.replans ?? []).toEqual([])
      expect((events as { type: string }[]).some((ev) => ev.type === 'replan')).toBe(false)
    } finally {
      h.edges = []
      h.settings.maxReplans = 0
    }
  })

  it('offers each boundary at most once (does not re-ask after resuming)', async () => {
    h.edges = orderedEdges
    h.settings.maxReplans = 2 // budget for 2, but there is only one boundary
    try {
      const order: string[] = []
      const events: unknown[] = []
      const out = await run(
        fake(order, () => ({
          replan: true,
          reason: 'always re-plan',
          tasks: [{ id: 't2', title: 'Build', description: 'use supabase', dependsOn: [] }]
        })),
        events
      )
      expect(out.status).toBe('completed')
      expect(out.replanAttempts).toBe(1) // NOT 2 — the boundary is offered once (cursor)
      expect(order.filter((o) => o === 'replan')).toHaveLength(1)
    } finally {
      h.edges = []
      h.settings.maxReplans = 0
    }
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "proactive re-plan"`
Expected: FAIL — the proactive/decline/cap tests fail (no pause / no `replan` node); the off-control test may already pass.

- [ ] **Step 4: Add the `replan` node to the graph (`buildOrchestratorGraph`)**

In `src/main/engine/nodes.ts`, update `buildOrchestratorGraph`'s `edges` and `nodes`:
```ts
    edges: {
      plan: 'route',
      route: 'execute',
      execute: 'domainReview',
      replan: 'execute',
      domainReview: 'integrationReview',
      integrationReview: 'reflect',
      repair: 'domainReview',
      reflect: 'synthesize',
      synthesize: END
    },
    nodes: {
      plan: (s, io) => planNode(s, io, eng),
      route: (s, io) => routeNode(s, io, eng),
      execute: (s, io) => executeNode(s, io, eng),
      replan: (s, io) => replanNode(s, io, eng),
      domainReview: (s, io) => domainReviewNode(s, io, eng),
      integrationReview: (s, io) => integrationReviewNode(s, io, eng),
      repair: (s, io) => repairNode(s, io, eng),
      reflect: (s, io) => reflectNode(s, io, eng),
      synthesize: (s, io) => synthNode(s, io, eng)
    }
```

- [ ] **Step 5: Add the pause check to `executeNode`**

In `src/main/engine/nodes.ts`, in `executeNode`'s wave loop, immediately after `if (pending.length === 0) break`, insert:
```ts
    // Phase 2: when enabled, pause at an ordered-stage boundary so the orchestrator can
    // re-plan the not-yet-run work before it runs. When off, this never fires → byte-for-byte.
    const maxReplans = getSettings().maxReplans ?? 0
    if (maxReplans > 0 && state.replanAttempts < maxReplans) {
      const boundary = pendingStageBoundary(tasks, state.replanStageCursor)
      if (boundary != null) {
        return { patch: { tasks, steps, replanStageCursor: boundary, phase: 'replanning' }, goto: 'replan' }
      }
    }
```

- [ ] **Step 6: Add `replanNode`, `replanStep`, and `replanPrompt`**

Add the import for the pure helpers (line 27 area, near the `graph` import):
```ts
import { mergeReplan, pendingStageBoundary } from '../../shared/replan'
```
Add `replanNode` after `repairNode` (and before `reflectNode`):
```ts
// Phase 2 — proactive re-plan: at an ordered-stage boundary the orchestrator may rewrite
// the not-yet-run plan based on what came back. GOAL IS NEVER TOUCHED. No-op when off.
async function replanNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const maxReplans = getSettings().maxReplans ?? 0
  if (maxReplans <= 0 || state.replanAttempts >= maxReplans || eng.abort.signal.aborted) {
    return { goto: 'execute' }
  }
  const boundary = pendingStageBoundary(state.tasks, state.replanStageCursor) ?? state.replanStageCursor
  const owned = ownedTasks(state)
  const executed = owned.filter((t) => t.status !== 'pending')
  const pending = owned.filter((t) => t.status === 'pending')

  let decision: { replan: boolean; reason: string; tasks: RunTask[]; deps: Record<string, string[]> }
  try {
    decision = await replanStep(eng, state.goal, state.orchestratorId, executed, pending)
  } catch {
    return { goto: 'execute', patch: { replanStageCursor: boundary } } // a parse failure = decline
  }
  if (!decision.replan) {
    return { goto: 'execute', patch: { replanStageCursor: boundary } }
  }

  const { plan, tasks } = mergeReplan(state.plan, structuredClone(state.tasks), decision)
  const attempt = state.replanAttempts + 1
  const replans = [...(state.replans ?? []), { attempt, reason: decision.reason }]
  eng.emit({ runId: eng.runId, type: 'replan', attempt, reason: decision.reason, tasks: plan })
  return {
    patch: {
      plan,
      tasks,
      replans,
      replanAttempts: attempt,
      repairAttempts: 0,
      replanStageCursor: boundary,
      phase: 'replanning'
    },
    goto: 'route'
  }
}
```
Extract the shared task+deps parser and refactor `planStep` to use it (pre-flight decision: DRY). Add this helper near the other Claude steps (e.g. just before `planStep`):
```ts
/** Parse a raw task array (from a plan or replan JSON) into RunTask[] + sanitized deps
 *  (dedup, drop self-references and ids that aren't real tasks). idPrefix names auto-ids. */
function parseTasksAndDeps(
  raw: Record<string, unknown>[],
  idPrefix: string
): { tasks: RunTask[]; deps: Record<string, string[]> } {
  const tasks: RunTask[] = raw.map((t, i) => ({
    id: typeof t.id === 'string' && t.id ? t.id : `${idPrefix}${i + 1}`,
    title: String(t.title ?? `Task ${i + 1}`),
    description: String(t.description ?? t.title ?? '')
  }))
  const ids = new Set(tasks.map((t) => t.id))
  const deps: Record<string, string[]> = {}
  raw.forEach((t, i) => {
    const id = tasks[i].id
    const list = Array.isArray(t.dependsOn)
      ? [...new Set(t.dependsOn.map((x) => String(x)))].filter((x) => x !== id && ids.has(x))
      : []
    if (list.length) deps[id] = list
  })
  return { tasks, deps }
}
```
Then replace the body of `planStep` after its `runStructured(...)` call (the inline `raw`→`tasks`/`deps` block) with:
```ts
  const raw = parsed.tasks as Record<string, unknown>[]
  return parseTasksAndDeps(raw, 't')
```
(`planStep`'s existing behavior is unchanged — the auto-id prefix stays `t` — so the existing plan/`dependsOn` tests still pass.)

Add `replanStep` near the other Claude steps (e.g. after `synthesizeStep`):
```ts
async function replanStep(
  eng: Eng,
  goal: string,
  orchestratorId: string,
  executed: TaskState[],
  pending: TaskState[]
): Promise<{ replan: boolean; reason: string; tasks: RunTask[]; deps: Record<string, string[]> }> {
  const parsed = await runStructured(
    eng,
    orchestratorId,
    replanPrompt(goal, executed, pending),
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && 'replan' in v,
    { permissionMode: 'default', disallowedTools: THINK_DISALLOW }
  )
  const p = parsed as { replan?: unknown; reason?: unknown; tasks?: unknown }
  const reason = String(p.reason ?? '')
  if (p.replan !== true) return { replan: false, reason, tasks: [], deps: {} }
  const raw = Array.isArray(p.tasks) ? (p.tasks as Record<string, unknown>[]) : []
  const { tasks, deps } = parseTasksAndDeps(raw, 'r')
  return { replan: true, reason, tasks, deps }
}
```
Add `replanPrompt` near the other prompt builders (e.g. after `synthPrompt`):
```ts
function replanPrompt(goal: string, executed: TaskState[], pending: TaskState[]): string {
  const done = executed
    .map((t) => `- ${t.task.title}: ${t.task.description}\n  result: ${t.output.replace(/\s+/g, ' ').slice(0, 1200)}`)
    .join('\n')
  const remaining = pending.map((t) => `- id: ${t.task.id} — ${t.task.title}: ${t.task.description}`).join('\n')
  return `You are the lead for this project. The GOAL below is FIXED and must NOT change — never modify, reinterpret, or expand it.

GOAL (immutable):
${goal}

An earlier stage of the plan has finished. Here is the COMPLETED work and what it produced:
${done || '(nothing completed yet)'}

Here is the REMAINING, not-yet-started plan:
${remaining || '(nothing remaining)'}

Based ONLY on what the completed work actually revealed, decide whether the remaining plan should change — for example its findings contradict an assumption the plan was built on, point to a materially better approach, or surface something the goal needs that the plan is missing. Re-plan ONLY if you are confident it will materially improve the outcome toward the goal; otherwise keep the plan as-is.

Rules:
- The completed work is DONE — never recreate or redo it. Its changes are already on the filesystem and the remaining tasks can build on them.
- You may add, remove, revise, or split the REMAINING tasks only.
- Do NOT change the goal.
- You may READ files to inform the decision, but make no changes.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "replan": true, "reason": "why, one sentence", "tasks": [ { "id": "t2", "title": "short title", "description": "what to do", "dependsOn": [] } ] }
\`\`\`
Set "replan" to false (and "tasks" to []) to keep the remaining plan unchanged.`
}
```

- [ ] **Step 7: Run the re-plan tests**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "proactive re-plan"`
Expected: PASS — off / proactive / decline / cap all green.

- [ ] **Step 8: Run the full suite + typecheck**

Run: `npm run test`
Expected: PASS — all existing tests green (other tests have `h.settings.maxReplans === 0`, so no pause).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): goal-locked mid-run re-plan node + executeNode stage-boundary pause

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Renderer store — handle the `replan` event

**Files:**
- Modify: `src/renderer/store.ts` (RunState interface, `emptyRun`, `applyOrchestration`)

**Interfaces:**
- Consumes: the `replan` `OrchestrationEvent` (Task 1).
- Produces: `run.replans: { attempt: number; reason: string }[]` on the store (consumed by Task 8 RunView).

- [ ] **Step 1: Add `replans` to the store RunState + empty state**

In `src/renderer/store.ts`, in the `RunState` interface (after `reviewAttempt: number`):
```ts
  replans: { attempt: number; reason: string }[]
```
In `emptyRun` (after `reviewAttempt: 0,`):
```ts
  replans: [],
```

- [ ] **Step 2: Handle the `replan` event in `applyOrchestration`**

In the `switch (e.type)` block, add a case (e.g. after the `verdict` case):
```ts
        case 'replan':
          run.plan = e.tasks
          run.replans = [...run.replans, { attempt: e.attempt, reason: e.reason }]
          return { run }
```

- [ ] **Step 3: Verify (renderer house precedent: typecheck + build)**

Run: `npm run typecheck`
Expected: PASS (the `replan` event narrows correctly; `e.tasks`/`e.attempt`/`e.reason` are typed).
Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store.ts
git commit -m "$(cat <<'EOF'
feat(workflow): store reduces the replan event (update plan + record notice)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Surfacing — RunView banner + HistoryView section + styling

**Files:**
- Modify: `src/renderer/run/RunView.tsx` (banner in the run-tree)
- Modify: `src/renderer/run/HistoryView.tsx` (Re-plans section in `RunDetail`)
- Modify: `src/renderer/styles.css` (`.run-replan`)

**Interfaces:**
- Consumes: `run.replans` (Task 7), `record.replans` (Task 4).

- [ ] **Step 1: Add the live banner to `RunView.tsx`**

In `src/renderer/run/RunView.tsx`, inside `<div className="run-tree">`, right after the `run.reviewAttempt > 0 && (…)` block (before `{chain.map(…)}`):
```tsx
        {run.replans.map((r) => (
          <div key={r.attempt} className="run-replan" title={r.reason}>
            ⚡ Re-planned (#{r.attempt}): {r.reason}
          </div>
        ))}
```

- [ ] **Step 2: Add the History section to `HistoryView.tsx`**

In `src/renderer/run/HistoryView.tsx`, in `RunDetail`, after the `Plan` section's closing `</div>` (and before the `Agents` section):
```tsx
      {(record.replans ?? []).length > 0 && (
        <div className="hist-section">
          <h4>Re-plans ({record.replans!.length})</h4>
          <ul>
            {record.replans!.map((r) => (
              <li key={r.attempt}>
                <b>#{r.attempt}</b>: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
```

- [ ] **Step 3: Add the banner styling to `styles.css`**

In `src/renderer/styles.css`, after the `.run-attempt { … }` block (around line 881):
```css
.run-replan {
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
feat(workflow): surface re-plans — Run view banner + History section

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Settings UI — `maxReplans` field + final verification

**Files:**
- Modify: `src/renderer/SettingsModal.tsx`

**Interfaces:**
- Consumes: `ProjectSettings.maxReplans` (Task 1) via `updateSettings`.

- [ ] **Step 1: Add the numeric field to `SettingsModal.tsx`**

In `src/renderer/SettingsModal.tsx`, after the `adaptiveEffort` checkbox field (the `<div className="field">` ending at line ~82) and before the `autoSyncTeam` field, add:
```tsx
        <div className="field">
          <label>Max mid-run re-plans (0 = off)</label>
          <input
            type="number"
            min={0}
            max={3}
            value={s.maxReplans}
            onChange={(e) =>
              void update({ maxReplans: Math.max(0, Math.min(3, Number(e.target.value) || 0)) })
            }
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            When you set an execution order on the canvas, the orchestrator may rewrite the
            not-yet-run plan between stages based on what earlier stages found. The goal never changes.
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
Expected: PASS — full suite green (≈190 tests).
Run: `npm run typecheck && npm run build`
Expected: PASS — both clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/SettingsModal.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): Settings — Max mid-run re-plans (0 = off)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## After all tasks

Use **superpowers:requesting-code-review** on the whole branch, then **superpowers:finishing-a-development-branch** to merge `feat/workflow-replanning` into `main` (`--no-ff`, matching the prior five features). Then update the project memory (`ai-manager-workflow-graph`, `ai-manager-status-roadmap`, `docs/roadmap-checklist.md`): Phase 2 SHIPPED, **live smoke pending** (eyeball: with `maxReplans ≥ 1` and an ordered research→build canvas, the run pauses after research, the `⚡ Re-planned` banner shows with a reason, the build runs on the revised plan; with `maxReplans = 0` nothing changes).

## Self-Review

**Spec coverage:**
- Control flow (pause → replan → route/execute) → Tasks 5, 6. ✓
- `deriveStages` → Task 2. ✓
- `pendingStageBoundary` + `mergeReplan` → Task 3. ✓
- `replanNode`/`replanStep`/`replanPrompt` (read-only, conservative, declines, parse-fail = decline) → Task 6. ✓
- Data model (settings/TaskState/RunState/RunRecord/RunPhase/OrchestrationEvent) → Task 1. ✓
- Surfacing (event reducer, RunView banner, HistoryView section, `toRunRecord`) → Tasks 4, 7, 8. ✓
- Settings (`maxReplans`, default 0) → Tasks 1, 9. ✓
- Byte-for-byte off-control → Task 6 (explicit test) + Task 5 (full suite green). ✓
- Goal immutability → structural (Task 3 `mergeReplan` has no goal; Task 6 patch excludes goal). ✓
- Termination (cursor ask-once + cap) → Task 3 (`pendingStageBoundary` cursor test) + Task 6 (cap test). ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code; every test step shows the assertions. ✓

**Type consistency:** `deriveStages(edges, orchestratorId, tasks)` (Task 2) matches its call in `routeNode` (Task 5). `pendingStageBoundary(tasks, cursor)` / `mergeReplan(plan, tasks, decision)` (Task 3) match calls in `executeNode`/`replanNode` (Task 6). `replanStep` returns `{ replan, reason, tasks, deps }` and feeds `mergeReplan`'s `{ tasks, deps }` shape (Task 6 ↔ Task 3). The `replan` event shape `{ type:'replan', attempt, reason, tasks }` is identical in Task 1 (type), Task 6 (emit), Task 7 (reducer). `RunState.replans`/`RunRecord.replans` element `{ attempt, reason }` is consistent across Tasks 1, 4, 6, 7, 8. ✓
