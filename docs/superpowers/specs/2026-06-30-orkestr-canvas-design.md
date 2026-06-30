# Orkestr — Sub-project 3: Canvas

**Date:** 2026-06-30
**Parent:** `docs/superpowers/specs/2026-06-29-orkestr-overhaul-direction-design.md` (umbrella).
**Builds on:** Foundation (tokens) `378479f`; Shell+IA `e8594cf` (+polish `2850259`); Run experience `2f77f6d`.
**Status:** Design approved (brainstorm). Ready for implementation planning.

The fourth sub-project of the Orkestr overhaul (decomposition item 3). It replaces the canvas's manual place-anywhere layout with an automatic "octopus" hierarchy, restyles the agent cards to Foundation tokens, and makes the edge semantics discoverable. Reference shape: `~/Desktop/Screenshot 2026-06-29 at 11.46.55 AM.png`.

---

## 1. Goal

Make the team canvas self-arranging and legible:
1. **Octopus auto-layout** — compute node positions from the report tree (orchestrator top-center, direct workers around its top arch, managers in a row below, each manager's workers fanned out staggered), auto-sorting on team change with a Tidy button; manual nudges persist between changes.
2. **Node-card restyle** — bring the agent cards onto the Foundation warm-dark tokens with clear role accents.
3. **Edge discoverability** — a corner legend + one-time coach-marks explaining report vs handoff edges, run-order numbers, and the drag-to-connect gesture.

Success = adding agents/edges arranges the team into a clean hierarchy automatically (no manual fiddling), the cards look like Orkestr, and a newcomer can tell what the dashed lines, colored lines, and numbers mean.

---

## 2. Current state (what we're changing)

`src/renderer/canvas/OrgChart.tsx` (React Flow / `@xyflow/react`):
- Node positions are **fully manual** — `toNodes` reads `a.position`; drags persist via `onNodeDragStop → setNodePositions`. New agents land wherever they were created. There is **no auto-layout**.
- Re-seeds nodes on a `nodeSig` (id/name/icon/kind) change; edges on an `edgeSig` (id/order/kind) change. Position changes don't re-seed (drags aren't clobbered).
- Edges: report (default, `animated` until ordered, `edge-ordered` when numbered) vs handoff (`edge-handoff`). **Order** mode (top-right Panel) numbers orchestrator edges (`applyOrderClick`); clicking an edge selects it → a "Make handoff/reporting" Panel toggles `kind`.
- `src/renderer/canvas/AgentNode.tsx`: `.agent-node kind-<kind>` card, Top target + Bottom source handles, head (icon/name/kind + run-status pill), Run (headless) / Terminal (interactive) actions.

Layout source today is `node.position` (persisted via `window.api.setNodePositions`). The octopus layout produces those same positions.

---

## 3. Octopus auto-layout

### 3.1 Pure layout function
New `src/shared/octopus-layout.ts`:
- `octopusLayout(nodes: LayoutNode[], edges: LayoutEdge[], opts?): { id: string; position: { x: number; y: number } }[]`
  - `LayoutNode = { id: string; kind: 'orchestrator' | 'manager' | 'worker' }`; `LayoutEdge = { source: string; target: string; kind?: 'report' | 'handoff'; order?: number | null }`.
- **Report tree only:** build parent→children from edges where `kind !== 'handoff'`; handoff edges are ignored for layout. Children ordered by `order` (ascending, nulls last) then input order.
- **Layering for the primary orchestrator root:**
  - **Orchestrator** at top-center of its subtree.
  - **Direct leaf workers** (report-children of the orchestrator that are `kind: 'worker'` AND have no children) → placed **above** the orchestrator (the "arch"), at `y = orchY - ARCH_GAP`, spread horizontally around the orchestrator's x.
  - **Managers + worker-subtrees** (the orchestrator's other children) → laid out as a tidy tree **below** the orchestrator: a horizontal row of managers at the next layer, each subtree's leaves placed left→right with parents centered over their children; the orchestrator is centered horizontally over this row.
  - **A manager's workers** fan out below it; sibling workers on the same layer are **staggered** (alternating `+STAGGER`/`0` y offset) so adjacent cards don't collide. Deeper nesting recurses with the same tidy rules.
- **Roots / orphans:** every node with no report parent is a root. The first orchestrator root is the primary (centered). Additional roots and orphan nodes (no report edges at all) are laid out as their own small trees / single cards and placed in a row beneath everything, so nothing is lost or overlapping.
- **Deterministic:** no `Math.random`/time; same input → same output (so it's testable and stable).
- **Tunable constants** (baseline; live-tuned to match the reference): `CARD_W`, `CARD_H`, `COL_GAP` (sibling x gap), `ROW_GAP` (layer y gap), `STAGGER` (worker alternation), `ARCH_GAP` (direct-worker height above orchestrator).

### 3.2 Applying it in OrgChart
- Compute a **structural signature** = report-tree shape (node ids + kinds + report edges, excluding positions and handoff edges). When it changes (agent or report edge added/removed), run `octopusLayout`, set the React Flow nodes to the computed positions, and persist via `window.api.setNodePositions`.
- A **Tidy** button (canvas Panel) runs `octopusLayout` on demand and persists.
- **Manual nudges persist** between structural changes (today's `onNodeDragStop` behavior is unchanged); a structural change (or Tidy) recomputes and overwrites positions. This matches the chosen "auto-sort on team change + Tidy" model.
- Handoff edges changing kind does NOT trigger a re-layout (they're not part of the tree) — but adding/removing a report edge does.

---

## 4. Node-card restyle

- Restyle `.agent-node` and its parts to Foundation tokens (`--surface-*`, `--hairline*`, `--fg*`, `--radius-*`, `--space-*`, `--text-*`, `--elev-*`) — no token redefinition.
- **Role accent** per `kind-*` using the existing role tokens: orchestrator `--orchestrator` (gold), manager `--manager` (periwinkle, already re-mapped), worker `--worker` (teal) — e.g. a left border/ring + icon tint, matching the reference screenshot.
- Refine the head (icon, name, KIND label), the Run/Terminal actions (use the Foundation button styling), the `selected` ring (rose `--signal`), and the run-status pill (`st-*`).
- Keep the Top target / Bottom source handles and both action buttons. No behavior change — restyle only.

---

## 5. Edge discoverability

- **Compact corner legend** (canvas Panel, e.g. bottom-left): a small key — dashed line = "reports to", colored line = "handoff", ① = "run order", and a one-line "drag bottom → top to connect" hint. Uses tokens; unobtrusive; always available. Collapsible to a small "?" is acceptable but a compact always-on key is the default.
- **First-run coach-marks:** one-time dismissible tips shown the first time the canvas is opened (point at an edge/handle to explain connect + report-vs-handoff). Tracked by a `localStorage` first-run flag (e.g. `orkestr:canvas:coachmarks-seen`), per machine; a "Got it"/dismiss clears it permanently. Never shown again after dismissal.
- **Edge styling:** report edges read as **curved dashed** lines; handoff edges visually distinct (e.g. solid/colored via `edge-handoff`); ordered edges show the number badge (`edge-ordered`). Keep the existing Order mode + Make-handoff/reporting controls unchanged.

---

## 6. Audit UX criteria owned here

From the umbrella §5 (audit `docs/audits/2026-06-27-tool-audit.md`):
- **#33 (edge-semantics part):** undiscoverable canvas edge semantics (report vs handoff, edge order) → the legend + coach-marks (§5). (The top-bar/run-button/terminal parts of #33 were done in Shell+IA.)

---

## 7. Out of scope

- **Enable-on-gesture for handoffs** (when drawing a handoff edge while `maxHandoffs` is off, offer to enable it) — needs the gated-feature setting; folded into the **Settings & gated cycle (5)**. Noted as a cross-ref; not built here.
- Settings, Context, the past-prompts picker — their own cycles.
- Tab/divider/menu ARIA — the pooled later a11y pass.
- Changing run/dock/panel behavior — those surfaces are shipped; this cycle is canvas-only.
- A full graph-layout engine / collision solver beyond the octopus rules (YAGNI — the tidy-tree + stagger is enough for these team sizes).

---

## 8. Architecture / units

- **New pure module** `src/shared/octopus-layout.ts` — the layout algorithm; no React/DOM; deterministic; the testable core.
- **`OrgChart.tsx`** — gains: the structural-signature effect that applies + persists the layout, the Tidy Panel button, and mounts the legend + coach-marks. Keep it focused; extract the legend and coach-marks into small components (`canvas/CanvasLegend.tsx`, `canvas/CoachMarks.tsx`) so OrgChart doesn't bloat.
- **`AgentNode.tsx`** — restyle only (classes/markup as needed for the accent); logic unchanged.
- **`styles.css`** — card, legend, coach-marks, and edge styling.

---

## 9. Testing

Per the project pattern (pure logic TDD'd; UI/visual by typecheck + build + live render):
- **Unit (TDD)** `octopus-layout.ts` on a known tree (1 orchestrator; 1 direct leaf worker; 2 managers each with 2 workers): assert the orchestrator's y is above the managers' y and below the direct worker's y; the managers share one row (equal y) and the orchestrator's x is centered over them; each manager's workers sit below it; sibling workers on a layer are staggered (their y differs by `STAGGER`); output is deterministic across runs; handoff edges don't change positions; orphan nodes get a position (not NaN/overlapping the root).
- **Type/build:** `tsc` + `npm run build` clean. (Executor note: the full build ~9 min has dropped subagent connections — run typecheck in-agent; controller runs the build at the integration gate.)
- **Live verify:** add/remove agents and report edges → the team re-arranges into the octopus shape; Tidy re-runs it; drags persist until the next structural change; cards show role accents + run status; the legend explains the edges; coach-marks appear once then never again after dismissal; report edges are curved dashed, handoff distinct, order numbers shown.

---

## 10. Acceptance criteria

1. `octopusLayout` is a pure, deterministic, TDD'd function that arranges a report tree into the octopus shape (orchestrator top-center, direct leaf workers above its arch, managers in a row below, workers fanned out staggered; orphans placed, no overlaps/NaN).
2. The canvas auto-sorts on structural change (agent/report-edge add/remove) and via a Tidy button; manual drags persist between structural changes.
3. Handoff edges are excluded from the layout tree; changing an edge's kind to/from handoff does not by itself reflow the report tree (adding/removing a report edge does).
4. Agent cards are restyled to Foundation tokens with role accents (gold/periwinkle/teal), selected ring in rose, run-status pill; handles + Run/Terminal preserved.
5. A corner legend explains report vs handoff edges + run-order + connect gesture; first-run coach-marks appear once and never again after dismissal.
6. `tsc` + build clean; `octopus-layout` unit tests pass; existing tests still pass; live-verified per §9.
7. No out-of-scope changes (no enable-on-gesture/settings, no run/dock/panel changes, no past-prompts picker).
