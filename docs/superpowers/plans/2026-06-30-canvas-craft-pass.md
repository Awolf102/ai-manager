# Canvas Craft Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent org-chart canvas feel alive and look richer — hover lift, press feedback, deliberate selection, a depth-staggered entrance for new agents, nodes that glide on Tidy instead of snapping, role-tinted icon chips, and a warm background — all crisp and reduced-motion-safe.

**Architecture:** One pure helper computes a per-node entrance delay from reporting-tree depth (TDD'd). The rest is CSS on the existing card/canvas plus light wiring in two React Flow components (`AgentNode` sets an `--enter-delay` var; `OrgChart` threads the delays, adds a temporary `org-tidying` class during reflow, and warms the background dots). No layout math, edge logic, run wiring, or persistence changes.

**Tech Stack:** TypeScript, React, `@xyflow/react` (React Flow) v12, plain CSS with the warm-dark token system (`src/renderer/tokens.css`), Vitest. Electron 42 (Chromium ~136 — modern CSS available).

## Global Constraints

- **Zero functional change:** do NOT touch `src/shared/octopus-layout.ts`, edge/order/handoff logic, run wiring, the store's persistence, or any engine/IPC file. This is presentation + one pure helper.
- **Calm-conductor personality:** crisp, restrained, **no springs/bounce**. UI motion durations stay ≤320ms; entrances start from `scale(0.96)` + opacity (never `scale(0)`).
- **Easing:** entrances/press/selection use `--ease-out` (`cubic-bezier(0.23,1,0.32,1)`); the on-screen glide uses `--ease-in-out` (`cubic-bezier(0.77,0,0.175,1)`); keep `--ease-standard` for existing subtle border/shadow transitions.
- **Accessibility:** a `@media (prefers-reduced-motion: reduce)` block drops every transform-based motion (lift, glide, entrance translate/scale, press) and the pulse, keeping opacity/color.
- **Warm-dark tokens only, no raw hex in CSS** — except the single warm dot color passed to React Flow's `<Background color>` prop in JS (nothing in CSS consumes it). Role tints are rgba tokens, mirroring the existing `--signal-tint`.
- **Glide must not affect dragging:** the `transition: transform` on nodes is gated behind the `.org-tidying` class, which is present only during a Tidy/auto-layout reflow.
- **Commands:** test = `npm test` (Vitest); a single file = `npx vitest run <path>`; `npm run typecheck`; `npm run build`. Each commit leaves typecheck + build green.

---

### Task 1: Pure entrance-stagger helper

**Files:**
- Create: `src/shared/canvas-motion.ts`
- Test: `src/shared/canvas-motion.test.ts`

**Interfaces:**
- Produces: `export function entranceDelays(nodes: { id: string }[], edges: { source: string; target: string; kind?: 'report' | 'handoff' }[], stepMs?: number): Record<string, number>` — per-node entrance delay in ms, staggered by reporting-tree depth (roots = 0). (The `kind` field on nodes is unused for depth, so the param type takes only `{ id: string }` — `graph.nodes` still fits structurally.)

- [ ] **Step 1: Write the failing tests in `src/shared/canvas-motion.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { entranceDelays } from './canvas-motion'

const n = (...ids: string[]) => ids.map((id) => ({ id }))

describe('entranceDelays', () => {
  it('puts roots at 0 and direct children at one step', () => {
    const d = entranceDelays(n('o', 'a', 'b'), [
      { source: 'o', target: 'a' },
      { source: 'o', target: 'b' }
    ])
    expect(d).toEqual({ o: 0, a: 50, b: 50 })
  })
  it('deepens with each level', () => {
    const d = entranceDelays(n('o', 'm', 'w'), [
      { source: 'o', target: 'm' },
      { source: 'm', target: 'w' }
    ])
    expect(d).toEqual({ o: 0, m: 50, w: 100 })
  })
  it('ignores handoff edges for depth', () => {
    const d = entranceDelays(n('o', 'a'), [{ source: 'o', target: 'a', kind: 'handoff' }])
    // no report edge → both are roots → both 0
    expect(d).toEqual({ o: 0, a: 0 })
  })
  it('honors a custom step', () => {
    const d = entranceDelays(n('o', 'a'), [{ source: 'o', target: 'a' }], 80)
    expect(d).toEqual({ o: 0, a: 80 })
  })
  it('gives a disconnected node delay 0', () => {
    const d = entranceDelays(n('o', 'x'), [])
    expect(d).toEqual({ o: 0, x: 0 })
  })
  it('clamps very deep chains to 6 steps', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] // chain a->b->...->i (depth 8)
    const edges = ids.slice(0, -1).map((s, i) => ({ source: s, target: ids[i + 1] }))
    const d = entranceDelays(n(...ids), edges)
    expect(d['i']).toBe(6 * 50) // clamped at depth 6
  })
  it('is cycle-safe (no infinite loop, no root → all 0)', () => {
    const d = entranceDelays(n('a', 'b'), [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' }
    ])
    expect(d).toEqual({ a: 0, b: 0 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/canvas-motion.test.ts`
Expected: FAIL — `entranceDelays` is not defined.

- [ ] **Step 3: Implement `src/shared/canvas-motion.ts`**

```ts
// Pure helper for canvas entrance motion (no node/DOM imports — unit-tested in plain Node).
// Mirrors octopus-layout.ts's forest/cycle handling: depth from the reporting tree, roots first.

/** Per-node entrance delay (ms), staggered by reporting-tree depth (roots = 0). Handoff edges ignored. */
export function entranceDelays(
  nodes: { id: string }[],
  edges: { source: string; target: string; kind?: 'report' | 'handoff' }[],
  stepMs = 50
): Record<string, number> {
  const MAX_DEPTH = 6
  const ids = new Set(nodes.map((n) => n.id))
  const children = new Map<string, string[]>()
  const hasParent = new Set<string>()
  for (const e of edges) {
    if (e.kind === 'handoff') continue
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    if (!children.has(e.source)) children.set(e.source, [])
    children.get(e.source)!.push(e.target)
    hasParent.add(e.target)
  }
  // roots = nodes with no incoming report edge
  const visited = new Set<string>()
  const depth: Record<string, number> = {}
  const queue: { id: string; d: number }[] = nodes
    .filter((nd) => !hasParent.has(nd.id))
    .map((nd) => ({ id: nd.id, d: 0 }))
  while (queue.length) {
    const { id, d } = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    depth[id] = d
    for (const c of children.get(id) ?? []) {
      if (!visited.has(c)) queue.push({ id: c, d: d + 1 })
    }
  }
  const out: Record<string, number> = {}
  for (const nd of nodes) out[nd.id] = Math.min(depth[nd.id] ?? 0, MAX_DEPTH) * stepMs
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/canvas-motion.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/shared/canvas-motion.ts src/shared/canvas-motion.test.ts
git commit -m "feat(canvas): pure entranceDelays helper (depth-staggered)"
```

---

### Task 2: Tokens + canvas craft CSS

**Files:**
- Modify: `src/renderer/tokens.css` (add curves + role tints)
- Modify: `src/renderer/styles.css` (card depth/hover/press/select/entrance, glide rule, refined pulse, `.btn:active`, reduced-motion)

**Interfaces:**
- Consumes: existing tokens (`--orchestrator`/`--manager`/`--worker`, `--signal`, `--elev-1/2`, `--motion*`, `--ease-standard`, `--accent`, `--accent-dim`, `--surface-1`, `--hairline`).
- Produces (for Task 3 to activate): the `.agent-node` entrance animation reading `var(--enter-delay, 0ms)`, and the `.org-tidying .react-flow__node` glide rule. Until Task 3 wires the class/var, the entrance plays synchronized (delay 0) and the glide rule matches nothing — both green.

- [ ] **Step 1: Add tokens to `src/renderer/tokens.css`**

Directly after the line `--ease-standard: cubic-bezier(0.2, 0, 0, 1);` (around line 61), add:

```css
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --orchestrator-tint: rgba(240, 181, 74, 0.14);
  --manager-tint: rgba(142, 162, 240, 0.14);
  --worker-tint: rgba(79, 209, 197, 0.14);
```

- [ ] **Step 2: Card depth + hover lift + selection — edit `src/renderer/styles.css`**

Replace the `.agent-node` transition line (the existing `transition: border-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);` inside `.agent-node`) with one that includes transform + an entrance animation. The `.agent-node` rule's tail becomes:

```css
  box-shadow: var(--elev-1);
  transition: border-color var(--motion-fast) var(--ease-standard),
    box-shadow var(--motion) var(--ease-out),
    transform var(--motion) var(--ease-out);
  animation: agent-enter var(--motion-slow) var(--ease-out) backwards;
  animation-delay: var(--enter-delay, 0ms);
```

Replace `.agent-node:hover { box-shadow: var(--elev-2); }` with:

```css
.agent-node:hover { box-shadow: var(--elev-2); transform: translateY(-2px); }
```

Replace `.agent-node.selected { border-color: var(--signal); box-shadow: 0 0 0 1px var(--signal); }` with:

```css
.agent-node.selected {
  border-color: var(--signal);
  box-shadow: 0 0 0 1px var(--signal), var(--elev-2);
  transform: translateY(-2px);
}
```

Add the entrance keyframe just above the `.agent-node` rule (or anywhere top-level):

```css
@keyframes agent-enter {
  from { opacity: 0; transform: translateY(6px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
```

- [ ] **Step 3: Role-tinted icon chips — edit `src/renderer/styles.css`**

Replace the three `.kind-* .agent-icon` colour rules with versions that add the faint role tint:

```css
.kind-orchestrator .agent-icon { color: var(--orchestrator); background: var(--orchestrator-tint); }
.kind-manager .agent-icon { color: var(--manager); background: var(--manager-tint); }
.kind-worker .agent-icon { color: var(--worker); background: var(--worker-tint); }
```

- [ ] **Step 4: Press feedback — edit `src/renderer/styles.css`**

Add a transform transition + `:active` to the card action buttons. Replace `.agent-node-actions button:hover { border-color: var(--signal); background: var(--surface-hover); }` with:

```css
.agent-node-actions button {
  transition: transform var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-standard),
    background var(--motion-fast) var(--ease-standard);
}
.agent-node-actions button:hover { border-color: var(--signal); background: var(--surface-hover); }
.agent-node-actions button:active { transform: scale(0.97); }
```

Then, the shared `.btn` (the app-wide press seed). Replace the `.btn` rule's `transition` declaration:

```css
  transition: border-color var(--motion-fast) var(--ease-standard),
              background var(--motion-fast) var(--ease-standard);
```

with one that also transitions transform, and add an `:active` rule right after the `.btn` block:

```css
  transition: border-color var(--motion-fast) var(--ease-standard),
              background var(--motion-fast) var(--ease-standard),
              transform var(--motion-fast) var(--ease-out);
```

```css
.btn:active { transform: scale(0.97); }
```

- [ ] **Step 5: Refine the running pulse — edit `src/renderer/styles.css`**

In the `.agent-node.run-planning, …` rule, change `animation: pulse 1.4s ease-in-out infinite;` to `animation: pulse 1.6s ease-in-out infinite;` (calmer breath). Replace the `@keyframes pulse` body with a softer, wider glow swing:

```css
@keyframes pulse {
  0%, 100% {
    box-shadow: 0 0 0 1px var(--accent), 0 6px 18px rgba(0, 0, 0, 0.35);
  }
  50% {
    box-shadow: 0 0 0 4px var(--accent-dim), 0 8px 22px rgba(0, 0, 0, 0.38);
  }
}
```

- [ ] **Step 6: Glide rule + reduced-motion — append to the end of `src/renderer/styles.css`**

```css
/* ---- Canvas: glide on tidy/auto-layout (gated so dragging stays instant) ---- */
.org-tidying .react-flow__node { transition: transform 320ms var(--ease-in-out); }

@media (prefers-reduced-motion: reduce) {
  .agent-node {
    animation: none;
    transition: border-color var(--motion-fast) var(--ease-standard),
      box-shadow var(--motion-fast) var(--ease-standard);
  }
  .agent-node:hover,
  .agent-node.selected { transform: none; }
  .org-tidying .react-flow__node { transition: none; }
  .agent-node-actions button:active,
  .btn:active { transform: none; }
  .agent-node.run-planning,
  .agent-node.run-assigning,
  .agent-node.run-working,
  .agent-node.run-reviewing,
  .agent-node.run-reflecting { animation: none; }
}
```

- [ ] **Step 7: Typecheck, build, test**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS. (Cards now lift on hover, dip on press, select with a ring+lift, animate in synchronized; the running pulse breathes; `.org-tidying`/`--enter-delay` are inert until Task 3.)

- [ ] **Step 8: Commit**

```bash
git add src/renderer/tokens.css src/renderer/styles.css
git commit -m "feat(canvas): card depth, hover/press/select motion, glide rule, reduced-motion"
```

---

### Task 3: Wire entrance stagger, glide, and warm background

**Files:**
- Modify: `src/renderer/canvas/AgentNode.tsx`
- Modify: `src/renderer/canvas/OrgChart.tsx`

**Interfaces:**
- Consumes: `entranceDelays` from `../../shared/canvas-motion` (Task 1); the `.org-tidying` glide rule + `.agent-node` `--enter-delay` animation (Task 2).
- Produces: the depth-staggered entrance cascade, the glide-on-tidy, and warm background dots — all activated.

- [ ] **Step 1: `AgentNode.tsx` — carry an entrance delay and set the CSS var**

Change the import on line 1 from `import { memo } from 'react'` to:

```tsx
import { memo, type CSSProperties } from 'react'
```

Change the node data type (line 8) to include the optional delay:

```tsx
export type AgentFlowNode = Node<{ agent: AgentNodeData; enterDelay?: number }, 'agent'>
```

In `AgentNodeImpl`, read the delay and set it as a CSS custom property on the card's root `<div>`. Add `const enterDelay = data.enterDelay ?? 0` near the other `const`s, and add a `style` prop to the `.agent-node` div:

```tsx
    <div
      className={`agent-node kind-${agent.kind} ${selected ? 'selected' : ''} ${
        active ? `run-${status}` : ''
      }`}
      style={{ '--enter-delay': `${enterDelay}ms` } as CSSProperties}
    >
```

- [ ] **Step 2: `OrgChart.tsx` — compute delays in `toNodes`, add the glide class, warm the dots**

Add the import near the other shared imports:

```tsx
import { entranceDelays } from '../../shared/canvas-motion'
```

Replace `toNodes` so it computes and threads the per-node delay:

```tsx
function toNodes(graph: ProjectGraph): AgentFlowNode[] {
  const delays = entranceDelays(graph.nodes, graph.edges)
  return graph.nodes.map((a) => ({
    id: a.id,
    type: 'agent',
    position: a.position,
    data: { agent: a, enterDelay: delays[a.id] ?? 0 }
  }))
}
```

Add `useRef` to the React import if not present (it already imports `useRef`). Inside the `OrgChart` component, add tidying state + a timer ref (near the other `useState`s):

```tsx
  const [tidying, setTidying] = useState(false)
  const tidyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(tidyTimer.current), [])
```

In `applyLayout`, after `patchPositions(positioned)` and `void window.api.setNodePositions(positioned)`, trigger the glide window:

```tsx
    setTidying(true)
    clearTimeout(tidyTimer.current)
    tidyTimer.current = setTimeout(() => setTidying(false), 360)
```

On the `<ReactFlow …>` element, add the conditional class and warm the background. Add `className={tidying ? 'org-tidying' : undefined}` to the `<ReactFlow>` props, and change the background line:

```tsx
      <Background gap={22} color="#322A4D" />
```

(from the old `color="#1d2230"` — a warm muted plum-indigo replacing the cool blue).

- [ ] **Step 3: Typecheck, build, test**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS. (New agents now cascade in by depth; Tidy/auto-layout glides; drag is still instant; the background reads warm.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/canvas/AgentNode.tsx src/renderer/canvas/OrgChart.tsx
git commit -m "feat(canvas): depth-staggered entrance, glide on tidy, warm background"
```

---

## Final verification (after all tasks)

- [ ] `npm test` — all pass (incl. the new `canvas-motion` suite).
- [ ] `npm run typecheck && npm run build` — clean.
- [ ] **User visual smoke** (agents can't run the GUI): hover a card (lifts), press Run/Terminal and any `.btn` (dips), select a card (ring + lift, deliberate), click **Tidy** (nodes glide, not snap) and confirm **dragging a node is still instant**, spawn/build a team (cards cascade in down the hierarchy), watch a run (active agents breathe), confirm the background reads warm not cold; toggle OS "reduce motion" and confirm motion drops to opacity/color only. Per Emil: re-check the timing the next day / in slow-mo.

## Spec coverage check

| Spec requirement | Task |
| --- | --- |
| Pure `entranceDelays(nodes, edges, stepMs?)` — BFS depth, handoffs ignored, clamp, cycle-safe | 1 |
| Role-tinted icon chips | 2 (tints) |
| Hover lift; intentional elevation | 2 |
| Press feedback on card buttons + app-wide `.btn:active` | 2 |
| Selection ring + lift (animated) | 2 |
| Entrance: opacity+scale(0.96)+translateY, never scale(0), depth-staggered | 2 (keyframe + `--enter-delay`) + 3 (delays wired) |
| Glide on Tidy/auto-layout, gated so drag stays instant | 2 (`.org-tidying` rule) + 3 (class toggled) |
| Refined calmer running pulse | 2 |
| Warm background (replace cool `#1d2230`) | 3 (`<Background color>`) |
| `--ease-out` / `--ease-in-out` tokens | 2 |
| `prefers-reduced-motion` drops transforms, keeps opacity/color | 2 |
| Zero functional change (no layout/edge/run/persistence/engine edits) | 1 + 2 + 3 (none touched) |
