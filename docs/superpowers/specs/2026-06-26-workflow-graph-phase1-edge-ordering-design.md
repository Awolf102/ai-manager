# Workflow-Graph Canvas — Phase 1: Clickable Edge Ordering

**Date:** 2026-06-26
**Status:** Approved design, ready for implementation planning
**Roadmap:** #1 (workflow-graph canvas) — **Phase 1 of 3**. Phases 2 (goal-locked mid-run re-planning) and 3 (lateral team↔team handoffs) are separate, later spec/plan/build cycles. Background: memory `ai-manager-workflow-graph`.

## Motivation

The canvas today is a pure ORG CHART: a `GraphEdge` is `{id, source, target}` meaning only "source delegates to target," and routing consumes edges as a strict tree (`childrenOf`). Execution order half-exists — Stage 4 `dependsOn` runs tasks in waves (`depsSatisfied`) — but it's planner-decided, per-task, and not expressible on the canvas. The user wants the canvas to express not just structure but the **order work flows in**: "this team runs first, then that team."

Phase 1 is the cheapest, lowest-risk step into that arc: let the user stamp an execution order onto the top-level flow lines, and have the engine sequence those teams by deriving the order onto the existing `dependsOn` wave machinery. It's purely additive — a project with no ordering behaves byte-for-byte as today — and it doesn't touch the routing tree.

## Goals

- A canvas affordance to author a **top-level execution order**: number the orchestrator's direct-child edges into a single 1..N sequence.
- The engine **runs the ordered teams in that order**, reusing the existing `dependsOn` wave loop (no changes to `executeNode`).
- **No ordering set → byte-for-byte today's behavior.**
- Clear visual language: animated line = concurrent; numbered solid line = sequenced stage N.

## Non-goals (out of scope, YAGNI)

- **Deeper / per-parent ordering** (e.g. sequencing a manager's workers). Phase 1 orders only the orchestrator's direct children — one global sequence.
- **Output-prompt threading between stages** — later teams do NOT get earlier stages' output text spliced into their prompts. Sequencing alone is the deliverable; agents share the project filesystem, so a later stage sees earlier stages' file changes. (Threading is a clean later add if needed.)
- **Typed edges / lateral handoffs** (Phase 3) and **mid-run re-planning** (Phase 2).
- **Run-view / history changes** — sequencing is implicit; the canvas badge is the only new surface.

## Decisions locked in brainstorming

- **Phase 1 only** (clickable edge ordering); the 3-phase arc is decomposed, build order 1→2→3.
- **UX:** an "Order" mode toggle + click-in-sequence (click edges in run order; click an ordered edge to clear+re-pack); numbered badge per ordered edge.
- **Scope:** orderable edges = the orchestrator's direct children only → one global 1..N sequence; everything inside a team stays parallel.
- **Engine approach (A):** derive task `dependsOn` from the ordered top-level subtrees and ride the existing wave loop; `executeNode` unchanged.
- **No output-prompt threading** in Phase 1 (filesystem is the shared medium).

## Architecture

### Data model — `src/shared/types.ts`

`GraphEdge` gains an optional order:

```ts
export interface GraphEdge {
  id: string
  source: string
  target: string
  order?: number // 1..N execution sequence; consumed only on edges whose source is the run's orchestrator
}
```

Additive; rides `graph.json` through the existing `setEdges` persistence. `setEdges` must preserve `order` (it currently rebuilds `graph.edges` from the passed array, which carries `order` — confirm no field is dropped).

### Canvas UX — `src/renderer/canvas/OrgChart.tsx`

- An **"Order" toggle** (a small button rendered over the canvas, e.g. in a corner toolbar). Default off.
- **Order mode on:** clicking an edge whose `source` is an orchestrator stamps the next sequence number (`max(existing top-level orders) + 1`); clicking an already-ordered edge **clears its order and re-packs** the remaining numbers to stay contiguous (1..N, no gaps). Clicks on non-top-level edges are ignored. Each change persists via `setEdges`.
- **Rendering:** an ordered edge shows `label: String(order)` (a numbered badge) and renders solid/non-animated with an accent stroke; unordered edges keep the current animated look. (Map this in `toEdges`: `animated: e.order == null`, `label: e.order != null ? String(e.order) : undefined`, plus a class/style for ordered.)
- **Order mode off:** edges behave exactly as today (`onConnect`/`onEdgesDelete`/select). The toggle only changes click behavior; it does not change the underlying graph except through explicit stamps.
- A subtle "Order mode" affordance (e.g. button highlighted + a hint) so the user knows clicks now stamp order.

### Engine — pure derivation + one merge point

New pure, node-free helper `src/shared/workflow-order.ts`:

```ts
export function deriveOrderDeps(
  edges: { source: string; target: string; order?: number }[],
  orchestratorId: string,
  tasks: { id: string; ownerId: string | null }[]
): Record<string, string[]>
```

Logic (pure):
1. Build a child map from `edges` (source → [targets]).
2. `orderedTeams` = edges where `source === orchestratorId` and `order != null`, sorted ascending by `order` → `[{ root: target, order }]`.
3. For each team root, compute its **subtree** node set (BFS over the child map, including the root).
4. `teamOf(ownerId)` = the root whose subtree contains the owner (tree ⇒ at most one); group owned task ids by team root → `tasksByTeam`.
5. For each task whose team has order *k*: its extra deps = the union of all task ids in teams with order *< k*.
6. Return `{ [taskId]: extraDepIds }` (only tasks that gain deps).

**Merge point** — `routeNode` (`src/main/engine/nodes.ts`), after `routeTasks` has assigned owners and before the return: build `ownedTasks` (`{id, ownerId}`), call `deriveOrderDeps(getEdges(), state.orchestratorId, ownedTasks)`, and union each result into `tasks[id].dependsOn` (dedup with any planner deps). `executeNode` is untouched — its wave loop, `depsSatisfied`, and cycle-guard sequence the teams.

New `src/main/engine/project-store.ts` accessor:

```ts
export function getEdges(): GraphEdge[] { return requireCurrent().graph.edges }
```

### Why this rides the existing machinery

`depsSatisfied(t, tasks)` already blocks a task while any *owned* dependency is `pending`/`running`, and the wave loop re-evaluates each wave. Order-derived deps are real owned task ids, so a later team's tasks simply won't enter a wave until the earlier teams' tasks have executed. Errors flip a task to `done` (so they don't block forever), and the deps form a strict earlier→later chain (no cycles).

## Data flow

Canvas (order mode) → stamp `GraphEdge.order` → `setEdges` → `graph.json`. At run time: `planNode` → `routeNode` (assign owners, then `deriveOrderDeps(getEdges(), orchestratorId, ownedTasks)` merged into `tasks[*].dependsOn`) → `executeNode` waves run the teams in order → review/reflect/synth as today.

## Error handling / edge cases

- No ordered edges → `deriveOrderDeps` returns `{}` → no added deps → **byte-for-byte today**.
- Ordered team with no assigned tasks → empty `tasksByTeam` entry → contributes nothing; later teams don't wait on emptiness.
- An earlier team's task that errors still flips to `done` in `executeNode` → `depsSatisfied` true → later teams proceed (no permanent block).
- Order-derived deps are a strict earlier→later chain → acyclic; the existing executeNode cycle-guard (run-the-rest when nothing's ready) is the backstop.
- Flat orchestrator (owns tasks directly, no children) → no top-level edges → ordering inert.
- `order` on a non-orchestrator edge → ignored by `deriveOrderDeps` (and the UI only stamps orchestrator-source edges).
- Deleting an ordered edge (normal mode) → its order vanishes with it; remaining orders may have a gap until next re-pack — acceptable (engine reads orders as a relative sort, gaps are harmless).

## Testing

- **Pure unit (`src/shared/workflow-order.test.ts`)** — the real coverage:
  - two teams (orders 1,2): every team-2 task depends on every team-1 task; team-1 tasks gain nothing.
  - three teams chain (1,2,3): team-3 tasks depend on teams 1 ∪ 2.
  - unordered teams: no edges with `order` → `{}`.
  - a multi-node team (orchestrator→manager→2 workers, ordered 1) ahead of a second team (ordered 2): all of team-1's worker tasks gate team-2.
  - empty earlier team (order 1 with no tasks) → team-2 gains no deps.
  - mixed: one ordered team + one unordered direct worker → only the ordered relationships are added.
- **`src/main/engine/nodes.test.ts`** — an integration test mirroring the existing `dependsOn`-ordering test: build `o → t1(team A), o → t2(team B)` with edge orders A=1,B=2, delay team A's worker, assert team A's task executes before team B's (order respected); and a no-order control that runs them in parallel as today.
- **OrgChart UX** — typecheck + build (renderer house precedent).

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/types.ts` | `GraphEdge.order?: number` |
| `src/shared/workflow-order.ts` | NEW pure `deriveOrderDeps(edges, orchestratorId, tasks)` |
| `src/shared/workflow-order.test.ts` | NEW unit tests |
| `src/main/engine/project-store.ts` | `getEdges()` accessor; verify `setEdges` preserves `order` |
| `src/main/engine/nodes.ts` | `routeNode` merges `deriveOrderDeps(...)` into `tasks[*].dependsOn` after routing |
| `src/main/engine/nodes.test.ts` | ordered-teams integration test + no-order control |
| `src/renderer/canvas/OrgChart.tsx` | Order-mode toggle; click-in-sequence stamping + re-pack; ordered-edge label/style; `toEdges` maps `order` |
| `src/renderer/styles.css` | ordered-edge / order-toggle styling |

No changes to `executeNode`, the run record/history, the review/reflect nodes, or `setEdges`'s signature.

## Risks / edge cases

- **`setEdges` dropping `order`** — it rebuilds `graph.edges` from the passed array; the passed `GraphEdge[]` carries `order`, so it persists. The plan must verify the filter (`ids.has(source)&&ids.has(target)`) keeps the whole edge object (it does — `.filter` preserves the element), so `order` survives.
- **Click-target precision in order mode** — clicking an edge in React Flow fires `onEdgeClick`; ensure the toggle routes edge clicks to the stamping handler and suppresses select/delete while on.
- **Multiple orchestrators** — ordering is per-edge-source; at run time only the run's `orchestratorId` edges' orders are consumed, so stray orders under a non-run orchestrator are inert. Acceptable.
- **Sequencing granularity** — a later team waits for earlier teams to *execute*, not to be *reviewed/repaired* (review is a later phase over all tasks). This is the intended "stage-before-stage" semantics; documented so it isn't mistaken for "fully QA'd before next."
- **Re-pack vs gaps** — clearing in order mode re-packs to 1..N; deleting an ordered edge in normal mode can leave a gap until the next stamp. Harmless because the engine treats orders as a relative sort.
