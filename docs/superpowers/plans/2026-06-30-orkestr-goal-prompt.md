# Orkestr Goal & Prompt (past-prompts picker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight "Recent" picker to the goal bar that lists past run goals as short labels and inserts a chosen one into the prompt textarea.

**Architecture:** A pure `recent-prompts.ts` (TDD) derives the short label (`promptLabel`) and the deduped/sorted/capped recent list (`recentGoals`). A thin `RecentPrompts` dropdown loads `listRuns()` on open, maps through the helpers, and calls `onPick` to set the goal; `GoalBar` renders it with `onPick={setGoal}`.

**Tech Stack:** React 19, zustand 5, electron-vite (vite 7), vitest, lucide-react. Foundation tokens on main.

## Global Constraints

- Past goals come from `window.api.listRuns()` → `RunSummary[]` = `{ file: string; goal: string; startedAt: string; status; taskCount }`.
- Heuristic labels only (no AI/engine/IPC pipeline). Select-and-insert only — picking REPLACES the textarea contents.
- History tab + its AI overview, run records, and `listRuns` are unchanged.
- Reuse Foundation tokens (`--surface-2`, `--surface-hover`, `--hairline-strong`, `--fg`, `--fg-dim`, `--radius*`, `--space-*`, `--text-sm`, `--elev-2`); mirror the existing `.topmenu` dropdown look.
- Scope: `src/renderer/run/recent-prompts.ts` (+test), `src/renderer/run/RecentPrompts.tsx`, `src/renderer/run/GoalBar.tsx` (render only), `styles.css`.
- Testing: pure logic TDD'd; component by typecheck + build + live. Implementers run `npm run typecheck` + focused `vitest`; the controller runs the full `npm run build` (~9 min, drops agent connections) at the integration gate.
- Commit after every task.

---

### Task 1: Pure recent-prompts helpers — TDD

**Files:**
- Create: `src/renderer/run/recent-prompts.ts`
- Test: `src/renderer/run/recent-prompts.test.ts`

**Interfaces:**
- Produces:
  - `promptLabel(goal: string, maxLen?: number): string`
  - `recentGoals(runs: { goal: string; startedAt: string }[], cap?: number): string[]`

- [ ] **Step 1: Write the failing test** — create `src/renderer/run/recent-prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { promptLabel, recentGoals } from './recent-prompts'

describe('promptLabel', () => {
  it('uses the first non-empty line with whitespace collapsed', () => {
    expect(promptLabel('  add   dark   mode  \nmore detail')).toBe('add dark mode')
  })
  it('skips leading blank lines', () => {
    expect(promptLabel('\n\n  hello')).toBe('hello')
  })
  it('returns (no goal) for empty/whitespace', () => {
    expect(promptLabel('   \n  ')).toBe('(no goal)')
  })
  it('truncates long goals with an ellipsis', () => {
    expect(promptLabel('x'.repeat(60), 10)).toBe('xxxxxxxxxx…')
  })
  it('leaves short goals unchanged', () => {
    expect(promptLabel('hello')).toBe('hello')
  })
})

describe('recentGoals', () => {
  const runs = [
    { goal: 'first', startedAt: '2026-06-01T10:00:00Z' },
    { goal: 'second', startedAt: '2026-06-03T10:00:00Z' },
    { goal: 'first', startedAt: '2026-06-02T10:00:00Z' },
    { goal: '   ', startedAt: '2026-06-04T10:00:00Z' }
  ]
  it('sorts most-recent first, drops empties, dedups keeping the most recent', () => {
    expect(recentGoals(runs)).toEqual(['second', 'first'])
  })
  it('caps the count', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      goal: `g${i}`,
      startedAt: `2026-06-01T00:00:${String(i).padStart(2, '0')}Z`
    }))
    expect(recentGoals(many, 5)).toHaveLength(5)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/run/recent-prompts.test.ts`
Expected: FAIL — cannot resolve `./recent-prompts`.

- [ ] **Step 3: Write the implementation** — create `src/renderer/run/recent-prompts.ts`:

```ts
/** A short, single-line label for a goal: first non-empty line, whitespace
 *  collapsed, truncated with an ellipsis. Empty → "(no goal)". Pure. */
export function promptLabel(goal: string, maxLen = 48): string {
  const firstLine = goal.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? ''
  const collapsed = firstLine.replace(/\s+/g, ' ').trim()
  if (!collapsed) return '(no goal)'
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen).trimEnd()}…` : collapsed
}

/** Recent run goals for the picker: most-recent first (by startedAt), empties
 *  dropped, duplicates removed (keeping the most recent), capped. Pure. */
export function recentGoals(runs: { goal: string; startedAt: string }[], cap = 12): string[] {
  const sorted = [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of sorted) {
    const key = r.goal.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(r.goal)
    if (out.length >= cap) break
  }
  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/run/recent-prompts.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/run/recent-prompts.ts src/renderer/run/recent-prompts.test.ts
git commit -m "feat(orkestr): pure recent-prompts helpers (promptLabel, recentGoals)"
```

---

### Task 2: "Recent" picker component + GoalBar integration

**Files:**
- Create: `src/renderer/run/RecentPrompts.tsx`
- Modify: `src/renderer/run/GoalBar.tsx` (import + render the picker)
- Modify: `src/renderer/styles.css` (picker styles)

**Interfaces:**
- Consumes: `recentGoals`, `promptLabel` from `./recent-prompts`; `window.api.listRuns()`.
- Produces: `RecentPrompts({ onPick }: { onPick: (goal: string) => void })` (default export).

This task is wiring + visual — verify by typecheck + live render.

- [ ] **Step 1: Create `src/renderer/run/RecentPrompts.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { recentGoals, promptLabel } from './recent-prompts'

export default function RecentPrompts({ onPick }: { onPick: (goal: string) => void }) {
  const [open, setOpen] = useState(false)
  const [goals, setGoals] = useState<string[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false)
      return
    }
    const runs = await window.api.listRuns()
    setGoals(recentGoals(runs))
    setOpen(true)
  }

  return (
    <div className="recent-menu" ref={ref}>
      <button className="btn" onClick={() => void toggle()} title="Reuse a recent prompt">
        <Clock size={14} /> Recent
      </button>
      {open && (
        <div className="recent-list">
          {goals.length === 0 ? (
            <div className="recent-empty">No past prompts yet.</div>
          ) : (
            goals.map((g, i) => (
              <button
                key={i}
                className="recent-item"
                title={g}
                onClick={() => {
                  onPick(g)
                  setOpen(false)
                }}
              >
                {promptLabel(g)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Render it in `GoalBar.tsx`**

Add the import with the other component imports:
```tsx
import RecentPrompts from './RecentPrompts'
```
Render it after the `goal-target` hint span and before the `goal-tools` span (so the row reads: textarea, target hint, Recent, tools, Run). Insert:
```tsx
      <span className="goal-target" title="The goal is given to this Orchestrator">
        <Target size={12} /> {hint}
      </span>
      <RecentPrompts onPick={setGoal} />
      <span className="goal-tools">
```
(`setGoal` is the existing goal state setter; picking a prompt replaces the textarea contents. No other GoalBar change.)

- [ ] **Step 3: Add CSS to `src/renderer/styles.css`** (mirrors the `.topmenu` dropdown):

```css
.recent-menu { position: relative; display: inline-flex; }
.recent-list {
  position: absolute; top: 100%; left: 0; margin-top: 4px;
  background: var(--surface-2); border: 1px solid var(--hairline-strong);
  border-radius: var(--radius); box-shadow: var(--elev-2); padding: 4px;
  display: flex; flex-direction: column; min-width: 240px; max-width: 360px;
  max-height: 320px; overflow-y: auto; z-index: 60;
}
.recent-item {
  display: block; width: 100%; padding: 7px 10px; background: none; border: none;
  color: var(--fg); font-size: var(--text-sm); border-radius: var(--radius-sm);
  text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.recent-item:hover { background: var(--surface-hover); }
.recent-empty { padding: 8px 10px; color: var(--fg-dim); font-size: var(--text-sm); }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes clean. (Do NOT run the full build — controller handles it.)

- [ ] **Step 5: Live-verify (controller/user)**

Note GUI live-verify is deferred: with past runs present, click "Recent" → a deduped, most-recent-first list of short labels (full goal on hover); pick one → the goal box fills with it; click outside → closes; no past runs → "No past prompts yet."

- [ ] **Step 6: Commit**

```bash
git add src/renderer/run/RecentPrompts.tsx src/renderer/run/GoalBar.tsx src/renderer/styles.css
git commit -m "feat(orkestr): Recent past-prompts picker in the goal bar"
```

---

## Self-Review

**Spec coverage:**
- §3 pure helpers (`promptLabel` first-line/collapse/empty/truncate; `recentGoals` sort/dedup/drop-empty/cap) → Task 1. ✓
- §4 Recent picker (button, load-on-open, dropdown of labels w/ full-goal title, pick→setGoal+close, click-outside, empty state) → Task 2. ✓
- §6 architecture (pure module + thin component + GoalBar render-only) → Tasks 1/2. ✓
- §7 testing (helpers TDD'd; component typecheck+live) → Task 1 TDD; Task 2 typecheck+live. ✓
- §8 acceptance → all mapped; out-of-scope (§5) respected (heuristic only, select-and-insert replace, History/listRuns untouched).

**Placeholder scan:** No TBD/TODO; helpers + component + CSS are complete. CSS values baseline/live-tunable.

**Type consistency:** `promptLabel(goal, maxLen?) → string` and `recentGoals(runs, cap?) → string[]` (Task 1) consumed with identical signatures in Task 2; `recentGoals` accepts `RunSummary[]` structurally (`{goal, startedAt}`). `RecentPrompts({ onPick })` rendered with `onPick={setGoal}` (matches `setGoal: (v: string) => void`).
