# Two-Tier Review v2 — Escalation Re-Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a reviewer judges a failed task is *mis-scoped* (not just buggy), let the orchestrator re-break-up the failed work — a reactive escalation re-plan at the review exit — reusing Phase 2's re-plan machinery, dormant by default.

**Architecture:** Review steps classify each failure `repair` vs `replan` (gated by `maxReplans>0`). A `replan` flag at a review exit routes to a new `escalate` node that re-breaks-up the not-passed tasks (passed frozen) via a generalized `mergeReplan` + a shared `applyReplanDecision` helper (also used by Phase 2's `replanNode`), then `route → execute → review`. Bounded by the shared `replanAttempts < maxReplans`. Reuses the Phase-2 `replan` event for surfacing — no renderer changes.

**Tech Stack:** TypeScript, Electron (main), Vitest. Pure shared module `src/shared/replan.ts` is node/DOM-free.

## Global Constraints

- **Byte-for-byte when off:** `maxReplans === 0` (default) → review prompts carry NO disposition instruction (`allowReplan=false` → identical prompt), the escalate branch is gated off, the `escalate` node is never entered → run identical to today. Pin with an "off control" test.
- **Goal immutable:** no node writes `state.goal`; `escalatePrompt` marks it locked and never asks for one; the escalate patch excludes `goal`.
- **Unified budget:** escalation shares Phase 2's `maxReplans` setting + `replanAttempts` counter (no new setting/counter). Termination: `replanAttempts < maxReplans`.
- **Reuse, don't duplicate:** generalize `mergeReplan` (optional `replaceIds`, defaults to today's pending behavior so Phase 2 is untouched); a shared `applyReplanDecision` helper serves both `replanNode` and `escalate`; reuse the `replan` event (no store/RunView/History/Settings changes).
- **Escalation re-plans the WHOLE not-passed set** when any failure is `replan`-flagged (passed frozen); `repair`-flagged failures in that exit are subsumed.
- **Commands:** tests `npm run test`; types `npm run typecheck`; build `npm run build`.
- **Commit footer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Branch:** `feat/two-tier-v2-escalation` (already created; spec committed there).

---

### Task 1: Data model — `TaskState.verdict.disposition`

**Files:**
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces: `TaskState.verdict?: { verdict: 'pass' | 'fail'; feedback: string; disposition?: 'repair' | 'replan' }`.

- [ ] **Step 1: Add the disposition field in `src/shared/types.ts`**

Find the `TaskState` interface's `verdict` field (currently `verdict?: { verdict: 'pass' | 'fail'; feedback: string }`) and replace it with:
```ts
  /** review outcome; `disposition` (fail only) = 'repair' (buggy, re-run) | 'replan' (mis-scoped, re-break-up). Default 'repair'. */
  verdict?: { verdict: 'pass' | 'fail'; feedback: string; disposition?: 'repair' | 'replan' }
```

- [ ] **Step 2: Verify (additive type — gated by typecheck + full suite, no behavior change)**

Run: `npm run typecheck`
Expected: PASS (additive optional field).
Run: `npm run test`
Expected: PASS — all existing tests green (no behavior change).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "$(cat <<'EOF'
feat(review): TaskState verdict gains disposition (repair|replan) for v2 escalation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Generalize `mergeReplan` with an optional `replaceIds`

**Files:**
- Modify: `src/shared/replan.ts`
- Test: `src/shared/replan.test.ts`

**Interfaces:**
- Produces: `mergeReplan(plan, tasks, decision, replaceIds?: string[])` — when `replaceIds` is omitted it defaults to the `pending` task ids (today's behavior, untouched); when given, those ids are the replaceable set and everything else is frozen.
- Consumes (Task 3): the `escalate` node passes the **failed** task ids.

- [ ] **Step 1: Write the failing test**

Add to `src/shared/replan.test.ts` (inside the existing `describe('mergeReplan', …)` block — it already has a `plan`, `mkTask`, etc.):
```ts
  it('with explicit replaceIds=failed, freezes passed and replaces only the failed', () => {
    const tasks = { t1: mkTask('t1', 'passed', 1), t2: mkTask('t2', 'failed', 2) }
    const decision = { tasks: [{ id: 't2a', title: 'T2A', description: 'split a' }, { id: 't2b', title: 'T2B', description: 'split b' }] }
    const out = mergeReplan(plan, tasks, decision, ['t2'])
    expect(out.tasks.t1).toBe(tasks.t1) // passed frozen (same reference)
    expect(out.tasks.t2).toBeUndefined() // failed dropped
    expect(out.tasks.t2a.status).toBe('pending')
    expect(out.tasks.t2a.ownerId).toBeNull()
    expect(out.plan.map((p) => p.id)).toEqual(['t1', 't2a', 't2b'])
  })

  it('with replaceIds, carries dependsOn and leaves non-listed tasks frozen even if pending', () => {
    const tasks = { t1: mkTask('t1', 'passed', 1), t2: mkTask('t2', 'failed', 2), t3: mkTask('t3', 'pending', 3) }
    const decision = { tasks: [{ id: 't2a', title: 'T2A', description: 'a' }], deps: { t2a: ['t1'] } }
    const out = mergeReplan(plan, tasks, decision, ['t2']) // only t2 replaced; t3 (pending) NOT in replaceIds → frozen
    expect(out.tasks.t3).toBe(tasks.t3) // pending but not listed → kept
    expect(out.tasks.t2a.dependsOn).toEqual(['t1'])
    expect(out.tasks.t2).toBeUndefined()
  })
```
(`mkTask` in this file builds a `TaskState`; if its signature differs, match the existing helper — the key is statuses `passed`/`failed`/`pending`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/shared/replan.test.ts -t "replaceIds"`
Expected: FAIL — `mergeReplan` ignores the 4th arg (TS at runtime accepts it but the behavior still frees by `pending`), so `out.tasks.t1` is dropped / `t3` replaced — assertions fail.

- [ ] **Step 3: Generalize `mergeReplan` in `src/shared/replan.ts`**

Replace the `mergeReplan` function with:
```ts
/**
 * Apply a re-plan decision. `replaceIds` selects which existing tasks the decision
 * replaces (defaults to all `pending` ids — Phase-2 proactive behavior); every task
 * NOT in that set is frozen verbatim. The replaced tasks are dropped and the decision's
 * revised set is added (each a fresh pending, un-owned TaskState, optional dependsOn from
 * `deps`). The plan is rebuilt as the frozen tasks (in original plan order) then the
 * revised tasks. Never reads or writes a goal — the goal-locked invariant is structural.
 */
export function mergeReplan(
  plan: RunTask[],
  tasks: Record<string, TaskState>,
  decision: { tasks: RunTask[]; deps?: Record<string, string[]> },
  replaceIds?: string[]
): { plan: RunTask[]; tasks: Record<string, TaskState> } {
  const deps = decision.deps ?? {}
  const replace = new Set(
    replaceIds ?? Object.keys(tasks).filter((id) => tasks[id].status === 'pending')
  )
  const frozen: Record<string, TaskState> = {}
  for (const [id, t] of Object.entries(tasks)) {
    if (!replace.has(id)) frozen[id] = t
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

- [ ] **Step 4: Run to verify pass (incl. existing mergeReplan tests — default unchanged)**

Run: `npm run test -- src/shared/replan.test.ts`
Expected: PASS — the new `replaceIds` tests + all existing `mergeReplan` (default = pending) and `pendingStageBoundary` tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/replan.ts src/shared/replan.test.ts
git commit -m "$(cat <<'EOF'
feat(review): mergeReplan accepts optional replaceIds (defaults to pending)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Escalation engine — classify failures, escalate node, shared apply helper

**Files:**
- Modify: `src/main/engine/nodes.ts` (graph wiring; `reviewStep`/`integrationReviewStep` + `reviewPrompt`/`integrationReviewPrompt`; `domainReviewNode`/`integrationReviewNode` exits; refactor `replanNode`; add `applyReplanDecision`, `escalateNode`, `escalateStep`, `escalatePrompt`)
- Test: `src/main/engine/nodes.test.ts`

**Interfaces:**
- Consumes: `mergeReplan(…, replaceIds)` (Task 2), `TaskState.verdict.disposition` (Task 1), `parseTasksAndDeps`/`ownedTasks`/`getSettings`/`runStructured`/`THINK_DISALLOW` (existing in nodes.ts).
- Produces: a `escalate` graph node; review steps return + store `disposition`; both review exits escalate when a failure is `replan`-flagged; `applyReplanDecision(state, eng, decision, replaceIds?, extraPatch?)` shared by `replanNode` + `escalateNode`.

- [ ] **Step 1: Write the failing integration tests**

Add a new describe block to `src/main/engine/nodes.test.ts`:
```ts
describe('orchestrator node graph — v2 escalation (mis-scoped re-plan)', () => {
  // two-tier: o -> m -> w1 ; manager m reviews w1's work.
  function setupTwoTier() {
    h.children = { o: ['m'], m: ['w1'], w1: [], w2: [] }
  }
  function restore() {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    h.settings.maxReplans = 0
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
  // route by parsing child ids from the prompt (matches routePrompt format), like cannedAgent
  function routeJSON(prompt: string): string {
    const childIds = [...prompt.matchAll(/- id: (\S+)\n\s+name:/g)].map((m) => m[1])
    const taskIds = [...prompt.matchAll(/- id: (\w+) —/g)].map((m) => m[1])
    const assignments = taskIds.map((tid) => ({ taskId: tid, childId: childIds[0] ?? null, effort: 'high', reason: 'r' }))
    return '```json\n' + JSON.stringify({ assignments }) + '\n```'
  }

  it('a domain reviewer flags a mis-scoped task → escalate re-breaks it up', async () => {
    setupTwoTier()
    h.settings.maxReplans = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      let escalatePrompt = ''
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"Build it","description":"too broad"}]}\n```' }
        if (p.includes('You route planned tasks')) return { text: routeJSON(p) }
        if (p.includes('You have been assigned')) { order.push(opts.agentId); return { text: `did ${[...p.matchAll(/\d+\. (\w+)/g)].length ? 'task' : ''}`, sessionId: 's' } }
        if (p.includes('MIS-SCOPED')) { escalatePrompt = p; order.push('escalate'); return { text: '```json\n{"reason":"t1 was too broad","tasks":[{"id":"e1","title":"E1","description":"do e1","dependsOn":[]}]}\n```' } }
        if (p.includes('Judge each task')) {
          // fail t1 as mis-scoped on the first review; pass e1 after the re-plan
          return p.includes('taskId: e1')
            ? { text: '```json\n{"tasks":[{"taskId":"e1","verdict":"pass","feedback":""}]}\n```' }
            : { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"fail","feedback":"mis-scoped, split it","disposition":"replan"}]}\n```' }
        }
        if (p.includes('final INTEGRATION review'))
          return { text: '```json\n{"tasks":[{"taskId":"e1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('Reflect on your REVIEW work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }
      const out = await run(runAgent, events)
      expect(out.status).toBe('completed')
      expect(order).toContain('escalate')
      expect(escalatePrompt).toContain('t1') // the failed task was handed to the escalate step
      expect(out.tasks.t1).toBeUndefined() // mis-scoped task replaced
      expect(out.tasks.e1?.status).toBe('passed') // re-broken-up task ran + passed
      expect(out.replanAttempts).toBe(1)
      const replans = (events as { type: string; reason: string }[]).filter((ev) => ev.type === 'replan')
      expect(replans).toHaveLength(1)
      expect(replans[0].reason).toBe('t1 was too broad')
    } finally {
      restore()
    }
  })

  it('off control: maxReplans=0 → no disposition asked, a fail repairs (byte-for-byte)', async () => {
    setupTwoTier()
    h.settings.maxReplans = 0
    try {
      const order: string[] = []
      const events: unknown[] = []
      let reviewPromptText = ''
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d"}]}\n```' }
        if (p.includes('You route planned tasks')) return { text: routeJSON(p) }
        if (p.includes('You have been assigned')) { order.push('work'); return { text: 'did t1', sessionId: 's' } }
        if (p.includes('did not pass review')) { order.push('repair'); return { text: 'fixed t1', sessionId: 's' } }
        if (p.includes('Judge each task')) { reviewPromptText = p; return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"' + (order.includes('repair') ? 'pass' : 'fail') + '","feedback":"x"}]}\n```' } }
        if (p.includes('final INTEGRATION review')) return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('MIS-SCOPED')) { order.push('escalate'); return { text: '```json\n{"reason":"x","tasks":[]}\n```' } }
        if (p.includes('Reflect on your REVIEW work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }
      const out = await run(runAgent, events)
      expect(out.status).toBe('completed')
      expect(reviewPromptText).not.toContain('disposition') // prompt unchanged when off
      expect(order).toContain('repair') // a fail repaired as today
      expect(order).not.toContain('escalate')
      expect((events as { type: string }[]).some((ev) => ev.type === 'replan')).toBe(false)
    } finally {
      restore()
    }
  })

  it('a fail with disposition=repair repairs, does not escalate', async () => {
    setupTwoTier()
    h.settings.maxReplans = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d"}]}\n```' }
        if (p.includes('You route planned tasks')) return { text: routeJSON(p) }
        if (p.includes('You have been assigned')) { order.push('work'); return { text: 'did t1', sessionId: 's' } }
        if (p.includes('did not pass review')) { order.push('repair'); return { text: 'fixed', sessionId: 's' } }
        if (p.includes('Judge each task')) return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"' + (order.includes('repair') ? 'pass' : 'fail') + '","feedback":"x","disposition":"repair"}]}\n```' }
        if (p.includes('final INTEGRATION review')) return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('MIS-SCOPED')) { order.push('escalate'); return { text: '```json\n{"reason":"x","tasks":[]}\n```' } }
        if (p.includes('Reflect')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }
      const out = await run(runAgent, events)
      expect(out.status).toBe('completed')
      expect(order).toContain('repair')
      expect(order).not.toContain('escalate')
      expect(out.replanAttempts).toBe(0)
    } finally {
      restore()
    }
  })
})
```
(These exercise: domain escalate, off-control byte-for-byte, and repair-still-works. The integration-review escalate uses the identical branch in `integrationReviewNode`; the domain test plus the off/repair controls cover the mechanism. A `routeJSON` helper assigns each task to the router's first child so `o→m→w1` routing flows.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "v2 escalation"`
Expected: FAIL — there is no `escalate` node / branch yet; the mis-scoped fail goes to `repair` (or the graph has no `escalate` node → throws).

- [ ] **Step 3: Extract the shared `applyReplanDecision` helper + refactor `replanNode`**

In `src/main/engine/nodes.ts`, add this helper (near `replanNode`):
```ts
/**
 * Apply a re-plan/escalation decision into the run: merge the revised tasks (replacing
 * `replaceIds`, or pending when undefined), bump the shared replanAttempts, reset the
 * repair budget, record + emit the `replan`, and goto route. `extraPatch` lets a caller
 * carry extra state (Phase-2 proactive carries replanStageCursor).
 */
function applyReplanDecision(
  state: RunState,
  eng: Eng,
  decision: { reason: string; tasks: RunTask[]; deps: Record<string, string[]> },
  replaceIds?: string[],
  extraPatch: Partial<RunState> = {}
): NodeResult {
  const { plan, tasks } = mergeReplan(state.plan, structuredClone(state.tasks), decision, replaceIds)
  const attempt = state.replanAttempts + 1
  const replans = [...(state.replans ?? []), { attempt, reason: decision.reason }]
  eng.emit({ runId: eng.runId, type: 'replan', attempt, reason: decision.reason, tasks: plan })
  return {
    patch: { plan, tasks, replans, replanAttempts: attempt, repairAttempts: 0, phase: 'replanning', ...extraPatch },
    goto: 'route'
  }
}
```
Then in `replanNode`, replace its final merge+emit+return block (the part after `if (!decision.replan) …`) with:
```ts
  return applyReplanDecision(state, eng, decision, undefined, { replanStageCursor: boundary })
```
(Passing `replaceIds: undefined` keeps the Phase-2 default = pending → byte-for-byte; the `replanStageCursor` rides in `extraPatch`.)

- [ ] **Step 4: Add `escalateStep` + `escalatePrompt`**

Add near the other Claude steps / prompts in `src/main/engine/nodes.ts`:
```ts
async function escalateStep(
  eng: Eng,
  goal: string,
  orchestratorId: string,
  passed: TaskState[],
  failed: TaskState[]
): Promise<{ reason: string; tasks: RunTask[]; deps: Record<string, string[]> }> {
  const parsed = await runStructured(
    eng,
    orchestratorId,
    escalatePrompt(goal, passed, failed),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: 'default', disallowedTools: THINK_DISALLOW }
  )
  const p = parsed as { reason?: unknown; tasks?: unknown }
  const raw = Array.isArray(p.tasks) ? (p.tasks as Record<string, unknown>[]) : []
  const { tasks, deps } = parseTasksAndDeps(raw, 'e')
  return { reason: String(p.reason ?? 'mis-scoped tasks re-planned'), tasks, deps }
}
```
```ts
function escalatePrompt(goal: string, passed: TaskState[], failed: TaskState[]): string {
  const kept = passed.map((t) => `- ${t.task.title}: ${t.task.description}`).join('\n')
  const broken = failed
    .map((t) => `- id: ${t.task.id} — ${t.task.title}: ${t.task.description}\n  why it failed review: ${(t.verdict?.feedback ?? '').replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n')
  return `You are the lead for this project. The GOAL below is FIXED and must NOT change — never modify, reinterpret, or expand it.

GOAL (immutable):
${goal}

Your team COMPLETED and PASSED this work — keep it, do NOT redo it (its changes are already on the filesystem):
${kept || '(none)'}

These tasks did NOT pass review because they are MIS-SCOPED — the plan broke the work down incorrectly, so simply re-running them will not help:
${broken}

Re-break-up ONLY the mis-scoped work into a corrected set of tasks: split, merge, drop, or add tasks so the failed portion can actually be done. Keep it the smallest set that fixes the breakdown. Do NOT touch the passed work or the goal. You may READ files to inform the breakdown, but make no changes.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "reason": "why the old breakdown was wrong, one sentence", "tasks": [ { "id": "e1", "title": "short title", "description": "what to do", "dependsOn": [] } ] }
\`\`\``
}
```

- [ ] **Step 5: Add the `escalate` node**

Add the node function in `src/main/engine/nodes.ts`:
```ts
// v2 escalation — reactive: a reviewer flagged a failed task as MIS-SCOPED, so the
// orchestrator re-breaks-up the failed work (passed frozen). Reuses the shared apply
// helper + the `replan` surfacing. Bounded by the shared replanAttempts < maxReplans.
async function escalateNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const maxReplans = getSettings().maxReplans ?? 0
  const owned = ownedTasks(state)
  const passed = owned.filter((t) => t.status === 'passed')
  const failed = owned.filter((t) => t.status === 'failed')
  if (maxReplans <= 0 || state.replanAttempts >= maxReplans || failed.length === 0 || eng.abort.signal.aborted) {
    return { patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } } // → reflect (static edge)
  }
  let decision: { reason: string; tasks: RunTask[]; deps: Record<string, string[]> }
  try {
    decision = await escalateStep(eng, state.goal, state.orchestratorId, passed, failed)
  } catch {
    return { patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } } // parse failure = give up
  }
  if (decision.tasks.length === 0) {
    return { patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } }
  }
  return applyReplanDecision(state, eng, decision, failed.map((t) => t.task.id))
}
```

- [ ] **Step 6: Wire the `escalate` node into the graph**

In `buildOrchestratorGraph`, add the edge and node:
```ts
    edges: {
      plan: 'route',
      route: 'execute',
      execute: 'domainReview',
      replan: 'execute',
      escalate: 'reflect',
      domainReview: 'integrationReview',
      integrationReview: 'reflect',
      repair: 'domainReview',
      reflect: 'synthesize',
      synthesize: END
    },
    nodes: {
      // …existing…
      escalate: (s, io) => escalateNode(s, io, eng),
      // …existing…
    }
```

- [ ] **Step 7: Classify failures in `reviewStep` / `integrationReviewStep` (gated prompt + parse)**

In `reviewStep`, compute `allowReplan`, pass it to `reviewPrompt`, parse `disposition`, and return it:
```ts
async function reviewStep(
  eng: Eng,
  goal: string,
  actingMode: PermissionMode,
  orchestratorId: string,
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[]
): Promise<{ taskId: string; verdict: 'pass' | 'fail'; feedback: string; disposition: 'repair' | 'replan' }[]> {
  const allowReplan = (getSettings().maxReplans ?? 0) > 0
  const parsed = await runStructured(
    eng,
    orchestratorId,
    reviewPrompt(goal, items, allowReplan),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: actingMode, disallowedTools: EDIT_TOOLS },
    consultFor(orchestratorId, goal, actingMode)
  )
  const byId = new Map<string, { verdict: 'pass' | 'fail'; feedback: string; disposition: 'repair' | 'replan' }>()
  for (const t of parsed.tasks as Record<string, unknown>[]) {
    const taskId = String(t.taskId ?? '')
    const verdict = String(t.verdict ?? 'pass').toLowerCase() === 'fail' ? 'fail' : 'pass'
    const disposition = String(t.disposition ?? 'repair').toLowerCase() === 'replan' ? 'replan' : 'repair'
    byId.set(taskId, { verdict, feedback: String(t.feedback ?? ''), disposition })
  }
  return items.map((it) => ({
    taskId: it.taskId,
    verdict: byId.get(it.taskId)?.verdict ?? 'pass',
    feedback: byId.get(it.taskId)?.feedback ?? '',
    disposition: byId.get(it.taskId)?.disposition ?? 'repair'
  }))
}
```
Apply the **identical** changes to `integrationReviewStep` (add `allowReplan`, pass it to `integrationReviewPrompt`, parse + return `disposition`).

- [ ] **Step 8: Add the gated disposition instruction to both review prompts**

Change `reviewPrompt` to take `allowReplan` and conditionally add the instruction + schema field:
```ts
function reviewPrompt(
  goal: string,
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[],
  allowReplan = false
): string {
  const list = items
    .map(
      (it) =>
        `- taskId: ${it.taskId}\n  title: ${it.title}\n  asked: ${it.asked}\n  done by: ${it.ownerName}\n  result: ${it.output.replace(/\s+/g, ' ').slice(0, 1200)}`
    )
    .join('\n')
  const dispoLine = allowReplan
    ? `\n\nFor each "fail", also set "disposition": "repair" if the task is correctly scoped but the implementation is buggy or incomplete (re-running it can fix it), or "replan" if the TASK ITSELF is mis-scoped — the plan broke the work down wrong and it should be re-broken-up rather than re-run. Default to "repair" when unsure.`
    : ''
  const schema = allowReplan
    ? `{ "tasks": [ { "taskId": "t1", "verdict": "pass", "feedback": "required when fail", "disposition": "repair or replan (only when fail)" } ] }`
    : `{ "tasks": [ { "taskId": "t1", "verdict": "pass", "feedback": "required when fail" } ] }`
  return `You are reviewing your team's work against the goal. You may READ files and RUN the app/commands to verify (start a server, curl an endpoint, run the tests) — you just must not edit files.

GOAL:
${goal}

Judge each task below: did the result actually accomplish what was asked, in service of the goal? Mark "pass" or "fail". For any "fail", give specific, actionable feedback the worker can use to fix it.

If the work is a web app or anything that serves pages, do NOT trust unit tests or the worker's report alone — run it: start the app, request the entry URL, and confirm it returns 200 AND every asset it references (CSS, JS, images) also returns 200. A common silent failure is assets 404ing from a static-path/route mismatch, which makes the page render as unstyled HTML even though the code is correct. Fail the task if the page does not render fully.${dispoLine}

TASKS TO REVIEW:
${list}

Reply with ONLY this JSON code block (no other text):
\`\`\`json
${schema}
\`\`\``
}
```
Apply the analogous change to `integrationReviewPrompt` (add `allowReplan = false` param; when true, append the same `dispoLine` after its assessment paragraph and swap to the disposition `schema`). Keep its existing "you cannot re-plan here" sentence only when `allowReplan` is false; when true, replace that sentence with: *"If a task is mis-scoped (the plan broke it down wrong), mark it fail with disposition \"replan\" and it will be re-broken-up."* (So the prompt is byte-for-byte when off, and coherent when on.)

- [ ] **Step 9: Store `disposition` on the verdict + add the escalate branch in both review nodes**

In `domainReviewNode`, where it records the verdict (currently `t.verdict = { verdict: v.verdict, feedback: v.feedback }`), include the disposition:
```ts
      t.verdict = { verdict: v.verdict, feedback: v.feedback, disposition: v.disposition }
```
Then replace `domainReviewNode`'s exit (the `failed`/repair/integrationReview block) with:
```ts
  const failed = Object.values(tasks).filter((t) => t.ownerId && t.status === 'failed')
  const maxReplans = getSettings().maxReplans ?? 0
  const misScoped = failed.filter((t) => t.verdict?.disposition === 'replan')
  if (maxReplans > 0 && misScoped.length > 0 && state.replanAttempts < maxReplans && !eng.abort.signal.aborted) {
    return { patch: { tasks, steps, reviews, phase: 'replanning' }, goto: 'escalate' }
  }
  if (failed.length > 0 && state.repairAttempts < maxAttempts && !eng.abort.signal.aborted) {
    return { patch: { tasks, steps, reviews, phase: 'repairing' }, goto: 'repair' }
  }
  return { patch: { tasks, steps, reviews, phase: 'reviewing' }, goto: 'integrationReview' }
```
In `integrationReviewNode`, likewise add `disposition: v.disposition` where it records the verdict, then insert the escalate branch **before** its repair branch:
```ts
  const failed = Object.values(tasks).filter((t) => t.ownerId && t.status === 'failed')
  const maxReplans = getSettings().maxReplans ?? 0
  const misScoped = failed.filter((t) => t.verdict?.disposition === 'replan')
  if (maxReplans > 0 && misScoped.length > 0 && state.replanAttempts < maxReplans && !eng.abort.signal.aborted) {
    return { patch: { tasks, steps, reviews, phase: 'replanning' }, goto: 'escalate' }
  }
  if (failed.length > 0 && state.repairAttempts < maxAttempts && !eng.abort.signal.aborted) {
    return { patch: { tasks, steps, reviews, phase: 'repairing' }, goto: 'repair' }
  }
  for (const wid of workerIdsOf(tasks)) if (!eng.abort.signal.aborted) setStatus(eng, steps, wid, 'done')
  return { patch: { tasks, steps, reviews, phase: 'reflecting' }, goto: 'reflect' }
```

- [ ] **Step 10: Run the escalation tests**

Run: `npm run test -- src/main/engine/nodes.test.ts -t "v2 escalation"`
Expected: PASS — domain escalate / off control / repair-still-works all green.

- [ ] **Step 11: Run the full suite + typecheck**

Run: `npm run test`
Expected: PASS — existing tests green (every existing test has `maxReplans === 0` → `allowReplan=false` prompts unchanged, escalate branch gated off; Phase-2 `replanNode` refactor preserved via `replaceIds: undefined`). If any existing test did `toEqual` on a whole `verdict` object, update it to include `disposition` (a fail now carries `disposition: 'repair'`).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "$(cat <<'EOF'
feat(review): v2 escalation — reviewers flag mis-scoped fails, orchestrator re-breaks-up

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## After all tasks

Use **superpowers:requesting-code-review** on the whole branch, then **superpowers:finishing-a-development-branch** to merge `feat/two-tier-v2-escalation` into `main` (`--no-ff`). Update memory (`ai-manager-two-tier-review`, `ai-manager-workflow-graph`, `ai-manager-status-roadmap`, `MEMORY.md`) + `docs/roadmap-checklist.md`: **v2 escalation SHIPPED** — the only remaining workflow-graph follow-on is now done. **live smoke** is the user's big-project run (no separate smoke needed): with `maxReplans ≥ 1`, a manager/orchestrator that judges a task mis-scoped should show a `⚡ Re-planned` notice and the failed work re-broken-up; `maxReplans = 0` unchanged.

## Self-Review

**Spec coverage:**
- `TaskState.verdict.disposition` → Task 1. ✓
- `mergeReplan` optional `replaceIds` (default pending) → Task 2. ✓
- Reviewer classification (parse + gated prompt at both review steps) → Task 3 (Steps 7–8). ✓
- Escalate branch at both review exits → Task 3 (Step 9). ✓
- `escalate` node + `escalateStep`/`escalatePrompt` + wiring → Task 3 (Steps 4–6). ✓
- Shared `applyReplanDecision` (also used by `replanNode`) → Task 3 (Step 3). ✓
- Unified `maxReplans`/`replanAttempts` budget → Task 3 (escalate gate + branch use `maxReplans`/`replanAttempts`). ✓
- Reuse `replan` event (no renderer) → `applyReplanDecision` emits it; no renderer files touched. ✓
- Byte-for-byte off → Task 3 off-control test + gated prompt/branch. ✓
- Goal immutable → `escalatePrompt` locks it; escalate patch excludes goal. ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code; every test step shows assertions. ✓

**Type consistency:** `mergeReplan(plan, tasks, decision, replaceIds?)` (Task 2) matches `applyReplanDecision`'s `mergeReplan(..., replaceIds)` call and `escalateNode`'s `failed.map(id)` arg (Task 3). `applyReplanDecision(state, eng, decision, replaceIds?, extraPatch?)` is defined and called identically in `replanNode` (`undefined, {replanStageCursor}`) and `escalateNode` (`failedIds`). `reviewStep`/`integrationReviewStep` return `…disposition: 'repair'|'replan'`, stored as `t.verdict.disposition` (Task 1 type) and read by the escalate branch (`t.verdict?.disposition === 'replan'`). `escalateStep` returns `{reason, tasks, deps}` consumed by `applyReplanDecision`'s `decision` shape. The `replan` event `{type:'replan', attempt, reason, tasks}` is the existing Phase-2 shape (no change). ✓
