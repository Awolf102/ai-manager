# Welcome & First Impression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Craft the app's front door — a distinctive startup welcome (conductor-arc mark + set wordmark, layered card, recent-project cards, tasteful entrance) and a fresh-project canvas onboarding state — plus a polished inspector empty hint.

**Architecture:** A reusable `BrandMark` SVG; a redesigned `ProjectPicker`; a new `CanvasEmptyState` shown when a project has no agents (its primary CTA seeds an Orchestrator and focuses the goal bar via a tiny store signal); and a lighter inspector empty hint. Renderer + CSS + one small store slice; no engine/IPC change.

**Tech Stack:** TypeScript, React, Zustand store, lucide-react, plain CSS with the warm-dark + motion tokens (`--ease-out`, `--motion*`, `--canvas-dot`, `--elev-*`). Electron 42 / Chromium 136.

## Global Constraints

- **Presentational except one behavior:** the ONLY new behavior is the canvas empty-state primary CTA seeding an Orchestrator (`createAgent`) + focusing the goal bar. No engine/IPC/main file changes.
- **Motion:** entrances use `--ease-out`, start from a small `translateY`+opacity (never `scale(0)`), stay short (welcome < ~300ms total; it plays every launch). `prefers-reduced-motion` → opacity only, no movement.
- **Identity:** a single-stroke conductor-arc SVG mark in `var(--accent)` (rose), no fill, no gradient (brand rule); reusable component. Wordmark set in Inter.
- **Warm-dark tokens only, no raw hex** in new CSS (the one warm dot color is `var(--canvas-dot)`, already a token). Calm-conductor voice.
- **Commands:** `npm run typecheck`; `npm run build`; `npm test` (full Vitest suite must stay green). Renderer has no unit tests (house precedent) — verify by typecheck + build + suite; final visual smoke is the user's.

---

### Task 1: Brand mark + crafted startup welcome

**Files:**
- Create: `src/renderer/BrandMark.tsx`
- Modify: `src/renderer/App.tsx` (the `ProjectPicker` function ~line 329)
- Modify: `src/renderer/styles.css` (picker/identity/recent + entrance)

**Interfaces:**
- Produces: `export function BrandMark({ size }: { size?: number }): JSX.Element`.

- [ ] **Step 1: Create `src/renderer/BrandMark.tsx`**

```tsx
/** Orkestr mark — a single confident conductor's arc / baton upbeat in the rose accent. Decorative. */
export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 35 C 14 14, 30 12, 41 21" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="41" cy="21" r="3" fill="var(--accent)" />
    </svg>
  )
}
```

- [ ] **Step 2: Redesign `ProjectPicker` in `src/renderer/App.tsx`**

Add to App.tsx's imports: `import { BrandMark } from './BrandMark'`, and add the `Folder` icon to the existing `lucide-react` import (it already imports `FolderOpen`) — only if `Folder` isn't already imported there.

Replace the whole `ProjectPicker` function body's `return (...)` (currently `<div className="picker"><div className="picker-card"><h1>…</h1><p>…</p><button>…</button>{recents…}</div></div>`) with:

```tsx
  return (
    <div className="picker">
      <div className="picker-card">
        <div className="picker-identity">
          <BrandMark size={48} />
          <h1 className="picker-wordmark">Orkestr</h1>
          <p className="picker-tagline">Conduct a team of agents.</p>
        </div>
        <button
          className="btn primary picker-open"
          onClick={async () => {
            const g = await window.api.pickProjectFolder()
            if (g) onOpen(g)
          }}
        >
          <FolderOpen size={14} /> Open project folder…
        </button>
        {recents.length > 0 && (
          <div className="recent-list">
            <div className="label">Recent</div>
            {recents.map((r) => (
              <button
                className="recent-item"
                key={r.path}
                onClick={async () => {
                  const g = await window.api.openProject(r.path)
                  if (g) onOpen(g)
                }}
              >
                <Folder size={16} className="recent-icon" />
                <span className="recent-meta">
                  <span className="recent-name">{r.name}</span>
                  <span className="path">{r.path}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
```

(The `recents` state + `useEffect` loader above the return are unchanged.)

- [ ] **Step 3: Replace the picker CSS in `src/renderer/styles.css`**

Replace the existing startup-picker rules — `.picker`, `.picker-card`, `.picker-card h1`, `.picker-card p`, `.recent-list`, `.recent-list .label`, `.recent-item`, `.recent-item:hover`, `.recent-item .path` (around lines 178–233; do NOT touch the unrelated `.recent-prompts-*` rules elsewhere) — with:

```css
.picker {
  display: grid;
  place-items: center;
  height: 100%;
  background-color: var(--bg);
  background-image: radial-gradient(circle at 1px 1px, var(--canvas-dot) 1px, transparent 0);
  background-size: 22px 22px;
}
.picker-card {
  width: 460px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 32px;
  box-shadow: var(--elev-2);
}
.picker-identity {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.brand-mark { display: block; }
.picker-wordmark {
  margin: 6px 0 0;
  font-size: 34px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
.picker-tagline {
  margin: 0;
  font-size: 14px;
  color: var(--muted);
}
.picker-open {
  align-self: flex-start;
}
.recent-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.recent-list .label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin-bottom: 4px;
}
.recent-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard),
    transform var(--motion-fast) var(--ease-out);
}
.recent-item:hover {
  background: var(--panel-2);
  border-color: var(--border);
  transform: translateY(-1px);
}
.recent-item:active {
  transform: scale(0.99);
}
.recent-icon {
  flex: 0 0 auto;
  color: var(--muted);
}
.recent-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.recent-name {
  font-size: 13px;
  font-weight: 600;
}
.recent-item .path {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* welcome entrance: identity → open button → recent list rise in */
.picker-card > * {
  animation: picker-rise var(--motion-slow) var(--ease-out) backwards;
}
.picker-card > *:nth-child(1) { animation-delay: 0ms; }
.picker-card > *:nth-child(2) { animation-delay: 60ms; }
.picker-card > *:nth-child(3) { animation-delay: 120ms; }
@keyframes picker-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .picker-card > * { animation: none; }
}
```

- [ ] **Step 4: Typecheck, build, test**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS. (Launching with no project shows the crafted welcome with the arc mark, set wordmark, entrance, and recent-project cards.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/BrandMark.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(welcome): conductor-arc mark + crafted startup ProjectPicker"
```

---

### Task 2: Goal-bar focus signal

**Files:**
- Modify: `src/renderer/store.ts` (add `goalFocusTick` + `focusGoal`)
- Modify: `src/renderer/run/GoalBar.tsx` (textarea ref + focus on the tick)

**Interfaces:**
- Produces: store fields `goalFocusTick: number` and `focusGoal: () => void` (bumps the tick). Consumed by Task 3's empty-state CTA.

- [ ] **Step 1: Add the store slice in `src/renderer/store.ts`**

In the `AppState` interface (near the other action signatures, e.g. after `select`/`toggleDock`), add:

```ts
  goalFocusTick: number
  focusGoal: () => void
```

In the store implementation object (`create<AppState>((set, get) => ({ … }))`), add the initial value and action (place near the other `set`-based actions):

```ts
  goalFocusTick: 0,
  focusGoal: () => set((s) => ({ goalFocusTick: s.goalFocusTick + 1 })),
```

- [ ] **Step 2: Wire the focus in `src/renderer/run/GoalBar.tsx`**

Change the React import on line 1 from `import { useState } from 'react'` to:

```tsx
import { useState, useRef, useEffect } from 'react'
```

Inside `GoalBar`, add the store selector, a textarea ref, and a focus effect (near the other `useStore`/`useState` lines):

```tsx
  const goalFocusTick = useStore((s) => s.goalFocusTick)
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (goalFocusTick > 0) taRef.current?.focus()
  }, [goalFocusTick])
```

Attach the ref to the textarea — change the opening `<textarea` / `className="goal-input"` (lines 108–109) to add `ref={taRef}`:

```tsx
      <textarea
        ref={taRef}
        className="goal-input"
```

- [ ] **Step 3: Typecheck, build, test**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS. (`focusGoal` exists but is unused until Task 3; `goalFocusTick` starts at 0 so the effect never focuses yet — no behavior change.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store.ts src/renderer/run/GoalBar.tsx
git commit -m "feat(welcome): goal-bar focus signal (goalFocusTick / focusGoal)"
```

---

### Task 3: Canvas empty-state onboarding + inspector hint

**Files:**
- Create: `src/renderer/CanvasEmptyState.tsx`
- Modify: `src/renderer/App.tsx` (render the empty state; `handleBuild`; inspector hint)
- Modify: `src/renderer/styles.css` (canvas-empty + inspector-empty)

**Interfaces:**
- Consumes: `BrandMark` (Task 1); `focusGoal` (Task 2); existing `window.api.createAgent`, `setGraph`, `notify`, `setShowAdd`.
- Produces: `CanvasEmptyState` default export.

- [ ] **Step 1: Create `src/renderer/CanvasEmptyState.tsx`**

```tsx
import { Network, Plus } from 'lucide-react'
import { BrandMark } from './BrandMark'

/** Shown over the canvas when a project has no agents yet. */
export default function CanvasEmptyState({ onBuild, onAdd }: { onBuild: () => void; onAdd: () => void }) {
  return (
    <div className="canvas-empty">
      <div className="canvas-empty-card">
        <BrandMark size={34} />
        <h2>Assemble your team</h2>
        <p>
          Your team is led by an <b>Orchestrator</b> who delegates to specialists. Start from a goal and it
          builds the team for you.
        </p>
        <div className="canvas-empty-actions">
          <button className="btn primary" onClick={onBuild}>
            <Network size={14} /> Build a team from a goal
          </button>
          <button className="btn" onClick={onAdd}>
            <Plus size={14} /> Add a single agent
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire it into `src/renderer/App.tsx`**

Add imports: `import CanvasEmptyState from './CanvasEmptyState'`, and add `PanelRight` to the `lucide-react` import (only if not already imported there). In the App component body, add the store selector + the build handler (near the other `useStore` selectors / handlers, where `setGraph` and `notify` are already available):

```tsx
  const focusGoal = useStore((s) => s.focusGoal)
  const handleBuild = async (): Promise<void> => {
    try {
      const g = await window.api.createAgent({ name: 'Orchestrator', kind: 'orchestrator' })
      setGraph(g)
      focusGoal()
    } catch {
      notify({ kind: 'error', message: 'Could not create the Orchestrator.' })
    }
  }
```

Render the empty state inside `canvas-wrap` (line ~170). Change:

```tsx
          <div className="canvas-wrap"><OrgChart /></div>
```

to:

```tsx
          <div className="canvas-wrap">
            <OrgChart />
            {graph.nodes.length === 0 && (
              <CanvasEmptyState onBuild={() => void handleBuild()} onAdd={() => setShowAdd(true)} />
            )}
          </div>
```

- [ ] **Step 3: Polish the inspector empty hint in `src/renderer/App.tsx`**

Replace the inspector `empty-hint` block (line ~190):

```tsx
              <div className="empty-hint">Select an agent to edit its role, memory, and settings.<br /><br />Drag from the <b>bottom</b> of one node to the <b>top</b> of another to make it <b>delegate</b> work down the chain.</div>
```

with:

```tsx
              <div className="inspector-empty">
                <PanelRight size={20} className="inspector-empty-icon" />
                <p>Select an agent to edit its role, memory, and skills.</p>
                <p className="dim">
                  Drag from the <b>bottom</b> of one node to the <b>top</b> of another to make it delegate work
                  down the chain.
                </p>
              </div>
```

- [ ] **Step 4: Add the CSS in `src/renderer/styles.css`**

Append:

```css
/* ---- Canvas empty-state onboarding ---- */
.canvas-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none; /* let the canvas pan/zoom around the card */
}
.canvas-empty-card {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  max-width: 380px;
  padding: 24px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--elev-2);
  animation: picker-rise var(--motion-slow) var(--ease-out) backwards;
}
.canvas-empty-card h2 {
  margin: 4px 0 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}
.canvas-empty-card p {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--muted);
}
.canvas-empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

/* ---- Inspector empty hint ---- */
.inspector-empty {
  padding: 20px 16px;
  color: var(--muted);
}
.inspector-empty-icon {
  color: var(--muted);
  opacity: 0.7;
  margin-bottom: 10px;
}
.inspector-empty p {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.5;
}
.inspector-empty .dim {
  font-size: 12px;
  color: var(--fg-dim, var(--muted));
}
@media (prefers-reduced-motion: reduce) {
  .canvas-empty-card { animation: none; }
}
```

- [ ] **Step 5: Typecheck, build, test**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS. (A fresh project shows the onboarding card; "Build a team from a goal" seeds an Orchestrator and focuses the goal bar, the card disappears; "Add a single agent" opens the modal; the inspector hint reads cleaner.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/CanvasEmptyState.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(welcome): canvas empty-state onboarding + inspector hint polish"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck && npm run build && npm test` — all clean.
- [ ] **User visual smoke** (agents can't run the GUI): launch with no project → the crafted welcome (arc mark, wordmark, tagline, staggered entrance, recent cards that lift on hover / dip on press); open a fresh project → the canvas onboarding card centered over the (still-pannable) canvas; click **Build a team from a goal** → an Orchestrator appears, the card vanishes, and the goal bar is focused; click **Add a single agent** → the Add-agent modal; select nothing → the cleaner inspector hint; toggle OS reduced-motion → entrances fade without moving. Per Emil, re-check the welcome entrance timing the next day / in slow-mo.

## Spec coverage check

| Spec requirement | Task |
| --- | --- |
| Reusable `BrandMark` conductor-arc SVG (rose, no fill/gradient) | 1 |
| ProjectPicker: identity block (mark + wordmark + tagline), layered card, warm dot-grid bg | 1 |
| Recent projects as hover/press cards | 1 |
| Welcome staggered entrance; reduced-motion opacity-only | 1 |
| Goal-focus store signal (`goalFocusTick`/`focusGoal`) + GoalBar wiring | 2 |
| Canvas empty state when `nodes.length === 0`; pannable around the panel | 3 |
| Primary "Build a team" → seed Orchestrator + focusGoal; secondary "Add a single agent" | 3 |
| Inspector empty hint polish | 3 |
| Only-behavior-add = the empty-state CTA; no engine/IPC change | 1 + 2 + 3 (none touched) |
