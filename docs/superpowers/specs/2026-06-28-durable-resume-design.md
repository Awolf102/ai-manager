# Durable Resume — Design (cycle P3)

**Date:** 2026-06-28
**Cycle:** P3 from `docs/audits/2026-06-27-remediation-cycles.md`
**Audit findings closed:** #11 (crash-recovery dead — `listResumable` unused, checkpoints leak forever) +
#12 (HITL pause has no UI recovery path on renderer reload/crash).

---

## 1. Principle

Durability is already **paid for** — `runGraph` writes a checkpoint to `runs/.checkpoints/<runId>.json`
after every node, and the engine's resume machinery works end-to-end (`resumeRun(runId, undefined)` →
`resumeDrive` re-emits `run-started` → `resumeGraph` continues from the saved cursor). But it is **inert**:
`listResumable` has zero production callers, nothing surfaces a crashed/paused run in the UI, `resumeRun`'s
answer is typed required (no no-answer call path), and checkpoints only get removed on graceful completion —
so every crash/force-quit leaks one forever.

P3 wires the existing machinery to a **minimal UI** (surface → resume/discard) and adds **garbage collection**,
without changing the run-while-active flow. No new engine resume logic — the resume path already exists.

---

## 2. Engine / store

### 2.1 Garbage collection (`src/main/engine/run-store.ts`)

Add to the `RunStore` interface + `createRunStore` factory:

```
gcCheckpoints(nowMs: number): Promise<number>   // returns count removed
```

For each `*.json` checkpoint in `dir`, parse it and **remove** when either:
- its `status` is **terminal** (`completed` | `cancelled` | `error`) — a dead leak from a crash in the
  remove-window; OR
- its `status` is resumable (`running` | `interrupted`) but **`nowMs - Date.parse(updatedAt) >
  MAX_RESUMABLE_AGE_MS`** (the ~30-day age prune — an abandoned crash whose agent sessions are likely
  unresumable anyway).

`MAX_RESUMABLE_AGE_MS = 30 * 24 * 60 * 60 * 1000`. Parse failures are **left alone** (rare with `atomicWrite`;
`listResumable` already skips them; deleting an unreadable file is riskier than leaving it). `nowMs` is a
parameter so the GC is deterministically unit-testable. Reuse the existing `RESUMABLE` set to classify status.

### 2.2 Resumable summary mapping (pure helper)

`listResumable()` returns full `RunState[]`; the renderer needs lightweight summaries and must not see a
**currently-active** run as "resumable." Add a pure helper (in `run-store.ts` or a small sibling module, no
node/DOM imports):

```
toResumableSummaries(states: RunState[], activeIds: ReadonlySet<string>): ResumableRun[]
```

Filters out `states` whose `runId ∈ activeIds`, maps each remaining state to a `ResumableRun` (§4), preserving
the newest-first order `listResumable` already produced.

### 2.3 Orchestrator wrappers (`src/main/engine/orchestrator.ts`)

The orchestrator owns the in-memory `active: Map<string, AbortController>` and already builds a store via
`createRunStore(getCheckpointDir())`. Add three exported functions, each creating a store the same way:

- `listResumable(): Promise<ResumableRun[]>` — `toResumableSummaries(await store.listResumable(), new Set(active.keys()))`.
- `discardRun(runId: string): Promise<void>` — `store.remove(runId)`.
- `gcCheckpoints(): Promise<void>` — best-effort `store.gcCheckpoints(Date.now())` wrapped in try/catch
  (GC must never block project open).

`resumeRun(wc, runId, resumeInput?)` already accepts an optional `resumeInput` and routes a missing one to the
crash-recovery path — **no engine change needed**; only the IPC/preload/renderer types below must stop forcing
an answer.

---

## 3. IPC + preload + open-time GC

`src/shared/types.ts` (the `IPC` channel object + the `RendererApi` type) and `src/preload/index.ts`:

- New channel `listResumable: 'run:list-resumable'` → `() => Promise<ResumableRun[]>`.
- New channel `discardRun: 'run:discard'` → `(runId: string) => Promise<void>`.
- **Change `resumeRun`** in `RendererApi` + the preload bridge + the `ipc.ts` handler from
  `(runId, answer: string)` to `(runId, answer?: string)`; the handler passes `answer` straight through to
  `orchestrator.resumeRun(e.sender, runId, answer)` (undefined ⇒ crash-recovery).

`src/main/ipc.ts`:
- Register the two new handlers (`orchestrator.listResumable` / `orchestrator.discardRun`).
- The `openProject` handler calls `await orchestrator.gcCheckpoints()` **after** `store.openProject(path)`
  (the project must be current for `getCheckpointDir()` to resolve), best-effort.

---

## 4. Shared type

`src/shared/types.ts`:

```typescript
/** A crashed ('running') or paused ('interrupted') run that can be resumed from its checkpoint. */
export interface ResumableRun {
  runId: string
  goal: string
  status: 'running' | 'interrupted'
  startedAt: string
  updatedAt: string
  taskCount: number // plan.length
}
```

---

## 5. Renderer store (`src/renderer/store.ts`)

Add to the app state:
- `resumable: ResumableRun[]` (default `[]`), `resumableDismissed: boolean` (default `false`).

Actions:
- `refreshResumable()` — `set({ resumable: await window.api.listResumable() })`. Called whenever a project is
  opened (and from the History view's Refresh).
- `resumeResumable(runId)` — `void window.api.resumeRun(runId)` (no answer); optimistically drop that id from
  `resumable`, set `showRunView`/`activeDockId='run'`. The engine re-emits `run-started` (and, for an
  `interrupted` run, re-emits `interrupt`), which the existing `applyOrchestration` already renders.
- `discardResumable(runId)` — `await window.api.discardRun(runId)` then `refreshResumable()`.
- `dismissResumableBanner()` — `set({ resumableDismissed: true })`.

**Open wiring:** every project-open path (App.tsx: pick-folder, open-recent, switch-project) calls
`refreshResumable()` and resets `resumableDismissed: false` after `setGraph`.

---

## 6. Renderer UI

**Banner (App.tsx).** When `resumable.length > 0 && !resumableDismissed`, render a dismissible banner:
"N run(s) can be resumed." with **View** (`openHistory()`) and **Dismiss** (`dismissResumableBanner()`).
Minimal styling (overhaul will redo).

**History button badge (App.tsx).** The existing History button shows a small count/dot when
`resumable.length > 0`.

**HistoryView "Resumable" section (`src/renderer/run/HistoryView.tsx`).** Above the finalized-runs list, when
`resumable.length > 0`, render a "Resumable" group. Each row: goal, a status pill (**Paused** for
`interrupted`, **Crashed** for `running`), `startedAt`, and **[Resume]** / **[Discard]**.
- Resume → `resumeResumable(runId)` then close History + show the run view.
- Discard → gated by the U1 `requestConfirm` ("Discard this run? Its recovery checkpoint is deleted."), then
  `discardResumable(runId)`.

Empty (`resumable.length === 0`) ⇒ no banner, no badge, no section.

---

## 7. Resume semantics (decided)

- **Manual only** — never auto-resume (re-running agents costs tokens; unsafe under bypass).
- `running` checkpoint (crashed) → resume from the saved cursor (engine re-emits `run-started`, rebuilds view).
- `interrupted` checkpoint (paused) → resume re-enters the paused node → re-emits `interrupt` → the question
  modal re-appears (this is the #12 reload-recovery).
- **Discard** → remove the checkpoint; no History record (the run never finished).
- **GC** → on open: remove terminal-status checkpoints (any age) + resumable checkpoints older than 30 days.

---

## 8. Testing

**Pure / store (`src/main/engine/run-store.test.ts`):**
- `gcCheckpoints(now)` with a temp `createRunStore(dir)`: a `completed`/`cancelled`/`error` checkpoint is
  removed; a recent `running`/`interrupted` checkpoint is **kept**; a `running`/`interrupted` checkpoint with
  `updatedAt` > 30 days before `now` is removed; a corrupt file is left; returns the removed count.
- `toResumableSummaries`: excludes ids in `activeIds`; maps `status`/`goal`/`taskCount`(=plan.length)/times;
  preserves order.
- `listResumable` (existing) still returns running/interrupted only — unchanged.

**Renderer store + UI:** verified by **`tsc` (node+web) + `build`**, matching the codebase convention — there
are **no renderer unit tests** (vitest runs in a node env; only pure helpers are unit-tested, and prior cycles
verified renderer/store changes via tsc+build+live-smoke). The renderer actions are thin pass-throughs over
`window.api`; their correctness is carried by the typed IPC contract. The **no-answer resume path** itself
(`resumeRun(runId, undefined)` → crash recovery) is already covered by the existing engine tests
(`graph.test.ts` resume cases) — this cycle only makes the renderer-facing arg optional.

**Off/empty byte-for-byte:** no checkpoints ⇒ `listResumable` returns `[]` ⇒ no banner/badge/section; the
on-open GC over an empty/absent dir is a no-op. Existing run/resume flows unchanged. Full suite stays green
(337) + net-new tests; tsc(node+web) + build clean.

---

## 9. Scope / non-goals

- **No auto-resume** (manual only — safety + token cost).
- **No change to the active-run flow** (start/stop/HITL-answer paths untouched; `resumeRun`'s engine behavior
  is unchanged — only its renderer-facing arg becomes optional).
- **Not the deferred #30 HITL UX** (Skip relabel, in-modal abort) — though Discard now lets a stranded paused
  run be abandoned from the resumable list.
- Parse-failed (corrupt) checkpoints are not auto-deleted (rare; skipped by `listResumable`; low value, real
  risk) — left as a known minor.
- Minimal banner/section/badge UI — the Orkestr overhaul will redo these surfaces.

---

## 10. File-by-file

| File | Change |
|---|---|
| `src/main/engine/run-store.ts` | + `gcCheckpoints(nowMs)` on the store; + pure `toResumableSummaries`. |
| `src/main/engine/orchestrator.ts` | + `listResumable`/`discardRun`/`gcCheckpoints` wrappers (use `active` + `getCheckpointDir`). |
| `src/main/ipc.ts` | + `listResumable`/`discardRun` handlers; `resumeRun` answer optional; `openProject` runs GC. |
| `src/preload/index.ts` | + `listResumable`/`discardRun`; `resumeRun(runId, answer?)`. |
| `src/shared/types.ts` | + `ResumableRun`; + 2 `IPC` channels; `RendererApi` `resumeRun` answer optional + 2 methods. |
| `src/renderer/store.ts` | + `resumable`/`resumableDismissed` state + 4 actions; open-time refresh. |
| `src/renderer/App.tsx` | + resumable banner + History-button badge + refresh-on-open wiring. |
| `src/renderer/run/HistoryView.tsx` | + "Resumable" section (Resume/Discard rows). |
| `*.test.ts` | run-store GC + summaries tests; renderer store action tests. |
