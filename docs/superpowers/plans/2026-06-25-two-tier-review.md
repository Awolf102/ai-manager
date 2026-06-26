# Two-Tier Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make domain managers review/test/repair + reflect on their own subtree (depth) while the orchestrator does one integration pass against the plan+goal (breadth) — with flat (no-manager) teams behaving byte-for-byte as today.

**Architecture:** Keep the existing state-graph in `src/main/engine/nodes.ts`; split `reviewNode` into `domainReview` (per-immediate-manager) + `integrationReview` (orchestrator, skipped when no managers), re-point `repair → domainReview`, bound the loop with a new `RunState.repairAttempts`, and make `reflectNode` reflect for reviewers too. Add small topology helpers (`parentOf`, `hasManagers`, `reviewerIdsOf`). The agent-execution seam (`Eng.runAgent`) is unchanged, so the whole pipeline stays deterministically testable via `nodes.test.ts`.

**Tech Stack:** TypeScript, the in-house graph runtime (`graph.ts`), vitest. No new dependencies.

## Global Constraints

- **No new `ProjectSettings`.** Reuse `reviewMode`/`maxRepairAttempts`/`reflection`/`autonomy`/`adaptiveEffort`.
- **Backward compatibility:** a team with **no manager nodes** must behave byte-for-byte as today — one orchestrator review pass, worker-only reflection, no integration pass. The second tier activates only when `hasManagers(state)`.
- **Managers review with acting mode but do not edit** — the domain review step passes `permissionMode: state.actingMode` with `disallowedTools: EDIT_TOOLS` (exactly how the orchestrator review works today).
- **Loop bound:** the combined domain↔integration↔repair loop is bounded by `state.repairAttempts < maxAttempts` (where `maxAttempts = maxAttemptsFor(settings)`), NOT by `reviews.length`.
- **Canned-agent prompt markers must stay unique.** The test routes by substring: domain review = `"Judge each task"`; integration review must use `"final INTEGRATION review"` + `"Assess each task"` (must NOT contain `"Judge each task"`); worker reflect = `"Reflect on the work"`; QA reflect must use `"Reflect on your REVIEW work"` (must NOT contain `"Reflect on the work"`).
- **Test runner:** `npx vitest run <file>` for one file; `npm test` for all; `npm run typecheck` + `npm run build` for the no-unit-test layers.
- **Commits:** every commit message ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Branch:** all work lands on `feat/two-tier-review` (already created; the design spec is committed there).

---

### Task 1: Foundation — `RunState.repairAttempts` + `parentOf`

The additive state field (loop counter) and the inverse-tree helper. No behavior change; all existing tests stay green.

**Files:**
- Modify: `src/shared/types.ts` (add `repairAttempts` to `RunState`)
- Modify: `src/main/engine/nodes.ts` (`seedRunState` sets `repairAttempts: 0`)
- Modify: `src/main/engine/project-store.ts` (add `parentOf`)
- Test: `src/main/engine/project-store.test.ts` (test `parentOf`)

**Interfaces:**
- Produces: `RunState.repairAttempts: number`
- Produces: `parentOf(nodeId: string): AgentNodeData | null` — the single reporting parent (the source of the edge whose target is `nodeId`), or `null`.

- [ ] **Step 1: Add the field to `RunState` in `src/shared/types.ts`**

In the `RunState` interface, add the field right after `reflections` (before `final`):

```ts
  reflections: { nodeId: string; win: string; loss: string; lessons: string[] }[]
  repairAttempts: number
  final: string
```

- [ ] **Step 2: Default it in `seedRunState` (`src/main/engine/nodes.ts`)**

In the object returned by `seedRunState`, add `repairAttempts: 0` after `reflections: []`:

```ts
    reviews: [],
    reflections: [],
    repairAttempts: 0,
    final: ''
```

- [ ] **Step 3: Write the failing test for `parentOf`** — add to `src/main/engine/project-store.test.ts`

Add this test (a fresh temp project with an orchestrator → manager → worker chain). Match the file's existing helper style for creating a temp project + agents + edges; if the file already has a `withTempProject`/`makeProject` helper and `createAgent`/`setEdges`, reuse them. The assertions:

```ts
import { parentOf } from './project-store'

it('parentOf returns the single reporting parent, or null for a root', async () => {
  // build: orchestrator o -> manager m -> worker w  (create agents, then setEdges)
  // (use the same project/agent/edge setup the other tests in this file use)
  const graph = /* the project graph after creating o, m, w and edges o->m, m->w */
  const o = graph.nodes.find((n) => n.kind === 'orchestrator')!
  const m = graph.nodes.find((n) => n.kind === 'manager')!
  const w = graph.nodes.find((n) => n.kind === 'worker')!
  expect(parentOf(w.id)?.id).toBe(m.id)
  expect(parentOf(m.id)?.id).toBe(o.id)
  expect(parentOf(o.id)).toBeNull()
})
```

(If creating the chain via the existing helpers is awkward, build it with `createAgent` for o/m/w then `setEdges([{id:'e1',source:o.id,target:m.id},{id:'e2',source:m.id,target:w.id}])` — mirror how `applySpawnedTeam`/edge tests in this file construct edges.)

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/main/engine/project-store.test.ts`
Expected: FAIL — `parentOf` is not exported / not a function.

- [ ] **Step 5: Implement `parentOf` in `src/main/engine/project-store.ts`**

Directly below `childrenOf` (after line ~305), add:

```ts
/** The single node this one reports to (source of the edge targeting it), or null for a root. */
export function parentOf(nodeId: string): AgentNodeData | null {
  const { graph } = requireCurrent()
  const edge = graph.edges.find((e) => e.target === nodeId)
  if (!edge) return null
  return graph.nodes.find((n) => n.id === edge.source) ?? null
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/main/engine/project-store.test.ts && npm test`
Expected: PASS — `parentOf` test green; full suite still 123 (the `repairAttempts` field is additive and unused so far).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/shared/types.ts src/main/engine/nodes.ts src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(two-tier): RunState.repairAttempts + parentOf helper"
```

---

### Task 2: Topology helpers — `hasManagers` + `reviewerIdsOf`

Two exported pure-ish helpers the review/reflect nodes will use. No node uses them yet, so no behavior change.

**Files:**
- Modify: `src/main/engine/nodes.ts` (add the helpers)
- Test: `src/main/engine/nodes.test.ts` (add `parentOf` to the project-store mock; unit-test the helpers)

**Interfaces:**
- Consumes: `parentOf` (Task 1).
- Produces: `hasManagers(state: RunState): boolean` — any owned task whose immediate parent is a `manager`.
- Produces: `reviewerIdsOf(state: RunState): string[]` — unique manager-parents of owned tasks, plus `state.orchestratorId` when `hasManagers(state)`. Empty for flat teams.

- [ ] **Step 1: Add `parentOf` to the project-store mock in `src/main/engine/nodes.test.ts`**

In the `vi.mock('./project-store', …)` object (currently has `getAgent`, `childrenOf`, …), add a `parentOf` that derives the parent from the hoisted `h.children` map:

```ts
  childrenOf: (id: string) => (h.children[id] ?? []).map((c) => h.agents[c]),
  parentOf: (id: string) => {
    const pid = Object.keys(h.children).find((p) => (h.children[p] ?? []).includes(id))
    return pid ? h.agents[pid] : null
  },
```

- [ ] **Step 2: Write the failing helper tests** — add to `src/main/engine/nodes.test.ts`

Import the two new helpers alongside the others (from `./nodes`): add `hasManagers` and `reviewerIdsOf` to the existing import list. Then add this describe block. It builds a minimal `RunState` and flips `h.children` to a two-tier shape.

```ts
describe('hasManagers / reviewerIdsOf', () => {
  const stateWith = (tasks: Record<string, { ownerId: string | null }>): RunState => ({
    ...seedRunState({ runId: 'r', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
    tasks: Object.fromEntries(
      Object.entries(tasks).map(([id, t]) => [
        id,
        { task: { id, title: id, description: '' }, ownerId: t.ownerId, status: 'done', attempts: 1, output: '' }
      ])
    ) as RunState['tasks']
  })

  it('flat team: no managers, no reviewers', () => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    const s = stateWith({ t1: { ownerId: 'w1' }, t2: { ownerId: 'w2' } })
    expect(hasManagers(s)).toBe(false)
    expect(reviewerIdsOf(s).sort()).toEqual([])
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
  })

  it('two-tier: the manager parent + the orchestrator are reviewers', () => {
    h.children = { o: ['m'], m: ['w1', 'w2'], w1: [], w2: [] }
    const s = stateWith({ t1: { ownerId: 'w1' }, t2: { ownerId: 'w2' } })
    expect(hasManagers(s)).toBe(true)
    expect(reviewerIdsOf(s).sort()).toEqual(['m', 'o'])
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: FAIL — `hasManagers`/`reviewerIdsOf` not exported.

- [ ] **Step 4: Implement the helpers in `src/main/engine/nodes.ts`**

Add `parentOf` to the project-store import (the `import { ... } from './project-store'` block — add `parentOf`). Then add, next to `ownedTasks` (after line ~560):

```ts
/** True when at least one owned task's immediate parent is a manager (the team is two-tier). */
export function hasManagers(state: RunState): boolean {
  return ownedTasks(state).some((t) => parentOf(t.ownerId!)?.kind === 'manager')
}

/**
 * The nodes that performed a review this run, for reflection: the manager parents of owned
 * tasks, plus the orchestrator when the integration pass ran (i.e. when managers exist).
 * Empty for flat teams — so flat teams keep worker-only reflection.
 */
export function reviewerIdsOf(state: RunState): string[] {
  const ids = new Set<string>()
  for (const t of ownedTasks(state)) {
    const p = parentOf(t.ownerId!)
    if (p && p.kind === 'manager') ids.add(p.id)
  }
  if (hasManagers(state)) ids.add(state.orchestratorId)
  return [...ids]
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/engine/nodes.test.ts && npm test`
Expected: PASS — full suite green (helpers unused by nodes so existing behavior is unchanged).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(two-tier): hasManagers + reviewerIdsOf topology helpers"
```

---

### Task 3: Two-tier review engine — split review, re-point repair, integration pass

The core surgery: `reviewNode` → `domainReviewNode` (group `done` tasks by immediate manager; each reviews its group in parallel) + `integrationReviewNode` (orchestrator broad pass, skipped when no managers); `repair` increments `repairAttempts` and returns to `domainReview`; the loop is bounded by `repairAttempts`. Reflection is still worker-only in this task (Task 4 adds reviewer reflection).

**Files:**
- Modify: `src/main/engine/nodes.ts` (graph wiring; `domainReviewNode`; `integrationReviewNode`; `reviewerOf`; `integrationReviewStep`; `integrationReviewPrompt`; `repairNode` edits)
- Modify: `src/main/engine/nodes.test.ts` (extend `cannedAgent` with the integration branch; add two-tier review tests; keep the flat tests green)

**Interfaces:**
- Consumes: `hasManagers` (Task 2), `parentOf` (Task 1), `RunState.repairAttempts` (Task 1), existing `reviewStep`, `ownedTasks`, `workerIdsOf`, `markWorkersDone`, `setStatus`, `maxAttemptsFor`, `mapCapped`.
- Produces: graph nodes `domainReview`/`integrationReview`; `reviewerOf(ownerId, orchestratorId)`; `integrationReviewStep`; `integrationReviewPrompt`. `repairNode` now `goto: 'domainReview'` and increments `repairAttempts`.

- [ ] **Step 1: Update the graph wiring in `buildOrchestratorGraph` (`src/main/engine/nodes.ts`)**

Replace the `review` edge/node with the two new ones:

```ts
    edges: {
      plan: 'route',
      route: 'execute',
      execute: 'domainReview',
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
      domainReview: (s, io) => domainReviewNode(s, io, eng),
      integrationReview: (s, io) => integrationReviewNode(s, io, eng),
      repair: (s, io) => repairNode(s, io, eng),
      reflect: (s, io) => reflectNode(s, io, eng),
      synthesize: (s, io) => synthNode(s, io, eng)
    }
```

- [ ] **Step 2: Replace `reviewNode` with `domainReviewNode` + add `integrationReviewNode` + `reviewerOf` (`src/main/engine/nodes.ts`)**

Delete the entire current `reviewNode` function (lines ~259–309) and put these in its place:

```ts
/** The immediate manager that reviews a task (the owner's parent), or the orchestrator. */
function reviewerOf(ownerId: string, orchestratorId: string): string {
  return parentOf(ownerId)?.id ?? orchestratorId
}

// Tier 1 — depth: each leaf task's immediate manager reviews its own group (orchestrator for flat workers).
async function domainReviewNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const settings = getSettings()
  const maxAttempts = maxAttemptsFor(settings)
  const doReview = maxAttempts > 0 || settings.reflection
  const owned = ownedTasks(state)
  if (!doReview || owned.length === 0) return { goto: 'reflect', patch: { phase: 'reflecting' } }

  const toReview = owned.filter((t) => t.status === 'done')
  if (toReview.length === 0) return { goto: 'integrationReview', patch: { phase: 'reviewing' } }

  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }

  // group tasks by their immediate manager (the reviewer)
  const groups = new Map<string, TaskState[]>()
  for (const t of toReview) {
    const rid = reviewerOf(t.ownerId!, state.orchestratorId)
    const list = groups.get(rid) ?? []
    list.push(t)
    groups.set(rid, list)
  }

  const recorded: TaskVerdict[] = []
  await mapCapped([...groups.entries()], MAX_PARALLEL, async ([reviewerId, group]) => {
    if (eng.abort.signal.aborted) return
    setStatus(eng, steps, reviewerId, 'reviewing', group.map((t) => t.task.title))
    const items = group.map((t) => ({
      taskId: t.task.id,
      title: t.task.title,
      asked: t.task.description,
      ownerName: getAgent(t.ownerId!).name,
      output: t.output
    }))
    let verdicts: { taskId: string; verdict: 'pass' | 'fail'; feedback: string }[]
    try {
      verdicts = await reviewStep(eng, state.goal, state.actingMode, reviewerId, items)
    } catch {
      return // a reviewer failure leaves its group unreviewed (status stays 'done'); surfaced upward
    }
    for (const v of verdicts) {
      const t = tasks[v.taskId]
      if (!t) continue
      t.verdict = { verdict: v.verdict, feedback: v.feedback }
      t.status = v.verdict === 'pass' ? 'passed' : 'failed'
      recorded.push({ taskId: v.taskId, nodeId: t.ownerId ?? null, verdict: v.verdict, feedback: v.feedback })
    }
    if (!eng.abort.signal.aborted) setStatus(eng, steps, reviewerId, 'done')
  })

  const reviewNo = state.reviews.length + 1
  const reviews = [...state.reviews, { attempt: reviewNo, tasks: recorded }]
  eng.emit({ runId: eng.runId, type: 'verdict', attempt: reviewNo, tasks: recorded })

  const failed = Object.values(tasks).filter((t) => t.ownerId && t.status === 'failed')
  if (failed.length > 0 && state.repairAttempts < maxAttempts && !eng.abort.signal.aborted) {
    return { patch: { tasks, steps, reviews, phase: 'repairing' }, goto: 'repair' }
  }
  return { patch: { tasks, steps, reviews, phase: 'reviewing' }, goto: 'integrationReview' }
}

// Tier 2 — breadth: the orchestrator checks the assembled result vs the plan+goal. Skipped for flat teams.
async function integrationReviewNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const settings = getSettings()
  const maxAttempts = maxAttemptsFor(settings)
  const doReview = maxAttempts > 0 || settings.reflection
  if (!doReview || !hasManagers(state) || ownedTasks(state).length === 0 || eng.abort.signal.aborted) {
    return { goto: 'reflect', patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } }
  }

  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }
  setStatus(eng, steps, state.orchestratorId, 'reviewing')

  const items = ownedTasks(state).map((t) => ({
    taskId: t.task.id,
    title: t.task.title,
    asked: t.task.description,
    ownerName: getAgent(t.ownerId!).name,
    output: t.output
  }))
  let verdicts: { taskId: string; verdict: 'pass' | 'fail'; feedback: string }[]
  try {
    verdicts = await integrationReviewStep(eng, state.goal, state.actingMode, state.orchestratorId, state.plan, items)
  } catch {
    return { goto: 'reflect', patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } }
  }

  const recorded: TaskVerdict[] = []
  for (const v of verdicts) {
    const t = tasks[v.taskId]
    if (!t) continue
    t.verdict = { verdict: v.verdict, feedback: v.feedback }
    t.status = v.verdict === 'pass' ? 'passed' : 'failed'
    recorded.push({ taskId: v.taskId, nodeId: t.ownerId ?? null, verdict: v.verdict, feedback: v.feedback })
  }
  const reviewNo = state.reviews.length + 1
  const reviews = [...state.reviews, { attempt: reviewNo, tasks: recorded }]
  eng.emit({ runId: eng.runId, type: 'verdict', attempt: reviewNo, tasks: recorded })

  const failed = Object.values(tasks).filter((t) => t.ownerId && t.status === 'failed')
  if (failed.length > 0 && state.repairAttempts < maxAttempts && !eng.abort.signal.aborted) {
    return { patch: { tasks, steps, reviews, phase: 'repairing' }, goto: 'repair' }
  }
  for (const wid of workerIdsOf(tasks)) if (!eng.abort.signal.aborted) setStatus(eng, steps, wid, 'done')
  return { patch: { tasks, steps, reviews, phase: 'reflecting' }, goto: 'reflect' }
}
```

- [ ] **Step 3: Update `repairNode` (`src/main/engine/nodes.ts`)**

Change the final return of `repairNode` (currently `goto: 'review'`) to increment the counter and return to domain review:

```ts
  await io.checkpoint({ ...state, tasks: structuredClone(tasks), steps: { ...steps }, phase: 'repairing' })
  return { patch: { tasks, steps, phase: 'reviewing', repairAttempts: state.repairAttempts + 1 }, goto: 'domainReview' }
```

- [ ] **Step 4: Add `integrationReviewStep` + `integrationReviewPrompt` (`src/main/engine/nodes.ts`)**

Add `integrationReviewStep` next to `reviewStep` (after line ~472):

```ts
async function integrationReviewStep(
  eng: Eng,
  goal: string,
  actingMode: PermissionMode,
  orchestratorId: string,
  plan: RunTask[],
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[]
): Promise<{ taskId: string; verdict: 'pass' | 'fail'; feedback: string }[]> {
  const parsed = await runStructured(
    eng,
    orchestratorId,
    integrationReviewPrompt(goal, plan, items),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: actingMode, disallowedTools: EDIT_TOOLS }
  )
  const byId = new Map<string, { verdict: 'pass' | 'fail'; feedback: string }>()
  for (const t of parsed.tasks as Record<string, unknown>[]) {
    const taskId = String(t.taskId ?? '')
    const verdict = String(t.verdict ?? 'pass').toLowerCase() === 'fail' ? 'fail' : 'pass'
    byId.set(taskId, { verdict, feedback: String(t.feedback ?? '') })
  }
  return items.map((it) => ({
    taskId: it.taskId,
    verdict: byId.get(it.taskId)?.verdict ?? 'pass',
    feedback: byId.get(it.taskId)?.feedback ?? ''
  }))
}
```

Add `integrationReviewPrompt` next to `reviewPrompt` (after line ~810). **Note the markers:** it uses `"final INTEGRATION review"` and `"Assess each task"` — NOT `"Judge each task"`.

```ts
function integrationReviewPrompt(
  goal: string,
  plan: RunTask[],
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[]
): string {
  const planList = plan.map((t, i) => `${i + 1}. ${t.title} — ${t.description}`).join('\n')
  const list = items
    .map(
      (it) =>
        `- taskId: ${it.taskId}\n  title: ${it.title}\n  by: ${it.ownerName}\n  result: ${it.output.replace(/\s+/g, ' ').slice(0, 1200)}`
    )
    .join('\n')
  return `You are doing the final INTEGRATION review of your team's assembled work. Your managers already reviewed each piece for domain correctness — your job is the BROADER check: do the pieces fit together, is anything missing or off-goal, does the integrated whole actually satisfy the plan and the goal? You may READ files and RUN the integrated app to verify — you just must not edit files.

GOAL:
${goal}

THE PLAN:
${planList}

THE ASSEMBLED RESULT (per task):
${list}

Assess each task for whether it fits the integrated whole and serves the goal. Mark "pass" or "fail"; for any "fail" give specific, actionable feedback the worker can use. If the plan itself is missing something needed for the goal, note it in the feedback of the most related task (it will be surfaced; you cannot re-plan here).

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "tasks": [ { "taskId": "t1", "verdict": "pass", "feedback": "required when fail" } ] }
\`\`\``
}
```

- [ ] **Step 5: Extend the canned agent with the integration branch (`src/main/engine/nodes.test.ts`)**

In `cannedAgent()`, add an integration branch **before** the existing `if (p.includes('Judge each task'))` branch (order is safe since the substrings are disjoint, but keep them separate):

```ts
    if (p.includes('final INTEGRATION review')) {
      rec('integration')
      return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```' }
    }
    if (p.includes('Judge each task')) {
```

- [ ] **Step 6: Write the two-tier review tests** — add to `src/main/engine/nodes.test.ts`

Add a new describe block. The first test asserts the manager does the domain review and the orchestrator does the integration pass with a repair loop in between; the flat regression confirms no integration pass.

```ts
describe('two-tier review', () => {
  afterEach(() => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
  })

  it('manager domain-reviews its subtree, orchestrator integration-reviews, with a repair loop', async () => {
    h.children = { o: ['m'], m: ['w1', 'w2'], w1: [], w2: [] }
    const { runAgent, calls } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    // domain review ran AS THE MANAGER (m), not the orchestrator
    expect(calls.some((c) => c.kind.startsWith('review') && c.agentId === 'm')).toBe(true)
    expect(calls.some((c) => c.kind.startsWith('review') && c.agentId === 'o')).toBe(false)
    // integration review ran as the orchestrator
    expect(calls.some((c) => c.kind === 'integration' && c.agentId === 'o')).toBe(true)
    // t2 failed domain review, was repaired by its worker, then passed
    expect(out.tasks.t1.status).toBe('passed')
    expect(out.tasks.t2.status).toBe('passed')
    expect(out.tasks.t2.attempts).toBe(2)
    expect(out.repairAttempts).toBe(1)
    // reviews = 2 domain rounds + 1 integration
    expect(out.reviews.length).toBe(3)
  })

  it('flat team: no integration pass (byte-for-byte today)', async () => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    const { runAgent, calls } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    expect(calls.some((c) => c.kind === 'integration')).toBe(false) // no managers → no integration pass
    expect(out.reviews.length).toBe(2) // two domain rounds only
    expect(out.tasks.t2.attempts).toBe(2)
  })
})
```

- [ ] **Step 7: Run it to verify the new tests pass and nothing regressed**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS — the two new tests pass; the existing flat end-to-end tests are unchanged; the existing "manager layer" test (`o → m → w1,w2`) still passes (`steps.m.status === 'done'` holds because `domainReviewNode` sets each reviewer `done` after its group, and the extended canned agent answers the integration pass).

- [ ] **Step 8: Full suite + typecheck + commit**

Run: `npm test && npm run typecheck`
Expected: all green (123 + 2 new = 125).
```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(two-tier): split review into domain (per-manager) + integration (orchestrator)"
```

---

### Task 4: Hierarchy-aware reflection — reviewers reflect on QA work

`reflectNode` keeps worker reflection and adds reviewer reflection (managers + the orchestrator's integration pass) via a QA-focused prompt. Flat teams are unchanged (`reviewerIdsOf` is empty).

**Files:**
- Modify: `src/main/engine/nodes.ts` (generalize `reflectStep` to take a prompt builder; add `qaReflectPrompt`; reviewer reflection in `reflectNode`)
- Modify: `src/main/engine/nodes.test.ts` (extend `cannedAgent` with the QA-reflect branch; assert reviewers reflect; flat unchanged)

**Interfaces:**
- Consumes: `reviewerIdsOf` (Task 2), `reviewerOf` (Task 3), existing `reflectStep`/`applyReflection`/`workerIdsOf`/`ownedTasks`/`mapCapped`/`setStatus`.
- Produces: `qaReflectPrompt`; `reflectStep` gains an optional `buildPrompt` parameter (defaults to `reflectPrompt`, so existing callers are unchanged).

- [ ] **Step 1: Generalize `reflectStep` to accept a prompt builder (`src/main/engine/nodes.ts`)**

Change the `reflectStep` signature to take an optional builder and use it. Replace its header + the `reflectPrompt(...)` call:

```ts
async function reflectStep(
  eng: Eng,
  goal: string,
  workerId: string,
  items: { title: string; output: string; review: string }[],
  buildPrompt: (goal: string, items: { title: string; output: string; review: string }[]) => string = reflectPrompt
): Promise<{ win: string; loss: string; lessons: string[] } | null> {
  if (eng.abort.signal.aborted) return null
  try {
    const parsed = await runStructured(
      eng,
      workerId,
      buildPrompt(goal, items),
      (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
      { permissionMode: 'default', disallowedTools: THINK_DISALLOW }
    )
```
(The rest of `reflectStep` is unchanged.)

- [ ] **Step 2: Add `qaReflectPrompt` (`src/main/engine/nodes.ts`)**

Add it next to `reflectPrompt` (after line ~852). **Marker:** starts with `"Reflect on your REVIEW work"` (must not contain `"Reflect on the work"`).

```ts
function qaReflectPrompt(goal: string, items: { title: string; output: string; review: string }[]): string {
  const list = items
    .map(
      (it) =>
        `- task: ${it.title}\n  result: ${it.output.replace(/\s+/g, ' ').slice(0, 800)}\n  your verdict: ${it.review}`
    )
    .join('\n')
  return `Reflect on your REVIEW work this run so your future reviews get sharper. Do NOT change any files — just reflect.

OVERALL GOAL: ${goal}

THE WORK YOU REVIEWED, AND YOUR VERDICT:
${list}

Capture, honestly and concisely:
- win: the most useful thing your review caught or did well.
- loss: the main thing you missed or could check better next time (empty string if none).
- lessons: 1-4 short, reusable QA rules for your future self — what to TEST or VERIFY in your domain, common failure modes to watch for, what "good" looks like. For EACH lesson set a "scope":
    - "portable": general QA/testing/review wisdom that helps on ANY project.
    - "project": a fact specific to THIS codebase or goal (what to check here, where things live).
  When unsure, use "project".

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "win": "...", "loss": "...", "lessons": [ { "text": "...", "scope": "portable" } ] }
\`\`\``
}
```

- [ ] **Step 3: Add reviewer reflection to `reflectNode` (`src/main/engine/nodes.ts`)**

In `reflectNode`, after the existing worker-reflection `mapCapped(workerIdsOf(...), …)` block and before the `return`, add a second pass for reviewers:

```ts
  // reviewers (managers + the orchestrator's integration pass) reflect on their QA work
  await mapCapped(reviewerIdsOf(state), MAX_PARALLEL, async (rid) => {
    if (eng.abort.signal.aborted) return
    const reviewed =
      rid === state.orchestratorId
        ? owned // the orchestrator integration-reviewed the whole
        : owned.filter((t) => reviewerOf(t.ownerId!, state.orchestratorId) === rid)
    if (reviewed.length === 0) return
    setStatus(eng, steps, rid, 'reflecting', reviewed.map((t) => t.task.title))
    const items = reviewed.map((t) => ({
      title: t.task.title,
      output: t.output,
      review: t.verdict
        ? `${t.verdict.verdict.toUpperCase()}${t.verdict.feedback ? ' — ' + t.verdict.feedback : ''}`
        : 'n/a'
    }))
    const refl = await reflectStep(eng, state.goal, rid, items, qaReflectPrompt)
    if (!refl) return
    await applyReflection(rid, { ...refl, label: state.goal.slice(0, 80) })
    reflections.push({ nodeId: rid, ...refl })
    eng.emit({ runId: eng.runId, type: 'reflection', nodeId: rid, ...refl })
    setStatus(eng, steps, rid, 'done')
  })
```

- [ ] **Step 4: Extend the canned agent with the QA-reflect branch (`src/main/engine/nodes.test.ts`)**

In `cannedAgent()`, add a QA-reflect branch **before** the existing `if (p.includes('Reflect on the work'))` branch:

```ts
    if (p.includes('Reflect on your REVIEW work')) {
      rec('qaReflect')
      return { text: '```json\n{"win":"caught a bug","loss":"","lessons":[{"text":"run the app","scope":"portable"}]}\n```' }
    }
    if (p.includes('Reflect on the work')) {
```

- [ ] **Step 5: Write the reviewer-reflection tests** — add to the `two-tier review` describe block in `src/main/engine/nodes.test.ts`

```ts
  it('managers and the orchestrator reflect on their QA work; workers reflect on implementation', async () => {
    h.children = { o: ['m'], m: ['w1', 'w2'], w1: [], w2: [] }
    const { runAgent, calls } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    // workers + manager + orchestrator all reflected
    expect(out.reflections.map((r) => r.nodeId).sort()).toEqual(['m', 'o', 'w1', 'w2'])
    // the manager + orchestrator used the QA reflect prompt; workers used the implementation reflect
    expect(calls.filter((c) => c.kind === 'qaReflect').map((c) => c.agentId).sort()).toEqual(['m', 'o'])
    expect(calls.filter((c) => c.kind === 'reflect').map((c) => c.agentId).sort()).toEqual(['w1', 'w2'])
  })

  it('flat team: only workers reflect (no QA reflection)', async () => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    const { runAgent, calls } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    expect(out.reflections.map((r) => r.nodeId).sort()).toEqual(['w1', 'w2'])
    expect(calls.some((c) => c.kind === 'qaReflect')).toBe(false)
  })
```

- [ ] **Step 6: Run it to verify the new tests pass and nothing regressed**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS — reviewers reflect in the two-tier case; flat teams unchanged; the existing first-describe flat test still asserts `reflections == ['w1','w2']` (no managers → no QA reflect).

- [ ] **Step 7: Full suite + typecheck + commit**

Run: `npm test && npm run typecheck`
Expected: all green (125 + 2 new = 127).
```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(two-tier): reviewers reflect on QA work (compounding-QA loop)"
```

---

### Task 5: Encourage managers — role template + spawn-bias

Document the manager's new review/test/reflect duties (new managers) and soften `spawnTeamPrompt`'s flat bias so Build-team proposes a domain manager for a cluster of related roles. Prompt/template only.

**Files:**
- Modify: `src/main/engine/project-store.ts` (`roleTemplate` manager section)
- Modify: `src/shared/team-spawn.ts` (soften the flat-bias rule)
- Test: `src/shared/team-spawn.test.ts` (marker assertion)

**Interfaces:**
- No code interfaces; string content only.

- [ ] **Step 1: Write the failing marker test for `spawnTeamPrompt`** — add to `src/shared/team-spawn.test.ts`

```ts
it('encourages a domain manager for a cluster of related roles (not only "several workers")', () => {
  const p = spawnTeamPrompt('build a big app', 'Boss', [])
  expect(p).toMatch(/cluster of (several )?related roles/i)
  expect(p).toMatch(/review|QA|test/i) // the rationale mentions dedicated review/QA
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/shared/team-spawn.test.ts`
Expected: FAIL — the current flat-bias line doesn't mention clusters/review.

- [ ] **Step 3: Soften the flat-bias rule in `src/shared/team-spawn.ts`**

Replace the current managers rule line (line ~23):

```ts
- Use managers only when the work genuinely splits into areas that each need several workers; otherwise keep it flat (workers reporting directly to you).
```
with:
```ts
- Create a domain manager when a distinct area of work (a cluster of several related roles or subsystems) would benefit from dedicated review, testing, and accumulated QA expertise — not only when there are many workers. A manager owns reviewing and testing its area, so group several related roles under one QA-capable manager. A manager with a single worker is pure overhead — keep that flat (the worker reports directly to you).
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/shared/team-spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the review/test/reflect duties to the manager role template (`src/main/engine/project-store.ts`)**

In `roleTemplate`, in the `kind === 'manager'` branch, replace the `## Responsibilities` and `## Constraints` so the manager owns review/test/reflect. Change the responsibilities block to add the review/test bullets and update the last line, and the constraints' last line:

Replace:
```ts
- Collect the workers' output and pass it up to the orchestrator for review.

## How you work
- Match tasks to roles literally — don't hand a database task to a UI specialist.
- Keep the orchestrator informed about what was assigned, to whom, and what is blocked.

## Constraints
- You operate inside this one project folder.
- You route and coordinate; the workers do the heavy implementation.
```
with:
```ts
- **Review and test your team's output in your domain against the goal.** Don't trust a worker's report — run the app/tests and verify it actually works. You own testing, so your workers can focus on building.
- For anything that fails, give specific, actionable feedback and have the worker fix it. Hand well-tested, less-buggy work up to the orchestrator.
- After a run, reflect on what your review caught so your future reviews get sharper.

## How you work
- Match tasks to roles literally — don't hand a database task to a UI specialist.
- Keep the orchestrator informed about what was assigned, to whom, and what is blocked.
- When reviewing, verify behavior in your domain first (run it), then completeness against what was asked.

## Constraints
- You operate inside this one project folder.
- You route, review, and test; the workers do the heavy implementation. Don't edit their files — review and give feedback instead.
```

- [ ] **Step 6: Typecheck + build + full suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green (127 + 1 new = 128). The role-template change is a string constant (build-verified, per the repo's precedent that `roleTemplate` is not unit-tested).

- [ ] **Step 7: Commit**

```bash
git add src/shared/team-spawn.ts src/shared/team-spawn.test.ts src/main/engine/project-store.ts
git commit -m "feat(two-tier): manager role review/test/reflect duties + soften spawn flat-bias"
```

---

## Self-Review

**Spec coverage:**
- Split review into `domainReview` (per immediate manager) + `integrationReview` (orchestrator, skipped when no managers) → Task 3. ✓
- Repair returns to `domainReview`; loop bounded by `repairAttempts` → Task 1 (field) + Task 3 (wiring + gate). ✓
- Managers review with acting mode, no edits → Task 3 (`reviewStep` call passes `actingMode` + `EDIT_TOOLS`, reused for integration). ✓
- Hierarchy-aware reflection (workers + reviewers); QA prompt; `[portable]`/`[project]` scope reused → Task 4 (`reflectStep` reuses `normalizeLessonInput` path; `qaReflectPrompt` carries the scope instruction). ✓
- Helpers `parentOf`/`reviewerIdsOf`/`hasManagers` → Tasks 1 + 2. ✓
- `RunState.repairAttempts` additive field → Task 1. ✓
- Manager role template review/test/reflect; `spawnTeamPrompt` softened → Task 5. ✓
- Backward compat (no managers = today) → Task 3 (integration skipped; domain = orchestrator reviews all) + Task 4 (`reviewerIdsOf` empty) + flat-regression tests in both. ✓
- Tests: two-tier happy path, repair loop (via `attempts`/`repairAttempts`), integration skip, flat regression, reviewer reflection, helper units, prompt markers → Tasks 2–5. ✓ (Integration-failure→repair loop is exercised implicitly by the shared repair loop; the domain repair-loop test covers the `repair → domainReview` path and the `repairAttempts` bound.)
- Deferred (v2 escalation, deep multi-level review, managers editing) → not implemented, matching non-goals. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The only soft spot is Task 1 Step 3's project-graph setup, which defers to "the same helpers the other tests in this file use" — acceptable because it depends on the existing test file's conventions, and concrete `setEdges` fallback is given.

**Type consistency:** `repairAttempts` (Task 1) is read in Task 3's gate and written in Task 3's `repairNode`. `parentOf` (Task 1) is consumed by `hasManagers`/`reviewerIdsOf` (Task 2), `reviewerOf` (Task 3), and `reflectNode` (Task 4). `reviewerOf(ownerId, orchestratorId)` signature is identical in Task 3 (definition + domainReview use) and Task 4 (reflectNode use). `reflectStep`'s new optional `buildPrompt` (Task 4) keeps existing callers valid. Canned-agent markers (`final INTEGRATION review`, `Assess each task`, `Reflect on your REVIEW work`) match the prompts they route to and are disjoint from the existing markers (`Judge each task`, `Reflect on the work`). ✓
