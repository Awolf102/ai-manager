# Welcome & First Impression — Front-Door Craft

**Date:** 2026-06-30
**Status:** Approved design, ready for implementation planning
**Roadmap:** Fourth surface of the post-overhaul **visual modernization arc** ([[ai-manager-visual-pass]]), via the `emil-design-eng` craft skill. The user picked "app shell / first impression," then chose the **Front door, deep** scope — the welcome moment — over the top-bar/frame (that becomes its own next cycle). Builds on the arc's motion tokens, `Switch`/`Modal` primitives, and `.btn:active`.

## Motivation

The app's *first impression* is its most generic screen. When no project is open, `ProjectPicker` shows a plain 460px card: a 20px `<h1>Orkestr</h1>`, a one-line subtitle, an "Open project folder…" button, and bare recent-project rows — no identity, no depth, no motion. And a **fresh project opens with `nodes: []`** (verified in `project-store.ts`), so a new user lands on an empty dotted canvas with **no onboarding**. Meanwhile there's no logo/mark anywhere — the wordmark is plain text.

This cycle crafts the two "what greets you" moments — the startup welcome and the empty-canvas onboarding — plus the inspector's empty hint, giving the app a real front door.

## Goals

- A distinctive, warm **startup welcome** (ProjectPicker): a conductor-arc brand mark + set wordmark, a layered card, recent projects as hover cards, a tasteful entrance.
- A **fresh-project canvas onboarding** state that guides the first step (build a team) instead of a dead void.
- A reusable **`BrandMark`** (arc mark) for the picker now and the top bar later.
- Consistent, calm-voice **empty states** (inspector hint polished too).
- **Minimal behavior add:** only the empty-canvas primary CTA does anything new (seed an Orchestrator + focus the goal bar). Everything else is presentational; no engine/IPC change.

## Decisions locked in brainstorming

- **Scope:** Front door, deep — ProjectPicker + canvas empty state + inspector empty hint. NOT the top bar (next cycle).
- **Identity:** a **simple conductor-arc SVG mark** (single confident arc/baton-upbeat stroke in the rose accent), reusable, above the wordmark — not text-only. Trivially swappable to text if it doesn't land in the smoke.
- **Empty-canvas primary CTA:** **"Build a team from a goal"**, which — because `Build team` needs an Orchestrator + a goal — **auto-seeds a default Orchestrator** (one `createAgent`) and **focuses the goal bar**. Secondary: **"Add a single agent"** (existing Add-agent modal).
- **Motion:** quick tasteful entrance (seen every launch — must not feel slow on repeat); reduced-motion aware.

## Architecture

### `src/renderer/BrandMark.tsx` (NEW, reusable)

```tsx
export function BrandMark({ size = 40 }: { size?: number }): JSX.Element
```
A single inline `<svg>` drawing one confident arc / baton-upbeat stroke: a stroked path (rounded line-caps) in `var(--accent)` (rose), optionally a small accent dot at the baton tip. No fill, no gradient (brand rule). `size` sets width/height; `aria-hidden` (decorative — the wordmark carries the name). The exact path is finalized in the plan; it must read as a calm upward gesture, not busy.

### ProjectPicker redesign — `src/renderer/App.tsx` (`ProjectPicker`) + `styles.css`

Structure (replacing the current card body):
- **Identity block:** `<BrandMark size={48} />` above the **Orkestr** wordmark (Inter, increased size/weight, letter-spacing) + a calm tagline (e.g. "Conduct a team of agents.").
- **Layered card:** `.picker-card` gains real depth (elevation `--elev-2`, hairline, larger padding, ~440–480px). It floats on a `.picker` background that carries the **warm dot-grid** (`--canvas-dot`, the same as the canvas) instead of flat `--bg` — tying the welcome to the app.
- **Primary action:** "Open project folder…" (`btn primary`).
- **Recent projects as cards:** each `.recent-item` becomes a hover-able card — a folder icon + bold name + muted, truncated path — with a hover lift/tint and `:active` press (motion tokens). Click opens the project (unchanged handler).
- **Entrance motion:** a staggered rise+fade of the identity block → primary button → recent list (~40ms stagger, `--ease-out`, total < ~300ms), via CSS `animation` with per-child `animation-delay`. Reduced-motion → opacity only, no translate.

### Canvas empty state — `src/renderer/CanvasEmptyState.tsx` (NEW) + wired in `App.tsx`

Rendered in `canvas-wrap` when the project has no agents:
```tsx
{graph.nodes.length === 0 && <CanvasEmptyState onBuild={handleBuild} onAdd={() => setShowAdd(true)} />}
```
A centered panel over the empty canvas (absolutely positioned, pointer-events on the panel only so the canvas stays pannable around it):
- A friendly heading + one line on the model: "Your team is led by an **Orchestrator** who delegates to specialists."
- **Primary "Build a team from a goal"** → `onBuild`: in `App`, `await window.api.createAgent({ name: 'Orchestrator', kind: 'orchestrator' })` → `setGraph` → `focusGoal()` (store signal). The empty state then disappears (nodes.length → 1) and the focused goal bar invites the goal; the user types it and clicks *Build team* (now enabled).
- **Secondary "Add a single agent"** → `onAdd` (opens the existing Add-agent modal).
- Gentle entrance (fade/scale-in), reduced-motion aware.

### Goal-bar focus signal — `src/renderer/store.ts` + `GoalBar.tsx`

A tiny store slice: `goalFocusTick: number` + `focusGoal()` (increments it). `GoalBar` holds a ref to its `<textarea>` and `useEffect(() => { if (goalFocusTick) ref.current?.focus() }, [goalFocusTick])`. This lets the empty-state CTA (in App) focus the goal bar across components without prop-drilling.

### Inspector empty state — `App.tsx` (`.empty-hint`) + `styles.css`

Replace the run-on text hint with a cleaner block: a small muted lucide icon (e.g. `MousePointerClick` / `PanelRight`) + concise calm-voice copy ("Select an agent to edit its role, memory, and skills." and the delegate tip on its own muted line), better spacing. Presentational only.

## Data flow

Open app, no project → `ProjectPicker` (crafted welcome, entrance plays) → open/recent → `onOpen(graph)`. If the opened project has 0 agents → `CanvasEmptyState` overlays the canvas → "Build a team" seeds an Orchestrator (`createAgent`) + `focusGoal()` → empty state unmounts, goal bar focused → user types goal → existing `Build team` flow. "Add a single agent" → existing Add-agent modal. All existing handlers (pickProjectFolder, openProject, createAgent, spawnTeam) are unchanged.

## Error handling / edge cases

- **Seed-orchestrator failure** (`createAgent` rejects): surface a toast (existing `notify`); the empty state stays. (Unlikely; createAgent is a local fs op.)
- **Project opens with agents already** (existing project): `graph.nodes.length > 0` → no empty state; unchanged behavior.
- **Reduced motion:** all entrances drop to opacity-only (no translate/scale).
- **Recent projects empty:** the recent-cards block is omitted (as today), the welcome still reads complete with the identity block + primary button.
- **Canvas pannability:** the empty-state panel captures pointer events only on itself, so the surrounding canvas can still pan/zoom; the panel disappears the moment an agent exists.

## Testing

- Renderer/CSS + a tiny store slice → `npm run typecheck` + `npm run build` + the full Vitest suite staying green (house precedent; the goal-focus slice is trivial state). If the store has existing slice tests, add a minimal `focusGoal` increments-tick assertion; otherwise typecheck/build carry it.
- **Visual smoke (user):** launch with no project → the crafted welcome (arc mark, wordmark, entrance, recent cards hover/press); open a fresh project → the canvas onboarding; "Build a team" seeds an Orchestrator and focuses the goal bar; "Add a single agent" opens the modal; the inspector hint reads clean; toggle OS reduced-motion → entrances fade without moving. Per Emil, re-check the entrance timing the next day / in slow-mo.

## File-by-file summary

| File | Change |
|------|--------|
| `src/renderer/BrandMark.tsx` | NEW reusable conductor-arc SVG mark |
| `src/renderer/CanvasEmptyState.tsx` | NEW fresh-project onboarding panel (Build a team / Add an agent) |
| `src/renderer/App.tsx` | ProjectPicker redesign (identity block, recent cards); render `CanvasEmptyState` when `nodes.length === 0` + `handleBuild` (seed Orchestrator + focusGoal); inspector empty-hint polish |
| `src/renderer/store.ts` | `goalFocusTick` + `focusGoal()` slice |
| `src/renderer/run/GoalBar.tsx` | textarea ref + focus on `goalFocusTick` |
| `src/renderer/styles.css` | picker/identity/mark, recent cards, canvas-empty panel, entrance keyframes + stagger, inspector hint, reduced-motion |

**No changes** to any engine/IPC/main file. The only new behavior is the empty-state CTA seeding an Orchestrator + focusing the goal bar.

## Risks / edge cases

- **Hand-coded arc mark quality.** A blind-designed SVG could read amateur; mitigated by keeping it a single clean stroke, and it's trivially swappable to a text-only wordmark if the smoke rejects it.
- **Entrance-on-every-launch fatigue.** The welcome animates on each app open; kept short (<300ms) and gentle so it doesn't grate; reduced-motion removes it.
- **Empty-state pointer capture.** Must not block canvas panning around the panel (pointer-events scoped to the panel), and must vanish immediately once an agent exists.
- **Cross-component focus.** The goal-focus store signal is the clean seam (no prop-drilling / no direct DOM reach from App into GoalBar).
- **Scope creep.** The top bar is explicitly deferred; this cycle touches only the welcome/empty surfaces + the shared `BrandMark` (which the top-bar cycle will reuse).
