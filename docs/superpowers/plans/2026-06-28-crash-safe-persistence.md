# Crash-safe Persistence (Atomic Writes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `graph.json` writes atomic and `openProject` corruption-resilient so a crash mid-write can never truncate or brick a project.

**Architecture:** A shared pure `atomic-write.ts` helper (temp-file + rename, plus a free `.bak` via rename). `saveGraph` uses the backup variant; `openProject` recovers from `.bak`/preserves a corrupt file/falls back to empty. `run-store` reuses the helper and sweeps orphaned `.tmp` files.

**Tech Stack:** TypeScript, Electron main process, node:fs, vitest, electron-vite.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-28-crash-safe-persistence-design.md`. Branch: `fix/crash-safe-persistence`.
- Atomic write = write `${target}.${process.pid}.${seq++}.tmp` then `fs.rename(tmp, target)`. The backup variant additionally renames an existing `target` → `${target}.bak` (wrapped in try/catch that ignores errors) before the final rename.
- `openProject` recovery order: parse `graph.json` → on failure rename it to `graph.json.corrupt-${Date.now()}` (best-effort) → try `graph.json.bak` → else empty `DEFAULT_SETTINGS` graph. `console.warn` ONLY when a corrupt file was found or `.bak` recovery happened; a fresh project (no `graph.json`, no `.bak`) stays silent. Keep the existing `graph.project = { path, name }` normalization and the trailing `await saveGraph()` / `addRecent`.
- `run-store.put` uses the shared `atomicWrite`; `sweepTmpFiles(dir)` removes `*.tmp`; `createRunStore` fires `void sweepTmpFiles(dir)` once at creation.
- `atomic-write.ts` is pure node (only `node:fs`), unit-tested like `run-store`.
- OUT OF SCOPE: the concurrent lost-update race (two `updateAgent`s clobbering each other) — that is cycle P2. P1 only makes each write atomic/torn-free.
- Existing constants in `project-store.ts`: `AIM_DIR='.ai-manager'`, `GRAPH_FILE='graph.json'`, `aimPath()`; `existsSync`, `fs` (node:fs/promises), `basename`, `DEFAULT_SETTINGS` already imported. `project-store.test.ts` already imports `existsSync`, `openProject`, `createAgent`, `writeMemory`, and has a `tmpProject()` helper.
- Commands: `npm test` (vitest), `npm run typecheck`, `npm run build`.

---

### Task 1: Shared atomic-write helper (pure, TDD)

**Files:**
- Create: `src/main/engine/atomic-write.ts`
- Test: `src/main/engine/atomic-write.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function atomicWrite(target: string, data: string): Promise<void>
  export function atomicWriteWithBackup(target: string, data: string): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/main/engine/atomic-write.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, atomicWriteWithBackup } from './atomic-write'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('atomicWrite', () => {
  it('writes the content to the target and leaves no .tmp behind', async () => {
    const target = join(dir, 'f.json')
    await atomicWrite(target, 'hello')
    expect(await fs.readFile(target, 'utf8')).toBe('hello')
    expect(await fs.readdir(dir)).toEqual(['f.json'])
  })
})

describe('atomicWriteWithBackup', () => {
  it('does not create a .bak on the first write', async () => {
    const target = join(dir, 'f.json')
    await atomicWriteWithBackup(target, 'v1')
    expect(await fs.readFile(target, 'utf8')).toBe('v1')
    expect(existsSync(`${target}.bak`)).toBe(false)
  })

  it('demotes the previous content to .bak on the second write, leaving no .tmp', async () => {
    const target = join(dir, 'f.json')
    await atomicWriteWithBackup(target, 'v1')
    await atomicWriteWithBackup(target, 'v2')
    expect(await fs.readFile(target, 'utf8')).toBe('v2')
    expect(await fs.readFile(`${target}.bak`, 'utf8')).toBe('v1')
    expect((await fs.readdir(dir)).some((e) => e.endsWith('.tmp'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/engine/atomic-write.test.ts`
Expected: FAIL — `Cannot find module './atomic-write'` (the file doesn't exist yet).

- [ ] **Step 3: Implement the helper**

Create `src/main/engine/atomic-write.ts`:
```ts
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'

let seq = 0
function tmpName(target: string): string {
  return `${target}.${process.pid}.${seq++}.tmp`
}

/** Write `data` to `target` atomically (temp file + rename): a crash mid-write never
 *  leaves a torn file, and concurrent writers never interleave bytes (last rename wins). */
export async function atomicWrite(target: string, data: string): Promise<void> {
  const tmp = tmpName(target)
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, target)
}

/** Like atomicWrite, but first demotes an existing `target` to `${target}.bak`
 *  (a cheap rename — no data copy), keeping one previous good version for recovery. */
export async function atomicWriteWithBackup(target: string, data: string): Promise<void> {
  const tmp = tmpName(target)
  await fs.writeFile(tmp, data, 'utf8')
  if (existsSync(target)) {
    try {
      await fs.rename(target, `${target}.bak`)
    } catch {
      // a concurrent writer may have already moved it; ignore
    }
  }
  await fs.rename(tmp, target)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/engine/atomic-write.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/atomic-write.ts src/main/engine/atomic-write.test.ts
git commit -m "feat(p1): add atomic-write helper (atomicWrite + atomicWriteWithBackup)"
```

---

### Task 2: Atomic + recoverable graph.json (project-store, TDD)

**Files:**
- Modify: `src/main/engine/project-store.ts` (import helper; `saveGraph` at `:152-157`; `openProject` read block at `:166-179`)
- Test: `src/main/engine/project-store.test.ts` (new recovery describe block)

**Interfaces:**
- Consumes: `atomicWriteWithBackup(target, data)` from Task 1.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/engine/project-store.test.ts` (the file already imports `existsSync`, `openProject`, `createAgent`, `fs`, `join`, and has `tmpProject()`):
```ts
describe('crash-safe graph.json', () => {
  it('keeps a graph.json.bak after a mutating save', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    await createAgent({ name: 'Dana', kind: 'worker' })
    expect(existsSync(join(proj, '.ai-manager', 'graph.json.bak'))).toBe(true)
  })

  it('recovers from .bak when graph.json is corrupt, preserving the corrupt file', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    await createAgent({ name: 'Dana', kind: 'worker' }) // creates .bak (=empty), graph.json (=Dana)
    await createAgent({ name: 'Quinn', kind: 'worker' }) // .bak (=Dana), graph.json (=Dana,Quinn)
    await fs.writeFile(join(proj, '.ai-manager', 'graph.json'), '{ broken', 'utf8')

    const recovered = await openProject(proj)
    expect(recovered.nodes.some((n) => n.name === 'Dana')).toBe(true) // from .bak
    const entries = await fs.readdir(join(proj, '.ai-manager'))
    expect(entries.some((e) => e.startsWith('graph.json.corrupt-'))).toBe(true)
  })

  it('opens an empty graph when graph.json is corrupt and there is no backup', async () => {
    const proj = await tmpProject()
    await fs.mkdir(join(proj, '.ai-manager'), { recursive: true })
    await fs.writeFile(join(proj, '.ai-manager', 'graph.json'), 'not json', 'utf8')
    const g = await openProject(proj)
    expect(g.nodes).toEqual([])
  })

  it('opens a fresh project to an empty graph without creating a .corrupt file', async () => {
    const proj = await tmpProject()
    const g = await openProject(proj)
    expect(g.nodes).toEqual([])
    const entries = await fs.readdir(join(proj, '.ai-manager'))
    expect(entries.some((e) => e.includes('.corrupt-'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "crash-safe"`
Expected: FAIL — the `.bak` test fails (current `saveGraph` writes no `.bak`) and the "corrupt" tests fail/throw (current `openProject` `JSON.parse` throws on a bad file).

- [ ] **Step 3: Implement saveGraph (atomic + backup)**

In `src/main/engine/project-store.ts`, add the import near the other `./` engine imports (e.g. after the `../../shared/...` imports block):
```ts
import { atomicWriteWithBackup } from './atomic-write'
```
Replace `saveGraph` (`:152-157`):
```ts
async function saveGraph(): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  await fs.mkdir(aimPath(path), { recursive: true })
  await atomicWriteWithBackup(aimPath(path, GRAPH_FILE), JSON.stringify(graph, null, 2))
  return graph
}
```

- [ ] **Step 4: Implement openProject (resilient read)**

Replace the read block in `openProject` (`:166-179`, the `const graphFile … }` up to and including the `if (existsSync(graphFile)) { … } else { … }`) with:
```ts
  const graphFile = aimPath(projectPath, GRAPH_FILE)
  const bakFile = `${graphFile}.bak`
  let graph: ProjectGraph | null = null

  if (existsSync(graphFile)) {
    try {
      graph = JSON.parse(await fs.readFile(graphFile, 'utf8')) as ProjectGraph
    } catch {
      // corrupt graph.json — preserve it for forensics, then fall back to the backup
      try {
        await fs.rename(graphFile, `${graphFile}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      console.warn(`[project-store] ${GRAPH_FILE} was unreadable; attempting backup recovery.`)
    }
  }
  if (!graph && existsSync(bakFile)) {
    // graph.json was missing (possible crash in the save rename window) or corrupt
    try {
      graph = JSON.parse(await fs.readFile(bakFile, 'utf8')) as ProjectGraph
      console.warn(`[project-store] recovered ${GRAPH_FILE} from ${GRAPH_FILE}.bak.`)
    } catch {
      /* .bak also bad — fall through to an empty graph */
    }
  }
  if (graph) {
    // keep the project path current even if the folder moved
    graph.project = { path: projectPath, name: graph.project?.name || basename(projectPath) }
  } else {
    graph = {
      project: { path: projectPath, name: basename(projectPath) },
      nodes: [],
      edges: [],
      settings: { ...DEFAULT_SETTINGS }
    }
  }
```
(The lines after — `graph.settings = { ...DEFAULT_SETTINGS, ...(graph.settings ?? {}) }`, `graph.context = …`, `current = …`, `await saveGraph()`, `await addRecent(...)`, `return graph` — are unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/engine/project-store.test.ts`
Expected: PASS — the new `crash-safe` block plus all pre-existing project-store tests (including the U1 soft-delete test).

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(p1): atomic graph.json write + corruption-resilient openProject"
```

---

### Task 3: run-store atomic write + .tmp sweep (TDD)

**Files:**
- Modify: `src/main/engine/run-store.ts` (import helper; `put` at `:30-36`; drop `let seq`; add `sweepTmpFiles` + fire-on-create)
- Test: `src/main/engine/run-store.test.ts` (new sweep test)

**Interfaces:**
- Consumes: `atomicWrite(target, data)` from Task 1.
- Produces: `export function sweepTmpFiles(dir: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Add `sweepTmpFiles` to the import in `src/main/engine/run-store.test.ts`:
```ts
import { createRunStore, sweepTmpFiles } from './run-store'
```
Append a describe block (the file already has `dir` set up via `beforeEach`/`afterEach`):
```ts
describe('sweepTmpFiles', () => {
  it('removes orphan .tmp files but leaves .json checkpoints', async () => {
    await fs.writeFile(join(dir, 'run-1.json'), '{}', 'utf8')
    await fs.writeFile(join(dir, 'run-1.json.99.0.tmp'), 'partial', 'utf8')
    await sweepTmpFiles(dir)
    const entries = await fs.readdir(dir)
    expect(entries).toContain('run-1.json')
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })

  it('round-trips put/get after the helper refactor', async () => {
    const store = createRunStore(dir)
    const state = mkState({ runId: 'xyz', final: 'ok' })
    await store.put(state)
    expect(await store.get('xyz')).toEqual(state)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/engine/run-store.test.ts -t "sweepTmpFiles"`
Expected: FAIL — `sweepTmpFiles` is not exported.

- [ ] **Step 3: Implement the refactor + sweep**

In `src/main/engine/run-store.ts`:
- Add the import at the top:
  ```ts
  import { atomicWrite } from './atomic-write'
  ```
- Add the exported sweep (place it above `createRunStore`):
  ```ts
  /** Best-effort removal of orphaned temp files left by a crash mid-write. */
  export async function sweepTmpFiles(dir: string): Promise<void> {
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      return // dir not created yet
    }
    await Promise.all(
      files.filter((f) => f.endsWith('.tmp')).map((f) => fs.rm(join(dir, f), { force: true }))
    )
  }
  ```
- In `createRunStore`, delete the `let seq = 0` line and replace `put` (`:30-36`) with:
  ```ts
    async function put(state: RunState): Promise<void> {
      await fs.mkdir(dir, { recursive: true })
      await atomicWrite(fileFor(state.runId), JSON.stringify(state, null, 2))
    }
  ```
- Immediately before `return { put, get, remove, listResumable }`, add:
  ```ts
    void sweepTmpFiles(dir) // clean up temp files orphaned by a prior crash (init-time, before any run)
  ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/engine/run-store.test.ts`
Expected: PASS — the new sweep tests plus all pre-existing run-store tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/run-store.ts src/main/engine/run-store.test.ts
git commit -m "feat(p1): run-store uses atomic-write helper + sweeps orphan .tmp"
```

---

### Task 4: Full-suite verification

**Files:** none (verification gate).

- [ ] **Step 1: Run the whole suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: vitest all green (294 prior + the new atomic-write/crash-safe/sweep tests), typecheck clean (node + web), build clean.

- [ ] **Step 2: Manual smoke notes (no code)**

Confirm from the diff: (a) `saveGraph` calls `atomicWriteWithBackup` (no bare `fs.writeFile` of graph.json remains); (b) `openProject` never `JSON.parse`s without a try/catch and preserves a corrupt file as `*.corrupt-*`; (c) `run-store.put` calls `atomicWrite` and `createRunStore` fires `sweepTmpFiles`. Live check later: kill the app mid-run, reopen — the project still opens; corrupt `graph.json` by hand, reopen — it recovers from `.bak` and leaves a `*.corrupt-*` file.

- [ ] **Step 3: Confirm clean tree**

```bash
git status --short   # expect clean
```

---

## Self-Review

**Spec coverage:**
- §1 `atomic-write.ts` (`atomicWrite`, `atomicWriteWithBackup`) + tests → Task 1. ✓
- §2 `saveGraph` atomic+backup → Task 2 Step 3. ✓
- §3 `openProject` resilient read (corrupt→preserve+`.bak`→empty; fresh silent) → Task 2 Step 4 + tests. ✓
- §4 `run-store` `put` via `atomicWrite`, `sweepTmpFiles`, fire-on-create → Task 3. ✓
- §5 tests (helper, recovery paths, sweep) → Tasks 1/2/3 + Task 4 gate. ✓
- Concurrency race explicitly OUT → no task touches updateAgent serialization. ✓

**Placeholder scan:** none — every code step shows full code; commands have expected output.

**Type consistency:** `atomicWrite`/`atomicWriteWithBackup(target: string, data: string): Promise<void>` defined in Task 1 are consumed with those exact signatures in Tasks 2 (`atomicWriteWithBackup`) and 3 (`atomicWrite`). `sweepTmpFiles(dir: string): Promise<void>` defined and consumed consistently in Task 3. `openProject`'s `graph: ProjectGraph | null` local is resolved to non-null before use.
