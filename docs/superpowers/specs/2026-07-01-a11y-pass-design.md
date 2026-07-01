# Accessibility Pass — Interactive Controls (Full APG)

Closes the accessibility debt deferred across the whole Orkestr overhaul + visual arc (see the `ai-manager-visual-pass` and `ai-manager-overhaul-plan` memories). Brings the app's custom interactive controls up to the **ARIA Authoring Practices Guide (APG)** patterns: keyboard-operable and screen-reader-correct.

## Motivation

Several custom controls are inaccessible today:
- **Run-view tabs** (`.run-tab`) are plain `<button>`s with no tab semantics; **dock tabs** (`.term-tab`) are `<div onClick>` — not keyboard-focusable or operable at all.
- **`PanelDivider`** has `role="separator"` only — no orientation, label, value, or keyboard resize (mouse-only).
- **Menus** (`TeamMenu`, `RecentPrompts`) have no `aria-haspopup`/`aria-expanded`, no menu roles, no keyboard model.
- The Add-agent **role picker** (`.seg`) is a segmented single-select with no radiogroup semantics.
- **Icon-only buttons** (zone `⇄`/`×`, FAQ `?`, dock reopen/close) rely on `title` with no `aria-label`.
- The **canvas** region and its nodes have no accessible names.

The existing baseline is good where it exists (`Modal` dialog, `Switch`, Toast `alert/status`, CoachMarks, `aria-hidden` on decorative marks) — this pass extends that rigor to the interactive controls.

## Goals

Full APG conformance for: **Tabs** (2 tablists), **Window Splitter** (dividers), **Menu Button** (2 menus), **Radio Group** (role picker), plus accessible names on all icon-only buttons and the canvas. Keyboard operation everywhere a mouse works today, and correct roles/states/properties for screen readers.

Non-goals: reimplementing React Flow's built-in graph keyboard navigation (we enable + label it instead); a visual redesign of any control (this is semantics + keyboard, not look); a new component-test harness; light theme.

## Decisions locked in brainstorming

- **Depth = full APG** (over pragmatic / semantics-only).
- **Tabs use automatic activation** (selection follows arrow focus) — switches are cheap.
- **Two pure keyboard-logic modules are extracted and TDD'd** in the existing vitest (node) harness; ARIA attributes themselves are declarative, verified by the whole-branch review + the user's on-device screen-reader/keyboard smoke. **No new component-test harness.**
- **Canvas relies on React Flow's built-in keyboard node navigation** + accessible labels, not a reimplemented graph model.

## Architecture

Two new pure modules (co-located tests, mirroring `layout.ts`/`dock.ts`) plus ARIA/keyboard wiring in the affected components. No engine/IPC/store/`shared` change.

### `src/renderer/roving.ts` (NEW, pure, TDD) — shared arrow-key index math

```ts
export type Orientation = 'horizontal' | 'vertical'
// Returns the next index for a roving-focus widget, or null for a non-navigation key.
// horizontal: ArrowRight→next, ArrowLeft→prev.  vertical: ArrowDown→next, ArrowUp→prev.
// Home→0, End→count-1.  loop wraps at the ends (default true).  count<=0 → null.
export function rovingIndex(
  key: string, index: number, count: number, orientation: Orientation, loop?: boolean
): number | null
```
Consumed by the tabs, the radiogroup, and the menus.

### `src/renderer/splitter-keys.ts` (NEW, pure, TDD) — divider keyboard resize

```ts
export interface SplitterOpts {
  axis: 'x' | 'y'        // 'x' = vertical separator (resizes width), 'y' = horizontal (resizes height)
  invert: boolean        // panel grows opposite the increase direction (mirrors the drag invert)
  size: number           // current size px
  min: number
  max: number
  step?: number          // arrow-key increment (default 16)
  pageStep?: number      // Page-key increment (default 64)
}
// Returns the new clamped size px, or null for a non-resize key.
// decrease-direction keys (dir -1): ArrowLeft (axis x), ArrowUp (axis y), PageUp (both)
// increase-direction keys (dir +1): ArrowRight (axis x), ArrowDown (axis y), PageDown (both)
//   screenDelta = dir * (arrow ? step : pageStep);  sizeDelta = screenDelta * (invert ? -1 : 1)
//   newSize = clamp(size + sizeDelta, min, max)
// Home → min, End → max (absolute, ignore invert).  Wrong-axis arrows → null.
export function splitterResize(key: string, opts: SplitterOpts): number | null
```
`step`/`pageStep` default to 16/64. Home returns `min`, End returns `max`.

### 1. Tabs — APG Tabs pattern

Applies to **two** tablists: RunView's Narration/Terminal/Result (`RunView.tsx`) and the dock's Run/History/agent-terminal tabs (`App.tsx`).

- Container: `role="tablist"` + `aria-label` ("Run view" / "Terminal dock").
- Each tab: `role="tab"`, `aria-selected`, `id`, `aria-controls={panelId}`, **roving tabindex** (`0` when selected, else `-1`).
- Each panel: `role="tabpanel"`, `id`, `aria-labelledby={tabId}`, `tabindex={0}` (keyboard users can focus/scroll panel content).
- Keyboard on the tablist (`onKeyDown`): `rovingIndex(key, i, n, 'horizontal')` → **automatic activation** (select + focus the new tab). Home/End included. Focus the newly-selected tab via a refs array.
- **Dock tabs** convert from `<div onClick>` to a `<button role="tab">` for the label, with the close `×` as a **sibling** `<button aria-label="Close terminal">` inside a `role="presentation"` wrapper (buttons can't nest). `Delete`/`Backspace` on a focused dock tab closes it (APG closable-tabs). Arrow nav skips the close buttons (operates over the tab buttons only).

### 2. Window Splitter — APG pattern (`PanelDivider.tsx`)

- Element keeps `role="separator"`; add `aria-orientation` (`axis==='x'`→`'vertical'`, `axis==='y'`→`'horizontal'`), `aria-label` (from a new `label` prop, e.g. "Resize inspector panel"), `tabindex={0}`, `aria-valuenow={size}`, `aria-valuemin={min}`, `aria-valuemax={max}`.
- `onKeyDown`: `splitterResize(key, {axis, invert, size, min, max})` → if non-null, `onResize(newSize)` + `preventDefault`.
- New props threaded from `App.tsx`: `label`, `min`, `max`, and current `size` (callers already pass `getStart`/`onResize`; add `size`/`min`/`max`/`label`). Bounds come from `clampInspector` (280–560) and `clampDock*` — expose the numeric bounds (extract the constants in `layout.ts` as named exports so both the clamp and the splitter share them; no behavior change).

### 3. Menu Button — APG pattern (`TeamMenu.tsx`, `RecentPrompts.tsx`)

- Trigger `<button>`: `aria-haspopup="menu"`, `aria-expanded={open}`, `id`.
- List: `role="menu"`, `aria-label`, `aria-labelledby={triggerId}`. Items: `role="menuitem"` (already `<button>`s).
- Behavior: opening (click or `ArrowDown`/`Enter`/`Space` on trigger) moves focus to the first item; `rovingIndex(key, i, n, 'vertical')` for Up/Down/Home/End over item refs; `Escape` closes and returns focus to the trigger; `Enter`/`Space`/click activates the item; `Tab` or outside-click closes. Keep the existing outside-click handler.

### 4. Radio Group — APG pattern (the `.seg` role picker in the Add-agent modal, `App.tsx`)

- Container: `role="radiogroup"`, `aria-label="Role in the chain"`.
- Each option `<button>`: `role="radio"`, `aria-checked={kind === k}`, roving tabindex (checked `0`, else `-1`).
- `onKeyDown`: `rovingIndex(key, i, n, 'horizontal')` → move focus **and** select (`setKind`).

### 5. Accessible names & toggle state

- `aria-label` on every icon-only button: zone-head `⇄` ("Move panel left"/"right" per current placement) and `×` ("Collapse panel"); FAQ `?` ("How to prompt"); dock reopen `▴` ("Show dock"); dock-tab close `×` (covered in §1). Keep existing `title` (mouse tooltip).
- Toggle buttons expose state: the Terminal top-bar button gets `aria-expanded={showDock}` (it shows/hides the dock); the zone collapse/reopen pair reflects state through the button that is present.

### 6. Canvas (`canvas/OrgChart.tsx`, `canvas/AgentNode.tsx`)

- The React Flow region/wrapper gets `aria-label="Agent org chart"` (via the container or React Flow's `aria-label`).
- Each node gets an accessible name via React Flow's node `ariaLabel` (set on the node objects): `"{name}, {kind}{, status}"`.
- Keep React Flow's default keyboard node navigation (focusable nodes, arrow-move, Tab between nodes) — it satisfies the graph-nav expectation; we do not reimplement it. Legend/coach-marks already have `role="dialog"`/labels.

## Data flow

No new app data. `PanelDivider` gains value props (`size`/`min`/`max`/`label`) passed from the existing layout store state. Tabs/menus/radiogroup read the same selection state they already use (`rightTab`, `activeDockId`, `open`, `kind`). Canvas node `ariaLabel` derives from existing node `name`/`kind` + run status.

## Error handling / edge cases

- **Empty tablist / single tab:** `rovingIndex` returns the same or wrapped index; a 1-tab list is a no-op on arrows (guard `count<=1`).
- **Dock tab close vs. arrow nav:** after closing the focused tab, focus moves to the adjacent tab (or the tablist) — component handles post-close focus; arrow nav never lands on a close button.
- **Splitter at a clamp bound:** `splitterResize` clamps; `aria-valuenow` stays within min/max; pressing further in that direction is a no-op (returns the clamped value = current, harmless `onResize`).
- **Menu open focus race:** focus the first item after the list mounts (same tick as `setOpen(true)` + a ref callback or effect); Escape always returns focus to the trigger even if no item was focused.
- **Reduced motion / existing motion:** unaffected — this pass adds no motion.
- **`nodrag` / React Flow:** node `ariaLabel` + region label must not interfere with React Flow drag/pan (labels are inert).

## Testing

Two pure modules are **TDD'd** in the existing vitest (node) harness — the first genuinely testable logic in this arc:
- `src/renderer/roving.test.ts` — horizontal/vertical arrows, Home/End, wrap vs. clamp at ends, non-nav keys → null, `count<=0`/`count===1` guards.
- `src/renderer/splitter-keys.test.ts` — each direction per axis, `invert` mirroring, Home/End → min/max, Page steps, clamp at bounds, wrong-axis arrows → null, non-resize keys → null.

The ARIA attributes and focus behavior are **not** unit-testable without a component harness (none exists; not added here). They are verified by:
- **Full existing suite green** + the two new modules' tests + `typecheck` + `build`.
- **On-device screen-reader + keyboard smoke by the user** (agents can't run the Electron GUI): Tab through the app reaching every control; arrow-navigate each tablist/menu/radiogroup; keyboard-resize the dividers; VoiceOver announces correct roles/states/names; Escape/focus-return in menus; Delete closes a dock tab.

## File-by-file summary

- `src/renderer/roving.ts` + `roving.test.ts` — NEW pure module (shared arrow-key index math).
- `src/renderer/splitter-keys.ts` + `splitter-keys.test.ts` — NEW pure module (divider keyboard resize).
- `src/renderer/layout.ts` — export the inspector/dock clamp bounds as named constants (no behavior change) for the splitter's `aria-valuemin/max`.
- `src/renderer/PanelDivider.tsx` — separator ARIA + value props + keyboard resize.
- `src/renderer/run/RunView.tsx` — tablist/tab/tabpanel ARIA + roving + arrow nav for the run tabs.
- `src/renderer/App.tsx` — dock tablist (div→button + close sibling + Delete-to-close), the `.seg` radiogroup, `PanelDivider` value props, icon-button `aria-label`s, Terminal `aria-expanded`.
- `src/renderer/TeamMenu.tsx`, `src/renderer/run/RecentPrompts.tsx` — menu-button ARIA + keyboard model.
- `src/renderer/canvas/OrgChart.tsx`, `canvas/AgentNode.tsx` — region label + node `ariaLabel`.

## Risks / edge cases

- **Dock tab restructure** (div→button + sibling close) is the highest-touch change; CSS for `.term-tab`/`.close` must be adjusted so layout is unchanged. Regression-guard with the full suite + on-device look check.
- **Nested-button trap:** the close button MUST be a sibling of the tab button, never nested inside it.
- **Two tablists share the pattern** but have separate state — keep their refs/handlers independent; don't share a single roving index.
- **Menu focus management** is the subtlest behavioral piece — verify Escape-returns-to-trigger and open-focuses-first-item on device.
- **React Flow version a11y:** confirm the installed `@xyflow/react` exposes node `ariaLabel` (it does in v12); if a prop name differs, adapt in the OrgChart task.
- Scope creep into a visual redesign of these controls — explicitly out of scope.
