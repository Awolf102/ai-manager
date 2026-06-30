# Orkestr Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the team canvas an automatic "octopus" hierarchy layout, restyle the agent cards to Foundation tokens, and make the edge semantics discoverable with a legend + first-run coach-marks.

**Architecture:** A pure, deterministic `shared/octopus-layout.ts` (TDD) computes node positions from the report tree. `OrgChart` applies it on structural change (skipping the initial mount so saved positions load intact) and via a Tidy button, persisting through the existing `setNodePositions`. A compact `CanvasLegend` + one-time `CoachMarks` explain the edges. `AgentNode`'s CSS migrates to semantic tokens.

**Tech Stack:** React 19, @xyflow/react (React Flow), zustand 5, electron-vite (vite 7), vitest. Foundation tokens + Shell/IA + Run experience already on main.

## Global Constraints

- Layout source is `node.position`, persisted via `window.api.setNodePositions(positions)` (existing). The octopus layout produces those positions.
- Layout uses the REPORT tree only: edges where `kind !== 'handoff'`. Handoff edges never affect positions.
- Auto-sort on STRUCTURAL change (agent or report-edge added/removed) + a Tidy button; manual drags persist between structural changes; **do not auto-layout on initial mount** (respect saved positions on load).
- `octopusLayout` must be pure + deterministic (no `Math.random`/time) and place every node (no NaN, no overlap of the primary root).
- Node kinds are `'orchestrator' | 'manager' | 'worker'`. Role tokens already exist: `--orchestrator` (gold), `--manager` (periwinkle), `--worker` (teal).
- Reuse Foundation tokens (`--surface-*`, `--hairline*`, `--fg*`, `--signal`, `--radius-*`, `--space-*`, `--text-*`, `--elev-*`); do not redefine tokens.
- Coach-marks first-run flag in `localStorage` key `orkestr:canvas:coachmarks-seen`; shown once, never again after dismissal.
- Scope: `shared/octopus-layout.ts`, `OrgChart.tsx`, `AgentNode.tsx`, new `canvas/CanvasLegend.tsx` + `canvas/CoachMarks.tsx`, `styles.css`. No settings/enable-on-gesture, no run/dock/panel changes, no past-prompts picker.
- Testing: pure logic TDD'd (`octopus-layout`); rest typecheck + build + live. Implementers run `npm run typecheck` + focused `vitest`; the controller runs the full `npm run build` (~9 min, drops agent connections) at the integration gate.
- Commit after every task.

---

### Task 1: Pure octopus layout (`octopus-layout.ts`) — TDD

**Files:**
- Create: `src/shared/octopus-layout.ts`
- Test: `src/shared/octopus-layout.test.ts`

**Interfaces:**
- Produces:
  - `interface LayoutNode { id: string; kind: 'orchestrator' | 'manager' | 'worker' }`
  - `interface LayoutEdge { source: string; target: string; kind?: 'report' | 'handoff'; order?: number | null }`
  - `interface Positioned { id: string; position: { x: number; y: number } }`
  - `octopusLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Positioned[]`

- [ ] **Step 1: Write the failing test** — create `src/shared/octopus-layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { octopusLayout, type LayoutNode, type LayoutEdge } from './octopus-layout'

const nodes: LayoutNode[] = [
  { id: 'O', kind: 'orchestrator' },
  { id: 'DW', kind: 'worker' },
  { id: 'M1', kind: 'manager' },
  { id: 'M2', kind: 'manager' },
  { id: 'W1', kind: 'worker' },
  { id: 'W2', kind: 'worker' },
  { id: 'W3', kind: 'worker' },
  { id: 'W4', kind: 'worker' }
]
const edges: LayoutEdge[] = [
  { source: 'O', target: 'DW' },
  { source: 'O', target: 'M1' },
  { source: 'O', target: 'M2' },
  { source: 'M1', target: 'W1' },
  { source: 'M1', target: 'W2' },
  { source: 'M2', target: 'W3' },
  { source: 'M2', target: 'W4' }
]
const byId = (r: ReturnType<typeof octopusLayout>) => new Map(r.map((p) => [p.id, p.position]))

describe('octopusLayout', () => {
  it('layers orchestrator above managers above workers', () => {
    const p = byId(octopusLayout(nodes, edges))
    expect(p.get('O')!.y).toBeLessThan(p.get('M1')!.y)
    expect(p.get('M1')!.y).toBeLessThan(p.get('W1')!.y)
  })
  it('places managers on one row', () => {
    const p = byId(octopusLayout(nodes, edges))
    expect(p.get('M1')!.y).toBe(p.get('M2')!.y)
  })
  it('centers the orchestrator over its managers', () => {
    const p = byId(octopusLayout(nodes, edges))
    const mid = (p.get('M1')!.x + p.get('M2')!.x) / 2
    expect(p.get('O')!.x).toBeCloseTo(mid, 5)
  })
  it('places a direct leaf worker above the orchestrator (the arch)', () => {
    const p = byId(octopusLayout(nodes, edges))
    expect(p.get('DW')!.y).toBeLessThan(p.get('O')!.y)
  })
  it('staggers sibling workers on a layer', () => {
    const p = byId(octopusLayout(nodes, edges))
    expect(p.get('W1')!.y).not.toBe(p.get('W2')!.y)
  })
  it('ignores handoff edges for layout', () => {
    const withHandoff = [...edges, { source: 'W1', target: 'W3', kind: 'handoff' as const }]
    const a = byId(octopusLayout(nodes, edges))
    const b = byId(octopusLayout(nodes, withHandoff))
    expect(b.get('W3')).toEqual(a.get('W3'))
  })
  it('is deterministic', () => {
    expect(octopusLayout(nodes, edges)).toEqual(octopusLayout(nodes, edges))
  })
  it('positions an orphan node (no edges) without NaN', () => {
    const r = octopusLayout([...nodes, { id: 'ORPH', kind: 'worker' }], edges)
    const orph = r.find((p) => p.id === 'ORPH')!.position
    expect(Number.isFinite(orph.x) && Number.isFinite(orph.y)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/octopus-layout.test.ts`
Expected: FAIL — cannot resolve `./octopus-layout`.

- [ ] **Step 3: Write the implementation** — create `src/shared/octopus-layout.ts`:

```ts
export interface LayoutNode {
  id: string
  kind: 'orchestrator' | 'manager' | 'worker'
}
export interface LayoutEdge {
  source: string
  target: string
  kind?: 'report' | 'handoff'
  order?: number | null
}
export interface Positioned {
  id: string
  position: { x: number; y: number }
}

const CARD_W = 200
const COL_GAP = 48
const SLOT = CARD_W + COL_GAP // horizontal slot per leaf
const ROW_GAP = 150 // vertical gap between layers
const STAGGER = 46 // alternating y offset for fanned siblings
const ARCH_GAP = 150 // how far above the orchestrator direct workers sit

export function octopusLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Positioned[] {
  const ids = nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]))

  // report children only; ordered by `order` (nulls last) then input order
  const childrenOf = new Map<string, string[]>()
  const hasParent = new Set<string>()
  edges
    .filter((e) => e.kind !== 'handoff' && idSet.has(e.source) && idSet.has(e.target))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.order ?? Infinity) - (b.e.order ?? Infinity) || a.i - b.i)
    .forEach(({ e }) => {
      if (!childrenOf.has(e.source)) childrenOf.set(e.source, [])
      childrenOf.get(e.source)!.push(e.target)
      hasParent.add(e.target)
    })
  const children = (id: string): string[] => childrenOf.get(id) ?? []

  const pos = new Map<string, { x: number; y: number }>()
  let leafCursor = 0

  // tidy-tree: leaves take sequential x slots; parents center over their children.
  // depth 0 = the row directly under the orchestrator.
  const place = (id: string, depth: number, siblingIndex: number): { minX: number; maxX: number } => {
    const kids = children(id)
    const y = ROW_GAP * (depth + 1)
    if (kids.length === 0) {
      const x = leafCursor * SLOT
      leafCursor++
      pos.set(id, { x, y: y + (siblingIndex % 2) * STAGGER })
      return { minX: x, maxX: x }
    }
    let minX = Infinity
    let maxX = -Infinity
    kids.forEach((k, i) => {
      const r = place(k, depth + 1, i)
      minX = Math.min(minX, r.minX)
      maxX = Math.max(maxX, r.maxX)
    })
    pos.set(id, { x: (minX + maxX) / 2, y })
    return { minX, maxX }
  }

  const roots = ids.filter((id) => !hasParent.has(id))
  const primary = roots.find((id) => kindOf.get(id) === 'orchestrator') ?? roots[0] ?? null

  if (primary) {
    const kids = children(primary)
    const directWorkers = kids.filter((k) => kindOf.get(k) === 'worker' && children(k).length === 0)
    const subtreeRoots = kids.filter((k) => !directWorkers.includes(k))

    let minX = Infinity
    let maxX = -Infinity
    subtreeRoots.forEach((k, i) => {
      const r = place(k, 0, i)
      minX = Math.min(minX, r.minX)
      maxX = Math.max(maxX, r.maxX)
    })
    const centerX = subtreeRoots.length ? (minX + maxX) / 2 : leafCursor * SLOT
    pos.set(primary, { x: centerX, y: 0 })
    if (!subtreeRoots.length) leafCursor++ // lone orchestrator still consumes a slot

    directWorkers.forEach((w, i) => {
      const offset = i - (directWorkers.length - 1) / 2
      pos.set(w, { x: centerX + offset * SLOT, y: -ARCH_GAP })
    })
  }

  // other roots / disconnected trees → laid out to the right (their roots at the managers' row)
  for (const r of roots) {
    if (r === primary || pos.has(r)) continue
    place(r, 0, 0)
  }
  // defensive: anything still unplaced → trailing slot
  for (const id of ids) {
    if (pos.has(id)) continue
    pos.set(id, { x: leafCursor * SLOT, y: ROW_GAP })
    leafCursor++
  }

  return ids.map((id) => ({ id, position: pos.get(id) ?? { x: 0, y: 0 } }))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/octopus-layout.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/shared/octopus-layout.ts src/shared/octopus-layout.test.ts
git commit -m "feat(orkestr): pure octopus layout from the report tree"
```

---

### Task 2: Apply auto-layout in OrgChart + Tidy button

**Files:**
- Modify: `src/renderer/canvas/OrgChart.tsx`

**Interfaces:**
- Consumes: `octopusLayout` from `../../shared/octopus-layout`; existing `patchPositions`, `setNodes`, `window.api.setNodePositions`.

This task is wiring — verify by typecheck + live render.

- [ ] **Step 1: Add imports + a layout applier** to `OrgChart.tsx`

Add the import:
```tsx
import { octopusLayout } from '../../shared/octopus-layout'
import { useRef } from 'react'
```
(If `useRef` is not already imported from `react`, add it to the existing `react` import rather than a second import line.)

Inside `OrgChart()`, after the `edges` state hooks, add a layout applier + a structural signature, and an effect that re-tidies on structural change but NOT on the initial mount:
```tsx
  const applyLayout = useCallback(() => {
    const positioned = octopusLayout(
      graph.nodes.map((n) => ({ id: n.id, kind: n.kind })),
      graph.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind, order: e.order }))
    )
    const posById = new Map(positioned.map((p) => [p.id, p.position]))
    setNodes((prev) => prev.map((n) => (posById.has(n.id) ? { ...n, position: posById.get(n.id)! } : n)))
    patchPositions(positioned)
    void window.api.setNodePositions(positioned)
  }, [graph.nodes, graph.edges, setNodes, patchPositions])

  // Structure = node ids+kinds + the report edges (handoff edges & positions excluded).
  const structSig = useMemo(
    () =>
      graph.nodes.map((n) => `${n.id}:${n.kind}`).sort().join('|') +
      '#' +
      graph.edges
        .filter((e) => e.kind !== 'handoff')
        .map((e) => `${e.source}>${e.target}`)
        .sort()
        .join('|'),
    [graph.nodes, graph.edges]
  )
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return // respect saved positions on first load
    }
    applyLayout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structSig])
```

- [ ] **Step 2: Add the Tidy button** — add a Panel (top-right, near the Order button) inside the `<ReactFlow>`:

```tsx
      <Panel position="top-right">
        <button className="btn" onClick={applyLayout} title="Auto-arrange the team into a tidy hierarchy">
          Tidy
        </button>
        <button
          className={`btn order-toggle ${orderMode ? 'active' : ''}`}
          onClick={() => setOrderMode((v) => !v)}
          title="Click top-level flow lines in the order their teams should run"
        >
          {orderMode ? 'Ordering — click edges in run order' : 'Order'}
        </button>
      </Panel>
```
(Replace the existing top-right Panel that holds only the Order button with this one containing Tidy + Order.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes clean. (Do NOT run the full build — controller handles it.)

- [ ] **Step 4: Live-verify (controller/user)**

Note in the report that GUI live-verify is deferred: add an agent / draw a report edge → the team re-arranges into the octopus shape; Tidy re-runs it; dragging a node and reloading keeps the drag; the initial load does not reflow saved positions.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/OrgChart.tsx
git commit -m "feat(orkestr): auto-tidy the canvas on team change + Tidy button"
```

---

### Task 3: Edge legend + first-run coach-marks

**Files:**
- Create: `src/renderer/canvas/CanvasLegend.tsx`
- Create: `src/renderer/canvas/CoachMarks.tsx`
- Modify: `src/renderer/canvas/OrgChart.tsx` (mount both as Panels)
- Modify: `src/renderer/styles.css` (legend + coach-marks styles)

**Interfaces:**
- Consumes: nothing new (self-contained components).

- [ ] **Step 1: Create `src/renderer/canvas/CanvasLegend.tsx`**

```tsx
export default function CanvasLegend() {
  return (
    <div className="canvas-legend">
      <div className="legend-row"><span className="legend-line report" /> reports to</div>
      <div className="legend-row"><span className="legend-line handoff" /> handoff</div>
      <div className="legend-row"><span className="legend-badge">1</span> run order</div>
      <div className="legend-hint">Drag a node’s bottom → another’s top to connect</div>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/renderer/canvas/CoachMarks.tsx`** — one-time dismissible tips:

```tsx
import { useState } from 'react'

const KEY = 'orkestr:canvas:coachmarks-seen'

export default function CoachMarks() {
  const [show, setShow] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== '1'
    } catch {
      return false
    }
  })
  if (!show) return null
  const dismiss = (): void => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* ignore */
    }
    setShow(false)
  }
  return (
    <div className="coachmarks" role="dialog" aria-label="Canvas tips">
      <h3>Working the canvas</h3>
      <ul>
        <li><b>Connect</b> agents by dragging from one node’s <b>bottom</b> to another’s <b>top</b> — the lower one reports up the chain.</li>
        <li><b>Dashed</b> lines are the reporting tree; a <b>handoff</b> line is a lateral ask (click a line → “Make handoff”).</li>
        <li>Use <b>Order</b> to number which teams run first; <b>Tidy</b> re-arranges the layout.</li>
      </ul>
      <button className="btn primary" onClick={dismiss}>Got it</button>
    </div>
  )
}
```

- [ ] **Step 3: Mount both in `OrgChart.tsx`**

Add imports:
```tsx
import CanvasLegend from './CanvasLegend'
import CoachMarks from './CoachMarks'
```
Inside `<ReactFlow>`, add Panels (legend bottom-left; coach-marks centered overlay):
```tsx
      <Panel position="bottom-left"><CanvasLegend /></Panel>
      <Panel position="top-center"><CoachMarks /></Panel>
```

- [ ] **Step 4: Add CSS to `src/renderer/styles.css`**

```css
.canvas-legend {
  display: flex; flex-direction: column; gap: var(--space-1);
  background: var(--surface-1); border: 1px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 8px 10px;
  font-size: var(--text-xs); color: var(--fg-muted);
}
.canvas-legend .legend-row { display: flex; align-items: center; gap: var(--space-2); }
.legend-line { width: 22px; height: 0; }
.legend-line.report { border-top: 2px dashed var(--fg-dim); }
.legend-line.handoff { border-top: 2px solid var(--signal); }
.legend-badge {
  display: inline-grid; place-items: center; width: 16px; height: 16px;
  border-radius: var(--radius-pill); background: var(--signal-tint); color: var(--signal);
  font-size: 10px;
}
.legend-hint { color: var(--fg-dim); margin-top: 2px; }
.coachmarks {
  max-width: 360px; background: var(--surface-2); border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg); box-shadow: var(--elev-2); padding: 14px 16px; margin-top: 8px;
  color: var(--fg); font-size: var(--text-sm);
}
.coachmarks h3 { margin: 0 0 8px; font-size: var(--text-md); }
.coachmarks ul { margin: 0 0 12px; padding-left: 18px; line-height: var(--lh-normal); }
.coachmarks li { margin-bottom: 6px; }
```

- [ ] **Step 5: Confirm edge styling (report dashed / handoff distinct)**

Read the existing `.react-flow__edge.edge-handoff` and `.edge-ordered` rules in `styles.css`. Ensure the DEFAULT report edge path reads as dashed: if there is no rule giving the base edge a dash, add one:
```css
.react-flow__edge:not(.edge-handoff) .react-flow__edge-path { stroke-dasharray: 5 4; }
```
Leave `.edge-handoff` (solid/colored) and `.edge-ordered` (numbered) as they are. Do not change OrgChart's edge logic.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: passes clean.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/canvas/CanvasLegend.tsx src/renderer/canvas/CoachMarks.tsx src/renderer/canvas/OrgChart.tsx src/renderer/styles.css
git commit -m "feat(orkestr): canvas edge legend + first-run coach-marks"
```

---

### Task 4: Node-card restyle to Foundation tokens

**Files:**
- Modify: `src/renderer/styles.css` (`.agent-node` group, ~lines 235-327)

**Interfaces:** none new.

This task is visual — verify by typecheck + live render. Migrate the card's legacy alias vars to the semantic tokens and refine; role tokens stay.

- [ ] **Step 1: Restyle the card** — replace the `.agent-node` rule + the icon/actions rules with token-based versions:

```css
.agent-node {
  width: 200px;
  background: var(--surface-2);
  border: 1px solid var(--hairline-strong);
  border-left: 3px solid var(--hairline-strong);
  border-radius: var(--radius);
  padding: var(--space-4) var(--space-4);
  box-shadow: var(--elev-1);
  transition: border-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
}
.agent-node:hover { box-shadow: var(--elev-2); }
.agent-node.selected { border-color: var(--signal); box-shadow: 0 0 0 1px var(--signal); }
.agent-icon {
  width: 30px; height: 30px; display: grid; place-items: center;
  border-radius: var(--radius-sm); background: var(--surface-1); border: 1px solid var(--hairline); flex: none;
}
.agent-kind { font-size: var(--text-xs); color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.5px; }
.agent-node-actions { display: flex; gap: var(--space-2); margin-top: var(--space-3); }
.agent-node-actions button {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  font-size: var(--text-xs); padding: 4px 6px; border-radius: var(--radius-sm);
  border: 1px solid var(--hairline-strong); background: var(--surface-1); color: var(--fg);
}
.agent-node-actions button:hover { border-color: var(--signal); background: var(--surface-hover); }
```

Leave the `.agent-node.kind-orchestrator/manager/worker` border-left-color rules and the `.kind-* .agent-icon` color rules as-is (they already use the role tokens). Leave `.agent-name`, `.agent-meta`, and the run-status rules (`.agent-node.run-*`, `.agent-status`) unchanged.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes clean.

- [ ] **Step 3: Live-verify (controller/user)**

Note deferred: cards read warm-dark with gold/periwinkle/teal role accents; selected shows a rose ring; hover lifts; run-status pill still shows during a run.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/styles.css
git commit -m "feat(orkestr): restyle agent cards to Foundation tokens"
```

---

## Self-Review

**Spec coverage:**
- §3 octopus auto-layout (pure fn + apply on structural change + Tidy + persist + skip-mount) → Task 1 + Task 2. ✓
- §4 node-card restyle (tokens + role accents + selected ring) → Task 4. ✓
- §5 edge discoverability (legend + first-run coach-marks + report-dashed/handoff-distinct) → Task 3. ✓
- §6 audit #33 edge-semantics → Task 3. ✓
- §8 architecture (pure shared module; legend/coach-marks extracted; OrgChart focused) → Tasks 1/3. ✓
- §9 testing (octopus-layout TDD; rest typecheck+live) → Task 1 TDD; 2-4 typecheck+live. ✓
- §10 acceptance criteria → all mapped; out-of-scope (§7) respected (no enable-on-gesture/settings, no run/dock/panel, no past-prompts).

**Placeholder scan:** No TBD/TODO. The octopus algorithm + tests + components + CSS are complete. Step 5 of Task 3 ("read existing edge rules, add a dash if absent") is a concrete conditional with the exact rule to add — not a placeholder. CSS values baseline/live-tunable.

**Type consistency:** `octopusLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Positioned[]` (Task 1) is consumed in Task 2 with the exact field mapping (`{id, kind}` / `{source, target, kind, order}`). `Positioned.position` matches `setNodePositions`'s `{ id, position: {x,y} }[]`. The coach-marks `localStorage` key `orkestr:canvas:coachmarks-seen` matches the spec.
