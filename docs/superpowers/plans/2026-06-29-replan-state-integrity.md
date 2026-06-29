# R1 — Replan/escalate state integrity (`mergeReplan` hardening) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `mergeReplan` produce a structurally consistent merge for any orchestrator decision — passed/
frozen tasks never clobbered, plan ids unique and 1:1 with the tasks map, and no dangling `dependsOn`.

**Architecture:** A single pure-function rewrite in `src/shared/replan.ts`. Re-id decision tasks whose id
collides with a frozen (kept) id or an earlier decision task (deterministic `freshId`), remap dependency
references to the re-ided ids, drop deps that point at non-existent tasks (on both new AND frozen tasks), and
build the plan from the now-unique ids. Pure, unit-tested; reached only when `maxReplans>0`.

**Tech Stack:** TypeScript, Vitest. Pure module (`src/shared/replan.ts`) — no node/DOM imports.

**Spec:** `docs/superpowers/specs/2026-06-29-replan-state-integrity-design.md`

## Global Constraints

- **Off-path byte-for-byte:** `maxReplans` defaults to `0`, so `mergeReplan` is never reached on a default run.
  This is automatic; do not add any gating code.
- **No-collision / no-dangling parity:** for any decision that does NOT collide with a frozen id and has no
  dangling deps, the output must be byte-for-byte identical to today — including keeping the **same object
  reference** for an unchanged frozen task (existing tests assert `toBe`) and **omitting** an empty `dependsOn`
  key. The existing `replan.test.ts` suite must stay green unchanged.
- **`used` seeds from FROZEN ids only.** A decision task reusing a *replaced* id (e.g. proactive replan returns
  a task still labelled `t2` while `t2` was the pending task being replaced) is normal and must keep its id —
  only collisions with FROZEN (kept) ids or earlier decision tasks get re-ided.
- **Deterministic ids:** `freshId` uses a numeric suffix scan (`base~2`, `base~3`, …) — no randomness, no
  `Date.now()`.
- **Drop, don't repoint, dangling deps.** Safe: `depsSatisfied` already skips unknown ids.
- Scope: ONLY `src/shared/replan.ts` + `src/shared/replan.test.ts`. No `nodes.ts`, renderer, or `types.ts`
  changes. `pendingStageBoundary` is unchanged.
- **Verification gates:** `npm test` (currently 352 green), `npm run typecheck` (node+web), `npm run build`.

---

## Task 1: Harden `mergeReplan` (re-id, dep remap, dangling cleanup, consistent plan)

**Files:**
- Modify: `src/shared/replan.ts` (rewrite the `mergeReplan` body, ~lines 39-67; add a `freshId` helper)
- Test: `src/shared/replan.test.ts` (additive: an invariant helper + 7 integrity tests)

**Interfaces:**
- `mergeReplan(plan: RunTask[], tasks: Record<string, TaskState>, decision: { tasks: RunTask[]; deps?: Record<string, string[]> }, replaceIds?: string[]): { plan: RunTask[]; tasks: Record<string, TaskState> }` — signature UNCHANGED; only the body's correctness changes.
- New module-local helper `freshId(base: string, used: Set<string>): string` (not exported).

- [ ] **Step 1: Write the failing integrity tests**

Add to `src/shared/replan.test.ts`, inside the existing `describe('mergeReplan', …)` block (so the
module-scope `plan` and `mkTask` are in scope). First add this invariant helper at the top of that describe
block (just after the `const plan` declaration):

```ts
  // Every merge must satisfy: unique plan ids, plan ids === tasks keys (1:1), no dangling dependsOn.
  function assertConsistent(out: { plan: RunTask[]; tasks: Record<string, TaskState> }) {
    const planIds = out.plan.map((p) => p.id)
    expect(new Set(planIds).size).toBe(planIds.length) // unique
    expect(planIds.slice().sort()).toEqual(Object.keys(out.tasks).sort()) // 1:1
    const present = new Set(Object.keys(out.tasks))
    for (const t of Object.values(out.tasks)) {
      for (const d of t.dependsOn ?? []) expect(present.has(d)).toBe(true) // no dangling
    }
  }
```

Then add these 7 tests:

```ts
  it('re-ids a decision task that collides with a frozen id (never clobbers the frozen task)', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    // replacing pending t2, the decision mistakenly labels its new task 't1' — a frozen id
    const decision = { tasks: [{ id: 't1', title: 'NEW', description: 'rewrite api' }] }
    const out = mergeReplan(plan, tasks, decision)
    expect(out.tasks.t1).toBe(tasks.t1) // frozen t1 preserved verbatim (output intact)
    const fresh = Object.values(out.tasks).find((t) => t.task.description === 'rewrite api')!
    expect(fresh).toBeTruthy()
    expect(fresh.task.id).not.toBe('t1')
    expect(fresh.status).toBe('pending')
    expect(fresh.ownerId).toBeNull()
    assertConsistent(out)
  })

  it('re-ids an escalation task that collides with a passed (frozen) id', () => {
    const tasks = { t1: mkTask('t1', 'passed', 1), t2: mkTask('t2', 'failed', 2) }
    const decision = { tasks: [{ id: 't1', title: 'X', description: 'redo work' }] }
    const out = mergeReplan(plan, tasks, decision, ['t2']) // only failed t2 replaced; t1 passed → frozen
    expect(out.tasks.t1).toBe(tasks.t1) // passed preserved
    expect(out.tasks.t1.status).toBe('passed')
    const fresh = Object.values(out.tasks).find((t) => t.task.description === 'redo work')!
    expect(fresh.task.id).not.toBe('t1')
    assertConsistent(out)
  })

  it('re-ids decision-internal duplicate ids so all are kept', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    const decision = { tasks: [{ id: 't3', title: 'A', description: 'a' }, { id: 't3', title: 'B', description: 'b' }] }
    const out = mergeReplan(plan, tasks, decision)
    const descs = Object.values(out.tasks).map((t) => t.task.description).sort()
    expect(descs).toEqual(['a', 'b', 't1']) // t1 frozen (its description is 't1'), both new kept
    assertConsistent(out)
  })

  it('drops a new task dependsOn that points at a replaced or unknown id', () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    // t2 is replaced (dropped); new t3 depends on the gone t2 and a hallucinated 'tX'
    const decision = { tasks: [{ id: 't3', title: 'T3', description: 'c' }], deps: { t3: ['t2', 'tX'] } }
    const out = mergeReplan(plan, tasks, decision) // default replace = pending = [t2]
    expect(out.tasks.t3.dependsOn).toBeUndefined() // both targets absent → key omitted
    assertConsistent(out)
  })

  it('drops a frozen task dependsOn that points at a replaced id', () => {
    const t1 = { ...mkTask('t1', 'done', 1), dependsOn: ['t2'] } // frozen t1 depended on t2
    const tasks = { t1, t2: mkTask('t2', 'pending', 2) }
    const out = mergeReplan(plan, tasks, { tasks: [] }) // t2 (pending) replaced by nothing → dropped
    expect(out.tasks.t1.dependsOn).toBeUndefined() // dangling dep on t2 removed
    assertConsistent(out)
  })

  it('keeps a frozen task dependsOn that still points at a present task (same reference)', () => {
    const t2 = { ...mkTask('t2', 'done', 2), dependsOn: ['t1'] } // depends on frozen t1
    const tasks = { t1: mkTask('t1', 'done', 1), t2, t3: mkTask('t3', 'pending', 3) }
    const out = mergeReplan(plan, tasks, { tasks: [] }) // only pending t3 replaced (by nothing)
    expect(out.tasks.t2).toBe(tasks.t2) // unchanged frozen task → same reference (shape parity)
    expect(out.tasks.t2.dependsOn).toEqual(['t1'])
    assertConsistent(out)
  })

  it("remaps a new task dependsOn to a sibling's re-ided id", () => {
    const tasks = { t1: mkTask('t1', 'done', 1), t2: mkTask('t2', 'pending', 2) }
    // new task reuses frozen id 't1' (→ re-ided); another new task t3 depends on the decision's 't1'
    const decision = {
      tasks: [{ id: 't1', title: 'A', description: 'a' }, { id: 't3', title: 'B', description: 'b' }],
      deps: { t3: ['t1'] }
    }
    const out = mergeReplan(plan, tasks, decision)
    const reided = Object.values(out.tasks).find((t) => t.task.description === 'a')!
    expect(reided.task.id).not.toBe('t1')
    expect(out.tasks.t3.dependsOn).toEqual([reided.task.id]) // dep remapped to the new id
    assertConsistent(out)
  })
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run src/shared/replan.test.ts`
Expected: the 7 new tests FAIL (current `mergeReplan` clobbers the frozen task / produces a duplicate plan id /
leaves the dangling dep), while the 8 pre-existing `mergeReplan` tests + the `pendingStageBoundary` tests still
pass. (If a new test errors on `assertConsistent` not defined, you forgot to add the helper in Step 1.)

- [ ] **Step 3: Rewrite `mergeReplan` + add `freshId`**

In `src/shared/replan.ts`, add the helper above `mergeReplan` (after `pendingStageBoundary`):

```ts
/** A deterministic id not already in `used`: returns `base`, else `base~2`, `base~3`, … */
function freshId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}~${n}`)) n++
  return `${base}~${n}`
}
```

Replace the entire `mergeReplan` body (keep the doc comment + signature) with:

```ts
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

  // Assign each decision task a collision-free final id (re-id, never clobber a frozen task or an
  // earlier decision task). `used` seeds from FROZEN ids only — reusing a replaced id is legitimate.
  const used = new Set(Object.keys(frozen))
  const remap: Record<string, string> = {}
  const finalIds = decision.tasks.map((rt) => {
    const finalId = freshId(rt.id, used)
    used.add(finalId)
    if (finalId !== rt.id) remap[rt.id] = finalId
    return finalId
  })

  // Every id that will exist after the merge — used to drop dangling deps.
  const present = new Set<string>([...Object.keys(frozen), ...finalIds])

  const next: Record<string, TaskState> = {}
  // Frozen tasks: kept verbatim, but re-filter dependsOn so a dropped target no longer dangles.
  // Keep the same object reference when nothing changes (shape parity with the pre-fix output).
  for (const [id, t] of Object.entries(frozen)) {
    const cleaned = (t.dependsOn ?? []).filter((d) => present.has(d))
    if (t.dependsOn && cleaned.length !== t.dependsOn.length) {
      const { dependsOn: _drop, ...rest } = t
      next[id] = cleaned.length ? { ...rest, dependsOn: cleaned } : rest
    } else {
      next[id] = t
    }
  }
  // Decision tasks: fresh pending, un-owned, with deps remapped to final ids and danglers dropped.
  decision.tasks.forEach((rt, i) => {
    const finalId = finalIds[i]
    const cleaned = (deps[rt.id] ?? [])
      .map((d) => remap[d] ?? d)
      .filter((d) => d !== finalId && present.has(d))
    next[finalId] = {
      task: { id: finalId, title: rt.title, description: rt.description },
      ownerId: null,
      status: 'pending',
      attempts: 0,
      output: '',
      ...(cleaned.length ? { dependsOn: cleaned } : {})
    }
  })

  const frozenInOrder = plan.filter((p) => frozen[p.id]).map((p) => frozen[p.id].task)
  const newTasks = decision.tasks.map((rt, i) => ({ id: finalIds[i], title: rt.title, description: rt.description }))
  return { plan: [...frozenInOrder, ...newTasks], tasks: next }
}
```

- [ ] **Step 4: Run `replan.test.ts` to verify the new tests pass and the old ones still pass**

Run: `npx vitest run src/shared/replan.test.ts`
Expected: ALL pass — the 7 new integrity tests, the 8 pre-existing `mergeReplan` tests (unchanged), and the
`pendingStageBoundary` tests. If a pre-existing test fails, you broke parity — re-check that `used` seeds from
frozen ids only and that unchanged frozen tasks keep their original object reference.

- [ ] **Step 5: Run the full suite + typecheck + build**

Run: `npm test` — expect all green (352 pre-existing + 7 new = 359).
Run: `npm run typecheck` — node + web projects clean.
Run: `npm run build` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/replan.ts src/shared/replan.test.ts
git commit -m "fix(replan): harden mergeReplan against id collisions + dangling deps (R1)

Re-id decision tasks that collide with a frozen/passed id (or an earlier
decision task) instead of clobbering them; remap dependency references to
the re-ided ids; drop dependsOn that points at a non-existent task (new and
frozen); build the plan from the now-unique ids so plan === tasks keys 1:1.
Resolves audit #6/#7/#13. Off-path (maxReplans=0) byte-for-byte; non-colliding
decisions unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (against the spec)

**Spec coverage:**
- §Design 1 (re-id, never clobber; `used` from frozen ids; deterministic `freshId`) → Step 3 + tests 1/2/3. ✓
- §Design 2 (dep remap + dangling cleanup on new AND frozen tasks; drop) → Step 3 + tests 4/5/6/7. ✓
- §Design 3 (consistent plan: unique ids, plan === tasks keys) → `assertConsistent` across all new tests. ✓
- §Goal invariants (passed preserved / 1:1 / no dangling) → tests 1/2 + `assertConsistent`. ✓
- §Non-goals (no `parseTasksAndDeps`/node-routing/types/renderer change) → scope limited to `replan.ts`. ✓
- §Constraints (off-path automatic; no-collision parity incl. same-ref frozen + omitted empty dep) → tests 6 +
  the unchanged existing suite. ✓

**Placeholder scan:** none — all code and test bodies are concrete.

**Type consistency:** `mergeReplan` signature unchanged; `freshId(base, used: Set<string>)` used exactly as
defined; `TaskState`/`RunTask` shapes match `replan.ts` imports and the `mkTask` helper.
