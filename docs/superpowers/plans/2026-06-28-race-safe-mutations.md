# Race-safe Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize concurrent graph and memory.md writes so parallel agents can't lose each other's updates (and the persisted sessionId stays reliable).

**Architecture:** A tiny `mutex.ts` primitive. `saveGraph` runs inside a single mutex (serializes all graph mutations, which all funnel through it). `memory.md` writes run inside a per-agent keyed mutex with a lock-free atomic raw write used inside the locks. Plus a P1 follow-up removing a TOCTOU in `atomicWriteWithBackup`.

**Tech Stack:** TypeScript, Electron main process, node:fs, vitest, electron-vite.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-28-race-safe-mutations-design.md`. Branch: `fix/race-safe-mutations`. Builds on P1 (`atomic-write.ts`).
- `createMutex()` returns `<T>(fn: () => Promise<T>) => Promise<T>` serializing via a promise chain where the stored tail swallows rejections (`result.then(noop, noop)`) so one failure can't break the chain. `createKeyedMutex()` returns `<T>(key: string, fn) => Promise<T>` with a per-key `Map` of tails.
- #5: serialize the shared `saveGraph` sink (every mutator funnels through it). Capture `requireCurrent()` at call time, run the mkdir + `atomicWriteWithBackup` inside the mutex. Do NOT wrap individual mutator bodies (re-entrancy).
- #14: a per-agent `memoryMutex`; the full read→merge→write RMW in `applyReflection`, the public `writeMemory`, and `refreshFromTeam`'s per-agent RMW all run inside `memoryMutex(agentId, …)`. A private lock-free `writeMemoryRaw` (using P1's `atomicWrite`) is used INSIDE the locks (never the public `writeMemory`, which would deadlock the same-key mutex). Reads stay lock-free.
- #16 is documentation-only: no code (resolved by #5; the spec explains why).
- §4: `atomicWriteWithBackup` drops the `existsSync` guard and relies on the `try/catch` around the demote rename; remove the now-unused `existsSync` import from `atomic-write.ts`.
- Commands: `npm test` (vitest), `npm run typecheck`, `npm run build`.
- Exact current code: `saveGraph` `project-store.ts:154-159`; `writeMemory` `:325-328`; `applyReflection` `:543-553`; `refreshFromTeam` per-agent loop `:672-680`; `atomicWriteWithBackup` `atomic-write.ts:19-30`. `project-store.test.ts` does NOT yet import `updateAgent` or `applyReflection` (add them).

---

### Task 1: Mutex primitive (pure, TDD)

**Files:**
- Create: `src/main/engine/mutex.ts`
- Test: `src/main/engine/mutex.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T>
  export function createKeyedMutex(): <T>(key: string, fn: () => Promise<T>) => Promise<T>
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/main/engine/mutex.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createMutex, createKeyedMutex } from './mutex'

describe('createMutex', () => {
  it('runs bodies one at a time, in call order', async () => {
    const run = createMutex()
    const events: string[] = []
    let active = 0
    const body = (id: string) =>
      run(async () => {
        active++
        expect(active).toBe(1) // never two bodies at once
        events.push(`start-${id}`)
        await Promise.resolve()
        await Promise.resolve()
        events.push(`end-${id}`)
        active--
      })
    await Promise.all([body('a'), body('b'), body('c')])
    expect(events).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c'])
  })

  it('keeps the chain alive after a rejected body', async () => {
    const run = createMutex()
    await expect(run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await run(async () => 42)).toBe(42)
  })
})

describe('createKeyedMutex', () => {
  it('serializes same-key calls in call order even when an earlier body yields longer', async () => {
    const run = createKeyedMutex()
    const order: string[] = []
    const body = (key: string, label: string, ticks: number) =>
      run(key, async () => {
        for (let i = 0; i < ticks; i++) await Promise.resolve()
        order.push(label)
      })
    await Promise.all([body('x', 'x1', 3), body('x', 'x2', 0)])
    expect(order).toEqual(['x1', 'x2']) // x1 first despite more ticks (serialized by key)
  })

  it('runs different keys independently (they can overlap)', async () => {
    const run = createKeyedMutex()
    let aRunning = false
    let overlapped = false
    const a = run('a', async () => {
      aRunning = true
      await Promise.resolve()
      await Promise.resolve()
      aRunning = false
    })
    const b = run('b', async () => {
      if (aRunning) overlapped = true
    })
    await Promise.all([a, b])
    expect(overlapped).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/engine/mutex.test.ts`
Expected: FAIL — `Cannot find module './mutex'`.

- [ ] **Step 3: Implement the primitive**

Create `src/main/engine/mutex.ts`:
```ts
/** Serialize async operations: each call runs after the previous settles (success OR failure),
 *  so two bodies never overlap. Resolves/rejects with the body's own result. */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn)
    tail = result.then(
      () => {},
      () => {}
    ) // swallow so a rejected body never breaks the chain
    return result
  }
}

/** Per-key serialization: same key runs one at a time in call order; different keys are
 *  independent. The key map is bounded by the number of distinct keys (e.g. agent count). */
export function createKeyedMutex(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve()
    const result = prev.then(fn, fn)
    tails.set(
      key,
      result.then(
        () => {},
        () => {}
      )
    )
    return result
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/engine/mutex.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/mutex.ts src/main/engine/mutex.test.ts
git commit -m "feat(p2): add createMutex / createKeyedMutex serialization primitive"
```

---

### Task 2: Serialize graph persistence (#5)

**Files:**
- Modify: `src/main/engine/project-store.ts` (import `createMutex`; `saveGraph` at `:154-159`)
- Test: `src/main/engine/project-store.test.ts` (graph-concurrency guard + add `updateAgent` to imports)

**Interfaces:**
- Consumes: `createMutex()` from Task 1.

- [ ] **Step 1: Write the guard test**

In `src/main/engine/project-store.test.ts`, add `updateAgent` to the `} from './project-store'` import list. Append:
```ts
describe('race-safe graph writes', () => {
  it('does not lose sessionIds written concurrently across agents', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    await createAgent({ name: 'A', kind: 'worker' })
    await createAgent({ name: 'B', kind: 'worker' })
    const g = await createAgent({ name: 'C', kind: 'worker' })
    const id = (n: string) => g.nodes.find((x) => x.name === n)!.id
    await Promise.all([
      updateAgent({ id: id('A'), sessionId: 'sa' }),
      updateAgent({ id: id('B'), sessionId: 'sb' }),
      updateAgent({ id: id('C'), sessionId: 'sc' })
    ])
    const reopened = await openProject(proj)
    const sid = (n: string) => reopened.nodes.find((x) => x.name === n)!.sessionId
    expect(sid('A')).toBe('sa')
    expect(sid('B')).toBe('sb')
    expect(sid('C')).toBe('sc')
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "race-safe graph"`
Expected: PASS — note this is an **invariant guard**, not a deterministic RED: the lost-update is timing-dependent and not reliably reproducible in a unit test (the deterministic serialization proof is Task 1's mutex test). It must stay green after Step 3.

- [ ] **Step 3: Serialize saveGraph**

In `src/main/engine/project-store.ts`, add the import (near the other `./` engine imports, e.g. by the `atomic-write` import):
```ts
import { createMutex } from './mutex'
```
Add the mutex instance just above `saveGraph` (in the `// ---------- graph io ----------` section):
```ts
const graphSaveMutex = createMutex()
```
Replace `saveGraph` (`:154-159`):
```ts
async function saveGraph(): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent() // capture at call time (binds to the open project)
  return graphSaveMutex(async () => {
    await fs.mkdir(aimPath(path), { recursive: true })
    await atomicWriteWithBackup(aimPath(path, GRAPH_FILE), JSON.stringify(graph, null, 2))
    return graph
  })
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/main/engine/project-store.test.ts && npm run typecheck`
Expected: PASS — the guard test plus all pre-existing project-store tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "fix(p2): serialize saveGraph so concurrent mutations can't lose updates"
```

---

### Task 3: Serialize memory.md writes per agent (#14, TDD)

**Files:**
- Modify: `src/main/engine/project-store.ts` (import `createKeyedMutex` + `atomicWrite`; `memoryMutex`; `writeMemoryRaw`; `writeMemory` `:325-328`; `applyReflection` `:543-553`; `refreshFromTeam` loop `:672-680`)
- Test: `src/main/engine/project-store.test.ts` (memory-concurrency test + add `applyReflection` to imports)

**Interfaces:**
- Consumes: `createKeyedMutex()` from Task 1; `atomicWrite` from P1's `atomic-write.ts`.

- [ ] **Step 1: Write the failing test**

In `src/main/engine/project-store.test.ts`, add `applyReflection` to the `} from './project-store'` import list. Append:
```ts
describe('race-safe memory writes', () => {
  it('does not lose lessons when reflections run concurrently on one agent', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    const g = await createAgent({ name: 'Dana', kind: 'worker' })
    const id = g.nodes[0].id
    await Promise.all([
      applyReflection(id, { win: '', loss: '', lessons: ['lesson alpha'], label: 't1' }),
      applyReflection(id, { win: '', loss: '', lessons: ['lesson beta'], label: 't2' })
    ])
    const mem = await readMemory(id)
    expect(mem).toContain('lesson alpha')
    expect(mem).toContain('lesson beta')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "race-safe memory"`
Expected: FAIL — the current unlocked `applyReflection` lets both calls read the same empty base; the second write clobbers the first, so only one lesson survives (the `toContain` for the other fails).

- [ ] **Step 3: Add the keyed mutex + lock-free raw write**

In `src/main/engine/project-store.ts`, add to the imports:
```ts
import { createKeyedMutex } from './mutex'
import { atomicWrite } from './atomic-write'
```
(The file already imports `atomicWriteWithBackup` from `./atomic-write`; add `atomicWrite` to that import or as shown.)

Add near the role/memory section:
```ts
const memoryMutex = createKeyedMutex()

// Private, lock-free, atomic memory write — only call INSIDE a memoryMutex section.
async function writeMemoryRaw(agentId: string, content: string): Promise<void> {
  const dir = agentDir(agentId)
  await fs.mkdir(dir, { recursive: true })
  await atomicWrite(join(dir, 'memory.md'), content)
}
```

- [ ] **Step 4: Route the writers through the mutex**

Replace `writeMemory` (`:325-328`):
```ts
export async function writeMemory(agentId: string, content: string): Promise<void> {
  await memoryMutex(agentId, () => writeMemoryRaw(agentId, content))
}
```
Replace `applyReflection` (`:543-553`):
```ts
export async function applyReflection(
  agentId: string,
  r: { win: string; loss: string; lessons: string[]; label: string }
): Promise<void> {
  await memoryMutex(agentId, async () => {
    const file = join(agentDir(agentId), 'memory.md')
    const content = await readFileOr(file, '')
    const next = mergeMemory(content, r)
    await writeMemoryRaw(agentId, next)
  })
}
```
Replace the `refreshFromTeam` per-agent loop (`:672-680`) — wrap the RMW and use `writeMemoryRaw` (NOT the public `writeMemory`, which would deadlock the same-key mutex):
```ts
  for (const p of planBrainPull(brain, graph.nodes)) {
    if (p.lessons.length === 0) continue
    const changed = await memoryMutex(p.agentId, async () => {
      const memory = await readMemory(p.agentId)
      const next = mergeLessons(memory, p.lessons)
      if (next === memory) return false
      await writeMemoryRaw(p.agentId, next)
      return true
    })
    if (changed) updated++
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/engine/project-store.test.ts && npm run typecheck`
Expected: PASS — both lessons present; all pre-existing project-store tests still green (the export round-trip / memory-quality tests exercise `writeMemory`/`applyReflection` through the new lock); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "fix(p2): serialize memory.md writes per agent to stop lost lessons"
```

---

### Task 4: Remove the atomicWriteWithBackup TOCTOU (P1 follow-up)

**Files:**
- Modify: `src/main/engine/atomic-write.ts` (`atomicWriteWithBackup` at `:19-30`; remove the `existsSync` import at `:2`)

**Interfaces:**
- None new.

- [ ] **Step 1: Replace the demote with a guard-free try/catch**

In `src/main/engine/atomic-write.ts`, replace `atomicWriteWithBackup` (`:19-30`):
```ts
/** Like atomicWrite, but first demotes an existing `target` to `${target}.bak`
 *  (a cheap rename — no data copy), keeping one previous good version for recovery. */
export async function atomicWriteWithBackup(target: string, data: string): Promise<void> {
  const tmp = tmpName(target)
  await fs.writeFile(tmp, data, 'utf8')
  try {
    await fs.rename(target, `${target}.bak`) // demote previous version; ENOENT (no prior file) is fine
  } catch {
    // no existing target, or a concurrent writer already moved it — ignore
  }
  await fs.rename(tmp, target)
}
```
Then delete the now-unused import line at the top of the file:
```ts
import { existsSync } from 'node:fs'
```
(Keep `import { promises as fs } from 'node:fs'`.)

- [ ] **Step 2: Run the atomic-write tests + typecheck**

Run: `npx vitest run src/main/engine/atomic-write.test.ts && npm run typecheck`
Expected: PASS unchanged — first write still creates no `.bak` (the demote rename throws `ENOENT`, caught); second write still demotes the previous content to `.bak`. Typecheck clean (no unused-import error).

- [ ] **Step 3: Commit**

```bash
git add src/main/engine/atomic-write.ts
git commit -m "fix(p2): drop atomicWriteWithBackup existsSync TOCTOU (rely on try/catch)"
```

---

### Task 5: Full-suite verification

**Files:** none (verification gate).

- [ ] **Step 1: Run the whole suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: vitest all green (303 prior + the new mutex/graph/memory tests), typecheck clean (node + web), build clean.

- [ ] **Step 2: Manual smoke notes (no code)**

Confirm from the diff: (a) `saveGraph` body runs inside `graphSaveMutex(...)`; (b) `writeMemory`/`applyReflection`/`refreshFromTeam` all go through `memoryMutex(agentId, …)` and use `writeMemoryRaw` inside (no public `writeMemory` call inside a lock); (c) `atomicWriteWithBackup` no longer calls `existsSync`. Live check later: run a multi-worker wave — every worker's sessionId persists (no agent silently re-starts a fresh session), and concurrent reflections don't drop lessons.

- [ ] **Step 3: Confirm clean tree**

```bash
git status --short   # expect clean
```

---

## Self-Review

**Spec coverage:**
- §0 `mutex.ts` (`createMutex`/`createKeyedMutex`) + tests → Task 1. ✓
- §1 serialize `saveGraph` (#5) → Task 2 (+ guard test). ✓
- §2 per-agent memory mutex + `writeMemoryRaw` + `writeMemory`/`applyReflection`/`refreshFromTeam` (#14) → Task 3 (+ deterministic RED test). ✓
- §3 #16 documentation-only → no task (resolved by Task 2). ✓
- §4 atomic-write TOCTOU → Task 4. ✓
- §5 tests → Tasks 1/2/3 + Task 5 gate. ✓

**Placeholder scan:** none — every code step shows full code; commands have expected output. Task 2's test is explicitly labeled an invariant guard (not a RED), which is honest, not a placeholder.

**Type consistency:** `createMutex`/`createKeyedMutex` signatures from Task 1 are consumed exactly in Tasks 2 (`graphSaveMutex(async () => …)`) and 3 (`memoryMutex(agentId, async () => …)`). `writeMemoryRaw(agentId, content)` defined in Task 3 Step 3 is used in Task 3 Step 4 consistently. `atomicWrite`/`atomicWriteWithBackup` signatures match P1. The `applyReflection` `r` type matches the existing call (`mergeMemory(content, r)`).
