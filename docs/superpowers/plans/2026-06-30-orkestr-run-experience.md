# Orkestr Run Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the live Run view: Narration/Terminal as full-height toggle tabs, a run-complete banner + a Result tab rendering `run.final`, and run errors/completions surfaced via the Foundation Toast.

**Architecture:** A pure `run/run-status.ts` (TDD) computes the completion banner, the toast-when-away decision, and the run-end toast payload — shared by RunView and the store so banner and toast never diverge. RunView keeps the agent-chain tree as its left column and turns the right pane into Narration | Terminal | Result toggle tabs (slots stay mounted, visibility toggles — like the dock). The store's `run-finished` case raises a toast only when the user isn't on the Run tab. GoalBar's run-action and run-start failures route to `notify`.

**Tech Stack:** React 19, zustand 5, electron-vite (vite 7), vitest, @xterm/xterm. Foundation tokens/primitives/Toast + Shell/IA dock already on main.

## Global Constraints

- Builds on Foundation + Shell/IA (on main). Reuse existing tokens (`--surface-*`, `--state-good`, `--state-danger`, `--fg*`, `--hairline*`, `--space-*`, `--text-*`, `--weight-medium`, `--radius-*`, `--lh-normal`) and `notify`/`addToast`. Do not redefine tokens.
- `run.final` renders as plain `<pre>` (no markdown lib — match History's `<pre>{record.final}</pre>`).
- Keep the agent-chain tree as the Run view's left column; only the right pane (narration/terminal) becomes toggle tabs. Default tab `narration`.
- Result tab appears only when `run.final` is non-empty; auto-select it on a successful finish only (never on failure).
- Banner: green "✓ Run complete" / red "✗ Run failed: <error>"; shown only when a run has finished (`running===false && runId`).
- Run-end toast only when NOT viewing the Run tab (`activeDockId !== 'run' || !dockOpen`); silent when viewing it.
- GoalBar: replace the 3 run-action `window.alert`s and add try/catch to `start()` — all via `notify({kind:'error'})`. No other GoalBar logic changes.
- Scope: RunView, store `run-finished` only, GoalBar, `run-status.ts`, styles.css. No canvas/settings/context, no past-prompts picker, dock/panel system untouched.
- Testing: pure logic TDD'd (`run-status.ts`); rest typecheck + build + live. Implementers run `npm run typecheck` + focused `vitest`; the controller runs the full `npm run build` (~9 min, drops agent connections) at the integration gate.
- Commit after every task.

---

### Task 1: Pure run-status module (`run-status.ts`) — TDD

**Files:**
- Create: `src/renderer/run/run-status.ts`
- Test: `src/renderer/run/run-status.test.ts`

**Interfaces:**
- Produces:
  - `interface RunBanner { kind: 'success' | 'failure'; text: string }`
  - `runBanner(run: { runId: string | null; running: boolean; error?: string }): RunBanner | null`
  - `shouldToastRunEnd(view: { activeDockId: string | null; dockOpen: boolean }): boolean`
  - `runEndToast(error?: string): { kind: 'success' | 'error'; message: string }`

- [ ] **Step 1: Write the failing test** — create `src/renderer/run/run-status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runBanner, shouldToastRunEnd, runEndToast } from './run-status'

describe('runBanner', () => {
  it('is null when no run has started', () => {
    expect(runBanner({ runId: null, running: false })).toBeNull()
  })
  it('is null while running', () => {
    expect(runBanner({ runId: 'r1', running: true })).toBeNull()
  })
  it('is success when finished with no error', () => {
    expect(runBanner({ runId: 'r1', running: false })).toEqual({ kind: 'success', text: 'Run complete' })
  })
  it('is failure with the error message when finished with an error', () => {
    expect(runBanner({ runId: 'r1', running: false, error: 'boom' })).toEqual({ kind: 'failure', text: 'Run failed: boom' })
  })
})

describe('shouldToastRunEnd', () => {
  it('is false when viewing the Run tab', () => {
    expect(shouldToastRunEnd({ activeDockId: 'run', dockOpen: true })).toBe(false)
  })
  it('is true when on another dock tab', () => {
    expect(shouldToastRunEnd({ activeDockId: 'history', dockOpen: true })).toBe(true)
  })
  it('is true when the dock is hidden even if Run is the active id', () => {
    expect(shouldToastRunEnd({ activeDockId: 'run', dockOpen: false })).toBe(true)
  })
  it('is true when nothing is active', () => {
    expect(shouldToastRunEnd({ activeDockId: null, dockOpen: true })).toBe(true)
  })
})

describe('runEndToast', () => {
  it('is a success toast with no error', () => {
    expect(runEndToast()).toEqual({ kind: 'success', message: 'Run complete' })
  })
  it('is an error toast with the message when failed', () => {
    expect(runEndToast('boom')).toEqual({ kind: 'error', message: 'Run failed: boom' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/run/run-status.test.ts`
Expected: FAIL — cannot resolve `./run-status`.

- [ ] **Step 3: Write the implementation** — create `src/renderer/run/run-status.ts`:

```ts
export interface RunBanner {
  kind: 'success' | 'failure'
  text: string
}

/** The completion banner for a finished run, or null while idle/running. Pure. */
export function runBanner(run: { runId: string | null; running: boolean; error?: string }): RunBanner | null {
  if (!run.runId || run.running) return null
  return run.error ? { kind: 'failure', text: `Run failed: ${run.error}` } : { kind: 'success', text: 'Run complete' }
}

/** True when the user is NOT viewing the live Run tab (so a run-end deserves a toast). Pure. */
export function shouldToastRunEnd(view: { activeDockId: string | null; dockOpen: boolean }): boolean {
  return view.activeDockId !== 'run' || !view.dockOpen
}

/** The toast payload for a run that just ended. Pure. */
export function runEndToast(error?: string): { kind: 'success' | 'error'; message: string } {
  return error ? { kind: 'error', message: `Run failed: ${error}` } : { kind: 'success', message: 'Run complete' }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/run/run-status.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/run/run-status.ts src/renderer/run/run-status.test.ts
git commit -m "feat(orkestr): pure run-status (banner, toast-when-away, run-end toast)"
```

---

### Task 2: Run-end toast-when-away in the store

**Files:**
- Modify: `src/renderer/store.ts` (import + the `run-finished` case)

**Interfaces:**
- Consumes: `shouldToastRunEnd`, `runEndToast` from `./run/run-status`; existing `addToast` + `Toast` (already imported).

- [ ] **Step 1: Add the import** to `src/renderer/store.ts` (near the other local imports):

```ts
import { shouldToastRunEnd, runEndToast } from './run/run-status'
```

- [ ] **Step 2: Replace the `run-finished` case** — find it in `applyOrchestration`:

```ts
        case 'run-finished':
          run.running = false
          run.error = e.error
          return { run }
```

Replace it with:

```ts
        case 'run-finished': {
          run.running = false
          run.error = e.error
          if (shouldToastRunEnd({ activeDockId: s.activeDockId, dockOpen: s.dockOpen })) {
            const t = runEndToast(e.error)
            const toast: Toast = { id: crypto.randomUUID(), kind: t.kind, message: t.message, createdAt: Date.now() }
            return { run, toasts: addToast(s.toasts, toast) }
          }
          return { run }
        }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes clean. (Do NOT run the full build — controller handles it.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store.ts
git commit -m "feat(orkestr): toast on run end when not viewing the Run tab"
```

---

### Task 3: RunView — completion banner + Narration/Terminal/Result toggle tabs

**Files:**
- Modify: `src/renderer/run/RunView.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `runBanner` from `./run-status`; existing `run.final`/`run.error`/`run.running`/`run.runId` from the store.

This task is UI — verify by typecheck + live render. CSS values are baseline/live-tunable.

- [ ] **Step 1: Add imports + state to `RunView.tsx`**

Add to the React import (it already imports `useEffect, useRef`): include `useState`:
```tsx
import { useEffect, useRef, useState } from 'react'
```
Add the run-status import with the other imports:
```tsx
import { runBanner } from './run-status'
```
Inside `RunView()`, after the existing `const selectStep = ...` line, add the tab state + the auto-select-Result effect:
```tsx
  const [rightTab, setRightTab] = useState<'narration' | 'terminal' | 'result'>('narration')
  const prevRunning = useRef(run.running)
  // Land on the Result tab when a run finishes successfully with a report.
  useEffect(() => {
    if (prevRunning.current && !run.running && run.final && !run.error) setRightTab('result')
    prevRunning.current = run.running
  }, [run.running, run.final, run.error])
```

- [ ] **Step 2: Restructure the `return` in `RunView.tsx`**

Replace the entire `return ( … )` block. Keep the existing `.run-tree` chain rows EXACTLY as they are today (the `run-attempt` / `run-replan` / `run-handoff` / `run-userrequest` blocks and the `chain.map(...)` rows), with ONE removal: delete the `{run.error && <div className="run-error">✗ {run.error}</div>}` line (the banner now shows failure). The new structure wraps the banner above a `.run-main` grid (tree + right), and the right pane becomes tabs + always-mounted slots:

```tsx
  const banner = runBanner(run)
  const hasResult = !!run.final

  return (
    <div className="runview">
      {banner && (
        <div className={`run-banner ${banner.kind}`}>
          {banner.kind === 'success' ? '✓' : '✗'} {banner.text}
        </div>
      )}
      <div className="run-main">
        <div className="run-tree">
          {/* KEEP the existing tree contents verbatim: run-empty, run-attempt,
              run-replan, run-handoff, run-userrequest, and the chain.map rows.
              DELETE only the old `{run.error && <div className="run-error">…}` line. */}
        </div>
        <div className="run-right">
          <div className="run-tabs">
            <button className={`run-tab ${rightTab === 'narration' ? 'active' : ''}`} onClick={() => setRightTab('narration')}>Narration</button>
            <button className={`run-tab ${rightTab === 'terminal' ? 'active' : ''}`} onClick={() => setRightTab('terminal')}>Terminal</button>
            {hasResult && (
              <button className={`run-tab ${rightTab === 'result' ? 'active' : ''}`} onClick={() => setRightTab('result')}>Result</button>
            )}
          </div>
          <div className="run-slots">
            <div className={`run-slot ${rightTab === 'narration' ? 'active' : ''}`}>
              <ActivityFeed runId={run.runId} />
            </div>
            <div className={`run-slot ${rightTab === 'terminal' ? 'active' : ''}`}>
              <div className="run-output" ref={hostRef} />
            </div>
            {hasResult && (
              <div className={`run-slot ${rightTab === 'result' ? 'active' : ''}`}>
                <pre className="run-result">{run.final}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
```

Notes for the implementer:
- The `hostRef` div (`.run-output`) MUST stay mounted (it's inside the always-rendered Terminal slot) so the xterm `useEffect`s keep working — do not conditionally unmount it.
- Do not touch the xterm `useEffect`s or `buildChain`/`STATUS_LABEL`/the chain-row logic above the return.

- [ ] **Step 3: Update the run-view CSS in `src/renderer/styles.css`**

Replace the `.runview` rule and the `.run-right` rule, and replace `.activity-feed`'s sizing, then append the new tab/slot/banner/result rules.

Replace `.runview { … }` (currently `display: grid; grid-template-columns: 230px 1fr; …`) with:
```css
.runview { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.run-main { display: grid; grid-template-columns: 230px 1fr; flex: 1; min-height: 0; overflow: hidden; }
.run-banner { display: flex; align-items: center; gap: var(--space-2); padding: 6px 12px; font-size: var(--text-sm); font-weight: var(--weight-medium); border-bottom: 1px solid var(--hairline); }
.run-banner.success { background: rgba(111, 208, 138, 0.12); color: var(--state-good); }
.run-banner.failure { background: rgba(240, 114, 111, 0.12); color: var(--state-danger); }
```

Replace the `.run-right { … }` rule (the one in the activity-feed section) with:
```css
.run-right { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.run-tabs { display: flex; align-items: stretch; border-bottom: 1px solid var(--hairline); background: var(--surface-1); }
.run-tab { padding: 6px 12px; background: none; border: none; border-right: 1px solid var(--hairline); color: var(--fg-muted); font-size: var(--text-sm); cursor: pointer; }
.run-tab.active { background: var(--surface-0); color: var(--fg); }
.run-slots { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.run-slot { position: absolute; inset: 0; visibility: hidden; overflow: hidden; }
.run-slot.active { visibility: visible; }
.run-result { margin: 0; height: 100%; overflow: auto; padding: 12px 14px; white-space: pre-wrap; font-size: var(--text-sm); line-height: var(--lh-normal); color: var(--fg); }
```

Replace `.run-output { … }` (currently `flex: 1; …`) with a slot-filling version:
```css
.run-output { position: absolute; inset: 0; padding: 6px 8px; background: #0b0c10; }
```

Replace `.activity-feed`'s sizing line `flex: 0 0 38%;` so it fills its slot — change the `.activity-feed` rule to:
```css
.activity-feed { height: 100%; overflow-y: auto; background: var(--surface-1); padding: 4px 0; font-size: var(--text-sm); }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes clean.

- [ ] **Step 5: Live-verify (controller/user)**

Note GUI live-verify is deferred to the controller/user: start a run → Narration/Terminal tabs switch at full height and the terminal keeps its content; selecting agents in the tree repaints the Terminal; on success a green banner shows and the Result tab is auto-selected rendering the report; a failure shows a red banner.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/run/RunView.tsx src/renderer/styles.css
git commit -m "feat(orkestr): run-complete banner + Narration/Terminal/Result toggle tabs"
```

---

### Task 4: GoalBar — route run errors to toasts

**Files:**
- Modify: `src/renderer/run/GoalBar.tsx`

**Interfaces:**
- Consumes: store `notify` action.

- [ ] **Step 1: Add the `notify` selector** in `GoalBar()` (near the other `useStore` selectors):

```tsx
  const notify = useStore((s) => s.notify)
```

- [ ] **Step 2: Replace the 3 run-action alerts** with toasts:

In `buildTeam`:
```tsx
      else notify({ kind: 'error', message: r.error ?? 'Could not build a team.' })
```
In `runResult`:
```tsx
      else notify({ kind: 'error', message: r.error ?? 'Could not detect how to run the result.' })
```
In `draftRoles`:
```tsx
      else notify({ kind: 'error', message: r.error ?? 'Could not draft roles.' })
```

- [ ] **Step 3: Add error handling to `start()`** — replace the `start` function body so a failed run-start surfaces a toast instead of failing silently:

```tsx
  const start = async (): Promise<void> => {
    if (!target || !goal.trim() || running) return
    try {
      const { runId: id } = await window.api.startRun({
        goal: goal.trim(),
        orchestratorId: target.id
      })
      beginRun(id, goal.trim(), target.id)
    } catch (err) {
      notify({ kind: 'error', message: err instanceof Error ? err.message : 'Could not start the run.' })
    }
  }
```

- [ ] **Step 4: Verify no run-action `window.alert` remains in GoalBar**

Run: `grep -n "window.alert" src/renderer/run/GoalBar.tsx`
Expected: no matches.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: passes clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/run/GoalBar.tsx
git commit -m "feat(orkestr): route GoalBar run-action + run-start failures to toasts"
```

---

## Self-Review

**Spec coverage:**
- §3 right-pane toggle tabs (tree left, always-mounted slots, default narration) → Task 3. ✓
- §4 run-complete banner (pure `runBanner`) → Task 1 + Task 3. ✓
- §5 Result tab (appears when `run.final`, `<pre>`, auto-select on success) → Task 3. ✓
- §6.1 GoalBar error toasts + start try/catch → Task 4. ✓
- §6.2 run-end toast-when-away (`shouldToastRunEnd`/`runEndToast`) → Task 1 + Task 2. ✓
- §7 architecture (pure module shared by RunView + store) → Tasks 1–3. ✓
- §8 audit #28 (Task 2 + 4) + #29 (Task 3). ✓
- §10 testing (run-status TDD; rest typecheck+live) → Task 1 TDD; 2–4 typecheck+live. ✓
- §11 acceptance criteria → all mapped; out-of-scope (§9) respected (no canvas/settings/context/past-prompts; dock untouched).

**Placeholder scan:** No TBD/TODO. Pure module + store + GoalBar code is complete; the RunView tree-rows block is an explicit "keep existing verbatim, delete only the run-error line" relocation instruction (not a placeholder) to avoid re-pasting ~60 unchanged lines and risking drift. CSS is concrete (baseline/live-tunable).

**Type consistency:** `runBanner({runId,running,error?})→RunBanner|null`, `shouldToastRunEnd({activeDockId,dockOpen})→boolean`, `runEndToast(error?)→{kind:'success'|'error';message}` (Task 1) are consumed with identical signatures in Task 2 (store) and Task 3 (RunView). `rightTab` union `'narration'|'terminal'|'result'` is consistent across Task 3. `notify({kind,message})` matches the Foundation store action used in Task 4.
