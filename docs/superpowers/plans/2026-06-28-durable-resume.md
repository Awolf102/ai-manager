# Durable Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-paid-for crash/pause checkpointing usable — surface resumable runs, let the user resume or discard them, and GC leaked checkpoints.

**Architecture:** A node-testable core (`gcCheckpoints` + pure `toResumableSummaries` in `run-store.ts`), thin orchestrator/IPC wrappers (using the existing `active` map + `createRunStore(getCheckpointDir())`), and minimal renderer surfaces (store state/actions + a banner + a History "Resumable" section + a button badge). The engine resume path is unchanged — it already works.

**Tech Stack:** TypeScript, Electron, React + zustand renderer, Vitest (node env), electron-vite.

## Global Constraints

- Test runner **Vitest** (node env). Commands: `npm test` (= `vitest run`), `npm run typecheck` (node+web), `npm run build`.
- **No renderer unit tests** exist (convention): pure/node logic is unit-tested; renderer store + UI are verified by `tsc` + `build`. Only Task 1 adds tests.
- `MAX_RESUMABLE_AGE_MS = 30 * 24 * 60 * 60 * 1000`. GC removes terminal-status checkpoints (any age) + `running`/`interrupted` older than that (by `updatedAt`); leaves unparseable files.
- `ResumableRun` = `{ runId, goal, status: 'running'|'interrupted', startedAt, updatedAt, taskCount }`.
- Resume is **manual only**; `resumeRun(runId)` with no answer = crash recovery; an `interrupted` run resumed with no answer re-shows its question (engine behavior, unchanged).
- Off/empty (no checkpoints) ⇒ no banner/badge/section, byte-for-byte; existing run/resume flows unchanged.
- Each task leaves `npm run typecheck` + `npm test` green before its commit (Task 4 also `build`).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/shared/types.ts` | + `ResumableRun`; + 2 IPC channels; `RendererApi` (resumeRun optional + 2 methods) | 1, 2 |
| `src/main/engine/run-store.ts` | + `gcCheckpoints` on the store; + pure `toResumableSummaries` | 1 |
| `src/main/engine/run-store.test.ts` | + GC + summaries tests | 1 |
| `src/main/engine/orchestrator.ts` | + `listResumable`/`discardRun`/`gcCheckpoints` wrappers | 2 |
| `src/main/ipc.ts` | + 2 handlers; resumeRun answer optional; openProject/pickProjectFolder run GC | 2 |
| `src/preload/index.ts` | + `listResumable`/`discardRun` bridges | 2 |
| `src/renderer/store.ts` | + `resumable`/`resumableDismissed` + 4 actions | 3 |
| `src/renderer/App.tsx` | + banner + History-button badge + refresh-on-open | 4 |
| `src/renderer/run/HistoryView.tsx` | + "Resumable" section (Resume/Discard) | 4 |

**Order:** 1 → 2 → 3 → 4.

---

### Task 1: Store GC + summaries + type

**Files:**
- Modify: `src/shared/types.ts` (+ `ResumableRun`)
- Modify: `src/main/engine/run-store.ts` (+ `gcCheckpoints`, + `toResumableSummaries`, + `MAX_RESUMABLE_AGE_MS`)
- Test: `src/main/engine/run-store.test.ts`

**Interfaces:**
- Produces: `ResumableRun` (type); `RunStore.gcCheckpoints(nowMs: number): Promise<number>`; `toResumableSummaries(states: RunState[], activeIds: ReadonlySet<string>): ResumableRun[]`.

- [ ] **Step 1: Add the `ResumableRun` type** — in `src/shared/types.ts`, near `RunSummary` (~line 309), add:

```typescript
/** A crashed ('running') or paused ('interrupted') run that can be resumed from its checkpoint. */
export interface ResumableRun {
  runId: string
  goal: string
  status: 'running' | 'interrupted'
  startedAt: string
  updatedAt: string
  taskCount: number
}
```

- [ ] **Step 2: Write the failing tests** — append to `src/main/engine/run-store.test.ts`. Add `toResumableSummaries` to the `./run-store` import:

```typescript
import { createRunStore, sweepTmpFiles, toResumableSummaries } from './run-store'

describe('gcCheckpoints', () => {
  const NOW = Date.parse('2026-07-01T00:00:00.000Z')
  it('removes terminal-status + old-resumable, keeps recent resumable', async () => {
    const store = createRunStore(dir)
    await store.put(mkState({ runId: 'done', status: 'completed' }))
    await store.put(mkState({ runId: 'err', status: 'error' }))
    await store.put(mkState({ runId: 'cancel', status: 'cancelled' }))
    await store.put(mkState({ runId: 'live', status: 'running', updatedAt: '2026-06-30T00:00:00.000Z' }))
    await store.put(mkState({ runId: 'paused', status: 'interrupted', updatedAt: '2026-06-29T00:00:00.000Z' }))
    await store.put(mkState({ runId: 'stale', status: 'running', updatedAt: '2026-01-01T00:00:00.000Z' }))
    const removed = await store.gcCheckpoints(NOW)
    expect(removed).toBe(4) // done, err, cancel, stale
    const kept = (await store.listResumable()).map((s) => s.runId).sort()
    expect(kept).toEqual(['live', 'paused'])
  })
  it('leaves an unparseable checkpoint file alone', async () => {
    const store = createRunStore(dir)
    await fs.writeFile(join(dir, 'bad.json'), '{ not json', 'utf8')
    expect(await store.gcCheckpoints(NOW)).toBe(0)
  })
})

describe('toResumableSummaries', () => {
  it('excludes active ids and maps fields (taskCount = plan.length)', () => {
    const states = [
      mkState({ runId: 'a', status: 'running' }),
      mkState({ runId: 'b', status: 'interrupted' })
    ]
    expect(toResumableSummaries(states, new Set(['a']))).toEqual([
      { runId: 'b', goal: 'ship it', status: 'interrupted', startedAt: '2026-06-24T00:00:00.000Z', updatedAt: '2026-06-24T00:01:00.000Z', taskCount: 1 }
    ])
  })
})
```

- [ ] **Step 3: Run, verify fail** — `npm test -- run-store` → FAIL (`gcCheckpoints`/`toResumableSummaries` missing).

- [ ] **Step 4: Implement** — in `src/main/engine/run-store.ts`: add the import + const + the pure helper + the store method.

Add to imports: `import type { ResumableRun, RunState } from '../../shared/types'` (extend the existing `RunState` type import).

Add a module-level const (near `RESUMABLE`):

```typescript
const MAX_RESUMABLE_AGE_MS = 30 * 24 * 60 * 60 * 1000 // prune resumable checkpoints abandoned > 30 days
```

Add to the `RunStore` interface:

```typescript
  /** GC dead/stale checkpoints: terminal-status (any age) + resumable older than 30 days (by updatedAt). Returns count removed. */
  gcCheckpoints(nowMs: number): Promise<number>
```

Inside `createRunStore`, add the function (and include it in the returned object):

```typescript
  async function gcCheckpoints(nowMs: number): Promise<number> {
    let files: string[]
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
    } catch {
      return 0 // dir not created yet
    }
    let removed = 0
    for (const file of files) {
      let s: RunState
      try {
        s = JSON.parse(await fs.readFile(join(dir, file), 'utf8')) as RunState
      } catch {
        continue // leave unparseable files (rare; listResumable skips them anyway)
      }
      const terminal = !RESUMABLE.has(s.status)
      const staleResumable = !terminal && nowMs - Date.parse(s.updatedAt) > MAX_RESUMABLE_AGE_MS
      if (terminal || staleResumable) {
        await remove(s.runId)
        removed++
      }
    }
    return removed
  }
```

Change the return to `return { put, get, remove, listResumable, gcCheckpoints }`.

Add the pure exported helper at module scope (after `createRunStore` or near `sweepTmpFiles`):

```typescript
/** Map resumable RunStates to lightweight summaries, excluding any currently-active run.
 *  Input is expected pre-filtered to running|interrupted (listResumable) and pre-sorted. */
export function toResumableSummaries(states: RunState[], activeIds: ReadonlySet<string>): ResumableRun[] {
  return states
    .filter((s) => !activeIds.has(s.runId))
    .map((s) => ({
      runId: s.runId,
      goal: s.goal,
      status: s.status as 'running' | 'interrupted',
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      taskCount: s.plan.length
    }))
}
```

- [ ] **Step 5: Run, verify pass** — `npm test -- run-store` → PASS. `npm run typecheck` → PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(p3): gcCheckpoints + toResumableSummaries + ResumableRun type"`

---

### Task 2: Orchestrator wrappers + IPC + preload + types

**Files:**
- Modify: `src/main/engine/orchestrator.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types.ts` (IPC channels + RendererApi)

**Interfaces:**
- Consumes: `toResumableSummaries`, `gcCheckpoints`, `ResumableRun` (Task 1); existing `createRunStore`, `getCheckpointDir`, `active`.
- Produces: `orchestrator.listResumable()`, `orchestrator.discardRun(runId)`, `orchestrator.gcCheckpoints()`; IPC `listResumable`/`discardRun`; `resumeRun` answer optional.

- [ ] **Step 1: Add orchestrator wrappers** — in `src/main/engine/orchestrator.ts`, add `toResumableSummaries` to the `./run-store` import and `ResumableRun` to the types import, then add three exported functions:

```typescript
export async function listResumable(): Promise<ResumableRun[]> {
  const store = createRunStore(getCheckpointDir())
  return toResumableSummaries(await store.listResumable(), new Set(active.keys()))
}

export async function discardRun(runId: string): Promise<void> {
  await createRunStore(getCheckpointDir()).remove(runId)
}

export async function gcCheckpoints(): Promise<void> {
  try {
    await createRunStore(getCheckpointDir()).gcCheckpoints(Date.now())
  } catch {
    // GC is best-effort — never block project open
  }
}
```

- [ ] **Step 2: Add IPC channels + RendererApi** — in `src/shared/types.ts`:

In the `IPC` object (near `resumeRun: 'run:resume'`):

```typescript
  listResumable: 'run:list-resumable',
  discardRun: 'run:discard',
```

In the `RendererApi` interface, change `resumeRun` and add two methods:

```typescript
  resumeRun: (runId: string, answer?: string) => Promise<void>
  listResumable: () => Promise<ResumableRun[]>
  discardRun: (runId: string) => Promise<void>
```

- [ ] **Step 3: Add preload bridges** — in `src/preload/index.ts`, near `resumeRun` (its existing line is unchanged — passing `undefined` works), add:

```typescript
  listResumable: () => ipcRenderer.invoke(IPC.listResumable),
  discardRun: (runId) => ipcRenderer.invoke(IPC.discardRun, runId),
```

- [ ] **Step 4: Add IPC handlers + GC-on-open** — in `src/main/ipc.ts`:

Change the `resumeRun` handler's answer to optional:

```typescript
  ipcMain.handle(IPC.resumeRun, (e: IpcMainInvokeEvent, runId: string, answer?: string) =>
    orchestrator.resumeRun(e.sender, runId, answer)
  )
```

Add two handlers (near the other run handlers):

```typescript
  ipcMain.handle(IPC.listResumable, () => orchestrator.listResumable())
  ipcMain.handle(IPC.discardRun, (_e, runId: string) => orchestrator.discardRun(runId))
```

Make the `openProject` handler run GC after opening (it becomes async):

```typescript
  ipcMain.handle(IPC.openProject, async (_e, path: string) => {
    serverMgr.killAllServers()
    const graph = await store.openProject(path)
    await orchestrator.gcCheckpoints()
    return graph
  })
```

Find the `pickProjectFolder` handler (the launch-screen open path); after it opens a project and before returning the graph, add `await orchestrator.gcCheckpoints()` the same way (only on the branch where a project was actually opened — if it returns null on cancel, don't GC). If `pickProjectFolder` internally delegates to `store.openProject`, GC there is sufficient; verify and avoid double-GC.

- [ ] **Step 5: Verify** — `npm test` → PASS (no behavior change to existing tests). `npm run typecheck` → PASS. `npm run build` → PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(p3): listResumable/discardRun IPC + optional resumeRun answer + GC on open"`

---

### Task 3: Renderer store state + actions

**Files:**
- Modify: `src/renderer/store.ts`

**Interfaces:**
- Consumes: `window.api.listResumable`/`discardRun`/`resumeRun` (Task 2); `ResumableRun` (Task 1).
- Produces: store state `resumable`, `resumableDismissed`; actions `refreshResumable`, `resumeResumable`, `discardResumable`, `dismissResumableBanner`.

- [ ] **Step 1: Add state + actions to the `AppState` interface** — in `src/renderer/store.ts`, add `ResumableRun` to the `../shared/types` import, then add to the `AppState` interface:

```typescript
  resumable: ResumableRun[]
  resumableDismissed: boolean
  refreshResumable: () => Promise<void>
  resumeResumable: (runId: string) => void
  discardResumable: (runId: string) => Promise<void>
  dismissResumableBanner: () => void
```

- [ ] **Step 2: Implement in the store body** — in the `create<AppState>((set, get) => ({ ... }))` object, add the initial state (near `showHistory: false`) and the actions:

```typescript
  resumable: [],
  resumableDismissed: false,

  refreshResumable: async () => set({ resumable: await window.api.listResumable() }),
  resumeResumable: (runId) =>
    set((s) => {
      void window.api.resumeRun(runId) // no answer → crash-recovery resume
      return {
        resumable: s.resumable.filter((r) => r.runId !== runId),
        showRunView: true,
        showHistory: false,
        activeDockId: 'run'
      }
    }),
  discardResumable: async (runId) => {
    await window.api.discardRun(runId)
    set({ resumable: await window.api.listResumable() })
  },
  dismissResumableBanner: () => set({ resumableDismissed: true }),
```

- [ ] **Step 3: Verify** — `npm run typecheck` → PASS. `npm test` → PASS. `npm run build` → PASS.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(p3): renderer store resumable state + resume/discard/refresh actions"`

---

### Task 4: Renderer UI — banner, badge, History section

**Files:**
- Modify: `src/renderer/App.tsx` (banner + History-button badge + refresh-on-open)
- Modify: `src/renderer/run/HistoryView.tsx` ("Resumable" section)

**Interfaces:**
- Consumes: store `resumable`/`resumableDismissed` + the 4 actions (Task 3); `requestConfirm`/`openHistory` (existing).

- [ ] **Step 1: Refresh resumable on every project open** — in `src/renderer/App.tsx`, select the action near the other store selectors: `const refreshResumable = useStore((s) => s.refreshResumable)`. In the App-level `onOpen` handler (used by the launch-screen pick + recent-project paths) and the top-bar **Switch project** onClick, after the project is set (`onOpen(g)` / `setGraph(g)`), call `void refreshResumable()`. If `onOpen` is a single shared handler, adding the call there covers both launch paths; the switch-project onClick needs it too. Example for the switch-project button:

```typescript
  onClick={async () => {
    const g = await window.api.pickProjectFolder()
    if (g) { setGraph(g); void refreshResumable() }
  }}
```

- [ ] **Step 2: Add the History-button badge** — in `src/renderer/App.tsx`, select `const resumable = useStore((s) => s.resumable)` and render a count on the History button:

```tsx
  <button className="btn" title="Run history" onClick={() => openHistory()}>
    <Clock size={14} />
    {resumable.length > 0 && <span className="badge">{resumable.length}</span>}
  </button>
```

- [ ] **Step 3: Add the resumable banner** — in `src/renderer/App.tsx`, select `resumableDismissed`, `openHistory`, `dismissResumableBanner`. Render a dismissible banner just inside the main app container (above the `<div className="topbar">`), shown only when there are resumable runs and it isn't dismissed:

```tsx
  {resumable.length > 0 && !resumableDismissed && (
    <div className="resume-banner">
      <span>{resumable.length} run{resumable.length > 1 ? 's' : ''} can be resumed.</span>
      <button className="btn tiny" onClick={() => openHistory()}>View</button>
      <button className="btn tiny" onClick={() => dismissResumableBanner()}>Dismiss</button>
    </div>
  )}
```

Add minimal CSS to `src/renderer/styles.css` for `.resume-banner` (a thin bar) and `.badge` (a small count pill) — e.g.:

```css
.resume-banner { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: #2d2a1e; border-bottom: 1px solid #4a432a; font-size: 13px; }
.badge { margin-left: 4px; background: #b54; color: #fff; border-radius: 8px; padding: 0 5px; font-size: 11px; }
```

- [ ] **Step 4: Add the "Resumable" section to HistoryView** — in `src/renderer/run/HistoryView.tsx`, pull the store pieces and render a section above the finalized-runs `.hist-list`. Add near the top of the component:

```tsx
  const resumable = useStore((s) => s.resumable)
  const resumeResumable = useStore((s) => s.resumeResumable)
  const discardResumable = useStore((s) => s.discardResumable)
  const requestConfirm = useStore((s) => s.requestConfirm)
  const setShowRunView = useStore((s) => s.setShowRunView)
```

Render this block immediately inside `<div className="history">`, before the existing `<div className="hist-list">`:

```tsx
      {resumable.length > 0 && (
        <div className="hist-list resumable">
          <div className="hist-list-head"><span>Resumable ({resumable.length})</span></div>
          {resumable.map((r) => (
            <div key={r.runId} className="hist-row">
              <div className="hist-goal">{r.goal || '(no goal)'}</div>
              <div className="hist-meta">
                <span className={`run-pill ${r.status === 'interrupted' ? 'st-skipped' : 'st-error'}`}>
                  {r.status === 'interrupted' ? 'Paused' : 'Crashed'}
                </span>
                <span>{fmt(r.startedAt)}</span>
                <span>· {r.taskCount} tasks</span>
                <button className="btn tiny" onClick={() => { resumeResumable(r.runId); setShowRunView(true) }}>Resume</button>
                <button
                  className="btn tiny"
                  onClick={async () => {
                    const ok = await requestConfirm({ title: 'Discard this run?', body: 'Its recovery checkpoint is deleted permanently.', confirmLabel: 'Discard', danger: true })
                    if (ok) void discardResumable(r.runId)
                  }}
                >Discard</button>
              </div>
            </div>
          ))}
        </div>
      )}
```

(`fmt` already exists in this file; `useStore` is already imported.)

- [ ] **Step 5: Verify** — `npm run typecheck` → PASS. `npm test` → PASS. `npm run build` → PASS.

- [ ] **Step 6: Manual-smoke note (describe, not automate)** — in the report, note that with a leftover `running`/`interrupted` checkpoint, the banner + badge + History "Resumable" section appear, Resume calls `resumeRun(runId)` (no answer), and Discard confirms then removes. (A full Playwright pass is part of the cycle's live-verify, not this task.)

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(p3): resumable banner + History-button badge + Resumable section"`

---

## Self-Review (completed by plan author)

- **Spec coverage:** §2 store core → Task 1. §2.3 orchestrator wrappers + §3 IPC/preload/types + §3 GC-on-open → Task 2. §4 type → Task 1. §5 renderer store → Task 3. §6 banner/badge/section → Task 4. §7 semantics honored (manual; no-answer resume; discard removes; GC terminal+old). §8 testing approach (pure tests Task 1; renderer tsc+build) honored. §9 non-goals respected. All sections mapped.
- **Placeholder scan:** every code step shows code; the one soft spot (Task 2 Step 4 `pickProjectFolder` handler shape, Task 4 Step 1 `onOpen` shape) gives explicit guidance to mirror the existing handler/verify, not a silent TBD.
- **Type consistency:** `ResumableRun` shape identical in Tasks 1/2/3/4; `gcCheckpoints(nowMs)` / `toResumableSummaries(states, activeIds)` signatures defined in Task 1 and consumed identically in Task 2; `resumeRun(runId, answer?)` consistent across types/preload/handler/store.
- **Build-green-per-task:** Task 1 additive (type + store method); Task 2 additive IPC + optional resumeRun (existing `answerInterrupt` still passes a string — valid); Task 3 additive store; Task 4 UI consumes Task 3. Each compiles independently.
