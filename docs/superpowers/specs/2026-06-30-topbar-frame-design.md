# Top Bar / App-Shell Frame — Structure & State

Part of the post-overhaul **visual modernization arc** (see the `ai-manager-visual-pass` memory). This is the explicitly-deferred *other half* of Surface 4 "Welcome & first impression" — the persistent app frame. It reuses the `BrandMark` shipped in that cycle.

## Motivation

The top bar (`App.tsx` `.topbar`, lines ~155–175) is the one surface visible in **every** state of the app, yet it is the weakest-looking one left: a flat, dense row of ~9 controls at equal visual weight, a plain `<span>Orkestr</span>` text brand (not the new `BrandMark`), no grouping, and almost no state reflection (only the Terminal toggle shows `.active`). It reads as an undifferentiated button strip.

## Goals

- Give the bar real **structure**: an identity cluster on the left, hairline-separated action groups on the right. Nothing is hidden — this is a regroup, not a reduction.
- Swap the text brand for **`BrandMark` + wordmark**, closing the first-impression loop.
- Make the bar an **honest map of app state**: every button whose surface is open reflects it (`.active`).
- Add **crisp, uniform feedback** (hover / press / focus) across labeled *and* icon buttons.
- Add exactly **one** earned animation — the Team ▾ dropdown open (origin-aware, restrained).
- **No entrance/decorative motion** on the persistent bar (Emil frequency rule: it's seen constantly → movement would be slop).

Non-goals: hiding controls behind an overflow menu; converting the project name into a switcher (both explicitly rejected in brainstorming — "keep labels / least disruptive"); any behavior/IPC/engine change; light theme.

## Decisions locked in brainstorming

- **Approach = "structured groups, keep labels"** (least disruptive of three options). All labels stay.
- **Project switch = keep the separate labeled `Switch project` button** (not a project-name dropdown). Zero behavior change — the button just moves into the left cluster.
- **Motion is state-first, not movement-first.** Governed by `emil-design-eng`: persistent + high-frequency → crisp feedback and honest state, no entrance animation. Calm-conductor: no springs/bounce.
- Warm-dark tokens only; no emoji-as-UI (icons are lucide, as today).

## Architecture

Purely presentational + trivial state wiring. Three files touched: `App.tsx` (markup), `TeamMenu.tsx` (open-state class + dropdown enter motion), `styles.css` (group/divider/brand styles + dropdown motion). `BrandMark.tsx` is reused unchanged (it already takes a `size` prop). No new module, no store/IPC/engine edits.

### Layout — `src/renderer/App.tsx` (`.topbar` block)

Restructure the flat row into semantic clusters. Left cluster is left-aligned; the existing `.spacer` (flex:1) pushes the right groups to the far edge.

```
┌ topbar ─────────────────────────────────────────────────────────────────────────────────┐
│ [identity cluster]                     <spacer>          [right groups, right-aligned]     │
│ ◇Orkestr │ Project [Switch project]    ·······   AuthPill ┆ Hist Ctx Term ┆ Team▾ Set ? ┆ [+ Add] │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

**Left — identity cluster** (`.topbar-brand` + project):
- `<BrandMark size={20} />` + a `.topbar-wordmark` "Orkestr" (`var(--text-sm)`, weight 600, `var(--text)`). Non-interactive (decorative); `BrandMark` SVG is `aria-hidden`, the wordmark text carries the name. Replaces the current `.brand` span.
- `.topbar-sep` hairline.
- `.project` name (plain text, unchanged) + the `Switch project` button (moved here from the right).

**Right — three hairline-separated groups + primary** (each wrapped in a `.topbar-group`, separated by `.topbar-sep`):
1. **AuthPill** (status; click to re-check) — leads the right side, in its own group.
2. **Workspace / run:** `History` (+ `.resume-badge`), `Context` (+ `.ctx-badge`), `Terminal` (toggle).
3. **Config / help:** `Team ▾` (`TeamMenu`; the conditional `.team-link` linked-team chip stays adjacent to it), `Settings`, then `FAQ` as a trailing icon-only `?` button (moved from its current far-left position).
4. **Primary:** `+ Add agent` (unchanged, still `.btn.primary`), visually distinct at the far right.

`.topbar-sep` = a 1px, ~18px-tall hairline (`background: var(--hairline)`, `aria-hidden`), used both inside the identity cluster and between the right groups. `.topbar-group` = `display:flex; align-items:center; gap` for intra-group spacing; larger gap between groups.

### State reflection — `App.tsx` + `TeamMenu.tsx`

Extend the existing `.btn.active` style (already defined: `border-color: var(--signal); background: var(--surface-hover)`) to reflect open surfaces. All the booleans are already in scope where the buttons render:
- `Settings` button → `active` when `showSettings`.
- `Context` button → `active` when `showContext`.
- `FAQ` button → `active` when `showFaq`.
- `Terminal` button → `active` when `showDock` (already present — keep).
- `Team ▾` trigger (inside `TeamMenu`) → `active` when its internal `open` is true (add `${open ? 'active' : ''}` to the trigger's className).

Pure presentational: `className={\`btn ${flag ? 'active' : ''}\`}`. No new state, no behavior change.

### Feedback states — `styles.css`

Mostly already exist on `.btn` (hover, `:active` `scale(0.97)`, `:focus-visible` ring, `.active`). Work here is ensuring they apply **uniformly** after the regroup, including icon-only buttons (`.faq-btn` and the Terminal/History/Context icons). Gate any hover-scale-type effects behind `@media (hover: hover) and (pointer: fine)` (existing `.btn:hover` is a color/border change, which is fine to keep ungated). `prefers-reduced-motion` already neutralizes `.btn:active` transform.

### The one animation — Team ▾ dropdown — `TeamMenu.tsx` + `styles.css`

Today `.topmenu-list` mounts with `{open && …}` and pops in with zero motion. Add an **origin-aware enter**:
- `transform-origin` set to the trigger edge the menu opens from (top-left if the list is left-aligned under the button; implementer verifies against actual anchor).
- Enter via `@starting-style` (Chromium 136, already used by the Modal primitive): from `opacity: 0; transform: scale(0.97)` → `opacity: 1; transform: none`, `transition: opacity 150ms var(--ease-out), transform 150ms var(--ease-out)`.
- **Enter-only.** Close simply unmounts (instant) — acceptable for a dropdown and consistent with the documented Modal action/dismiss asymmetry. No `data-closing` machinery needed here.
- `@media (prefers-reduced-motion: reduce)`: opacity-only, no scale.

### AuthPill — `styles.css`

Add a subtle `transition` on the pill's color/background so a state flip (checking → ok) crossfades instead of snapping. State changes are rare, so this is a nicety, not a hot path. No TSX change (`AuthPill` already sets `auth-${state}` classes).

## Data flow

None new. The bar renders from existing store/graph state (`graph.project.name`, `graph.linkedTeam`, `resumable`, badge counts) and local App booleans (`showSettings`/`showContext`/`showFaq`/`showDock`). All click handlers are unchanged. `TeamMenu` keeps its self-contained `open` state.

## Error handling / edge cases

- **Long project names:** the `.project` text should `text-overflow: ellipsis` with a `max-width` so a long name can't shove the right groups off-screen (verify current behavior; add clamp if missing).
- **Narrow windows:** the right groups + primary must stay reachable; allow the identity cluster's project name to truncate first. No wrapping (single-row bar).
- **Conditional items:** `.team-link` chip and the `.resume-badge`/`.ctx-badge` only render conditionally — the group layout must look right with and without them (no empty divider artifacts).
- **`@starting-style` unsupported** (non-Chromium, N/A for Electron but for safety): the menu still appears (transition simply no-ops) — no functional regression.

## Testing

This surface has **no pure logic to extract** (static JSX grouping + boolean→className toggles + CSS), and the repo has **no component-test harness** (no testing-library/jsdom; all existing `*.test.ts` are pure-node logic). Consistent with the Modal-primitive and Welcome surfaces in this same arc, there are **no new automated tests**. Verification:
- **Full existing suite stays green** (462 tests) — guards against any accidental import/logic regression from the `App.tsx`/`TeamMenu.tsx` edits.
- **`typecheck` + `build` clean.**
- **On-device eyes-on smoke by the user** (agents can't run the Electron GUI): the visual grouping, `BrandMark` alignment, open-state reflection on each button, the Team ▾ dropdown enter motion, hover/press feedback, long-name truncation, and reduced-motion behavior. This is the real acceptance gate for the visual/motion parts and is required before merge is called "verified."

## File-by-file summary

- `src/renderer/App.tsx` — restructure the `.topbar` JSX into identity cluster + right groups with `.topbar-sep` dividers; replace the `.brand` span with `BrandMark` + `.topbar-wordmark`; move `Switch project` into the left cluster and `FAQ` into the config group; add `active` className to Settings/Context/FAQ buttons.
- `src/renderer/TeamMenu.tsx` — reflect `open` on the trigger button (`.active`); keep the dropdown mounted-on-open so its `@starting-style` enter fires.
- `src/renderer/styles.css` — new `.topbar-brand` / `.topbar-wordmark` / `.topbar-group` / `.topbar-sep` styles; `.topmenu-list` origin-aware enter motion + reduced-motion fallback; project-name truncation clamp; AuthPill color transition. Remove now-dead `.topbar .brand` text styling if fully superseded.
- `src/renderer/BrandMark.tsx` — **no change** (reused via `size` prop).

## Risks / edge cases

- **Reflowing `.topbar` markup** is the main risk. Mitigation: run the full suite + typecheck + build; the wordmark still renders the text "Orkestr" so any test asserting brand text still passes; AuthPill/badges keyed by class not position.
- **Divider/group emptiness** with conditional items — verify layout with linked team absent/present and with zero resumable runs.
- **Dropdown origin** — must match the menu's actual anchor or the scale will feel off; verify in the on-device smoke.
- Scope creep toward hiding controls or a project switcher — **explicitly out of scope** per the locked decisions.
