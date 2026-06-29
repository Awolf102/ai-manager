# Orkestr Foundation (Design System) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish Orkestr's shared design system — a documented warm-dark `tokens.css`, restyled shared primitives, a Toast/notification surface, a bundled UI font, and the visible rebrand — with no per-surface layout work.

**Architecture:** A new `tokens.css` defines the warm-dark palette + scales as CSS custom properties AND redefines the existing legacy variable names as aliases onto the new system, so the whole app re-tints with zero find-replace churn. Shared primitives are restyled in place against the semantic tokens. A pure `toasts.ts` reducer (TDD'd) backs a thin zustand store slice + a `ToastViewport` component that replaces the "homeless" `window.alert` sites.

**Tech Stack:** React 19, zustand 5, electron-vite (vite 7), vitest, lucide-react, `@fontsource-variable/inter`.

## Global Constraints

- Warm-dark palette anchors (locked): indigo `#1F1A38`, plum `#7B506F`, rose `#DD99BB`, cream `#EAD7D1`, greige `#DBCDC6`. Manager role re-mapped to periwinkle `#8EA2F0` (distinct from rose + teal).
- Rose signal is used **sparingly** (primary actions, focus, selection); it is never a role color.
- Rebrand is **visible strings only**. Do NOT change internal identifiers: `ai-manager-team` bundle `kind`, `.ai-manager/` / `~/.ai-manager/` dirs, `ai-manager-skills-pack` id, IPC dialog filter names, or any tests asserting these.
- Scope is tokens + primitives + Toast + font + rebrand ONLY. No panel system, no canvas/run/settings/goalbar reshaping. Do NOT touch `GoalBar.tsx`'s three run-related `window.alert`s — those belong to the later Run-experience cycle.
- Testing pattern (matches this codebase): pure logic is TDD'd; CSS/component-wiring/rebrand are verified by `npm run typecheck` + `npm run build` + live render. Visual values below are baseline starting points, live-tunable.
- Commit after every task. Test command: `npx vitest run <file>`. Typecheck: `npm run typecheck`. Build: `npm run build`.

---

### Task 1: Warm-dark token system + rebrand base

**Files:**
- Create: `src/renderer/tokens.css`
- Modify: `src/renderer/main.tsx:3` (add tokens import before styles)
- Modify: `src/renderer/styles.css:1-18` (remove the legacy `:root` color block)
- Modify: `src/main/index.ts:14-15` (window `backgroundColor` + `title`)
- Modify: `src/renderer/App.tsx:121` and `:365` ("AI Manager" → "Orkestr")
- Modify: `src/renderer/index.html:6` (`<title>`)

**Interfaces:**
- Produces: the CSS token vocabulary consumed by all later tasks — semantic names (`--surface-0/1/2`, `--surface-hover`, `--surface-selected`, `--fg`, `--fg-muted`, `--fg-dim`, `--hairline`, `--hairline-strong`, `--signal`, `--signal-hover`, `--signal-press`, `--signal-tint`, `--focus-ring`, `--on-signal`, `--orchestrator`, `--manager`, `--worker`, `--state-danger`, `--state-good`, `--font-sans`, `--font-mono`, `--text-xs…xl`, `--space-1…7`, `--radius-sm/-/lg/pill`, `--elev-1/2`, `--motion-fast/-/slow`, `--ease-standard`) plus legacy aliases (`--bg`, `--panel`, `--panel-2`, `--border`, `--border-strong`, `--text`, `--muted`, `--accent`, `--accent-dim`, `--danger`, `--good`, `--radius`).

- [ ] **Step 1: Create `src/renderer/tokens.css`**

```css
:root {
  /* ===== Brand anchors (locked) ===== */
  --indigo: #1F1A38;
  --plum: #7B506F;
  --rose: #DD99BB;
  --cream: #EAD7D1;
  --greige: #DBCDC6;

  /* ===== Surfaces (indigo→plum ramp; plum reserved for selected/active) ===== */
  --surface-0: #1F1A38;      /* app background / canvas — deepest */
  --surface-1: #25203F;      /* panels, dock, top bar */
  --surface-2: #2E2749;      /* raised cards, inputs, modals */
  --surface-hover: #3A2F54;
  --surface-selected: #7B506F;

  /* ===== Text & borders ===== */
  --fg: #EAD7D1;
  --fg-muted: #C9BEC2;
  --fg-dim: #9C8F96;
  --hairline: rgba(234, 215, 209, 0.10);
  --hairline-strong: rgba(234, 215, 209, 0.18);

  /* ===== Signal & states ===== */
  --signal: #DD99BB;
  --signal-hover: #E7ADC8;
  --signal-press: #C97FA6;
  --signal-tint: rgba(221, 153, 187, 0.16);
  --focus-ring: rgba(221, 153, 187, 0.45);
  --on-signal: #1F1A38;      /* text/icon on a rose fill */

  /* ===== Agent roles ===== */
  --orchestrator: #F0B54A;   /* gold — kept */
  --manager: #8EA2F0;        /* periwinkle — re-mapped off lavender #b08cff */
  --worker: #4FD1C5;         /* teal — kept */
  --state-danger: #F0726F;
  --state-good: #6FD08A;

  /* ===== Typography ===== */
  --font-sans: 'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --text-xs: 11px;
  --text-sm: 12px;
  --text-base: 13px;
  --text-md: 15px;
  --text-lg: 18px;
  --text-xl: 22px;
  --lh-tight: 1.25;
  --lh-normal: 1.5;
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --tracking-tight: -0.01em;

  /* ===== Spacing / radius / elevation / motion ===== */
  --space-1: 2px; --space-2: 4px; --space-3: 8px; --space-4: 12px;
  --space-5: 16px; --space-6: 24px; --space-7: 32px;
  --radius-sm: 6px; --radius: 10px; --radius-lg: 14px; --radius-pill: 999px;
  --elev-1: 0 1px 2px rgba(0, 0, 0, 0.30);
  --elev-2: 0 8px 24px rgba(0, 0, 0, 0.38);
  --motion-fast: 120ms; --motion: 180ms; --motion-slow: 260ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);

  /* ===== Legacy aliases — map OLD names onto the warm-dark system so the
     existing styles.css re-tints with zero churn. Later cycles migrate
     individual rules to the semantic names above. ===== */
  --bg: var(--surface-0);
  --panel: var(--surface-1);
  --panel-2: var(--surface-2);
  --border: var(--hairline);
  --border-strong: var(--hairline-strong);
  --text: var(--fg);
  --muted: var(--fg-muted);
  --accent: var(--signal);
  --accent-dim: var(--signal-tint);
  --danger: var(--state-danger);
  --good: var(--state-good);

  font-synthesis: none;
}
```

- [ ] **Step 2: Import tokens before styles in `src/renderer/main.tsx`**

Change line 3 area so tokens load first:

```tsx
import App from './App'
import './tokens.css'
import './styles.css'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
```

- [ ] **Step 3: Remove the legacy `:root` block from `src/renderer/styles.css`**

Delete lines 1–18 (the old `:root { --bg … --radius: 10px; font-synthesis: none; }` block) entirely — `tokens.css` now owns all of it (including `font-synthesis: none`). Leave the rest of the file untouched.

- [ ] **Step 4: Update the window chrome in `src/main/index.ts`**

```ts
    backgroundColor: '#1F1A38',
    title: 'Orkestr',
```

- [ ] **Step 5: Rebrand the visible strings**

`src/renderer/App.tsx` line ~121:
```tsx
        <span className="brand">Orkestr</span>
```
`src/renderer/App.tsx` line ~365:
```tsx
        <h1>Orkestr</h1>
```
`src/renderer/index.html` line 6:
```html
    <title>Orkestr</title>
```

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both pass with no errors.

- [ ] **Step 7: Live-verify**

Run the app (`npm run dev`). Confirm: background is deep indigo, panels/top bar read warm (not cold gray), text is cream, the brand + window title say "Orkestr". No layout has changed.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/tokens.css src/renderer/main.tsx src/renderer/styles.css src/main/index.ts src/renderer/App.tsx src/renderer/index.html
git commit -m "feat(orkestr): warm-dark token system + Orkestr rebrand base"
```

---

### Task 2: Bundle the Inter UI font

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/renderer/main.tsx` (import the font)
- Modify: `src/renderer/styles.css:31-37` (body `font-family` → token)

**Interfaces:**
- Consumes: `--font-sans` from Task 1 (already lists `'Inter Variable'` first).
- Produces: the bundled font so `--font-sans` resolves to Inter on every OS.

- [ ] **Step 1: Install the font package**

Run: `npm install @fontsource-variable/inter`
Expected: added to `dependencies`.

- [ ] **Step 2: Import the font in `src/renderer/main.tsx`**

Add at the top of the import block (after the CSS imports):

```tsx
import '@fontsource-variable/inter'
```

- [ ] **Step 3: Point the body font at the token in `src/renderer/styles.css`**

Replace the `body { … font-family: -apple-system, …; … }` declaration's font-family line (around line 34) with:

```css
  font-family: var(--font-sans);
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both pass.

- [ ] **Step 5: Live-verify**

Run the app; confirm the UI renders in Inter (consistent letterforms; compare a heading vs body weight).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/renderer/main.tsx src/renderer/styles.css
git commit -m "feat(orkestr): bundle Inter Variable as the UI typeface"
```

---

### Task 3: Restyle shared primitives

**Files:**
- Modify: `src/renderer/styles.css` — `.btn` group (~156-200), `.field` inputs (~386-405), `.modal` (~651-660), `.seg` (~680-700); add a shared `.badge`.

**Interfaces:**
- Consumes: semantic tokens from Task 1.

Baseline values below; live-tunable. This task is verified by build + live render (no unit tests).

- [ ] **Step 1: Restyle the button group** — replace the `.btn` … `.btn:disabled` rules with:

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline-strong);
  background: var(--surface-2);
  color: var(--fg);
  font-size: var(--text-sm);
  transition: border-color var(--motion-fast) var(--ease-standard),
              background var(--motion-fast) var(--ease-standard);
}
.btn:hover { border-color: var(--signal); background: var(--surface-hover); }
.btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--focus-ring); }
.btn.primary {
  background: var(--signal);
  border-color: var(--signal);
  color: var(--on-signal);
  font-weight: var(--weight-medium);
}
.btn.primary:hover { background: var(--signal-hover); border-color: var(--signal-hover); }
.btn.danger { background: transparent; border-color: var(--hairline-strong); color: var(--state-danger); }
.btn.danger:hover { border-color: var(--state-danger); background: var(--surface-hover); }
.btn.tiny { padding: 3px 8px; font-size: var(--text-xs); border-radius: var(--radius-sm); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
```

- [ ] **Step 2: Restyle inputs** — replace the `.field input/select/textarea` + `:focus` rules with:

```css
.field input,
.field select,
.field textarea {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--hairline-strong);
  color: var(--fg);
  border-radius: var(--radius-sm);
  padding: 7px 9px;
  font-size: var(--text-sm);
  font-family: var(--font-sans);
}
.field input:focus,
.field select:focus,
.field textarea:focus {
  outline: none;
  border-color: var(--signal);
  box-shadow: 0 0 0 3px var(--focus-ring);
}
```

- [ ] **Step 3: Restyle the modal shell** — replace the `.modal` rule with:

```css
.modal {
  width: 380px;
  max-height: 86vh;
  overflow-y: auto;
  background: var(--surface-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  padding: 20px;
  box-shadow: var(--elev-2);
}
```

- [ ] **Step 4: Restyle the segmented control** — replace the `.seg button` + `.seg button.active` rules with:

```css
.seg button {
  flex: 1;
  padding: 7px;
  background: var(--surface-2);
  border: none;
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
.seg button.active { background: var(--signal); color: var(--on-signal); }
```

- [ ] **Step 5: Add a shared `.badge`** — append near the `.seg` rules:

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  background: var(--signal-tint);
  color: var(--signal);
}
```

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both pass.

- [ ] **Step 7: Live-verify**

Open a modal (e.g. Add agent), confirm: primary buttons are rose with dark text, inputs show a rose focus ring, the segmented control highlights in rose, the modal has soft elevation. Legible throughout.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/styles.css
git commit -m "feat(orkestr): restyle shared primitives to warm-dark tokens"
```

---

### Task 4: Pure toast reducer (`toasts.ts`) — TDD

**Files:**
- Create: `src/renderer/toasts.ts`
- Test: `src/renderer/toasts.test.ts`

**Interfaces:**
- Produces:
  - `interface Toast { id: string; kind: 'info' | 'success' | 'error'; message: string; createdAt: number }`
  - `const TOAST_CAP: number`
  - `addToast(list: Toast[], toast: Toast, cap?: number): Toast[]` — append; drop oldest over cap; pure (no mutation)
  - `removeToast(list: Toast[], id: string): Toast[]` — filter by id; pure

- [ ] **Step 1: Write the failing test** — create `src/renderer/toasts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { addToast, removeToast, TOAST_CAP, type Toast } from './toasts'

const mk = (id: string): Toast => ({ id, kind: 'info', message: id, createdAt: 0 })

describe('addToast', () => {
  it('appends to the end', () => {
    expect(addToast([mk('a')], mk('b')).map((t) => t.id)).toEqual(['a', 'b'])
  })
  it('drops the oldest when over the cap', () => {
    const full = Array.from({ length: TOAST_CAP }, (_, i) => mk(`t${i}`))
    const result = addToast(full, mk('new'))
    expect(result).toHaveLength(TOAST_CAP)
    expect(result[0].id).toBe('t1') // t0 dropped
    expect(result.at(-1)!.id).toBe('new')
  })
  it('does not mutate the input', () => {
    const input = [mk('a')]
    addToast(input, mk('b'))
    expect(input).toHaveLength(1)
  })
})

describe('removeToast', () => {
  it('removes the matching id', () => {
    expect(removeToast([mk('a'), mk('b')], 'a').map((t) => t.id)).toEqual(['b'])
  })
  it('returns the list unchanged when id is absent', () => {
    expect(removeToast([mk('a')], 'z').map((t) => t.id)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/toasts.test.ts`
Expected: FAIL — cannot resolve `./toasts`.

- [ ] **Step 3: Write the minimal implementation** — create `src/renderer/toasts.ts`:

```ts
export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error'
  message: string
  createdAt: number
}

export const TOAST_CAP = 4

/** Append a toast, dropping the oldest when over the cap. Pure. */
export function addToast(list: Toast[], toast: Toast, cap: number = TOAST_CAP): Toast[] {
  const next = [...list, toast]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/** Remove a toast by id. Pure. */
export function removeToast(list: Toast[], id: string): Toast[] {
  return list.filter((t) => t.id !== id)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/toasts.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/toasts.ts src/renderer/toasts.test.ts
git commit -m "feat(orkestr): pure toast reducer (addToast/removeToast)"
```

---

### Task 5: Toast store slice + `ToastViewport`

**Files:**
- Modify: `src/renderer/store.ts` (import from `./toasts`; add `toasts`/`notify`/`dismissToast` to `AppState` and the `create` body)
- Create: `src/renderer/ToastViewport.tsx`
- Modify: `src/renderer/App.tsx` (render `<ToastViewport />`)
- Modify: `src/renderer/styles.css` (append toast styles)

**Interfaces:**
- Consumes: `addToast`, `removeToast`, `Toast` from Task 4.
- Produces (on the store): `toasts: Toast[]`; `notify(input: { kind: Toast['kind']; message: string }) => string` (returns new id); `dismissToast(id: string) => void`.

This task is wiring + visual — verified by build + live render.

- [ ] **Step 1: Add the import to `src/renderer/store.ts`**

Near the top imports:

```ts
import { addToast, removeToast, type Toast } from './toasts'
```

- [ ] **Step 2: Extend the `AppState` interface** — add inside `interface AppState { … }`:

```ts
  toasts: Toast[]
  notify: (input: { kind: Toast['kind']; message: string }) => string
  dismissToast: (id: string) => void
```

- [ ] **Step 3: Implement the slice** — add inside the `create<AppState>((set, get) => ({ … }))` body (e.g. after `dismissResumableBanner`):

```ts
  toasts: [],
  notify: ({ kind, message }) => {
    const toast: Toast = { id: crypto.randomUUID(), kind, message, createdAt: Date.now() }
    set((s) => ({ toasts: addToast(s.toasts, toast) }))
    return toast.id
  },
  dismissToast: (id) => set((s) => ({ toasts: removeToast(s.toasts, id) })),
```

- [ ] **Step 4: Create `src/renderer/ToastViewport.tsx`**

```tsx
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useStore } from './store'
import type { Toast } from './toasts'

const AUTO_DISMISS_MS: Record<Toast['kind'], number> = {
  info: 5000,
  success: 5000,
  error: 0 // 0 = persist until dismissed
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast)
  useEffect(() => {
    const ms = AUTO_DISMISS_MS[toast.kind]
    if (ms <= 0) return
    const t = setTimeout(() => dismiss(toast.id), ms)
    return () => clearTimeout(t)
  }, [toast.id, toast.kind, dismiss])
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <span className="toast-msg">{toast.message}</span>
      <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
        <X size={13} />
      </button>
    </div>
  )
}

export default function ToastViewport() {
  const toasts = useStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="toast-viewport">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
```

- [ ] **Step 5: Mount it in `src/renderer/App.tsx`**

Add the import with the other component imports:
```tsx
import ToastViewport from './ToastViewport'
```
Render it next to the other always-on overlays (near `<HitlModal />` / `<ConfirmDialog />`):
```tsx
      <HitlModal />
      <ConfirmDialog />
      <ToastViewport />
```

- [ ] **Step 6: Append toast styles to `src/renderer/styles.css`**

```css
/* ---------- toasts ---------- */
.toast-viewport {
  position: fixed;
  right: var(--space-5);
  bottom: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  z-index: 100;
  max-width: 360px;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--hairline-strong);
  border-left: 3px solid var(--fg-dim);
  border-radius: var(--radius);
  box-shadow: var(--elev-2);
  font-size: var(--text-sm);
  color: var(--fg);
  animation: toast-in var(--motion) var(--ease-standard);
}
.toast-info { border-left-color: var(--signal); }
.toast-success { border-left-color: var(--state-good); }
.toast-error { border-left-color: var(--state-danger); }
.toast-msg { flex: 1; line-height: var(--lh-normal); }
.toast-close {
  background: none;
  border: none;
  color: var(--fg-dim);
  padding: 0;
  display: inline-flex;
  cursor: pointer;
}
.toast-close:hover { color: var(--fg); }
@keyframes toast-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 7: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/store.ts src/renderer/ToastViewport.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(orkestr): toast store slice + ToastViewport surface"
```

---

### Task 6: Migrate the homeless `window.alert` sites to `notify`

**Files:**
- Modify: `src/renderer/App.tsx` (5 alert sites)
- Modify: `src/renderer/TeamSpawnModal.tsx` (1 site)
- Modify: `src/renderer/ContextModal.tsx` (1 site)

**Interfaces:**
- Consumes: `notify` from Task 5.

Do NOT touch `GoalBar.tsx`'s run alerts. Verified by build + live render.

- [ ] **Step 1: App.tsx — add the `notify` selector**

In the `App` component's hook block (near the other `useStore` selectors, ~line 31):
```tsx
  const notify = useStore((s) => s.notify)
```

- [ ] **Step 2: App.tsx — replace the 5 alerts**

Line ~101 (context-skip, info):
```tsx
    if (r.skipped.length) notify({ kind: 'info', message: `Skipped (not a readable file): ${r.skipped.join(', ')}` })
```
Line ~153 (import preview error):
```tsx
            if (r.status === 'error') { notify({ kind: 'error', message: r.error }); return }
```
Line ~163 (import apply error):
```tsx
            else if ('error' in a && a.error) notify({ kind: 'error', message: a.error })
```
Line ~190 (sync success):
```tsx
              notify({ kind: 'success', message: `Updated ${r.updated} agent(s) from the team brain.` })
```
Line ~192 (sync error):
```tsx
              notify({ kind: 'error', message: r.error })
```

- [ ] **Step 3: TeamSpawnModal.tsx — migrate the create-team failure**

Add the selector in the component (near its other `useStore` calls):
```tsx
  const notify = useStore((s) => s.notify)
```
Replace line ~36:
```tsx
      notify({ kind: 'error', message: err instanceof Error ? err.message : 'Could not create the team.' })
```

- [ ] **Step 4: ContextModal.tsx — migrate the context-skip message**

Add the selector (near the other `useStore` calls, ~line 34):
```tsx
  const notify = useStore((s) => s.notify)
```
Replace line ~41:
```tsx
    if (r.skipped.length) notify({ kind: 'info', message: `Skipped (not a readable file): ${r.skipped.join(', ')}` })
```

- [ ] **Step 5: Verify no homeless alerts remain (GoalBar excepted)**

Run: `grep -rn "window.alert" src/renderer`
Expected: only the 3 `GoalBar.tsx` run-related alerts remain.

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both pass.

- [ ] **Step 7: Live-verify**

Trigger a migrated path (e.g. import an invalid team file, or sync from a team brain) and confirm a toast appears bottom-right, styled per kind, auto-dismissing (info/success) or dismissable (error) — no blocking `alert()` dialog.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/App.tsx src/renderer/TeamSpawnModal.tsx src/renderer/ContextModal.tsx
git commit -m "feat(orkestr): route homeless alerts through the toast surface"
```

---

## Self-Review

**Spec coverage:**
- §2 token system → Task 1 (full `tokens.css`) + Task 2 (`--font-sans` load). ✓
- §2.5 manager re-map (`#8EA2F0`) → Task 1 tokens. ✓
- §2.6 bundled UI sans → Task 2. ✓
- §3 primitive restyle (button/input/modal/panel via tokens/seg/badge) → Task 3. ✓ (Panel chrome `.topbar/.sidepanel/.panel-section` re-tint automatically via the legacy aliases in Task 1; explicit semantic-token migration of those is deferred to their owning surface cycles per the spec's "no per-surface layout" boundary.)
- §4 Toast (pure reducer / store slice / viewport / migrate homeless alerts) → Tasks 4, 5, 6. ✓
- §5 rebrand (4 visible strings; internal ids untouched) → Task 1. ✓
- §6 testing (logic TDD'd; rest build+live) → Task 4 TDD; Tasks 1-3,5,6 build+live. ✓
- §7 acceptance criteria → all mapped; out-of-scope respected (GoalBar untouched, no panel/canvas/run/settings reshaping). ✓

**Placeholder scan:** No TBD/TODO; all CSS and test code is concrete. Visual values are explicitly baseline/live-tunable, not placeholders.

**Type consistency:** `Toast`, `addToast`, `removeToast`, `TOAST_CAP` defined in Task 4 and consumed with identical signatures in Task 5; `notify({ kind, message })` returns `string` and is consumed consistently in Task 6.
