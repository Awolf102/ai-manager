# Orkestr — Sub-project 1: App Shell + Panel System + Top-bar IA

**Date:** 2026-06-29
**Parent:** `docs/superpowers/specs/2026-06-29-orkestr-overhaul-direction-design.md` (umbrella direction + decomposition)
**Builds on:** sub-project 0 Foundation (design tokens, restyled primitives, Toast/notify) — SHIPPED to main `378479f`.
**Status:** Design approved (brainstorm). Ready for implementation planning.

The second sub-project of the Orkestr overhaul. It turns today's fixed layout into a flexible, persistent panel shell and fixes the top-bar information architecture, so every later surface (Run experience, Canvas, etc.) re-homes into a sane, discoverable container. Visual execution uses the Foundation tokens + live iteration.

---

## 1. Goal

Make the app shell flexible and discoverable:
1. **Panel system** — the right inspector and bottom dock become resizable, collapsible, and re-placeable, with per-project persistence (today both are fixed).
2. **Top-bar IA** — declutter the crowded icon-only row into labeled groups + a "Team" overflow menu, and add the FAQ "how to prompt" button.
3. **Run-button disambiguation** — kill the "Run" / "Run result" collision.
4. **Terminal-hides-live-run fix** — keep an active run reachable when an agent terminal is open.

Success = the shell is rearrangeable and remembers its layout per project, the top bar is grouped/labeled/findable, there is exactly one thing called "Run," and an in-progress run is never hidden by opening a terminal — with no regressions to running, canvas, or the dock's existing tabs.

---

## 2. Current state (what we're changing)

- `.app` is a 2-row grid (top bar 48px / body). `.body` is `grid-template-columns: 1fr 348px` — canvas-area + a **fixed 348px** right `.sidepanel`. `.main` is `grid-template-rows: 46px 1fr var(--dock-h, 300px)` — goal bar / canvas / bottom dock; **`--dock-h` is never set in JS, so the dock is a fixed 300px**. There is no resize/collapse/divider logic anywhere and no left rail.
- The **bottom dock** is a tab strip (`activeDockId` in the store selects the single visible slot): a Run tab (when `showRunView`), a History tab (when `showHistory`), and one tab per open terminal. `openTerminal` sets `activeDockId` to the new terminal — which is why opening a terminal navigates away from (hides) the live Run view.
- The **top bar** (`App.tsx`) is: `Orkestr` wordmark + project name + auth pill + 8 icon-only buttons (switch project, history, export, import, sync↑, sync↓, context, settings) + the "Add agent" primary.
- The **goal bar** (`GoalBar.tsx`) has four buttons crowded together: Draft roles · Build team · **Run result** · **Run** (Run becomes Stop while running).

---

## 3. Panel system

### 3.1 Zones (this cycle)
- **Right inspector** — today's `.sidepanel` (agent config + role memory, or the empty hint).
- **Bottom dock** — today's tabbed dock (Run / History / terminals).
- **Left rail — deferred** (no content for it yet; a future cycle adds it if an agent-list/nav emerges). Build the panel abstraction so a third zone can be added later without rework, but ship only the two.

### 3.2 Resize
- A draggable divider on each zone's inner edge (vertical divider left of the inspector; horizontal divider above the dock). Drag updates the zone size live.
- Clamp to sensible min/max (e.g. inspector 280–560px; dock 160px–60% of viewport height) so a zone can't be dragged to unusable or swallow the canvas.

### 3.3 Collapse
- Each zone has a collapse/expand toggle. Collapsed = hidden, with a thin persistent affordance to re-open (e.g. a small edge tab/button). The canvas reclaims the space. Collapsing never loses the zone's contents/state.

### 3.4 Placement swaps
- **Inspector:** left ↔ right.
- **Dock:** bottom ↔ right.
- If both the inspector and the dock are placed right, they stack within the right column (each keeps its own resize). Keep the rule simple and predictable; document the chosen stacking behavior in the plan.

### 3.5 Persistence
- Layout state — each zone's size, collapsed flag, and placement — persists **per project**, keyed by project path, in `localStorage`. Rationale: layout is a local view preference; it must NOT travel with team export/import and must NOT touch `graph.json`.
- On opening a project, restore its saved layout; first-open uses sensible defaults (inspector right ~348px, dock bottom ~300px) that reproduce today's layout.

### 3.6 Structure
- Introduce a small, focused panel abstraction (a `Panel`/zone component or hook owning size/collapsed/placement + the divider drag) rather than ad-hoc grid math in `App.tsx`. Keep `App.tsx` readable; the panel logic should be unit-testable in isolation (pure size-clamp + layout-state reducer, mirroring the Foundation `toasts.ts` pattern).

---

## 4. Top-bar IA

- **FAQ button:** a `?` icon button placed **to the left of the `Orkestr` wordmark**; opens the "how to prompt" guide (§7).
- **Grouping:** reorganize the icon row into labeled, logically grouped controls (icons keep text labels and/or clear tooltips so nothing is icon-only-mystery). Suggested clusters: Project (switch project, settings), View (history, context), Team (the brain ops below), and the primary **Add agent**. The auth pill stays.
- **"Team ▾" overflow menu:** collapse the 4 low-frequency team-brain actions — **export, import, sync↑ (to team brain), sync↓ (from team brain)** — behind a single labeled menu, so they're grouped and out of the primary row but still discoverable. The linked-team indicator stays visible when present.
- Use Foundation primitives/tokens throughout; this is restyle + reorganize, not new functionality (each action keeps its existing handler).

---

## 5. Run-button disambiguation

- Rename **"Run result" → "Launch app"** (keep the rocket icon; update its tooltip to "Launch the app your team built and open it"). This removes the "Run"/"Run result" collision.
- **"Run"** stays the single clear primary action (runs the team); it still becomes **Stop** while running.
- Visually separate the **secondary goal tools** (Draft roles · Build team · Launch app) from the **primary Run/Stop** in the goal bar, so the primary action reads as primary (e.g. group the three tools, set Run apart). Exact arrangement tuned in execution.

---

## 6. Terminal-hides-live-run fix

- While a run is active, the **Run tab stays present and shows a live "● running" indicator** in the dock tab strip.
- Opening an agent terminal must not bury the live run: opening a terminal during an active run **does not steal the active dock view from Run** (the terminal opens as a tab but the run stays in view), OR — if a placement makes it natural — the run remains visible in its zone while terminals occupy the dock. Pick the simpler option in the plan; the invariant is: **an in-progress run is always one obvious action away, never hidden.**
- Closing terminals retains today's sensible fallback behavior.

---

## 7. FAQ / "how to prompt" guide

- A lightweight modal (consistent with the Foundation modal shell) opened by the top-bar `?` button.
- Content: a short, calm-conductor-voiced guide — what makes a good goal, how delegation/the chain works, what Draft roles / Build team / Run / Launch app do, and where output appears. Static content (no engine work). Keep it skimmable.

---

## 8. Audit UX criteria owned here

From the umbrella spec §5 (audit `docs/audits/2026-06-27-tool-audit.md`):
- **#33 (part):** two identical "Run" buttons → §5; opening a terminal hides the live run → §6; ambiguous icon-only top bar → §4. (The *edge-semantics* part of #33 — report vs handoff, edge ordering — belongs to the **Canvas** sub-project, not this one.)

No other audit items are owned by this cycle.

---

## 9. Out of scope

- **Left rail** (deferred, §3.1).
- **Run experience** internals — narration↔terminal toggle tabs, run-complete success state, run error surfacing (sub-project 2). This cycle only keeps the live run *reachable*; it does not redesign the run view.
- **Canvas** layout/edges, **Settings** grouping, **Context** unification, **Goal textarea** focus-expand / past-prompts picker — their own later cycles.
- Free-floating/draggable-anywhere panels (the umbrella chose preset zones, not free-float).

---

## 10. Testing

Per the project pattern (pure logic TDD'd; CSS/wiring/IA verified by typecheck + build + live render):
- **Unit (TDD):** the panel layout-state logic — size clamping (min/max), collapse toggle, placement swap, and the persistence serialize/restore (pure functions, no DOM), mirroring `toasts.ts`.
- **Unit (TDD) where feasible:** the dock "keep-run-reachable" rule (e.g. a pure helper deciding the active dock id when a terminal opens during an active run).
- **Type/build:** `tsc` + `npm run build` clean. (Note for executors: the full `electron-vite build` takes ~9 min and has dropped subagent connections — run typecheck in-agent and the full build at the controller/integration level.)
- **Live verify:** resize + collapse + swap each zone; reload the project and confirm layout restored; confirm export/import a team does NOT carry layout; top bar grouped with a working Team menu + FAQ modal; only one "Run" (plus "Launch app"); start a run, open an agent terminal, confirm the run stays reachable with its running indicator.

---

## 11. Acceptance criteria

1. Right inspector and bottom dock are each resizable (clamped), collapsible (with a re-open affordance, no content loss), and placement-swappable (inspector L/R, dock bottom/right).
2. Layout persists per project (localStorage by project path), restores on reopen, and does NOT travel with team export/import or appear in `graph.json`. First-open reproduces today's default layout.
3. Top bar is grouped + labeled (no icon-only-mystery), with export/import/sync↑/sync↓ behind a "Team ▾" menu, and a FAQ `?` button left of the wordmark opening the how-to-prompt guide.
4. There is exactly one control labeled "Run" (the team run); the former "Run result" is "Launch app"; the primary Run/Stop is visually distinct from the secondary goal tools.
5. Starting a run then opening an agent terminal never hides the run: the Run tab persists with a live running indicator and stays reachable.
6. `tsc` + build clean; new layout/dock-rule unit tests pass; existing tests still pass; live-verified per §10.
7. No out-of-scope changes (no left rail, no run-view redesign, no canvas/settings/context/goal-textarea work).
