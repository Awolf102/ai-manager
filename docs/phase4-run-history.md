# Phase 4 — Run History Browser (spec + resume note)

## Status (where we are)

- Phases 1–3 + the permissions fix (Autonomy: auto/full/cautious) + the in-app login
  indicator are **all implemented, typecheck-clean, and build-green**.
- A real live run was confirmed working by the user (auto permission mode let the review run
  `pytest`; the review→repair→memory loop fired).
- **This phase (Run history browser) is now IMPLEMENTED** (typecheck-clean, build-green). The
  plan below is the as-built design.

## Goal

Every run is already saved to `.ai-manager/runs/<startedAt>.json` as a `RunRecord` (see
`src/shared/types.ts`), but nothing reads them back. Add a **History** browser: list past runs
and open one read-only to inspect plan, per-task verdicts, each agent's output, reflections,
and the final report.

`RunRecord` shape (already on disk): `{ runId, goal, orchestratorId, startedAt, finishedAt,
status, plan: RunTask[], steps: RunStepRecord[] (each {nodeId,nodeName,kind,status,tasks?,
assignments?,output?}), reviews: {attempt, tasks: TaskVerdict[]}[], reflections:
{nodeId,win,loss,lessons}[], final, error? }`.

## Plan (file by file)

1. **`src/shared/types.ts`**
   - Add `export interface RunSummary { file: string; goal: string; startedAt: string; status: RunStatus; taskCount: number }`.
   - `IPC` += `listRuns: 'runs:list'`, `loadRun: 'runs:load'`.
   - `RendererApi` += `listRuns: () => Promise<RunSummary[]>` and `loadRun: (file: string) => Promise<RunRecord | null>`.

2. **`src/main/engine/project-store.ts`** (it already imports `basename`, `join`, `fs`, `aimPath`, `requireCurrent`, type `RunRecord`)
   - `listRuns()`: read `.ai-manager/runs/`, parse each `*.json`, map to `RunSummary`
     (`taskCount = rec.plan?.length ?? 0`), sort by `startedAt` **descending** (newest first);
     return `[]` if the dir is missing; skip corrupt files.
   - `loadRun(file)`: `const safe = basename(file)` (prevent traversal), read
     `aimPath(path,'runs',safe)`, return parsed `RunRecord` or `null` on error.

3. **`src/main/ipc.ts`**: `ipcMain.handle(IPC.listRuns, () => store.listRuns())` and
   `ipcMain.handle(IPC.loadRun, (_e, file: string) => store.loadRun(file))`.

4. **`src/preload/index.ts`**: `listRuns: () => ipcRenderer.invoke(IPC.listRuns)`,
   `loadRun: (file) => ipcRenderer.invoke(IPC.loadRun, file)`.

5. **`src/renderer/store.ts`**: add `showHistory: boolean` (init false) and
   `openHistory: () => set({ showHistory: true, activeDockId: 'history' })`. (Dock active id
   `'history'` is a pseudo-tab like `'run'`.)

6. **`src/renderer/run/HistoryView.tsx`** (new): on mount `window.api.listRuns()` → list (left
   column: goal, relative/short time, status pill, `taskCount` tasks). Click a row →
   `window.api.loadRun(file)` → detail (right, scrollable, plain formatted text — NOT xterm):
   - Header: goal · status · started/finished.
   - **Final report** (`record.final`).
   - **Review verdicts**: for each `reviews[last]`/all, list `taskId → ✓/✗ + feedback`.
   - **Steps**: each `steps[]` → `nodeName (kind) · status`, assigned `tasks`, and `output`
     (in a `<pre>`).
   - **Reflections**: per `reflections[]` → win / loss / lessons bullets.
   - Empty state when no runs.

7. **`src/renderer/App.tsx`**: add a **History** button in the topbar (lucide `History` icon) →
   `openHistory()`. In the dock: include `showHistory` in `showDock`; add a pinned
   **History** tab (`activeDockId === 'history'`) and a `term-slot` rendering `<HistoryView/>`
   (same active/visibility pattern as the Run slot). Import `HistoryView`.

8. **`src/renderer/styles.css`**: `.history` grid (≈230px list | 1fr detail), `.hist-row`
   (+ `.sel`), `.hist-detail` scroll, `.hist-section`, `<pre>` output styling (reuse muted/
   panel vars). Reuse `.run-pill.st-*` for status where handy.

9. Typecheck + build; update `README.md` (add a line: "Open **History** to browse past runs").

## Notes
- Keep HistoryView read-only and text-based (no live streams, no xterm) — it renders the saved
  strings directly.
- `basename()` on `loadRun` is the only security-relevant bit (path traversal guard).
