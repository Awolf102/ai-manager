# Orkestr Shell + Panel System + Top-bar IA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app shell flexible (resizable/collapsible/placement-swappable right inspector + bottom dock with per-project persistence), regroup the crowded top bar (labeled groups + "Team ▾" menu + FAQ button), rename "Run result"→"Launch app", and keep an active run reachable when a terminal opens.

**Architecture:** A pure `layout.ts` owns all layout math — clamps, the placement→CSS-grid matrix (`computeBodyGrid`), and serialize/parse — so the dynamic grid is tested logic that `App.tsx` only applies via inline `style`. A pure `dock.ts` decides the active dock tab when a terminal opens during a run. A thin zustand layout slice holds state + localStorage persistence keyed by project path. UI tasks wire these into `App.tsx` (3 zones + dividers), a `TeamMenu` + `FaqModal`, and `GoalBar`.

**Tech Stack:** React 19, zustand 5, electron-vite (vite 7), vitest, lucide-react. Foundation tokens/primitives/Toast already on main.

## Global Constraints

- Builds on Foundation (sub-project 0, merged `378479f`): use existing tokens (`--surface-*`, `--signal`, `--hairline*`, `--fg*`, `--space-*`, `--radius-*`, `--elev-2`, `--motion*`, `--ease-standard`) and the `.modal`/`.btn`/`.badge` primitives. Do not redefine tokens.
- Zones this cycle: **right inspector** + **bottom dock** only. NO left rail (deferred). Build the layout so a 3rd zone could be added later, but ship two.
- Layout persists **per project in `localStorage`** keyed by project path (`orkestr:layout:<path>`). It must NOT touch `graph.json` and must NOT travel with team export/import.
- First-open defaults reproduce today's layout: inspector right 348px, dock bottom 300px.
- Run-button: rename "Run result" → "Launch app" (keep rocket icon). Exactly one control says "Run" (the team run). Do NOT touch GoalBar's run logic, only the label/grouping.
- Invariant: an in-progress run is never hidden — Run tab persists with a live running indicator and opening a terminal during a run does not steal the active view from Run.
- Out of scope: left rail; run-view internals (narration/success/error — sub-project 2); canvas/settings/context/goal-textarea work; free-floating panels.
- Testing pattern: pure logic is TDD'd (`vitest`); CSS/wiring/IA verified by `npm run typecheck` + build + live render. CSS values are baseline/live-tunable.
- IMPORTANT for executors: `npm run build` (electron-vite) takes ~9 min and has dropped subagent connections. Implementers run `npm run typecheck` (fast) + focused `vitest`; the controller runs the full build at the integration gate.
- Commit after every task.

---

### Task 1: Pure layout module (`layout.ts`) — TDD

**Files:**
- Create: `src/renderer/layout.ts`
- Test: `src/renderer/layout.test.ts`

**Interfaces:**
- Produces:
  - `type InspectorPlacement = 'left' | 'right'`; `type DockPlacement = 'bottom' | 'right'`
  - `interface LayoutState { inspector: { size: number; collapsed: boolean; placement: InspectorPlacement }; dock: { size: number; collapsed: boolean; placement: DockPlacement } }`
  - `const DEFAULT_LAYOUT: LayoutState`
  - `clampInspector(px: number): number` (280–560)
  - `clampDockHeight(px: number, viewportH: number): number` (160 … 0.6·viewportH)
  - `clampDockWidth(px: number): number` (240–640)
  - `computeBodyGrid(layout: LayoutState): { columns: string; rows: string; areas: string }`
  - `serializeLayout(s: LayoutState): string`
  - `parseLayout(raw: string | null): LayoutState` (falls back to DEFAULT_LAYOUT for null/invalid/partial)

- [ ] **Step 1: Write the failing test** — create `src/renderer/layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LAYOUT, clampInspector, clampDockHeight, clampDockWidth,
  computeBodyGrid, serializeLayout, parseLayout, type LayoutState
} from './layout'

describe('clamps', () => {
  it('clampInspector bounds to 280..560', () => {
    expect(clampInspector(100)).toBe(280)
    expect(clampInspector(700)).toBe(560)
    expect(clampInspector(400)).toBe(400)
  })
  it('clampDockHeight bounds to 160..60% of viewport', () => {
    expect(clampDockHeight(50, 1000)).toBe(160)
    expect(clampDockHeight(900, 1000)).toBe(600)
    expect(clampDockHeight(300, 1000)).toBe(300)
  })
  it('clampDockWidth bounds to 240..640', () => {
    expect(clampDockWidth(100)).toBe(240)
    expect(clampDockWidth(900)).toBe(640)
  })
})

describe('computeBodyGrid', () => {
  it('default (inspector right, dock bottom) keeps inspector full-height right', () => {
    const g = computeBodyGrid(DEFAULT_LAYOUT)
    expect(g.columns).toBe('1fr 348px')
    expect(g.rows).toBe('1fr 300px')
    expect(g.areas).toBe('"main inspector" "dock inspector"')
  })
  it('inspector left, dock bottom', () => {
    const s: LayoutState = { ...DEFAULT_LAYOUT, inspector: { ...DEFAULT_LAYOUT.inspector, placement: 'left' } }
    const g = computeBodyGrid(s)
    expect(g.columns).toBe('348px 1fr')
    expect(g.areas).toBe('"inspector main" "inspector dock"')
  })
  it('inspector left, dock right → three columns one row', () => {
    const s: LayoutState = {
      inspector: { size: 348, collapsed: false, placement: 'left' },
      dock: { size: 300, collapsed: false, placement: 'right' }
    }
    const g = computeBodyGrid(s)
    expect(g.columns).toBe('348px 1fr 300px')
    expect(g.rows).toBe('1fr')
    expect(g.areas).toBe('"inspector main dock"')
  })
  it('both right → right column stacks inspector over dock', () => {
    const s: LayoutState = {
      inspector: { size: 348, collapsed: false, placement: 'right' },
      dock: { size: 300, collapsed: false, placement: 'right' }
    }
    const g = computeBodyGrid(s)
    expect(g.columns).toBe('1fr 348px')
    expect(g.rows).toBe('1fr 300px')
    expect(g.areas).toBe('"main inspector" "main dock"')
  })
  it('collapsed inspector yields a 0px track', () => {
    const s: LayoutState = { ...DEFAULT_LAYOUT, inspector: { ...DEFAULT_LAYOUT.inspector, collapsed: true } }
    expect(computeBodyGrid(s).columns).toBe('1fr 0px')
  })
})

describe('serialize/parse', () => {
  it('round-trips', () => {
    expect(parseLayout(serializeLayout(DEFAULT_LAYOUT))).toEqual(DEFAULT_LAYOUT)
  })
  it('falls back to default on null', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT)
  })
  it('falls back to default on garbage', () => {
    expect(parseLayout('{not json')).toEqual(DEFAULT_LAYOUT)
  })
  it('fills missing fields from default', () => {
    const partial = JSON.stringify({ inspector: { size: 400 } })
    const r = parseLayout(partial)
    expect(r.inspector.size).toBe(400)
    expect(r.inspector.placement).toBe('right') // from default
    expect(r.dock).toEqual(DEFAULT_LAYOUT.dock)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/layout.test.ts`
Expected: FAIL — cannot resolve `./layout`.

- [ ] **Step 3: Write the implementation** — create `src/renderer/layout.ts`:

```ts
export type InspectorPlacement = 'left' | 'right'
export type DockPlacement = 'bottom' | 'right'

export interface LayoutState {
  inspector: { size: number; collapsed: boolean; placement: InspectorPlacement }
  dock: { size: number; collapsed: boolean; placement: DockPlacement }
}

export const DEFAULT_LAYOUT: LayoutState = {
  inspector: { size: 348, collapsed: false, placement: 'right' },
  dock: { size: 300, collapsed: false, placement: 'bottom' }
}

const clamp = (px: number, min: number, max: number): number => Math.max(min, Math.min(max, px))

export const clampInspector = (px: number): number => clamp(px, 280, 560)
export const clampDockHeight = (px: number, viewportH: number): number => clamp(px, 160, Math.round(viewportH * 0.6))
export const clampDockWidth = (px: number): number => clamp(px, 240, 640)

export function computeBodyGrid(layout: LayoutState): { columns: string; rows: string; areas: string } {
  const insW = layout.inspector.collapsed ? '0px' : `${layout.inspector.size}px`
  const dockBottomH = layout.dock.collapsed ? '0px' : `${layout.dock.size}px`
  const dockRightW = layout.dock.collapsed ? '0px' : `${layout.dock.size}px`
  const insLeft = layout.inspector.placement === 'left'
  const dockRight = layout.dock.placement === 'right'

  if (dockRight && insLeft) {
    return { columns: `${insW} 1fr ${dockRightW}`, rows: '1fr', areas: '"inspector main dock"' }
  }
  if (dockRight && !insLeft) {
    // both right: right column stacks inspector (top) over dock (bottom); column width = inspector's
    return { columns: `1fr ${insW}`, rows: `1fr ${dockBottomH}`, areas: '"main inspector" "main dock"' }
  }
  // dock bottom
  if (insLeft) {
    return { columns: `${insW} 1fr`, rows: `1fr ${dockBottomH}`, areas: '"inspector main" "inspector dock"' }
  }
  return { columns: `1fr ${insW}`, rows: `1fr ${dockBottomH}`, areas: '"main inspector" "dock inspector"' }
}

export function serializeLayout(s: LayoutState): string {
  return JSON.stringify(s)
}

export function parseLayout(raw: string | null): LayoutState {
  if (!raw) return DEFAULT_LAYOUT
  try {
    const o = JSON.parse(raw) as Partial<LayoutState>
    return {
      inspector: { ...DEFAULT_LAYOUT.inspector, ...(o.inspector ?? {}) },
      dock: { ...DEFAULT_LAYOUT.dock, ...(o.dock ?? {}) }
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/layout.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/layout.ts src/renderer/layout.test.ts
git commit -m "feat(orkestr): pure layout module (clamps, grid matrix, persistence parse)"
```

---

### Task 2: Pure dock active-tab helper (`dock.ts`) — TDD

**Files:**
- Create: `src/renderer/dock.ts`
- Test: `src/renderer/dock.test.ts`

**Interfaces:**
- Produces: `activeDockAfterOpenTerminal(opts: { running: boolean; currentActive: string | null; newTermId: string }): string` — returns `currentActive` (don't steal) when a run is active and there is a current view; otherwise focuses `newTermId`.

- [ ] **Step 1: Write the failing test** — create `src/renderer/dock.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { activeDockAfterOpenTerminal } from './dock'

describe('activeDockAfterOpenTerminal', () => {
  it('focuses the new terminal when no run is active', () => {
    expect(activeDockAfterOpenTerminal({ running: false, currentActive: 'run', newTermId: 'term-2' })).toBe('term-2')
  })
  it('keeps the current view (does not steal) when a run is active', () => {
    expect(activeDockAfterOpenTerminal({ running: true, currentActive: 'run', newTermId: 'term-2' })).toBe('run')
  })
  it('keeps a non-run current view while running too', () => {
    expect(activeDockAfterOpenTerminal({ running: true, currentActive: 'term-1', newTermId: 'term-2' })).toBe('term-1')
  })
  it('focuses the new terminal if running but nothing is active yet', () => {
    expect(activeDockAfterOpenTerminal({ running: true, currentActive: null, newTermId: 'term-2' })).toBe('term-2')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/dock.test.ts`
Expected: FAIL — cannot resolve `./dock`.

- [ ] **Step 3: Write the implementation** — create `src/renderer/dock.ts`:

```ts
/** Decide the active dock tab after opening a terminal.
 * While a run is active and a view is showing, do NOT steal focus from it
 * (keeps the live run reachable); otherwise focus the new terminal. */
export function activeDockAfterOpenTerminal(opts: {
  running: boolean
  currentActive: string | null
  newTermId: string
}): string {
  if (opts.running && opts.currentActive) return opts.currentActive
  return opts.newTermId
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/dock.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/dock.ts src/renderer/dock.test.ts
git commit -m "feat(orkestr): pure dock active-tab helper (keep run reachable)"
```

---

### Task 3: Store layout slice + non-stealing openTerminal

**Files:**
- Modify: `src/renderer/store.ts`

**Interfaces:**
- Consumes: `layout.ts` (`LayoutState`, `DEFAULT_LAYOUT`, `clampInspector`, `clampDockHeight`, `clampDockWidth`, `serializeLayout`, `parseLayout`), `dock.ts` (`activeDockAfterOpenTerminal`).
- Produces (on the store): `layout: LayoutState`; `loadLayout(projectPath: string): void`; `setZoneSize(zone: 'inspector' | 'dock', px: number, viewportH: number): void`; `toggleZoneCollapsed(zone: 'inspector' | 'dock'): void`; `setZonePlacement(zone: 'inspector' | 'dock', placement: string): void`.

- [ ] **Step 1: Add imports to `src/renderer/store.ts`** (near the top imports):

```ts
import {
  DEFAULT_LAYOUT, clampInspector, clampDockHeight, clampDockWidth,
  serializeLayout, parseLayout, type LayoutState
} from './layout'
import { activeDockAfterOpenTerminal } from './dock'
```

- [ ] **Step 2: Extend the `AppState` interface** — add inside `interface AppState { … }`:

```ts
  layout: LayoutState
  layoutProjectPath: string | null
  loadLayout: (projectPath: string) => void
  setZoneSize: (zone: 'inspector' | 'dock', px: number, viewportH: number) => void
  toggleZoneCollapsed: (zone: 'inspector' | 'dock') => void
  setZonePlacement: (zone: 'inspector' | 'dock', placement: string) => void
```

- [ ] **Step 3: Add the slice implementation** — inside the `create<AppState>((set, get) => ({ … }))` body, add a helper + state + actions (place near `setGraph`):

```ts
  layout: DEFAULT_LAYOUT,
  layoutProjectPath: null,

  loadLayout: (projectPath) =>
    set((s) => {
      if (s.layoutProjectPath === projectPath) return {}
      const raw = localStorage.getItem(`orkestr:layout:${projectPath}`)
      return { layout: parseLayout(raw), layoutProjectPath: projectPath }
    }),

  setZoneSize: (zone, px, viewportH) =>
    set((s) => {
      const layout: LayoutState = { ...s.layout, [zone]: { ...s.layout[zone] } }
      if (zone === 'inspector') layout.inspector.size = clampInspector(px)
      else layout.dock.size = s.layout.dock.placement === 'right' ? clampDockWidth(px) : clampDockHeight(px, viewportH)
      persistLayout(s.layoutProjectPath, layout)
      return { layout }
    }),

  toggleZoneCollapsed: (zone) =>
    set((s) => {
      const layout: LayoutState = { ...s.layout, [zone]: { ...s.layout[zone], collapsed: !s.layout[zone].collapsed } }
      persistLayout(s.layoutProjectPath, layout)
      return { layout }
    }),

  setZonePlacement: (zone, placement) =>
    set((s) => {
      const layout: LayoutState = { ...s.layout, [zone]: { ...s.layout[zone], placement: placement as never } }
      persistLayout(s.layoutProjectPath, layout)
      return { layout }
    }),
```

Add this module-level helper near the top of `store.ts` (after imports, before `useStore`):

```ts
function persistLayout(projectPath: string | null, layout: LayoutState): void {
  if (projectPath) localStorage.setItem(`orkestr:layout:${projectPath}`, serializeLayout(layout))
}
```

- [ ] **Step 4: Make `openTerminal` keep the run reachable** — replace the existing `openTerminal` action body so the active dock is decided by the helper:

```ts
  openTerminal: (agent, mode) =>
    set((s) => {
      const id = `term-${++counter}`
      const tab: TerminalTab = { id, agentId: agent.id, agentName: agent.name, mode }
      const activeDockId = activeDockAfterOpenTerminal({
        running: s.run.running,
        currentActive: s.activeDockId,
        newTermId: id
      })
      return { terminals: [...s.terminals, tab], activeDockId }
    }),
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: passes clean. (Do NOT run the full build — controller handles it.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store.ts
git commit -m "feat(orkestr): store layout slice + non-stealing openTerminal"
```

---

### Task 4: Panel system UI — resizable / collapsible / swappable zones

**Files:**
- Create: `src/renderer/PanelDivider.tsx`
- Modify: `src/renderer/App.tsx` (restructure `.body` into 3 grid zones driven by `computeBodyGrid`; dividers; collapse + placement controls; load layout on project change)
- Modify: `src/renderer/styles.css` (zone/divider/collapse styles)

**Interfaces:**
- Consumes: store `layout`, `loadLayout`, `setZoneSize`, `toggleZoneCollapsed`, `setZonePlacement`; `computeBodyGrid` from `layout.ts`.

This task is wiring + visual — verify by typecheck + live render. CSS values are baseline.

- [ ] **Step 1: Create `src/renderer/PanelDivider.tsx`** — a drag handle that reports the new pixel size:

```tsx
import { useCallback } from 'react'

/** A draggable divider. `axis='x'` resizes width, `axis='y'` resizes height.
 * `invert` is true when the panel grows opposite the drag direction
 * (e.g. a right inspector grows as the mouse moves left). Calls onResize(px). */
export default function PanelDivider({
  axis,
  invert,
  getStart,
  onResize
}: {
  axis: 'x' | 'y'
  invert: boolean
  getStart: () => number // current panel size in px at drag start
  onResize: (px: number) => void
}) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startPos = axis === 'x' ? e.clientX : e.clientY
      const startSize = getStart()
      const move = (ev: MouseEvent): void => {
        const pos = axis === 'x' ? ev.clientX : ev.clientY
        const delta = (pos - startPos) * (invert ? -1 : 1)
        onResize(startSize + delta)
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [axis, invert, getStart, onResize]
  )
  return <div className={`panel-divider panel-divider-${axis}`} onMouseDown={onMouseDown} role="separator" />
}
```

- [ ] **Step 2: Wire the layout into `App.tsx`** — replace the `.body` block. The body becomes a grid styled from `computeBodyGrid`; the inspector and dock are grid areas with dividers; the main area (goal bar + canvas) is the `main` area. Add the store selectors and a load-on-project-change effect.

Add imports + selectors at the top of `App()` (near the other `useStore` calls):
```tsx
import PanelDivider from './PanelDivider'
import { computeBodyGrid } from './layout'
// inside App():
const layout = useStore((s) => s.layout)
const loadLayout = useStore((s) => s.loadLayout)
const setZoneSize = useStore((s) => s.setZoneSize)
const toggleZoneCollapsed = useStore((s) => s.toggleZoneCollapsed)
const setZonePlacement = useStore((s) => s.setZonePlacement)
```

Add the effect (near the other `useEffect`s), keyed on project path:
```tsx
useEffect(() => {
  if (graph?.project.path) loadLayout(graph.project.path)
}, [graph?.project.path, loadLayout])
```

Replace the `<div className="body">…</div>` so it is a grid driven by the computed template, with the inspector and dock as zones and their dividers. Compute the grid once per render:
```tsx
const grid = computeBodyGrid(layout)
```
```tsx
<div
  className="body"
  style={{ gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows, gridTemplateAreas: grid.areas }}
>
  <div className="zone-main" style={{ gridArea: 'main' }}>
    <GoalBar />
    <div className="canvas-wrap"><OrgChart /></div>
  </div>

  <div className={`zone-inspector ${layout.inspector.collapsed ? 'collapsed' : ''}`} style={{ gridArea: 'inspector' }}>
    {!layout.inspector.collapsed && (
      <PanelDivider
        axis="x"
        invert={layout.inspector.placement === 'right'}
        getStart={() => layout.inspector.size}
        onResize={(px) => setZoneSize('inspector', px, window.innerHeight)}
      />
    )}
    <div className="zone-head">
      <span>Inspector</span>
      <span className="spacer" />
      <button className="btn tiny" title="Move left/right" onClick={() => setZonePlacement('inspector', layout.inspector.placement === 'right' ? 'left' : 'right')}>⇄</button>
      <button className="btn tiny" title="Collapse" onClick={() => toggleZoneCollapsed('inspector')}>×</button>
    </div>
    <div className="zone-body">
      {selectedId ? (<><AgentConfigPanel /><RoleMemoryEditor /></>) : (
        <div className="empty-hint">Select an agent to edit its role, memory, and settings.<br /><br />Drag from the <b>bottom</b> of one node to the <b>top</b> of another to make it <b>delegate</b> work down the chain.</div>
      )}
    </div>
  </div>

  {showDock && (
    <div className={`zone-dock ${layout.dock.collapsed ? 'collapsed' : ''}`} style={{ gridArea: 'dock' }}>
      {!layout.dock.collapsed && (
        <PanelDivider
          axis={layout.dock.placement === 'right' ? 'x' : 'y'}
          invert={true}
          getStart={() => layout.dock.size}
          onResize={(px) => setZoneSize('dock', px, window.innerHeight)}
        />
      )}
      {/* existing dock contents: term-tabs + term-stack (unchanged markup) */}
      <div className="terminal-dock">
        {/* … keep the existing term-tabs + term-stack JSX exactly as today … */}
      </div>
    </div>
  )}

  {/* collapsed re-open affordances */}
  {layout.inspector.collapsed && (
    <button className="zone-reopen reopen-inspector" onClick={() => toggleZoneCollapsed('inspector')} title="Show inspector">‹</button>
  )}
  {showDock && layout.dock.collapsed && (
    <button className="zone-reopen reopen-dock" onClick={() => toggleZoneCollapsed('dock')} title="Show dock">▴</button>
  )}
</div>
```

Notes for the implementer:
- Preserve the existing `term-tabs` + `term-stack` JSX (Run/History/terminal tabs) verbatim inside `.terminal-dock`; only its container moved into `.zone-dock`. The old `.main`/`.has-dock` wrapper and the old separate `.sidepanel` block are removed in favor of these zones.
- The drag-region CSS (`-webkit-app-region`) on the top bar is unaffected.
- Keep `showDock` exactly as defined today (`terminals.length > 0 || showRunView || showHistory`).

- [ ] **Step 3: Add zone/divider CSS to `src/renderer/styles.css`** (replace the old `.body`/`.main`/`.main.has-dock`/`.sidepanel` rules; append the rest):

```css
.body { display: grid; overflow: hidden; height: 100%; }
.zone-main { display: grid; grid-template-rows: 46px 1fr; overflow: hidden; position: relative; min-width: 0; }
.zone-inspector { position: relative; border-left: 1px solid var(--hairline); background: var(--surface-1); overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
.zone-inspector.collapsed, .zone-dock.collapsed { display: none; }
.zone-dock { position: relative; overflow: hidden; border-top: 1px solid var(--hairline); min-height: 0; }
.zone-head { display: flex; align-items: center; gap: var(--space-2); padding: 4px 8px; border-bottom: 1px solid var(--hairline); font-size: var(--text-xs); color: var(--fg-muted); }
.zone-head .spacer { flex: 1; }
.zone-body { flex: 1; overflow-y: auto; }
.panel-divider { position: absolute; z-index: 5; }
.panel-divider-x { top: 0; bottom: 0; left: 0; width: 6px; margin-left: -3px; cursor: ew-resize; }
.panel-divider-y { left: 0; right: 0; top: 0; height: 6px; margin-top: -3px; cursor: ns-resize; }
.panel-divider:hover { background: var(--signal-tint); }
.zone-reopen { position: absolute; z-index: 6; background: var(--surface-2); border: 1px solid var(--hairline-strong); color: var(--fg-muted); border-radius: var(--radius-sm); cursor: pointer; padding: 2px 6px; }
.reopen-inspector { top: 8px; right: 8px; }
.reopen-dock { bottom: 8px; right: 8px; }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes clean.

- [ ] **Step 5: Live-verify (controller/user)**

Note in the report that GUI live-verify is deferred to the controller/user: resize inspector + dock by dragging dividers; collapse + re-open each; swap inspector left/right and dock bottom/right; reload the project and confirm the layout restored; confirm exporting a team does NOT carry layout.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/PanelDivider.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(orkestr): resizable/collapsible/swappable panel zones with per-project persistence"
```

---

### Task 5: Live "running" indicator on the Run dock tab

**Files:**
- Modify: `src/renderer/App.tsx` (the Run `term-tab`)
- Modify: `src/renderer/styles.css` (indicator style)

**Interfaces:**
- Consumes: `useStore((s) => s.run.running)`.

The non-stealing behavior already shipped in Task 3; this adds the visible indicator so the run is obviously present.

- [ ] **Step 1: Add the running selector in `App.tsx`** (near other selectors):

```tsx
const runRunning = useStore((s) => s.run.running)
```

- [ ] **Step 2: Mark the Run tab when running** — update the Run `term-tab` (the `showRunView` tab) to show a running indicator:

```tsx
{showRunView && (
  <div
    className={`term-tab mode-run ${activeDockId === 'run' ? 'active' : ''} ${runRunning ? 'running' : ''}`}
    onClick={() => setActiveDock('run')}
  >
    <span className="dot" /> Run{runRunning && <span className="run-live" title="Run in progress">● running</span>}
  </div>
)}
```

- [ ] **Step 3: Add CSS to `src/renderer/styles.css`**:

```css
.term-tab .run-live { margin-left: 6px; color: var(--state-good); font-size: var(--text-xs); }
.term-tab.running .dot { background: var(--state-good); }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(orkestr): live running indicator on the Run dock tab"
```

---

### Task 6: Top-bar IA — FAQ button, grouping, Team menu

**Files:**
- Create: `src/renderer/TeamMenu.tsx`
- Create: `src/renderer/FaqModal.tsx`
- Modify: `src/renderer/App.tsx` (top bar: FAQ button before brand; move export/import/sync into TeamMenu; grouping)
- Modify: `src/renderer/styles.css` (menu + faq + topbar group styles)

**Interfaces:**
- Consumes: Foundation `.modal` shell; `useStore` (`setGraph`, `requestConfirm`, `notify`); `window.api` team methods.
- Produces: `TeamMenu` (default export) and `FaqModal` (default export, props `{ onClose: () => void }`).

- [ ] **Step 1: Create `src/renderer/TeamMenu.tsx`** — a dropdown owning export / import / sync↑ / sync↓ (move the handlers out of App.tsx verbatim):

```tsx
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, CloudDownload, CloudUpload, Download, Upload } from 'lucide-react'
import { useStore } from './store'
import { buildImportConfirmBody } from './import-confirm'

export default function TeamMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const setGraph = useStore((s) => s.setGraph)
  const requestConfirm = useStore((s) => s.requestConfirm)
  const notify = useStore((s) => s.notify)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const exportTeam = async (): Promise<void> => { await window.api.exportTeam(); setOpen(false) }
  const importTeam = async (): Promise<void> => {
    setOpen(false)
    const r = await window.api.importTeamPreview()
    if (r.status === 'canceled') return
    if (r.status === 'error') { notify({ kind: 'error', message: r.error }); return }
    const ok = await requestConfirm({ title: 'Import this team?', body: buildImportConfirmBody(r.preview), confirmLabel: 'Import', danger: false })
    if (!ok) return
    const a = await window.api.importTeamApply(r.bundle, r.path)
    if ('graph' in a && a.graph) setGraph(a.graph)
    else if ('error' in a && a.error) notify({ kind: 'error', message: a.error })
  }
  const syncUp = async (): Promise<void> => { setOpen(false); const r = await window.api.syncToTeam(); if (r.synced && r.graph) setGraph(r.graph) }
  const syncDown = async (): Promise<void> => {
    setOpen(false)
    const r = await window.api.refreshFromTeam()
    if (r.refreshed && r.graph) { setGraph(r.graph); notify({ kind: 'success', message: `Updated ${r.updated} agent(s) from the team brain.` }) }
    else if (r.error) notify({ kind: 'error', message: r.error })
  }

  return (
    <div className="topmenu" ref={ref}>
      <button className="btn" onClick={() => setOpen((v) => !v)}>Team <ChevronDown size={12} /></button>
      {open && (
        <div className="topmenu-list">
          <button onClick={() => void exportTeam()}><Upload size={14} /> Export team…</button>
          <button onClick={() => void importTeam()}><Download size={14} /> Import team…</button>
          <button onClick={() => void syncUp()}><CloudUpload size={14} /> Sync to team brain</button>
          <button onClick={() => void syncDown()}><CloudDownload size={14} /> Refresh from team brain</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create `src/renderer/FaqModal.tsx`** — a static how-to-prompt guide using the modal shell:

```tsx
export default function FaqModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>How to prompt Orkestr</h2>
        <div className="faq-body">
          <p><b>Give the orchestrator a goal.</b> Describe the outcome you want in plain language in the goal box, then press Run. The orchestrator plans the work and delegates down the chain.</p>
          <p><b>Build a team first if you have none.</b> Use <i>Draft roles</i> to suggest specialists, or <i>Build team</i> to have the orchestrator design and create one for your goal.</p>
          <p><b>Wire the chain.</b> Drag from the bottom of one agent to the top of another so the upper one delegates to the lower one.</p>
          <p><b>Watch and launch.</b> The Run tab streams progress; <i>Launch app</i> starts the app your team built and opens it.</p>
          <p><b>Good goals are specific.</b> State the what and the constraints (stack, scope, must-haves); leave the how to the team.</p>
        </div>
        <div className="modal-actions"><button className="btn primary" onClick={onClose}>Got it</button></div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Rework the top bar in `App.tsx`** — add a `showFaq` state, the FAQ button before the brand, render `<TeamMenu />`, drop the 4 moved buttons, and mount `<FaqModal>`:

Add state + imports:
```tsx
import { CircleHelp } from 'lucide-react'
import TeamMenu from './TeamMenu'
import FaqModal from './FaqModal'
// inside App():
const [showFaq, setShowFaq] = useState(false)
```
Top bar — replace the brand area start and remove the export/import/sync buttons; keep switch-project, history, context, settings, add-agent:
```tsx
<div className="topbar">
  <button className="btn icon faq-btn" title="How to prompt" onClick={() => setShowFaq(true)}><CircleHelp size={15} /></button>
  <span className="brand">Orkestr</span>
  <span className="project">{graph.project.name}</span>
  <span className="spacer" />
  <AuthPill checking={authChecking} status={auth} onClick={() => void recheckAuth()} />
  <button className="btn" onClick={async () => { const g = await window.api.pickProjectFolder(); if (g) { setGraph(g); void refreshResumable(true) } }}><FolderOpen size={14} /> Switch project</button>
  <button className="btn" title="Run history" onClick={() => openHistory()}><Clock size={14} /> History{resumable.length > 0 && <span className="resume-badge">{resumable.length}</span>}</button>
  <TeamMenu />
  {graph.linkedTeam && (<span className="team-link" title={`Linked team brain: ${graph.linkedTeam.path}`}><Users size={12} /> {graph.linkedTeam.path.split(/[\\/]/).pop()}</span>)}
  <button className="btn ctx-btn" title="Project context — files & images for the team" onClick={() => setShowContext(true)}><Paperclip size={14} /> Context{(graph.context?.length ?? 0) > 0 && <span className="ctx-badge">{graph.context!.length}</span>}</button>
  <button className="btn" title="Settings" onClick={() => setShowSettings(true)}><SettingsIcon size={14} /> Settings</button>
  <button className="btn primary" onClick={() => setShowAdd(true)}><Plus size={14} /> Add agent</button>
</div>
```
Mount the modal near the others:
```tsx
{showFaq && <FaqModal onClose={() => setShowFaq(false)} />}
```
Remove the now-unused imports (`Upload`, `Download`, `CloudUpload`, `CloudDownload`, `buildImportConfirmBody`) from App.tsx if no longer referenced.

- [ ] **Step 4: Add CSS to `src/renderer/styles.css`**:

```css
.topmenu { position: relative; -webkit-app-region: no-drag; }
.topmenu-list { position: absolute; top: 100%; right: 0; margin-top: 4px; background: var(--surface-2); border: 1px solid var(--hairline-strong); border-radius: var(--radius); box-shadow: var(--elev-2); padding: 4px; display: flex; flex-direction: column; min-width: 200px; z-index: 60; }
.topmenu-list button { display: flex; align-items: center; gap: var(--space-3); padding: 7px 10px; background: none; border: none; color: var(--fg); font-size: var(--text-sm); border-radius: var(--radius-sm); text-align: left; }
.topmenu-list button:hover { background: var(--surface-hover); }
.faq-body { font-size: var(--text-base); line-height: var(--lh-normal); color: var(--fg); }
.faq-body p { margin: 0 0 10px; }
.faq-btn { padding: 5px; }
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: passes clean (and no unused-import errors in App.tsx).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/TeamMenu.tsx src/renderer/FaqModal.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(orkestr): top-bar IA — FAQ guide, labeled actions, Team menu"
```

---

### Task 7: Run-button disambiguation in the goal bar

**Files:**
- Modify: `src/renderer/run/GoalBar.tsx` (rename "Run result" → "Launch app"; group secondary tools vs primary)
- Modify: `src/renderer/styles.css` (goal-bar grouping)

**Interfaces:** none new.

- [ ] **Step 1: Rename "Run result" → "Launch app"** — in `GoalBar.tsx`, update the button label + tooltip (the `runResult` handler keeps its name; only the visible text changes):

```tsx
<button
  className="btn"
  onClick={() => void runResult()}
  disabled={!canRunResult}
  title="Launch the app your team built and open it in the browser"
>
  <Rocket size={14} /> {detecting ? 'Launching…' : 'Launch app'}
</button>
```

- [ ] **Step 2: Group the secondary tools apart from the primary Run/Stop** — wrap Draft roles + Build team + Launch app in a `goal-tools` group so the primary Run/Stop reads as primary. Wrap the three secondary buttons:

```tsx
<span className="goal-tools">
  {/* Draft roles button */}
  {/* Build team button */}
  {/* Launch app button */}
</span>
{/* then the existing Run/Stop button stays after the group */}
```
(Keep each button's existing props; only add the wrapping `<span className="goal-tools">` around the three secondary buttons, leaving the Run/Stop button as the last child.)

- [ ] **Step 3: Add CSS to `src/renderer/styles.css`**:

```css
.goal-tools { display: inline-flex; gap: var(--space-2); padding-right: var(--space-3); margin-right: var(--space-1); border-right: 1px solid var(--hairline); }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/run/GoalBar.tsx src/renderer/styles.css
git commit -m "feat(orkestr): rename Run result -> Launch app, group goal tools vs primary Run"
```

---

## Self-Review

**Spec coverage:**
- §3 panel system (zones, resize, collapse, swaps, persistence, structure, defer left rail) → Tasks 1 (grid/clamps/persist logic), 3 (store slice + persistence), 4 (UI). ✓
- §4 top-bar IA (FAQ button, grouping, Team menu) → Task 6. ✓
- §5 run-button disambiguation → Task 7. ✓
- §6 terminal-hides-run fix (non-steal + running indicator) → Task 2 + 3 (non-steal logic), Task 5 (indicator). ✓
- §7 FAQ content → Task 6 (FaqModal). ✓
- §8 audit #33 parts → Tasks 5/6/7. ✓
- §10 testing (pure logic TDD'd; rest typecheck+build+live) → Tasks 1,2 TDD; 3–7 typecheck+live; controller runs build. ✓
- §11 acceptance criteria → all mapped; out-of-scope (§9) respected.

**Placeholder scan:** No TBD/TODO. Pure-module + store code is complete; component code is complete; CSS is concrete (baseline/live-tunable per the project pattern). The one prose instruction (Task 4 "keep the existing term-tabs/term-stack JSX verbatim") references existing code rather than re-pasting the large block — intentional, to avoid drift in unchanged markup.

**Type consistency:** `LayoutState`, `DEFAULT_LAYOUT`, `clampInspector`, `clampDockHeight`, `clampDockWidth`, `computeBodyGrid`, `serializeLayout`, `parseLayout` (Task 1) are consumed with identical signatures in Task 3; `activeDockAfterOpenTerminal({running,currentActive,newTermId})` (Task 2) consumed identically in Task 3; store actions `setZoneSize(zone,px,viewportH)`, `toggleZoneCollapsed(zone)`, `setZonePlacement(zone,placement)`, `loadLayout(path)` (Task 3) consumed identically in Task 4.
