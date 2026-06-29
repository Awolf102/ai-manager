# Orkestr — Sub-project 0: Foundation (design system)

**Date:** 2026-06-29
**Parent:** `docs/superpowers/specs/2026-06-29-orkestr-overhaul-direction-design.md` (umbrella direction + decomposition)
**Status:** Design approved (brainstorm). Ready for implementation planning.

This is the first sub-project of the Orkestr overhaul. It establishes the shared design system (tokens + primitives) and the rebrand, so every later sub-project builds on one consistent base. It deliberately does **no** per-surface layout/IA work.

---

## 1. Goal

Stand up Orkestr's visual foundation:
1. A documented **token system** (`tokens.css`) expressing the locked warm-dark palette as ramps + scales.
2. **Restyled shared primitives** wired to those tokens, so the whole app re-tints to warm-dark automatically (every primitive already reads `var(--…)`).
3. A **Toast/notification** primitive + store action, replacing the "homeless" `window.alert` sites.
4. The **rebrand** to Orkestr (visible strings only) and the **manager role-color re-map**.

Success = the app runs, looks warm-dark and coherent (no cold-gray leftovers in shared chrome), no regressions, and `tokens.css` is a clean reusable artifact the later cycles consume.

---

## 2. Token system (`tokens.css`)

New file `src/renderer/tokens.css`, imported before `styles.css`. Holds all design tokens as CSS custom properties on `:root`; `styles.css` keeps only primitive/layout rules that reference them. Values below are concrete **starting points**, tuned during execution (contrast-checked); they are not placeholders.

### 2.1 Color — brand anchors (locked, user-supplied)
```
--indigo: #1F1A38;   --plum: #7B506F;   --rose: #DD99BB;
--cream:  #EAD7D1;   --greige: #DBCDC6;
```

### 2.2 Color — surfaces (indigo→plum ramp; plum reserved for interactive/selected, not every panel)
```
--bg:            #1F1A38;  /* app background / canvas — deepest */
--surface-1:     #25203F;  /* panels, dock, top bar */
--surface-2:     #2E2749;  /* raised cards, inputs, modals */
--surface-hover: #3A2F54;  /* hover (indigo drifting toward plum) */
--surface-selected: #7B506F; /* plum — selected/active accents, used sparingly */
```

### 2.3 Color — text & borders
```
--text:      #EAD7D1;  /* primary */
--muted:     #C9BEC2;  /* secondary (greige toned down for emphasis hierarchy) */
--text-dim:  #9C8F96;  /* tertiary/captions */
--border:        rgba(234,215,209,0.10);  /* hairline */
--border-strong: rgba(234,215,209,0.18);
```

### 2.4 Color — signal & states
```
--accent:       #DD99BB;  /* rose — primary actions, links, selection (SPARING) */
--accent-hover: #E7ADC8;
--accent-press: #C97FA6;
--focus-ring:   rgba(221,153,187,0.45);  /* visible focus on dark */
--accent-dim:   rgba(221,153,187,0.16);  /* subtle tints/fills */
--danger:       #F0726F;  /* retuned warm-dark */
--good:         #6FD08A;
```

### 2.5 Color — agent roles
```
--orchestrator: #F0B54A;  /* gold — kept */
--manager:      #8EA2F0;  /* periwinkle — RE-MAPPED off lavender #b08cff; tunable, must stay distinct from --rose and --worker */
--worker:       #4FD1C5;  /* teal — kept */
```

### 2.6 Typography
Bundle a single refined UI sans (default **Inter Variable**, tunable in execution) shipped with the app for cross-OS consistency; hierarchy from weight/size/spacing only. No separate display face (the wordmark is a future logo).
```
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, monospace; /* terminals/IDs */
--text-xs: 11px;  --text-sm: 12px;  --text-base: 13px;  /* base stays 13px for density */
--text-md: 15px;  --text-lg: 18px;  --text-xl: 22px;
--lh-tight: 1.25; --lh-normal: 1.5;
--weight-regular: 400; --weight-medium: 500; --weight-semibold: 600;
--tracking-tight: -0.01em;  /* headings/wordmark */
```

### 2.7 Spacing, radius, elevation, motion
```
--space-1: 2px; --space-2: 4px; --space-3: 8px; --space-4: 12px;
--space-5: 16px; --space-6: 24px; --space-7: 32px;
--radius-sm: 6px; --radius: 10px; --radius-lg: 14px; --radius-pill: 999px;
/* flat aesthetic: depth from surface step + hairline border, shadows minimal */
--elev-1: 0 1px 2px rgba(0,0,0,0.30);
--elev-2: 0 8px 24px rgba(0,0,0,0.38);   /* modals, toasts */
--motion-fast: 120ms; --motion: 180ms; --motion-slow: 260ms;
--ease-standard: cubic-bezier(0.2, 0, 0, 1);
```

The legacy `:root` block in `styles.css` (current `--bg/--panel/--accent/...`) is removed; any rule referencing an old name is repointed to the new token (e.g. `--panel` → `--surface-1`, old `--accent #6ea8fe` → `--accent` rose). This is a mechanical find-and-repoint pass across `styles.css`.

---

## 3. Primitive restyle (in `styles.css`, in place)

Restyle the existing shared primitive classes to the new tokens — no markup/layout restructuring beyond what the restyle needs:

- **Button** `.btn` + `.btn.primary` (rose) + `.btn.danger` + `.btn.tiny` + `:disabled` — rose primary, plum/hover surfaces, hairline borders, focus ring.
- **Inputs** `.field input/select/textarea` + `.goal-input` — `--surface-2`, `--border-strong`, rose focus ring.
- **Modal shell** `.modal-backdrop` + `.modal` + `.modal-actions` — `--surface-2`, `--elev-2`, radius-lg.
- **Panel chrome** `.topbar`, `.sidepanel`, `.panel-section` — `--surface-1`, hairline borders.
- **Badge/pill** — introduce a shared `.badge` and align existing badges (`.ctx-badge`, `.resume-badge`, effort badges, role pills) to it.
- **Segmented control** `.seg` / `.seg button.active` — token-driven.

Role-colored chrome (node accents, role pills) continues to reference `var(--orchestrator|manager|worker)` and so updates automatically with the manager re-map.

---

## 4. Toast / notification surface

### 4.1 Store slice (TDD'd)
Add a `toasts` slice to the renderer store:
- State: `toasts: { id: string; kind: 'info' | 'success' | 'error'; message: string; createdAt: number }[]`.
- `notify(input: { kind; message })` → pushes a toast (id via `crypto.randomUUID()`), returns id.
- `dismissToast(id)` → removes it.
- Auto-expire: `info`/`success` auto-dismiss after a timeout; `error` persists until dismissed (or a longer timeout). Timer wiring lives in the container component; the slice exposes add/dismiss.
- Cap: at most N visible toasts (e.g. 4); oldest dropped when exceeded.

### 4.2 Container primitive
A `ToastViewport` component rendered once in `App` (fixed, non-blocking, e.g. bottom-right), mapping `toasts` → toast cards styled per kind (`--good`/`--danger`/neutral), each dismissible, with restrained enter/exit motion using the motion tokens.

### 4.3 Migrate the homeless `window.alert` sites → `notify`
- `App.tsx`: context-skip message (`info`), import error (`error`), team-sync "updated N agents" (`success`) + sync error (`error`).
- `TeamSpawnModal.tsx`: create-team failure (`error`).
- `ContextModal.tsx`: context-skip message (`info`).

**Left for the Run-experience cycle (not migrated here):** `GoalBar.tsx`'s three run-related `window.alert`s (build-team / run-result / draft-roles failures) + the silent-fail fix — that cycle owns run error/success surfacing and will build on `notify`.

---

## 5. Rebrand (visible strings only)

Swap "AI Manager" → "Orkestr" at the 4 visible sites: `App.tsx` brand span (line ~121), `App.tsx` ProjectPicker `<h1>` (~365), `index.html` `<title>`, `main/index.ts` BrowserWindow `title`. 

**Do NOT change** internal identifiers: the `ai-manager-team` bundle `kind`, `.ai-manager/` / `~/.ai-manager/` data dirs, `ai-manager-skills-pack` plugin id, IPC dialog filter names tied to the bundle format, and all tests asserting these. (Optional, low-risk: human-facing dialog filter labels like "AI Manager team" may become "Orkestr team" only if they don't affect file compatibility — defer unless trivial.)

---

## 6. Testing

Matches the project's pattern (logic TDD'd; visuals live-verified):
- **Unit (TDD):** the `toasts` store slice — add returns id; dismiss removes; cap drops oldest; kind preserved. Optionally assert migrated call sites invoke `notify` with the expected kind (where structured enough to test).
- **Type/build:** `tsc` + build clean.
- **Live verify:** launch the app; confirm warm-dark palette applied app-wide with no cold-gray leftovers in shared chrome, primitives legible, focus rings visible, manager nodes periwinkle (distinct from rose/teal), a triggered toast appears/auto-dismisses/can be dismissed, and the title/brand read "Orkestr".

---

## 7. Acceptance criteria

1. `tokens.css` exists, is imported before `styles.css`, and holds the documented warm-dark token system (§2); no design values remain hard-coded in `styles.css` outside tokens (role chrome excepted via vars).
2. Shared primitives (§3) render in warm-dark and reference only tokens.
3. Manager role color is periwinkle and visibly distinct from rose and teal; orchestrator gold + worker teal unchanged.
4. Toast surface works (§4) and the homeless alert sites use `notify` instead of `window.alert`; GoalBar's run alerts intentionally remain.
5. Visible brand reads "Orkestr"; all internal ids/dirs/bundle-kind unchanged and all existing tests still pass.
6. `tsc` + build clean; new store-slice tests pass; app live-verified per §6.
7. No per-surface layout/IA changes, no panel system, no canvas/run/settings reshaping (those are later cycles).
