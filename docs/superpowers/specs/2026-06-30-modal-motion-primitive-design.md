# Shared Modal Primitive — Motion + Consistency

**Date:** 2026-06-30
**Status:** Approved design, ready for implementation planning
**Roadmap:** Third surface of the post-overhaul **visual modernization arc** ([[ai-manager-visual-pass]]), via the `emil-design-eng` craft skill. The user picked "Modal consistency + motion," then chose the **shared Modal motion primitive** scope (not enter-only CSS, not the full per-modal re-treat). Builds on the canvas pass's motion tokens + `.btn:active` seed.

## Motivation

After Settings and the canvas were crafted, the ~9 remaining modals look dated by contrast and — more glaringly — **every modal pops in and out instantly** (the shared `.modal`/`.modal-backdrop` CSS has zero transition). By Emil's principle, elements appearing/disappearing without transition feel broken once the rest of the app moves. Worse, each modal hand-rolls the same `<div className="modal-backdrop" onClick={onClose}><div className="modal" onClick={stopPropagation}>…</div></div>` shell, duplicating backdrop + click-outside logic ~9 times, with no Escape-to-close, no focus management, and inconsistent close affordances.

This cycle introduces one reusable `<Modal>` primitive that owns the backdrop, click-outside, Escape, focus, ARIA, and a tasteful **symmetric enter/exit animation**, and migrates every modal onto it — fixing the cohesion gap and the "pops in" gap in one DRY move, the way the `Switch` primitive did for toggles.

## Goals

- A single `<Modal>` component (+ `useModalClose` hook) that all modals use; one place for backdrop/click-outside/Escape/focus/ARIA/motion.
- **Enter + exit motion:** backdrop fade, panel scale-in-from-`0.96` (centered origin) on open; a snappier reverse on close. Calm-conductor crisp; full `prefers-reduced-motion`.
- **Consistency:** uniform Escape-to-close, focus-on-open + restore-on-close, and a light restyle of the few raw checkboxes.
- **No functional change** beyond a ~150ms animated-close delay and the added Escape/focus. No engine/store/IPC edits; no modal's internal content/layout is redesigned (that was the deferred "full pass").

## Decisions locked in brainstorming

- **Scope:** the shared Modal motion primitive + migrate all modals + restyle the few raw checkboxes. Deeper per-modal content re-layouts are a later cycle.
- **Enter via `@starting-style`** (Electron 42 / Chromium 136 supports it) — zero JS for enter. **Exit via a wrapper-managed `[data-closing]`** state + delayed `onClose` (conditional-render modals unmount instantly otherwise).
- **`.modal-panel` carries motion; `.modal` keeps box styling** — decoupled so custom-sized modals (`.settings-modal`, `.ctx-modal`) animate without box conflicts.
- **`useModalClose()` context** threads the animated close to any close button inside a modal.
- **Uniform Escape-to-close + focus-on-open/restore** (approved as a cohesion win; no modal opts out unless found necessary). Light focus management — focus-on-open + restore, NOT a full focus-trap (YAGNI).
- Multi-select checkboxes stay checkboxes (not Switches); just a cleaner shared style.

## Architecture

### The primitive — `src/renderer/Modal.tsx` (NEW)

```tsx
export function useModalClose(): () => void  // animated close from anywhere inside a <Modal>

export function Modal({
  onClose,        // parent's real unmount (called AFTER the exit animation)
  className,      // extra class on the panel (e.g. 'ctx-modal', 'settings-modal')
  unstyled,       // when true, omit the default '.modal' box class (panel supplies its own)
  labelledBy,     // id of the modal's heading, for aria-labelledby
  children
}: {
  onClose: () => void
  className?: string
  unstyled?: boolean
  labelledBy?: string
  children: ReactNode
}): JSX.Element
```

Responsibilities:
- Renders `<div className="modal-backdrop" data-closing? onClick={requestClose} onKeyDown={Escape→requestClose}>` wrapping `<div className="modal-panel [modal] [className]" role="dialog" aria-modal="true" aria-labelledby={labelledBy} data-closing? onClick={stopPropagation} tabIndex={-1} ref>`.
- **Close lifecycle:** `requestClose()` → `setClosing(true)` (drives `[data-closing]` exit animation) → after the exit duration (a `setTimeout`, cleared on unmount), call `props.onClose()`. Backdrop click, Escape, and `useModalClose()` all route through `requestClose`. Idempotent (ignore repeat calls while closing).
- **Focus:** on mount, store `document.activeElement`, then focus the panel; on unmount, restore focus to the stored element. Escape is caught via `onKeyDown` on the backdrop (bubbles from any focused child), which scopes it to the topmost focused modal naturally (handles a ConfirmDialog stacked over another modal without a document-level listener).
- Provides `requestClose` to descendants via `ModalContext`; `useModalClose()` reads it.

Class composition on the panel: always `modal-panel`; plus `modal` unless `unstyled`; plus `className`. (`modal-panel` = motion only; `modal` = the existing 380px box; custom classes = their own box.)

### Motion — `src/renderer/styles.css`

Uses the existing motion tokens (`--ease-out`, `--motion`, etc. from the canvas pass).

```css
.modal-backdrop {
  /* existing layout … */
  transition: opacity var(--motion) var(--ease-out);
  opacity: 1;
  @starting-style { opacity: 0; }
}
.modal-backdrop[data-closing] { opacity: 0; transition: opacity 150ms var(--ease-out); }

.modal-panel {
  transform-origin: center;            /* modals stay centered (Emil) */
  transition: opacity var(--motion) var(--ease-out), transform var(--motion) var(--ease-out);
  opacity: 1; transform: scale(1);
  @starting-style { opacity: 0; transform: scale(0.96); }
}
.modal-panel[data-closing] {
  opacity: 0; transform: scale(0.96);
  transition: opacity 150ms var(--ease-out), transform 150ms var(--ease-out);
}

@media (prefers-reduced-motion: reduce) {
  .modal-panel, .modal-panel[data-closing] { transform: none; }
  /* opacity fade is retained; no movement */
}
```

Enter ≈180ms (`--motion`), exit ≈150ms (snappier, Emil's asymmetric timing). The wrapper's close `setTimeout` matches the 150ms exit.

### Migration — every modal onto `<Modal>`

Each modal replaces its hand-rolled `<div className="modal-backdrop" onClick={onClose}><div className="modal …" onClick={stopProp}>…</div></div>` with `<Modal onClose={onClose} className="…" labelledBy="…">…</Modal>`, and switches its footer/X close buttons from `onClick={onClose}` to `const close = useModalClose()` / `onClick={close}`:

| Modal | Notes |
|---|---|
| `ConfirmDialog.tsx` | Escape = cancel (safe default). The simplest — good first migration. |
| `ContextModal.tsx` | `className="ctx-modal"`; its scope-picker checkboxes get the restyle. |
| `FaqModal.tsx` | straightforward. |
| `HitlModal.tsx` | always mounted, internally gated — wrap the *inner* shown modal in `<Modal>`; enter fires when a request appears, exit on resolve. |
| `RoleDraftModal.tsx` | straightforward. |
| `run/RunResultModal.tsx` | straightforward. |
| `TeamSpawnModal.tsx` | straightforward. |
| `AddAgentModal` | (defined in/near `App.tsx`) straightforward. |
| `SettingsModal.tsx` | `unstyled className="settings-modal"` so the two-pane box is preserved while gaining the motion; the X + nav stay; route its close through `useModalClose`. |

The `.modal` and per-modal box classes (`.ctx-modal`, `.settings-modal`, etc.) are unchanged except that motion now lives on `.modal-panel`.

### Checkbox polish — `src/renderer/styles.css`

A light shared restyle of the raw checkboxes that remain (Context scope picker, `panels/AgentConfigPanel.tsx`, `terminal/TerminalPane.tsx`) so they match the new craft — accent-colored check, consistent size/spacing. They stay `type="checkbox"` (multi-select), not Switches.

## Data flow

Open: parent renders `{show && <Modal onClose={() => setShow(false)}>…}` → `@starting-style` animates the enter. Close (backdrop / Escape / a `useModalClose()` button) → `requestClose` → `[data-closing]` exit animation → after 150ms `props.onClose()` runs → parent unmounts. No change to what `onClose` does, only a short delay.

## Error handling / edge cases

- **Stacked modals** (e.g. ConfirmDialog over another modal): Escape is scoped via the backdrop's `onKeyDown`, so only the focused (topmost) modal closes. Each manages its own lifecycle.
- **Unmount mid-animation** (parent removes the Modal for another reason): the `setTimeout` is cleared on unmount; no setState-after-unmount.
- **Double close** (rapid backdrop click + Escape): `requestClose` is idempotent while `closing`.
- **Reduced motion:** opacity-only; the close still delays ~150ms (consistent timing) but without movement.
- **`@starting-style` support:** Electron 42 (Chromium 136) supports it; if ever unsupported the modal simply appears without the enter animation (graceful).

## Testing

- Renderer component → `npm run typecheck` + `npm run build` + the full Vitest suite staying green (house precedent; the modal lifecycle is React state/timers, not a pure module).
- **Visual smoke (user):** every modal opens with a soft centered scale-in and closes with a quick fade-out; backdrop click, Escape, and footer/X buttons all animate the close; tab-focus lands inside the modal on open and returns to the trigger on close; the restyled checkboxes read clean; toggle OS reduced-motion → modals fade without scaling. Per Emil, re-check timing the next day / in slow-mo.

## File-by-file summary

| File | Change |
|------|--------|
| `src/renderer/Modal.tsx` | NEW — `<Modal>` primitive + `useModalClose` + `ModalContext` (backdrop, click-outside, Escape, focus, ARIA, enter/exit lifecycle) |
| `src/renderer/styles.css` | `.modal-backdrop`/`.modal-panel` motion + `@starting-style` + `[data-closing]` + reduced-motion; light checkbox restyle |
| `src/renderer/ConfirmDialog.tsx`, `ContextModal.tsx`, `FaqModal.tsx`, `HitlModal.tsx`, `RoleDraftModal.tsx`, `run/RunResultModal.tsx`, `TeamSpawnModal.tsx`, `SettingsModal.tsx`, `AddAgentModal` (in/near `App.tsx`) | migrate outer shell to `<Modal>`; close buttons → `useModalClose()` |
| `panels/AgentConfigPanel.tsx`, `terminal/TerminalPane.tsx` | adopt the restyled checkbox class (no logic change) |

**No changes** to any engine/store/IPC file. No modal's internal content layout is redesigned.

## Risks / edge cases

- **Behavior addition (Escape/focus).** Uniform Escape-to-close and focus-on-open are new for most modals — standard and approved, but flagged: if a specific modal must not close on Escape, the primitive can take an `escapeClosable={false}` prop later (YAGNI now).
- **Migration breadth.** ~9 modals touched; each is a mechanical shell swap, but the close-button rewiring must be complete (a missed button would close without animating). The plan migrates one as a proof, then batches the rest, each verified by build.
- **Settings two-pane.** Must use `unstyled` so `.settings-modal`'s sizing isn't overridden by `.modal`'s 380px box; the motion still applies via `.modal-panel`.
- **HITL special-case.** It's always-mounted with internal gating; wrapping the inner shown content (not the always-present component) keeps enter/exit correct.
- **Exit-delay correctness.** The wrapper's 150ms close timeout must match the CSS exit duration; both are tied to the same value to avoid a premature unmount cutting the animation.
