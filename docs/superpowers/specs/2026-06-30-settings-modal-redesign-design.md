# Settings Modal Redesign — Two-Pane "Notion-airy" Layout

**Date:** 2026-06-30
**Status:** Approved design, ready for implementation planning
**Roadmap:** First surface of a **post-overhaul visual pass** — the user's note that the Orkestr Phase-2 overhaul ([[ai-manager-overhaul-plan]]) was largely structure/cleanup rather than a change in *how things look*. This cycle restyles the Settings modal to a modern two-pane layout; more surfaces may follow as their own cycles. Self-contained renderer change.

## Motivation

The Settings modal today is **five sections stacked in one vertical scroll** (Safety / Cost / Review & repair / Run behavior / Team) inside a single small centered box — the structure sub-project 5 produced when it regrouped *what's where*. It reads as a form, not a designed settings surface. The user wants the **Cursor/Notion settings pattern**: a left rail of categories + a right content pane showing one category at a time, with clean rows (label + description left, control right) and toggle switches. This is the first deliberately *visual* (not cleanup) change and a template for making the app feel different.

The user supplied Notion and Cursor reference screenshots and chose the **Notion-airy** row treatment (section headers underlined by full-width hairlines, open rows with breathing room — no card borders).

## Goals

- Replace the single-scroll modal with a **two-pane** layout: fixed left rail (categories) + scrolling right content pane (the selected category).
- Each setting becomes a **row**: label + description on the left, control right-aligned.
- **Toggle switches** replace boolean checkboxes (a reusable `Switch` primitive).
- **Notion-airy** grouping: per-pane section headers with full-width hairline dividers; no card borders.
- Remove the leftover **emoji-as-UI** (💸 cost hints, ⚠ Full-auto warning) per the warm-dark/calm-conductor brand; the Full-auto warning becomes a real inline danger callout.
- **Zero behavior change:** every setting persists exactly as today (auto-save on change via `updateSettings`); no changes to `ProjectSettings`, the store, or IPC.

## Decisions locked in brainstorming

- **Row treatment:** Notion-airy (section header + full-width hairline + open rows). NOT Cursor bordered cards.
- **Two-pane modal**, ~880px × `min(660px, 86vh)`; only the content pane scrolls; rail fixed.
- **No "Done" button** — settings auto-save; an **X (top-right)** + backdrop click close it (matches both references).
- **Left rail top** shows a "Settings" eyebrow + the **project name** (`graph.project.name`) — our honest version of the references' account row (settings are per-project).
- **Booleans → `Switch`** (new reusable `src/renderer/Switch.tsx`, `role="switch"`).
- **Review & repair mode → a dropdown** (3 modes as `<option>`s; the chosen mode's sentence becomes the row description). Max repair attempts appears as a follow-up row only when mode = "repair loop".
- **Emoji removed:** 💸 → plain muted text; ⚠ Full-auto → inline danger callout (danger-tinted left border + lucide `AlertTriangle`, shown only when Autonomy = Full).
- **Scope:** Settings modal only this cycle. `Switch` is built reusable, but other modals are NOT migrated now.

## Architecture

### Component structure — `src/renderer/SettingsModal.tsx` (rewritten)

```
SettingsModal
├─ modal-backdrop (click → onClose)
└─ .settings-modal (two-pane; stopPropagation)
   ├─ .settings-rail
   │   ├─ rail header: "Settings" eyebrow + project.name (muted)
   │   └─ nav: 5 SettingsNavItem (icon + label; active = filled bg)
   ├─ button.settings-close (X, top-right)  // lucide X
   └─ .settings-pane (scrolls)
       ├─ pane header: <h2> category title + muted subtitle
       └─ one or more SettingSection (header + hairline) of SettingRow
```

- **`activeCategory` state** (`useState<CategoryId>('safety')`) selects which pane renders.
- **`CategoryId`** = `'safety' | 'cost' | 'review' | 'run' | 'team'`. A small static array `CATEGORIES: { id, label, icon, subtitle }[]` drives the rail; the pane body is rendered by a `switch (activeCategory)` (the controls are heterogeneous, so panes are explicit JSX, not data-driven).
- **`SettingRow`** helper (co-located): props `{ label, desc?, control, danger? }` → renders the label/description-left, `control`-right row. Keeps rows DRY without over-abstracting heterogeneous controls.
- **`SettingSection`** helper (co-located): props `{ title?, children }` → optional section header + full-width hairline + the rows.
- Preserves the existing `update(patch)` (auto-save) and `onAutonomyChange` (Full-auto `requestConfirm` gate) logic verbatim; only the presentation changes.

### `Switch` primitive — `src/renderer/Switch.tsx` (NEW, reusable)

```tsx
export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string            // accessible name (aria-label)
  disabled?: boolean
}): JSX.Element
```

A styled `<button role="switch" aria-checked={checked} aria-label={label}>` with a sliding knob: rose accent track when on, muted track off, short eased transition (~120ms). Keyboard/Space-Enter toggles (native button). Reusable beyond Settings (later modals can adopt it).

### Controls per row

| Setting | Control |
|---|---|
| Autonomy | styled `<select>` (auto / full / cautious) + Full-auto danger callout when `full` |
| Never bypass permissions | `Switch` |
| Auto-trust Anthropic-only | `Switch` |
| Block plugin-hook skills | `Switch` |
| Auto-assign worker models | `Switch` |
| Adaptive effort | `Switch` |
| Review & repair mode | styled `<select>` (none / once / loop); chosen mode's sentence = row description |
| Max repair attempts | number stepper (1–6), row shown only when mode = loop |
| Update agent memory | `Switch` |
| Mid-run re-plans / Peer handoffs / User questions | `Switch` + inline "up to N" stepper when on (the gated-toggle pattern) |
| Auto-sync team brain | `Switch` |
| Trusted-skill install threshold | number input (step 1000) |
| Skills pack | `Switch` |
| Skills-pack folder | text input (full-width within its row, placeholder `~/.ai-manager/skills-pack`) |

### Category → panes

- **Safety** (subtitle: "Autonomy, permissions, and which skills agents may load")
  - *Permissions* — Autonomy (+ Full-auto callout), Never bypass permissions
  - *Skills trust* — Auto-trust Anthropic-only, Block plugin-hook skills
- **Cost** (subtitle: "Where the team is allowed to spend more for better results")
  - Auto-assign worker models, Adaptive effort (cost note as plain muted text, no 💸)
- **Review & repair** (subtitle: "What happens after work is produced")
  - *Review mode* — Review & repair (dropdown), Max repair attempts (conditional)
  - *Memory* — Update agent memory after runs
- **Run behavior** (subtitle: "Optional mid-run behaviors, off by default")
  - Mid-run re-plans, Peer handoffs, User questions (gated toggles)
- **Team** (subtitle: "Shared team knowledge and the skills available to agents")
  - *Sync* — Auto-sync team brain
  - *Skills* — Trusted-skill install threshold, Skills pack, Skills-pack folder

### Styling — `src/renderer/styles.css` (warm-dark tokens only)

New Settings-scoped classes (no raw hex; tokens `--bg`/`--panel`/`--panel-2`/`--border`/`--accent`/`--text`/`--muted`/`--radius`, plus the danger semantic token for the callout):
`.settings-modal` (two-pane grid, sized), `.settings-rail` + `.settings-rail-head` + `.settings-nav` + `.settings-nav-item` (+ `.active`), `.settings-close`, `.settings-pane` (scroll) + `.settings-pane-title` + `.settings-pane-subtitle`, `.setting-section` + `.setting-section-title`, `.setting-row` + `.setting-row-main` + `.setting-row-control`, `.setting-danger-callout`, and `.switch` + `.switch-knob` (+ checked/disabled states). The rail sits on a slightly deeper surface than the pane, divided by a hairline border (warm-dark layering).

## Data flow

Unchanged from today: each control's `onChange` calls `update(patch)` → `window.api.updateSettings(patch)` → store `setGraph`. The only new client state is `activeCategory` (pure UI, not persisted). The Full-auto path still routes through `onAutonomyChange` → `requestConfirm` before `update({ autonomy: 'full' })`.

## Error handling

- No new IO. Settings persistence error handling is unchanged (the store/IPC own it).
- The Full-auto confirmation gate is preserved exactly (cancel → no change).
- Conditional rows (max repair attempts; gated counts) render off the current settings value, identical logic to today.

## Testing

- Renderer-only, no logic change → verified by `npm run typecheck` + `npm run build`, with the existing Vitest suite staying green (house precedent: the renderer is not unit-tested; settings persistence logic is untouched).
- `Switch` is a pure presentational component (props in, callback out) — covered by typecheck/build.
- Final eyes-on **visual smoke is the user's** (agents can't run the Electron GUI): confirm the two-pane layout, switches, the dropdowns, and the Full-auto callout render correctly and every setting still saves.

## File-by-file summary

| File | Change |
|------|--------|
| `src/renderer/Switch.tsx` | NEW reusable toggle-switch primitive (`role="switch"`) |
| `src/renderer/SettingsModal.tsx` | Rewritten: rail + `activeCategory` + per-category panes + `SettingRow`/`SettingSection` helpers; booleans → `Switch`; review-mode → dropdown; Full-auto → danger callout; emoji removed; "Done" → X. Preserves `update`/`onAutonomyChange` logic |
| `src/renderer/styles.css` | NEW Settings two-pane + section/row + Switch + danger-callout classes (tokens only); the old single-column settings rules can be removed if unused elsewhere |

**No changes** to `src/shared/types.ts` (`ProjectSettings`), `project-store.ts`, `ipc.ts`, `preload`, or any engine file. Other modals are untouched.

## Risks / edge cases

- **Shared CSS classes:** the current modal reuses generic `.field`/`.check`/`.radio-*` classes also used by other modals (e.g. AgentConfigPanel). The redesign introduces **Settings-scoped** classes and stops using the generic ones inside Settings, so other modals are unaffected; do not delete a generic class still referenced elsewhere (grep before removing).
- **Modal height on small windows:** the content pane scrolls within the capped modal height; the rail stays fixed. Verify on a short window.
- **Switch accessibility:** `role="switch"` + `aria-checked` + an `aria-label` (the setting name) so the control is announced; native `<button>` gives keyboard support for free.
- **Review-mode dropdown vs the old radio cards:** the three descriptions previously shown as a radio list now surface as the row's dynamic description (the selected mode's sentence). No information is lost; the other two descriptions are visible on selection. Acceptable per the brainstorm.
- **No behavior drift:** because `ProjectSettings`, IPC, and the store are untouched and every control keeps calling `update(patch)`, a project's settings round-trip is byte-for-byte identical to today.
