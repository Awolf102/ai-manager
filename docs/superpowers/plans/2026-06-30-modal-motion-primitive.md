# Shared Modal Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce one reusable `<Modal>` primitive (backdrop, click-outside, Escape, focus, ARIA, enter+exit motion) and migrate every modal onto it, so modals stop popping in/out and share one shell — plus a light checkbox restyle.

**Architecture:** A `<Modal>` component renders the backdrop + panel, manages an animated close (a `closing` flag drives a `[data-closing]` exit animation, then a 150ms timer calls the parent's real `onClose`), and threads that animated `close` to inline buttons via a render-prop (`children` as a function) with a `useModalClose()` hook for nested components. Enter is pure CSS (`@starting-style`). Motion lives on a new `.modal-panel` class so it composes with each modal's box class. No engine/store/IPC changes.

**Tech Stack:** TypeScript, React, plain CSS with the warm-dark + motion tokens (`--ease-out`, `--motion`). Electron 42 / Chromium 136 (`@starting-style`, `accent-color` available).

## Global Constraints

- **No functional change** beyond a ~150ms animated-close delay and the added Escape/focus: do NOT touch any engine/store/IPC file. Migrations are shell swaps + close-button rewiring only; no modal's internal content is redesigned.
- **Motion:** enter ≈`--motion` (180ms) `--ease-out`; exit 150ms `--ease-out` (snappier — Emil's asymmetric timing); panel scales from `0.96`+opacity, `transform-origin: center` (modals stay centered, never `scale(0)`). The wrapper's close timeout (`EXIT_MS = 150`) MUST equal the CSS exit duration.
- **`.modal-panel` carries motion; `.modal` keeps the box.** The wrapper adds `modal-panel`, plus `modal` unless `unstyled`, plus the extra `className`.
- **Accessibility:** `role="dialog"` + `aria-modal="true"`; Escape-to-close + focus-on-open (but don't steal focus from an inner `autoFocus` element) + restore-focus-on-close. `dismissable={false}` disables backdrop+Escape close (HITL).
- **`prefers-reduced-motion`:** opacity-only fade, no scale/movement.
- **Tokens only, no raw hex** in the new CSS.
- **Commands:** `npm run typecheck`; `npm run build`; `npm test` (full Vitest suite must stay green). Renderer has no unit tests (house precedent) — each task verifies by typecheck + build + suite, and the final visual smoke is the user's.

---

### Task 1: The `<Modal>` primitive + motion CSS + FaqModal proof

**Files:**
- Create: `src/renderer/Modal.tsx`
- Modify: `src/renderer/styles.css` (modal motion + reduced-motion + checkbox restyle)
- Modify: `src/renderer/FaqModal.tsx` (first migration — proves the primitive)

**Interfaces:**
- Produces:
  - `export function Modal(props: { onClose: () => void; className?: string; unstyled?: boolean; dismissable?: boolean; labelledBy?: string; children: ReactNode | ((close: (after?: () => void) => void) => ReactNode) }): JSX.Element`
  - `export function useModalClose(): (after?: () => void) => void`
  - The `close(after?)` function: plays the exit animation, then after 150ms calls `after ?? onClose`.

- [ ] **Step 1: Create `src/renderer/Modal.tsx`**

```tsx
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

type CloseFn = (after?: () => void) => void

const ModalCloseContext = createContext<CloseFn>(() => {})

/** Animated close from a component nested inside a <Modal>. Inline buttons should prefer the render-prop `close`. */
export function useModalClose(): CloseFn {
  return useContext(ModalCloseContext)
}

const EXIT_MS = 150 // must match the .modal-panel[data-closing] CSS transition

export function Modal({
  onClose,
  className,
  unstyled = false,
  dismissable = true,
  labelledBy,
  children
}: {
  onClose: () => void
  className?: string
  unstyled?: boolean
  dismissable?: boolean
  labelledBy?: string
  children: ReactNode | ((close: CloseFn) => ReactNode)
}) {
  const [closing, setClosing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevFocus = useRef<Element | null>(null)

  useEffect(() => {
    prevFocus.current = document.activeElement
    // focus the panel for Escape/AT, but don't steal an inner autoFocus (e.g. HITL textarea)
    if (panelRef.current && !panelRef.current.contains(document.activeElement)) {
      panelRef.current.focus()
    }
    return () => {
      clearTimeout(timer.current)
      if (prevFocus.current instanceof HTMLElement) prevFocus.current.focus()
    }
  }, [])

  const close: CloseFn = (after) => {
    if (closing) return
    setClosing(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => (after ?? onClose)(), EXIT_MS)
  }

  const panelClass = ['modal-panel', unstyled ? '' : 'modal', className].filter(Boolean).join(' ')
  const body = typeof children === 'function' ? children(close) : children

  return (
    <div
      className="modal-backdrop"
      data-closing={closing || undefined}
      onClick={() => {
        if (dismissable) close()
      }}
      onKeyDown={(e) => {
        if (dismissable && e.key === 'Escape') {
          e.stopPropagation()
          close()
        }
      }}
    >
      <ModalCloseContext.Provider value={close}>
        <div
          ref={panelRef}
          className={panelClass}
          data-closing={closing || undefined}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </div>
      </ModalCloseContext.Provider>
    </div>
  )
}
```

- [ ] **Step 2: Add the modal motion + checkbox restyle to `src/renderer/styles.css`**

Edit the existing `.modal-backdrop` rule to add the fade transition (keep its existing `position/inset/background/display/place-items/z-index`), then append the rest. The `.modal-backdrop` rule becomes:

```css
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  z-index: 50;
  opacity: 1;
  transition: opacity var(--motion) var(--ease-out);
}
```

Then append at the end of the file:

```css
/* ---- Shared modal motion (Modal.tsx primitive) ---- */
@starting-style {
  .modal-backdrop { opacity: 0; }
}
.modal-backdrop[data-closing] { opacity: 0; transition: opacity 150ms var(--ease-out); }

.modal-panel {
  transform-origin: center;
  opacity: 1;
  transform: scale(1);
  transition: opacity var(--motion) var(--ease-out), transform var(--motion) var(--ease-out);
}
@starting-style {
  .modal-panel { opacity: 0; transform: scale(0.96); }
}
.modal-panel[data-closing] {
  opacity: 0;
  transform: scale(0.96);
  transition: opacity 150ms var(--ease-out), transform 150ms var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .modal-panel,
  .modal-panel[data-closing] { transform: none; }
}

/* ---- Checkbox restyle (accent-recolor the few remaining multi-select checkboxes) ---- */
input[type='checkbox'] {
  accent-color: var(--accent);
  cursor: pointer;
}
```

- [ ] **Step 3: Migrate `src/renderer/FaqModal.tsx` (proof)**

Add the import at the top:

```tsx
import { Modal } from './Modal'
```

Replace the outer shell. The current structure is `<div className="modal-backdrop" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}> …content… </div></div>`. Replace the opening `<div className="modal-backdrop" …><div className="modal" …>` with `<Modal onClose={onClose}>{(close) => (<>`, replace the matching closing `</div></div>` with `</>)}</Modal>`, and change the "Got it" button from `onClick={onClose}` to `onClick={() => close()}`. The result:

```tsx
import { Modal } from './Modal'

export default function FaqModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      {(close) => (
        <>
          {/* …existing FAQ heading + body content, unchanged… */}
          <div className="modal-actions">
            <button className="btn primary" onClick={() => close()}>
              Got it
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
```

(Keep all the existing inner FAQ content exactly as-is between the heading and the actions row.)

- [ ] **Step 4: Typecheck, build, test**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS. (FAQ now opens with a centered scale-in and closes with a quick fade; other modals still use their hand-rolled shell — they gain only the backdrop fade-in, which is harmless.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/Modal.tsx src/renderer/styles.css src/renderer/FaqModal.tsx
git commit -m "feat(modal): shared Modal primitive with enter/exit motion + FAQ proof"
```

---

### Task 2: Migrate the standard modals

**Files:**
- Modify: `src/renderer/ContextModal.tsx`
- Modify: `src/renderer/RoleDraftModal.tsx`
- Modify: `src/renderer/TeamSpawnModal.tsx`
- Modify: `src/renderer/run/RunResultModal.tsx`
- Modify: `src/renderer/App.tsx` (the `AddAgentModal` defined at ~line 372)

**Interfaces:**
- Consumes: `Modal` from Task 1 (`import { Modal } from './Modal'`, or `'../Modal'` from `run/`).

**The transformation (applies to each file below):**
1. Add `import { Modal } from './Modal'` (use `'../Modal'` for `run/RunResultModal.tsx`).
2. Replace `<div className="modal-backdrop" onClick={onClose}><div className="modal <EXTRA>" onClick={(e) => e.stopPropagation()}>` with `<Modal onClose={onClose} className="<EXTRA>">{(close) => (<>` — where `<EXTRA>` is the class(es) after `modal` (omit `className` entirely if the panel was just `"modal"`).
3. Replace the matching closing `</div></div>` with `</>)}</Modal>`.
4. **Dismiss buttons** (Cancel / Close) `onClick={onClose}` → `onClick={() => close()}` (keep any `disabled={…}`).
5. **Action buttons that already call `onClose` after async work** (Apply / Create) stay as-is — they close instantly after the action; only dismiss paths animate (acceptable for this cycle).

- [ ] **Step 1: Migrate `ContextModal.tsx`**

Panel is `modal ctx-modal` → `<Modal onClose={onClose} className="ctx-modal">{(close) => (<>` … `</>)}</Modal>`. The footer **Close** button (`<button className="btn primary" onClick={onClose}>Close</button>`) → `onClick={() => close()}`. Leave all the file/folder rows, ScopeControl, and `removeFile`/`addFiles`/etc. handlers untouched (those are not closes).

- [ ] **Step 2: Migrate `RoleDraftModal.tsx`**

Panel is `modal modal-wide` → `<Modal onClose={onClose} className="modal-wide">{(close) => (<>` … `</>)}</Modal>`. The **Cancel** button (`onClick={onClose} disabled={applying}`) → `onClick={() => close()}` (keep `disabled={applying}`). The **Apply** button keeps its existing handler (it applies then calls `onClose`).

- [ ] **Step 3: Migrate `TeamSpawnModal.tsx`**

Same as RoleDraft: panel `modal modal-wide` → `className="modal-wide"`; **Cancel** (`onClick={onClose} disabled={applying}`) → `onClick={() => close()}`; **Apply** unchanged.

- [ ] **Step 4: Migrate `run/RunResultModal.tsx`**

Import `{ Modal } from '../Modal'`. Panel `modal modal-wide` → `<Modal onClose={onClose} className="modal-wide">{(close) => (<>` … `</>)}</Modal>`. The footer dismiss button (`<button className="btn" onClick={onClose}>…</button>`) → `onClick={() => close()}`. Any "Launch app"/action buttons keep their handlers.

- [ ] **Step 5: Migrate `AddAgentModal` in `src/renderer/App.tsx`**

Find `function AddAgentModal({ onClose, onCreated }…)` (~line 372). Add `import { Modal } from './Modal'` to App.tsx's imports. Its panel is just `className="modal"` (no extra class), so use `<Modal onClose={onClose}>` with no `className`. Replace `<div className="modal-backdrop" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}>` with `<Modal onClose={onClose}>{(close) => (<>` and the matching `</div></div>` with `</>)}</Modal>`. The **Cancel** button (`<button className="btn" onClick={onClose}>Cancel</button>`) → `onClick={() => close()}`. The **Create** button keeps `onClick={() => void create()}` (its `create` calls `onCreated` + `onClose` itself). The name input's `autoFocus` is preserved — the primitive's focus-on-open skips when focus is already inside.

- [ ] **Step 6: Typecheck, build, test**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS. (These five modals now open + close with motion.)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/ContextModal.tsx src/renderer/RoleDraftModal.tsx src/renderer/TeamSpawnModal.tsx src/renderer/run/RunResultModal.tsx src/renderer/App.tsx
git commit -m "feat(modal): migrate standard modals onto <Modal>"
```

---

### Task 3: Migrate the special modals (Settings, ConfirmDialog, HITL)

**Files:**
- Modify: `src/renderer/SettingsModal.tsx`
- Modify: `src/renderer/ConfirmDialog.tsx`
- Modify: `src/renderer/HitlModal.tsx`

**Interfaces:**
- Consumes: `Modal` from `./Modal`.

- [ ] **Step 1: Migrate `SettingsModal.tsx` (custom box → `unstyled`)**

Add `import { Modal } from './Modal'`. The panel uses `.settings-modal` (its own box, NOT `.modal`), so pass `unstyled` so the wrapper doesn't add the 380px `.modal` box. Replace `<div className="modal-backdrop" onClick={onClose}><div className="settings-modal" onClick={(e) => e.stopPropagation()}>` with `<Modal onClose={onClose} unstyled className="settings-modal">{(close) => (<>`, and the matching `</div></div>` with `</>)}</Modal>`. Change the top-right close button (`<button className="settings-close" … onClick={onClose}>`) to `onClick={() => close()}`. The rail/nav/panes are unchanged.

- [ ] **Step 2: Migrate `ConfirmDialog.tsx` (store-gated; drop its own Escape)**

Replace the whole file body with the `<Modal>` form. Remove the `useEffect` Escape handler and the `useEffect` import (the Modal handles Escape now). Backdrop/Escape/Cancel resolve `false`; Confirm resolves `true` after the exit animation:

```tsx
import { useStore } from './store'
import { Modal } from './Modal'

export default function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm)
  const resolveConfirm = useStore((s) => s.resolveConfirm)

  if (!confirm) return null
  const { title, body, confirmLabel, danger } = confirm.opts
  return (
    <Modal onClose={() => resolveConfirm(false)}>
      {(close) => (
        <>
          <h2>{title}</h2>
          <p className="confirm-body">{body}</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => close()}>
              Cancel
            </button>
            <button
              className={`btn ${danger ? 'danger' : 'primary'}`}
              onClick={() => close(() => resolveConfirm(true))}
            >
              {confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
```

- [ ] **Step 3: Migrate `HitlModal.tsx` (non-dismissible; route every action through `close`)**

HITL's backdrop has no click handler today (you must respond), so pass `dismissable={false}` (no backdrop/Escape close). Keep the early `if (!pending) return null` and the minimized-badge branch unchanged — wrap only the full modal return. Add `import { Modal } from './Modal'`. Replace `<div className="modal-backdrop"><div className="modal" onClick={(e) => e.stopPropagation()}>` with `<Modal dismissable={false} onClose={() => minimizeInterrupt(true)}>{(close) => (<>`, and the matching `</div></div>` with `</>)}</Modal>`. Route the three actions through `close(after)` so they animate out first:

```tsx
        <div className="modal-actions">
          <button className="btn" onClick={() => close(() => minimizeInterrupt(true))}>
            Minimize
          </button>
          <button className="btn" onClick={() => close(() => submit(''))}>
            Skip
          </button>
          <button className="btn primary" disabled={!text.trim()} onClick={() => close(() => submit(text.trim()))}>
            Submit
          </button>
        </div>
```

(Keep the `<h2>`, the question, and the `field`/textarea — with its `autoFocus` — exactly as-is; the primitive won't steal focus from the autoFocused textarea.)

- [ ] **Step 4: Typecheck, build, test**

Run: `npm run typecheck && npm run build && npm test`
Expected: all PASS. (Settings keeps its two-pane box but now animates; ConfirmDialog animates and still resolves true/false correctly; HITL animates in/out and stays non-dismissible.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/SettingsModal.tsx src/renderer/ConfirmDialog.tsx src/renderer/HitlModal.tsx
git commit -m "feat(modal): migrate Settings, ConfirmDialog, and HITL onto <Modal>"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck && npm run build && npm test` — all clean.
- [ ] **User visual smoke** (agents can't run the GUI): open each modal (Settings, Context, FAQ, Add agent, Team spawn, Role draft, Run result, a confirm dialog, and a HITL request) — each should **scale-in from center on open** and **fade/scale-out on close**; backdrop click + Escape close the dismissable ones (NOT HITL); ConfirmDialog's Confirm/Cancel resolve correctly after the animation; tab-focus lands inside on open and returns to the trigger on close; the HITL textarea still autofocuses; restyled checkboxes (Context scope picker, Agent-config panel, terminal) read with a rose accent; toggle OS reduced-motion → modals fade without scaling. Per Emil: re-check timing the next day / in slow-mo.

## Spec coverage check

| Spec requirement | Task |
| --- | --- |
| `<Modal>` primitive (backdrop, click-outside, Escape, focus, ARIA, lifecycle) + `useModalClose` | 1 |
| Enter via `@starting-style`; exit via `[data-closing]` + 150ms delayed `onClose` | 1 |
| `.modal-panel` motion decoupled from `.modal` box; `unstyled` for custom boxes | 1 (CSS) + 3 (Settings `unstyled`) |
| Render-prop `close` (+ `useModalClose` hook) for inline buttons | 1 |
| `dismissable={false}` for non-dismissible modals (HITL) | 1 (prop) + 3 (HITL) |
| Focus-on-open without stealing inner autoFocus; restore on close | 1 |
| Reduced-motion (opacity only) | 1 (CSS) |
| Checkbox restyle (accent-color, multi-select stays checkbox) | 1 (CSS) |
| Migrate all ~9 modals (Faq/Context/RoleDraft/TeamSpawn/RunResult/AddAgent/Settings/Confirm/HITL) | 1 (Faq) + 2 (standard) + 3 (special) |
| No engine/store/IPC change; no internal content redesign | 1 + 2 + 3 (none touched) |
