# Obsidian & Emerald — Premium Re-skin

A ground-up **visual re-skin** of Orkestr: retire the warm-dark indigo/plum/rose identity for a **black + royal-green + white**, glossy, glass-layered look — "premium & crafted" (Apple/visionOS depth × Linear/Vercel crispness). Strategic direction is in `PRODUCT.md` (impeccable). This is the concrete visual system + how it's applied.

## Motivation

The user wants the tool to look **fancier** — glossier buttons and a richer overall look. After the restrained "calm conductor" arc completed, this is a deliberate pivot to a bolder, more premium aesthetic. It re-tints the whole app (via the token system) and adds glossy/glass materials.

## Decisions locked in brainstorming

- **Register:** product. **Personality:** premium & crafted (glossy via craft, not flash). **References:** Apple/visionOS (glass, layered depth, glossy highlights) + Linear/Vercel (crisp premium restraint). **Anti:** garish/over-the-top; generic-SaaS; heavy skeuomorphism.
- **Palette pivot:** primary **black**, secondary **royal green = Deep Racing Green (~`#0F6B45`)**, auxiliary **white**. Replaces warm indigo/plum/rose entirely.
- **Font:** switch UI from Inter → **Geist** (Vercel's geometric-premium sans).
- **Materials:** tasteful **gloss** on buttons; **purposeful glass** on elevated surfaces (not everywhere — impeccable bans glass-as-default).
- **Signature:** obsidian-glass agent cards on the canvas + an emerald "run is alive" glow.

## Architecture

The original Foundation aliased legacy token names, so **most of the app re-tints by editing `tokens.css` values alone**. The re-skin = (1) new token values + new material tokens, (2) the Geist font swap, (3) gloss/glass treatment on shared primitives (`.btn`, inputs, `.modal`, menus), (4) targeted material passes on the hero surfaces (canvas cards, dock/panels, run view, top bar). No behavior/logic/IPC change — pure presentation. Contrast is a first-class constraint throughout (AA), and `prefers-reduced-motion` stays honored.

### 1. Token system — `src/renderer/tokens.css`

Replace the palette; keep every existing token **name** (legacy aliases included) so consumers re-tint for free. All colors AA-checked against their usage.

**Obsidian surfaces (near-black, layered — NOT pure `#000`, so glass/depth reads):**
- `--surface-0` (app base / canvas): `#0B0C0E`
- `--surface-1` (panels, dock, top bar): `#121417`
- `--surface-2` (raised cards, inputs, modals): `#191C20`
- `--surface-hover`: `#22262B`
- `--surface-selected`: emerald-tinted raise (see accent)

**White (auxiliary) — type + hairlines:**
- `--fg`: `#F4F6F5` (crisp near-white, not harsh pure `#FFF`)
- `--fg-muted`: `#AAB2AF` (AA on all surfaces)
- `--fg-dim`: `#727B77`
- `--hairline`: `rgba(255,255,255,0.08)` · `--hairline-strong`: `rgba(255,255,255,0.15)`

**Emerald ramp (the accent — deep green identity + a lighter step for legibility on black):**
- `--brand` / core fill (glossy primary button base, brand mark): `#0F6B45` (Deep Racing Green)
- `--brand-hi` / hover: `#128052` · `--brand-press`: `#0B5638`
- `--accent` = the **on-black legible** emerald for focus rings, green text, active/running indicators, small accents: `#3FBE86` (AA as large/UI; verify for body-size, bump toward `#4CCB92` if needed)
- `--accent-tint`: `rgba(63,190,134,0.14)` (glows, active row tints, focus halo)
- **Principle:** emerald = **action / interactive / run-state** (the old "rose = signal, never a role color" rule carries over — emerald is signal, not a role color).

**Role colors (canvas) — kept as a distinct triad, retuned for obsidian + kept clearly separate from emerald-action:**
- orchestrator (gold): `#E6B23C` · manager (periwinkle/steel): `#8FA6E6` · worker (silver-slate, moved OFF teal so it can't be mistaken for emerald-action): `#B8C2CE`
- role tint rgba tokens updated to match. *(Exact role hues are a build-time tune + on-device distinctness check — this is the one sub-area to eyeball; goal: three obviously-different roles, none reading as "the green action color.")*

**Semantic:** `--state-good` = an emerald-adjacent green distinct enough from the brand (or reuse `--accent` — success and brand green harmonize; fine); `--state-danger` = a red tuned for black (`#F06A6A`). Keep as separate tokens.

**Materials (new tokens):**
- Elevation shadows (soft, dark, layered): `--elev-1/2/3` (e.g. `0 1px 2px rgba(0,0,0,.4)` → `0 12px 40px rgba(0,0,0,.55)`).
- Glass: `--glass-bg: rgba(18,20,23,0.72)`, `--glass-blur: 16px`, `--glass-highlight: inset 0 1px 0 rgba(255,255,255,0.07)`.
- Gloss sheen (button top-highlight gradient): `--gloss: linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0) 45%)` (a *lightening* sheen overlay — NOT gradient text).
- Radii: keep the existing scale (maybe +1–2px softer on large surfaces for a premium feel — tune in build).

### 2. Font swap — Geist

- Add dep `@fontsource-variable/geist` (mirrors the existing `@fontsource-variable/inter`); import the variable CSS in the renderer entry; set the `--font`/body stack to `'Geist Variable', system-ui, …`. Remove the Inter import + dependency once Geist is in and verified.
- Optional (nice, in-scope-if-cheap): use **Geist Mono** for the run terminal / code `<pre>` surfaces (`@fontsource-variable/geist-mono`) in place of the generic `ui-monospace` stack. If it complicates the xterm theme, keep `ui-monospace` and defer.

### 3. Gloss on primitives — `src/renderer/styles.css`

- **`.btn.primary` (emerald, glossy):** deep-racing-green fill + the `--gloss` sheen overlay (top highlight) + `--glass-highlight` inset + a soft emerald outer glow on hover (`box-shadow` using `--accent-tint`); `:active` keeps the existing `scale(0.97)` press + sheen dip. White text (AA on `#0F6B45`).
- **`.btn` (secondary/ghost):** subtle glass — translucent white fill (`rgba(255,255,255,0.04)`), hairline border, faint top sheen; hover lifts fill + border toward emerald; `:focus-visible` = emerald focus ring (`--accent`).
- Inputs/selects/textarea: obsidian fields (`--surface-2`), hairline border, emerald focus ring. Checkboxes/`Switch`: emerald "on".
- Motion (emil): the gloss sheen/glow transitions on hover/press are crisp (`--ease-out`, ~120–160ms), reduced-motion drops transforms/keeps color.

### 4. Glass on elevated surfaces (purposeful, not default)

- **Modals** (`.modal` / `.modal-panel`) + **menus** (`.topmenu-list`, `.recent-prompts-list`): glass background (`--glass-bg` + `backdrop-filter: blur(var(--glass-blur))`) + `--glass-highlight` top edge + `--elev-3`. This is the visionOS layered-glass feel, on genuinely-elevated surfaces only.
- **Dock / panels / top bar:** obsidian surfaces with a subtle top hairline-highlight; glass reserved for overlays. (Avoid glass on everything — impeccable ban.)
- Backdrop: modal backdrop darkens + very subtle blur.

### 5. Hero surfaces — targeted material passes

- **Canvas agent cards** (the signature): obsidian-glass tiles — near-black glassy fill, hairline highlight, soft elevation; **role chip** in its (retuned) role color; **selected** = emerald ring; **running** = emerald glow pulse (retint the existing run-pulse to emerald). Warm dot-grid → a cool obsidian dot-grid (retint `--canvas-dot`, and mirror to the React Flow `<Background color>` prop — the known two-places gotcha).
- **Run view:** status pills + narration retinted to the obsidian/emerald world; the warm terminal (`#141019`) → an obsidian terminal (`#0B0C0E` bg, `#F4F6F5` fg, emerald cursor) — update both xterm themes + the `.run-output`/`.terminal-dock`/`.term-tab.active` layers (the all-layers gotcha).
- **Top bar / BrandMark:** BrandMark stroke → emerald; top-bar surface obsidian.
- **Welcome/ProjectPicker:** obsidian + emerald identity; picker card as glass.

### 6. DESIGN.md

At the end, write a root `DESIGN.md` (impeccable format) capturing the shipped token system + material rules, so impeccable and future work stay on-brand.

## Data flow / behavior

None. Pure CSS/token/font change. No store/IPC/engine/component-logic edits (className/markup only where a surface needs a material hook).

## Error handling / edge cases

- **Contrast (the #1 risk):** deep racing green is dark — never use `--brand` as text/icon on black; use `--accent` (lighter emerald) for on-black green. Verify AA for all body text, muted text, green accents, white-on-emerald buttons, and role colors. Bump values if close.
- **`backdrop-filter` performance/support:** Electron/Chromium supports it; keep blur ≤ ~18px (Safari-style cost) and use glass only on the few elevated surfaces. Provide a solid-ish fallback bg so a failed blur still reads.
- **Role-color distinctness:** verify the three roles are obviously different from each other AND from emerald-action (on-device).
- **Reduced motion:** gloss glows/sheen use color/opacity transitions (kept) — no new movement gated behind motion.
- **xterm themes** are JS objects (can't read CSS vars) — hardcode the obsidian hex in both `RunView.tsx` and `TerminalPane.tsx`, mirroring `--canvas-dot`→React-Flow.

## Testing

Presentational; no pure logic to extract, no component-test harness → **no new automated tests**. Verification: full existing suite green (476) + `typecheck` + `build` + **`npm run lint`** (0 errors) + **on-device smoke** (the real acceptance gate for a re-skin — every surface eyeballed for the new look + contrast). Where feasible, do a quick contrast check on the key pairs during build.

## Decomposition preview (for the plan)

~7 tasks: (1) tokens.css re-skin (palette + material tokens, keep aliases); (2) Geist font swap; (3) gloss primitives (`.btn`/inputs/Switch); (4) glass on modals + menus; (5) canvas material pass (obsidian-glass cards + emerald run-glow + obsidian dot-grid); (6) run view + top bar + welcome retint (incl. obsidian terminals, all layers); (7) integration gate (typecheck/test/lint/build) + DESIGN.md + on-device smoke. Contrast verified within each task.

## Risks / edge cases

- **It's a full re-skin** — the biggest visual change since the original overhaul. The token-alias architecture keeps it tractable, but every surface must be eyeballed; expect a real on-device smoke pass.
- **Black + green is an AI-default look if done flat** — we avoid that via the *deep jewel* green (not acid), white as a true third role, and glass/gloss depth. Keep checking it doesn't read generic.
- **Contrast with a dark green** is the recurring trap — the two-step emerald ramp exists specifically for this; hold the line on AA.
- Scope creep into re-laying-out surfaces (this is re-color + materials, NOT re-layout — the layout work is already done).
