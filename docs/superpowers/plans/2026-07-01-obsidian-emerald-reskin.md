# Obsidian & Emerald Re-skin Implementation Plan

> **For agentic workers:** This is a **presentational re-skin** — pure CSS/token/font/material changes, no logic/IPC/engine edits. There are **no new automated tests** (spec §Testing). Each task's verification = `npm run typecheck` + `npm run lint` + `npm run build` green, plus the full existing suite (`npm run test`, 476) staying green at the integration gate, plus on-device eyeballing. Steps use checkbox (`- [ ]`) syntax. Execution is **inline** (executing-plans, batch with checkpoints), not subagent-driven.

**Goal:** Retire the warm indigo/plum/rose identity and re-skin Orkestr as **Obsidian & Emerald** — near-black surfaces, a two-step emerald ramp (deep racing green brand fill + legible on-black emerald accent), white type, glossy buttons, purposeful glass on elevated surfaces, obsidian-glass canvas cards, an emerald "run is alive" glow, and the Geist font.

**Architecture:** The Foundation aliased legacy token names onto semantic ones, so **most of the app re-tints by editing `tokens.css` values alone**. The re-skin = (1) new token values + new material tokens, (2) Geist font swap, (3) gloss/glass treatment on shared primitives, (4) targeted material passes on hero surfaces + every remaining hardcoded warm hex. Contrast (AA) is a first-class constraint; `prefers-reduced-motion` stays honored.

**Tech Stack:** React + Vite (electron-vite) renderer, plain CSS (`tokens.css` + `styles.css`), `@fontsource-variable/*` fonts, React Flow canvas, xterm terminals.

## Global Constraints

- **Palette (verbatim from spec):** primary **black** (obsidian surfaces, NOT pure `#000`), secondary **royal green = Deep Racing Green `#0F6B45`**, auxiliary **white**. Replaces warm indigo/plum/rose entirely.
- **Two-step emerald ramp:** `--brand #0F6B45` = fill only (white text on it); `--accent #3FBE86` = the on-black legible emerald for borders/focus/green-text/run-state. **Never use `--brand` as text/icon on black.**
- **Emerald is signal, not a role color** (carries over the old "rose = signal" rule).
- **Contrast AA:** body text ≥ 4.5:1, large/UI ≥ 3:1. Verify white-on-emerald button, muted text, green accents, and the three role colors. Bump values if close.
- **`prefers-reduced-motion`:** gloss glows/sheen use color/opacity transitions (kept) — no NEW movement gated behind motion. Existing reduced-motion blocks stay intact.
- **Glass only on genuinely-elevated surfaces** (modals + menus). Dock/panels/top bar = obsidian, not glass (impeccable glass-as-default ban). Keep `backdrop-filter` blur ≤ 18px; provide a solid-ish fallback bg.
- **No behavior/logic/IPC/engine/store change.** className/markup edits only where a surface needs a material hook; otherwise CSS/token/font only.
- **xterm themes are JS objects** (can't read CSS vars) — hardcode obsidian hex in both `RunView.tsx` and `TerminalPane.tsx`, and mirror `--canvas-dot` to the React Flow `<Background color>` prop in `OrgChart.tsx` (the two known "can't-read-CSS-var" gotchas).
- **Commits:** `git add` only the specific files each task touches. Do NOT stage the untracked `.agents/`, `.claude/`, `.codex/`, `skills-lock.json`. Work stays on branch `obsidian-emerald-reskin`.

---

## File map

- **Modify** `src/renderer/tokens.css` — new palette + material tokens (Tasks 1).
- **Modify** `src/renderer/main.tsx` + `package.json` — Geist font (Task 2).
- **Modify** `src/renderer/styles.css` — gloss primitives (3), glass modals/menus (4), canvas cards + pulse (5), run-view + warm-hex sweep (6).
- **Modify** `src/renderer/canvas/OrgChart.tsx` — Background dot color mirror (5).
- **Modify** `src/renderer/run/RunView.tsx`, `src/renderer/terminal/TerminalPane.tsx` — xterm obsidian themes (6).
- **Create** `DESIGN.md` (root) — shipped token/material system (7).

---

## Task 1: tokens.css — palette + material tokens

**Files:** Modify `src/renderer/tokens.css` (replace the whole `:root` block).

**Interfaces — Produces (token names later tasks rely on):**
- Surfaces: `--surface-0/1/2`, `--surface-hover`, `--surface-selected`.
- Text/hairline: `--fg`, `--fg-muted`, `--fg-dim`, `--hairline`, `--hairline-strong`.
- Emerald accent family (legible on black): `--signal`, `--signal-hover`, `--signal-press`, `--signal-tint`, `--focus-ring`, `--on-signal`; alias `--accent`=`--signal`, `--accent-dim`=`--signal-tint`, plus `--accent-tint`.
- Emerald brand-fill family (deep racing green, fill only): `--brand`, `--brand-hi`, `--brand-press`.
- Roles: `--orchestrator`, `--manager`, `--worker` + `*-tint`.
- States: `--state-good`, `--state-danger` (+ aliases `--good`,`--danger`).
- Materials: `--elev-1/2/3`, `--glass-bg`, `--glass-blur`, `--glass-highlight`, `--gloss`.
- Canvas: `--canvas-dot`.
- Typography: `--font-sans`, `--font-mono` (Task 2 rewrites the family strings).

- [ ] **Step 1: Replace the `:root` block** in `src/renderer/tokens.css` with:

```css
:root {
  /* ===== Brand anchors (Obsidian & Emerald) ===== */
  --obsidian: #0B0C0E;
  --racing-green: #0F6B45;   /* Deep Racing Green — brand fill */
  --emerald: #3FBE86;        /* legible on-black emerald — accent/signal */
  --white: #F4F6F5;

  /* ===== Obsidian surfaces (layered near-black, NOT pure #000) ===== */
  --surface-0: #0B0C0E;      /* app base / canvas — deepest */
  --surface-1: #121417;      /* panels, dock, top bar */
  --surface-2: #191C20;      /* raised cards, inputs, modals */
  --surface-hover: #22262B;
  --surface-selected: #16332599; /* emerald-tinted raise for selected rows */

  /* ===== White (auxiliary) — type + hairlines ===== */
  --fg: #F4F6F5;
  --fg-muted: #AAB2AF;       /* AA on all surfaces */
  --fg-dim: #727B77;
  --hairline: rgba(255, 255, 255, 0.08);
  --hairline-strong: rgba(255, 255, 255, 0.15);

  /* ===== Emerald ACCENT family (on-black legible — borders/focus/run-state/green-text) ===== */
  --signal: #3FBE86;
  --signal-hover: #5AD6A0;
  --signal-press: #2FA372;
  --signal-tint: rgba(63, 190, 134, 0.16);
  --accent-tint: rgba(63, 190, 134, 0.14);   /* softer glow/halo */
  --focus-ring: rgba(63, 190, 134, 0.48);
  --on-signal: #07130D;      /* dark text/icon on an emerald (light) fill */

  /* ===== Emerald BRAND-FILL family (Deep Racing Green — glossy primary fill only, white text) ===== */
  --brand: #0F6B45;
  --brand-hi: #128052;
  --brand-press: #0B5638;

  /* ===== Agent roles (retuned for obsidian; all clearly ≠ emerald-action) ===== */
  --orchestrator: #E6B23C;   /* gold */
  --manager: #8FA6E6;        /* periwinkle/steel */
  --worker: #B8C2CE;         /* silver-slate (moved OFF teal so it can't read as emerald) */
  --orchestrator-tint: rgba(230, 178, 60, 0.14);
  --manager-tint: rgba(143, 166, 230, 0.14);
  --worker-tint: rgba(184, 194, 206, 0.14);

  /* ===== Semantic states ===== */
  --state-danger: #F06A6A;
  --state-good: #4FD08A;     /* emerald-adjacent success, distinct from the deep brand */

  /* ===== Typography (family strings finalised in Task 2) ===== */
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

  /* ===== Spacing / radius ===== */
  --space-1: 2px; --space-2: 4px; --space-3: 8px; --space-4: 12px;
  --space-5: 16px; --space-6: 24px; --space-7: 32px;
  --radius-sm: 6px; --radius: 10px; --radius-lg: 14px; --radius-pill: 999px;

  /* ===== Elevation (soft, dark, layered — deepened for near-black) ===== */
  --elev-1: 0 1px 2px rgba(0, 0, 0, 0.40);
  --elev-2: 0 8px 24px rgba(0, 0, 0, 0.50);
  --elev-3: 0 12px 40px rgba(0, 0, 0, 0.55);

  /* ===== Materials — glass + gloss ===== */
  --glass-bg: rgba(18, 20, 23, 0.72);          /* dark & opaque enough for AA text */
  --glass-blur: 16px;                          /* within the 10–20px safe band */
  --glass-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.07);
  --gloss: linear-gradient(180deg, rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0) 45%);

  /* ===== Motion ===== */
  --motion-fast: 120ms; --motion: 180ms; --motion-slow: 260ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);

  /* Cool obsidian canvas dot-grid (mirrored to the React Flow <Background color> prop). */
  --canvas-dot: #1E2329;

  /* ===== Legacy aliases — map OLD names onto the obsidian/emerald system so styles.css
     re-tints with zero churn. ===== */
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

- [ ] **Step 2: Verify build** — `npm run build`. Expected: success (CSS parses). The app now broadly re-tints obsidian/emerald except the hardcoded warm hexes handled in Tasks 5–6.
- [ ] **Step 3: Commit**

```bash
git add src/renderer/tokens.css
git commit -m "feat(reskin): obsidian & emerald token palette + material tokens"
```

---

## Task 2: Geist font swap

**Files:** Modify `package.json`, `src/renderer/main.tsx`, `src/renderer/tokens.css`.

**Interfaces — Consumes:** `--font-sans` / `--font-mono` from Task 1. **Produces:** Geist as the UI family.

- [ ] **Step 1: Install Geist** (mirrors the existing `@fontsource-variable/inter`):

```bash
npm install @fontsource-variable/geist @fontsource-variable/geist-mono
```

Expected: added to `dependencies`. **If the registry is unreachable** (offline), skip this task, keep Inter, and flag it in the integration gate — the rest of the re-skin ships without the font swap.

- [ ] **Step 2: Swap the import** in `src/renderer/main.tsx`. Replace:

```ts
import '@fontsource-variable/inter/index.css'
```

with:

```ts
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
```

- [ ] **Step 3: Update the font stacks** in `src/renderer/tokens.css`:

```css
  --font-sans: 'Geist Variable', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace;
```

- [ ] **Step 4: Remove Inter** — drop `@fontsource-variable/inter` from `package.json` dependencies, remove `'Inter Variable'` from the stack (done in Step 3), then `npm install` to prune the lockfile.
- [ ] **Step 5: Verify** — `npm run typecheck && npm run build`. Expected: success. On device, UI text renders in Geist.
- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/renderer/main.tsx src/renderer/tokens.css
git commit -m "feat(reskin): swap UI font Inter -> Geist (+ Geist Mono)"
```

---

## Task 3: Gloss on primitives (buttons, inputs, Switch)

**Files:** Modify `src/renderer/styles.css` (buttons `~169-207`, fields `~441-459`).

**Interfaces — Consumes:** `--brand*`, `--signal*`, `--gloss`, `--glass-highlight`, `--accent-tint`, `--focus-ring`, `--fg`, `--on-signal`, `--surface-2`, `--hairline-strong` from Task 1.

- [ ] **Step 1: Secondary/ghost `.btn` — subtle glass sheen.** Replace the `.btn { … }` rule (`~169-182`) with:

```css
.btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline-strong);
  background: rgba(255, 255, 255, 0.04);
  background-image: var(--gloss);
  box-shadow: var(--glass-highlight);
  color: var(--fg);
  font-size: var(--text-sm);
  transition: border-color var(--motion-fast) var(--ease-standard),
              background-color var(--motion-fast) var(--ease-standard),
              box-shadow var(--motion-fast) var(--ease-out),
              transform var(--motion-fast) var(--ease-out);
}
```

- [ ] **Step 2: Hover lifts toward emerald.** Replace `.btn:hover { … }` (`~184`):

```css
.btn:hover { border-color: var(--signal); background-color: rgba(63, 190, 134, 0.08); }
```

(Leave `.btn:active { transform: scale(0.97); }` and the shared `:focus-visible { box-shadow: 0 0 0 3px var(--focus-ring); }` rules — they now use the emerald focus ring for free.)

- [ ] **Step 3: Glossy emerald primary.** Replace `.btn.primary` + its hover (`~196-202`):

```css
.btn.primary {
  background: var(--brand);
  background-image: var(--gloss);
  border-color: var(--brand-hi);
  box-shadow: var(--glass-highlight);
  color: var(--fg);
  font-weight: var(--weight-medium);
}
.btn.primary:hover {
  background-color: var(--brand-hi);
  border-color: var(--brand-hi);
  box-shadow: var(--glass-highlight), 0 0 0 3px var(--accent-tint), 0 4px 14px rgba(15, 107, 69, 0.45);
}
.btn.primary:active { background-color: var(--brand-press); }
```

(White `--fg` on `#0F6B45` = ~6.3:1 → AA pass. `.btn.danger`, `.btn.active` already re-tint via tokens; leave them.)

- [ ] **Step 4: Inputs keep the emerald focus ring.** The `.field input/select/textarea` block (`~441-459`) already uses `--surface-2` + `--hairline-strong` + `--signal` focus + `--focus-ring` → re-tints for free. **Verify only** — no edit unless the on-device check shows a warm remnant. `.switch.on` (`~1819`) already uses `--accent` (emerald) and the checkbox `accent-color: var(--accent)` (`~2087`) is emerald → verify, no edit.
- [ ] **Step 5: Reduced-motion.** Confirm the existing `@media (prefers-reduced-motion: reduce) { … .btn:active { transform: none; } }` block (`~2051-2052`) still covers `.btn` (it does — gloss uses color/shadow only, no new movement). No edit.
- [ ] **Step 6: Verify** — `npm run build`. Expected: success.
- [ ] **Step 7: Commit**

```bash
git add src/renderer/styles.css
git commit -m "feat(reskin): glossy emerald primary + glass-sheen secondary buttons"
```

---

## Task 4: Glass on modals + menus

**Files:** Modify `src/renderer/styles.css` (`.modal-backdrop` `~707`, `.modal` `~718`, `.topmenu-list` `~1737`, `.recent-prompts-list` `~1788`).

**Interfaces — Consumes:** `--glass-bg`, `--glass-blur`, `--glass-highlight`, `--elev-3`, `--hairline-strong` from Task 1.

- [ ] **Step 1: Backdrop — darken + subtle blur.** Replace `.modal-backdrop { background: rgba(0,0,0,0.55); … }` (`~710`) so the `background` line and a blur are:

```css
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
```

(keep the rest of `.modal-backdrop` — `position/inset/display/place-items/z-index/opacity/transition` — unchanged.)

- [ ] **Step 2: Modal panel — glass.** Replace the `.modal { … }` background/border/shadow lines (`~724-727`) with:

```css
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-highlight), var(--elev-3);
```

(keep `.modal`'s `width/max-height/display/flex-direction/overflow` unchanged. `--glass-bg` at 0.72 opacity keeps modal body text ≥ AA.)

- [ ] **Step 3: Top menu — glass.** In `.topmenu-list` (`~1737`) replace `background: var(--surface-2); border: 1px solid var(--hairline-strong); … box-shadow: var(--elev-2);` with:

```css
background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur)); -webkit-backdrop-filter: blur(var(--glass-blur)); border: 1px solid var(--hairline-strong); border-radius: var(--radius); box-shadow: var(--glass-highlight), var(--elev-3);
```

- [ ] **Step 4: Recent-prompts menu — glass.** In `.recent-prompts-list` (`~1788`) apply the same swap: `background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur)); -webkit-backdrop-filter: blur(var(--glass-blur));` and `box-shadow: var(--glass-highlight), var(--elev-3);` (keep border/radius/layout).
- [ ] **Step 5: Verify** — `npm run build`. Expected: success. On device: modals + both menus read as frosted obsidian glass with a top highlight; text stays legible.
- [ ] **Step 6: Commit**

```bash
git add src/renderer/styles.css
git commit -m "feat(reskin): purposeful glass on modals + menus"
```

---

## Task 5: Canvas material pass (obsidian-glass cards, emerald pulse, obsidian dot-grid)

**Files:** Modify `src/renderer/styles.css` (`.agent-node` `~336-350`), `src/renderer/canvas/OrgChart.tsx` (`~259`).

**Interfaces — Consumes:** `--surface-2`, `--glass-highlight`, `--elev-1/2`, `--hairline-strong`, `--signal`, `--accent`, `--accent-dim`, role tokens, `--canvas-dot`.

- [ ] **Step 1: Obsidian-glass card.** Replace the `.agent-node { … }` background/border/shadow lines (`~338-343`) with:

```css
  background: var(--surface-2);
  background-image: var(--gloss);
  border: 1px solid var(--hairline-strong);
  border-left: 3px solid var(--hairline-strong);
  border-radius: var(--radius);
  padding: var(--space-4) var(--space-4);
  box-shadow: var(--glass-highlight), var(--elev-1);
```

(keep the `transition`/`animation`/`animation-delay` lines. The role border-left colors `~352-360`, `.selected` emerald ring `~362-366`, and `.agent-node:hover` `~350` already re-tint via tokens — no edit.)

- [ ] **Step 2: Emerald run glow.** The run-state block (`~860-870`) + `@keyframes pulse` (`~882-889`) already use `--accent`/`--accent-dim` → now emerald for free. **Verify only.** Confirm `.agent-node.run-done` uses `--good` (emerald-adjacent) and `.run-error` uses `--danger` (red) — both re-tinted. No edit.
- [ ] **Step 3: Mirror the dot-grid color to React Flow.** In `src/renderer/canvas/OrgChart.tsx` line ~259, replace:

```tsx
      <Background gap={22} color="#322A4D" />
```

with (keep the mirror comment above it accurate):

```tsx
      {/* color mirrors --canvas-dot in tokens.css (React Flow can't read CSS vars) */}
      <Background gap={22} color="#1E2329" />
```

- [ ] **Step 4: Verify** — `npm run typecheck && npm run build`. Expected: success. On device: cards read as obsidian-glass tiles with a faint top sheen + role-tinted left edge; selected = emerald ring; running = emerald pulse; canvas dot-grid is cool obsidian (both the CSS `.canvas-wrap` layer and the React Flow overlay match).
- [ ] **Step 5: Commit**

```bash
git add src/renderer/styles.css src/renderer/canvas/OrgChart.tsx
git commit -m "feat(reskin): obsidian-glass canvas cards + emerald pulse + obsidian dot-grid"
```

---

## Task 6: Run view, terminals, top bar & the warm-hex sweep

The remaining hardcoded warm hexes (audited: run terminal, status pills, auth banner/pills, HITL badge/question, resume banner, handoff edges/legend, run-userrequest) that don't re-tint via tokens.

**Files:** Modify `src/renderer/styles.css`, `src/renderer/run/RunView.tsx` (`~64`), `src/renderer/terminal/TerminalPane.tsx` (`~25`).

- [ ] **Step 1: Obsidian terminals — the "all-layers" swap.** In `src/renderer/styles.css` replace every `background: #141019;` — `.terminal-dock` (`~557`), `.term-tab.active` (`~586`), `.term-tab-wrap:has(.term-tab.active)` (`~606`), `.run-output` (`~965`) — with `background: var(--surface-0);` (`#0B0C0E`).
- [ ] **Step 2: xterm JS themes (2 spots).** In `src/renderer/run/RunView.tsx` (`~64`) and `src/renderer/terminal/TerminalPane.tsx` (`~25`), replace:

```ts
theme: { background: '#141019', foreground: '#EAD7D1', cursor: '#DD99BB' }
```

with:

```ts
theme: { background: '#0B0C0E', foreground: '#F4F6F5', cursor: '#3FBE86' }
```

- [ ] **Step 3: Run status pills — obsidian-cooled triads.** Replace the 7 `.st-*`/`.run-pill.st-*` rules (`~813-853`) with (keeps phase-distinct hues — blue/steel/amber/cyan/emerald/red — but cools bg toward obsidian; **eyeball on device**, bump if a chip reads muddy):

```css
.st-planning,
.run-pill.st-planning { color: #BCD3F5; background: #16233A; border-color: #2C4670; }
.st-assigning,
.run-pill.st-assigning { color: #D4DEFB; background: #20263D; border-color: #3A4675; }
.st-working,
.run-pill.st-working { color: #F2D89B; background: #2E2611; border-color: #6E5A23; }
.st-reviewing,
.run-pill.st-reviewing { color: #A9E6DE; background: #10322E; border-color: #215048; }
.st-reflecting,
.run-pill.st-reflecting { color: #D4DEFB; background: #20263D; border-color: #3A4675; }
.st-done,
.run-pill.st-done { color: #B7EFCF; background: #0F3122; border-color: #1D6B45; }
.st-error,
.run-pill.st-error { color: #F3B7B7; background: #361717; border-color: #6E2E2F; }
```

(`.st-skipped` uses `--muted` — leave.)

- [ ] **Step 4: Run banner tints.** `.run-banner.success` (`~900`) + `.run-banner.failure` (`~901`) use rgba of the old good/danger hexes; retint to the new tokens' hues:

```css
.run-banner.success { background: rgba(79, 208, 138, 0.12); color: var(--state-good); }
.run-banner.failure { background: rgba(240, 106, 106, 0.12); color: var(--state-danger); }
```

- [ ] **Step 5: Auth banner (warm amber/red bg → obsidian).** Replace `.auth-banner` bg/text/border (`~1121-1123`) and `.auth-banner.auth-no-cli` (`~1127-1129`):

```css
  background: var(--surface-1);
  color: var(--orchestrator);
  border-top: 1px solid var(--hairline-strong);
```

```css
.auth-banner.auth-no-cli {
  background: var(--surface-1);
  color: var(--danger);
  border-top-color: var(--hairline-strong);
}
```

(The `.auth-pill` border hexes `#2f6a44`/`#806326`/`#80393a` at `~1097/1102/1106` are muted dark accents that harmonize with obsidian — leave, verify on device.)

- [ ] **Step 6: Handoff edge + legend gold → role token.** `.react-flow__edge.edge-handoff .react-flow__edge-path` (`~1546`) `stroke: #d6a44c;` → `stroke: var(--orchestrator);`. `.legend-line.handoff` (`~1770`) `border-top: 2px solid #d6a44c;` → `border-top: 2px solid var(--orchestrator);`.
- [ ] **Step 7: HITL badge + question + userrequest (warm plum/lavender → obsidian/emerald).** Replace `.hitl-badge` (`~1559-1574`) color lines:

```css
  background: var(--surface-2);
  color: var(--fg);
  border: 1px solid var(--accent);
```
```css
.hitl-badge:hover { background: var(--surface-hover); }
```

`.hitl-question` (`~1552-1553`): `background: var(--surface-1); border: 1px solid var(--hairline-strong);`. `.run-userrequest` (`~1576`): `color: var(--accent);`.

- [ ] **Step 8: Resume banner (warm olive → obsidian; badge → emerald).** `.resume-banner` (`~1688`): `background: var(--surface-2); border-bottom: 1px solid var(--hairline-strong);`. `.resume-badge` (`~1689`): `background: var(--accent); color: var(--on-signal);`.
- [ ] **Step 9: BrandMark** (`src/renderer/BrandMark.tsx`) already strokes `var(--accent)` → emerald for free. **Verify only, no edit.**
- [ ] **Step 10: Verify** — `npm run typecheck && npm run build`. Expected: success. On device: terminals are obsidian with an emerald cursor; no warm plum/amber/lavender splotch remains anywhere (top bar, run view, auth, HITL, resume, edges).
- [ ] **Step 11: Commit**

```bash
git add src/renderer/styles.css src/renderer/run/RunView.tsx src/renderer/terminal/TerminalPane.tsx
git commit -m "feat(reskin): obsidian terminals, retinted run/status/auth/HITL surfaces"
```

---

## Task 7: Integration gate + DESIGN.md

**Files:** Create `DESIGN.md` (root).

- [ ] **Step 1: Full verification gate.** Run and confirm all green:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Expected: typecheck 0 errors, lint 0 errors, **476 tests pass**, build succeeds. (`run-store.test.ts` has a known full-suite isolation flake — if it fails, re-run in isolation to confirm it's the pre-existing flake, not a regression: `npx vitest run src/renderer/run/... ` / the run-store test path.)

- [ ] **Step 2: Contrast spot-check.** Confirm the key pairs meet AA (use any contrast tool / quick manual check):
  - `--fg #F4F6F5` on `--surface-0/1/2` → ≥ 4.5:1 (body).
  - `--fg-muted #AAB2AF` on `--surface-1` → ≥ 4.5:1 (muted body).
  - `--fg #F4F6F5` on `--brand #0F6B45` (primary button) → ≥ 4.5:1.
  - `--accent #3FBE86` on `--surface-0` → ≥ 3:1 (UI/large green text + focus ring). Bump toward `#4CCB92` if it fails.
  - Role colors `#E6B23C` / `#8FA6E6` / `#B8C2CE` on `--surface-2` → ≥ 3:1 and obviously distinct from each other and from emerald.

- [ ] **Step 3: Write `DESIGN.md`** at repo root capturing the shipped system (impeccable format): the obsidian surface ramp, the two-step emerald ramp (brand-fill vs accent) + the "never `--brand` as on-black text / emerald = signal not a role" rules, role triad, material tokens (elevation/glass/gloss) + where glass is allowed (elevated overlays only), font (Geist), the two "can't-read-CSS-var" mirrors (xterm themes, React Flow Background), and AA + reduced-motion constraints. Keep it concise and reference `src/renderer/tokens.css` as the source of truth.
- [ ] **Step 4: On-device smoke (the real acceptance gate).** Launch the app and eyeball every hero surface for the new look + contrast: canvas cards (obsidian-glass + role edges + emerald select/pulse), a live run (obsidian terminals, status pills, narration, banners), modals + menus (glass), top bar + BrandMark (emerald), welcome/ProjectPicker (obsidian + emerald + glass card), buttons (glossy emerald primary, glass secondary), inputs/Switch (emerald focus/on). Note any warm remnant or contrast miss and fix in a follow-up commit. **This step needs the user** — hand off for the eyeball pass.
- [ ] **Step 5: Commit**

```bash
git add DESIGN.md
git commit -m "docs(reskin): DESIGN.md — obsidian & emerald token + material system"
```

---

## Self-review notes (spec coverage)

- Spec §1 token system → Task 1 (all names kept incl. legacy aliases; material tokens added).
- Spec §2 Geist → Task 2 (+ Geist Mono for terminals; Inter removed).
- Spec §3 gloss primitives → Task 3 (`.btn`, `.btn.primary`, inputs/Switch verified).
- Spec §4 glass modals/menus → Task 4 (backdrop blur + fallback dark bg).
- Spec §5 hero surfaces → Task 5 (canvas) + Task 6 (run view, terminals, top bar) + the full warm-hex sweep (status pills, auth, HITL, resume, handoff edges, run-userrequest) so no warm remnant survives.
- Spec §6 DESIGN.md → Task 7.
- Contrast (the #1 risk) → per-task verify + Task 7 Step 2 explicit AA spot-check; two-step emerald ramp holds the line on dark-green legibility.
- Reduced-motion → preserved (gloss = color/opacity only); confirmed in Task 3 Step 5.
- The two "can't-read-CSS-var" gotchas → Task 5 Step 3 (React Flow Background) + Task 6 Step 2 (xterm themes).
- No behavior/logic/IPC change → all tasks are CSS/token/font + 2 color-prop/theme literal edits + 1 import swap.
```
