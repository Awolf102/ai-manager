# Canvas Craft Pass — Motion + Visual Depth for the Agent Org-Chart

**Date:** 2026-06-30
**Status:** Approved design, ready for implementation planning
**Roadmap:** Second surface of the post-overhaul **visual modernization arc** ([[ai-manager-visual-pass]]). The user invoked the `emil-design-eng` skill — "make the UI better, less slop, it looks really boring" — chose **both** (it's inert AND visually flat) and **one hero surface, deeply**, and picked **the canvas** as the hero. Self-contained renderer change driven by Emil Kowalski's design-engineering craft.

## Motivation

The canvas is the app's centerpiece and identity — the "conductor's stage" where the agent team lives — but it is almost entirely **static**. A repo-wide audit found only ~8 CSS transitions total and **zero `:active` press states**; the motion-token system Foundation shipped (`--motion`, `--ease-standard`) is barely wired. On the canvas specifically: hover only swaps a shadow, selection is a flat ring, **Tidy/auto-layout snaps nodes instantly** (teleport), new agents pop in with no entrance, the only animation is the run-state pulse, and the React-Flow background dots are a **cool blue `#1d2230`** that fights the warm-dark palette. The result reads inert and a little cheap.

This cycle pours real craft into the canvas — motion *and* visual depth — so it feels alive and looks intentional, following Emil's framework (every animation justified by frequency, purpose, easing, duration) and the brand's *calm-conductor* voice (crisp, never bouncy).

## Goals

- Make the canvas **feel alive**: hover lift, press feedback, deliberate selection, an entrance cascade for new agents, and — the signature moment — nodes that **glide** to new positions on Tidy/auto-layout instead of snapping.
- Make it **look richer**: role-tinted icon chips, intentional elevation, and a warm background that stops reading cold.
- Stay **calm-conductor**: short durations, real purpose per motion, no bounce/springs, full `prefers-reduced-motion` support.
- **Zero functional change**: layout math, edges, run wiring, persistence are untouched; this is presentation + a small pure stagger helper.

## Decisions locked in brainstorming

- **Hero surface:** the canvas (`src/renderer/canvas/`). One surface, deep.
- **Both halves:** motion (inert → alive) AND visual depth (flat → richer).
- **Personality:** calm-conductor → crisp & restrained. No springs/physics, no bounce, no role-colored hover glows (considered, rejected as too much). Durations stay short (≤320ms).
- **Glide-on-tidy via a temporary class** so dragging stays instant and pan/zoom is untouched.
- **Entrance fires only for genuinely new cards** (React Flow reconciles by id; existing card instances don't remount), staggered by **org depth** (orchestrator → managers → workers).
- **One app-wide seed:** `.btn:active { transform: scale(0.97) }` — the only change reaching beyond the canvas, so every button gains press feedback cheaply.
- **Add two Emil curves as tokens**; keep `--ease-standard` for existing subtle transitions.

## Architecture

### Pure core — `src/shared/canvas-motion.ts` (NEW, node/DOM-free, unit-tested)

The one piece of real logic — the meaningful entrance stagger:

```ts
/** Per-node entrance delay (ms), staggered by org depth (roots first). Report edges only. */
export function entranceDelays(
  nodes: { id: string; kind: AgentKind }[],
  edges: { source: string; target: string; kind?: 'report' | 'handoff' }[],
  stepMs?: number // default 50
): Record<string, number>
```

- Build the reporting tree from non-handoff edges; BFS depth from roots (nodes with no incoming report edge, e.g. the orchestrator = depth 0).
- delay = `depth * stepMs`, clamped to a max (e.g. `min(depth, 6) * stepMs`) so a deep tree never delays absurdly.
- A node not reached from any root (disconnected) gets depth 0.
- Cycle-safe (visited set), mirroring `octopus-layout.ts`'s forest handling.

### Card — `src/renderer/canvas/AgentNode.tsx`

- Wrap the role icon so its chip can carry a **role-tinted background** (faint tint of `--orchestrator`/`--manager`/`--worker`) — driven by the existing `kind-*` class, no JSX logic change needed beyond what's already there.
- Accept an **entrance delay** as a CSS custom property: the node's `data` gains `enterDelay?: number` (set in `OrgChart.toNodes`), and the card sets `style={{ '--enter-delay': `${enterDelay ?? 0}ms` }}`. The mount animation reads it.
- No change to behavior, handles, or the Run/Terminal buttons (those gain press feedback via CSS only).

### Canvas — `src/renderer/canvas/OrgChart.tsx`

- **Entrance delays:** compute `entranceDelays(graph.nodes, graph.edges)` (memoized on the structure signature) and thread each node's delay into `toNodes` → `data.enterDelay`.
- **Glide-on-tidy:** add `const [tidying, setTidying] = useState(false)`. In `applyLayout()` (called by the Tidy button AND the auto-tidy `structSig` effect), set `tidying = true`, then a `setTimeout(() => setTidying(false), 360)`. Render `<ReactFlow className={tidying ? 'org-tidying' : undefined} …>`. CSS enables `transition: transform` on `.react-flow__node` only while `.org-tidying` is present — so drags (no class) stay instant. Clear any pending timeout on unmount.
- **Warm background:** change `<Background … color="#1d2230" />` to a warm value (a token-derived color, e.g. `var(--canvas-dot)` resolved to a faint warm tone — pass the resolved color string; define `--canvas-dot` in tokens). Keep `gap={22}`.
- No change to layout math, edge handling, drag persistence, delete flow, order mode, or handoff conversion.

### Tokens — `src/renderer/tokens.css`

Add the two Emil curves and the dot color (all alongside the existing `--motion-*` / `--ease-standard`):

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);     /* entrances, press, selection */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1); /* on-screen movement: the glide */
--canvas-dot: #322A4D;                            /* warm muted plum-indigo, replaces cool #1d2230 (tunable in build) */
```

### Styles — `src/renderer/styles.css`

| Element | Change | Easing / duration |
| --- | --- | --- |
| `.agent-icon` (per `kind-*`) | faint role-tinted background | n/a (visual) |
| `.agent-node` hover | add `transform: translateY(-2px)` (keep `--elev-2`) | `--ease-out` 150ms |
| `.agent-node.selected` | ring scales+fades in + slight lift (animate box-shadow + transform) | `--ease-out` 150ms |
| `.agent-node` enter | one-shot keyframe: `opacity 0→1`, `scale(.96→1)`, `translateY(6→0)`, `animation-delay: var(--enter-delay)` | `--ease-out` 260ms |
| `.org-tidying .react-flow__node` | `transition: transform 320ms var(--ease-in-out)` | on-screen move |
| `.agent-node-actions button`, `.btn` | `:active { transform: scale(0.97) }` + `transition: transform 120ms var(--ease-out)` | press feedback |
| `.agent-node.run-*` pulse | refine to a calmer breathing glow (keep ~1.4s ease-in-out infinite, gentler intensity) | status |
| `@media (prefers-reduced-motion: reduce)` | drop transform-based motion (lift, glide, entrance translate/scale, press); keep opacity/color; pulse → static ring or gentle opacity | a11y |

Notes:
- **Never `scale(0)`** — entrance starts at `scale(0.96)` + opacity (Emil: nothing appears from nothing).
- The entrance keyframe runs once per card *mount*; because React Flow reconciles existing nodes by id, only newly-added cards (and a one-time gentle cascade on project load) animate — a structure change does not replay it for existing cards.
- Press feedback uses `:active` `scale(0.97)`; the draggable card itself is NOT scaled on press (only its buttons + shared `.btn`), to avoid fighting React Flow's drag.

## Data flow

`graph` → `OrgChart`: `entranceDelays(nodes, edges)` (memo) → `toNodes` writes `data.enterDelay` → `AgentNode` sets `--enter-delay` → CSS entrance keyframe staggers by depth. `applyLayout()` (Tidy/auto-tidy) → `setTidying(true)` for 360ms → `.org-tidying` on the flow → nodes transition their transform to the new positions → `setTidying(false)`. All persistence (`setNodePositions`, `patchPositions`) is unchanged.

## Error handling / edge cases

- **Drag during a glide window** (rare): the dragged node may briefly transition — acceptable; not worth excluding.
- **Reduced motion:** every transform-based motion is gated off; the UI stays fully coherent (instant, opacity/color only).
- **Deep/disconnected trees:** `entranceDelays` clamps depth and treats unreached nodes as depth 0 (no absurd delay, no crash); cycle-safe.
- **First load:** the `mounted` guard already skips auto-layout on first render, so there's no glide on initial load — cards simply do the gentle entrance cascade.
- **Background color:** passed as a resolved color string to React Flow's `<Background color>` (it doesn't read CSS vars itself); the warm value lives in a token and is mirrored to the prop.

## Testing

- **Pure unit (`src/shared/canvas-motion.test.ts`)** — the real coverage: `entranceDelays` — root(s) at 0; children at `stepMs`, grandchildren `2*stepMs`; handoff edges ignored; depth clamp; disconnected node → 0; cycle-safe (no infinite loop); custom `stepMs`.
- **Renderer/CSS** — `AgentNode.tsx`, `OrgChart.tsx`, `tokens.css`, `styles.css`: verified by `npm run typecheck` + `npm run build` + the full Vitest suite staying green (house precedent; no logic in the components beyond wiring the pure helper).
- **Visual smoke (user):** open the canvas — hover lifts, buttons dip on press, selecting a card feels deliberate, **Tidy glides** (and drag is still instant), spawning a team cascades in, the running pulse breathes, the background reads warm; toggle OS reduced-motion and confirm motion drops to opacity/color. Per Emil: review the motion the next day / in slow-mo to catch timing.

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/canvas-motion.ts` | NEW pure `entranceDelays(nodes, edges, stepMs?)` (BFS depth → delay map) |
| `src/shared/canvas-motion.test.ts` | NEW unit tests |
| `src/renderer/canvas/AgentNode.tsx` | role-tinted icon chip hook (via existing `kind-*`); set `--enter-delay` from `data.enterDelay` |
| `src/renderer/canvas/OrgChart.tsx` | compute + thread entrance delays; `tidying` state + `org-tidying` class; warm `<Background color>` |
| `src/renderer/tokens.css` | `--ease-out`, `--ease-in-out`, `--canvas-dot` |
| `src/renderer/styles.css` | card depth/hover/press/select/enter CSS; `.org-tidying` glide; refined pulse; `.btn:active` press; `prefers-reduced-motion` block |

**No changes** to `octopus-layout.ts`, edge/order/handoff logic, run wiring, the store's persistence, or any engine/IPC file. Other surfaces are untouched (except the one shared `.btn:active` press seed).

## Risks / edge cases

- **`.btn:active` is app-wide.** It's a single, low-risk rule (scale 0.97 + 120ms) that benefits every button; intentionally the only cross-surface change. If any button must not scale, it can opt out later — not expected.
- **React Flow internals.** The glide relies on transitioning `.react-flow__node`'s `transform`; React Flow v12 sets node position via inline `transform` and adds no transition of its own, so a scoped CSS transition composes cleanly. Gated behind `.org-tidying` so it never affects drag.
- **Entrance replay.** If a future refactor changes how `OrgChart` re-seeds nodes (e.g. remounting by a changing key), the entrance could replay for existing cards. The current `setNodes(toNodes(graph))` reconciles by id and does not remount — preserve that.
- **Calm, not flashy.** Durations and curves are tuned for a professional dashboard; if it still reads "boring," the dial to turn is up (more presence on hover/selection), but bounce/springs stay out per the brand.
