# Orkestr — Design System

**Identity: Obsidian & Emerald.** A premium, crafted dark look — near-black obsidian surfaces, a two-step emerald ramp, white type, tasteful gloss on buttons, and purposeful glass on elevated overlays. Fancy through *craft and correct invisible detail*, not flash. See `PRODUCT.md` for the strategic direction.

**Source of truth:** `src/renderer/tokens.css`. Every color/material is a CSS custom property; legacy alias names map onto the semantic tokens so the whole app re-tints from that one file. Consume tokens — do not hardcode hex (the only exceptions are the two "can't-read-CSS-var" mirrors below).

## Palette

### Obsidian surfaces (layered near-black — never pure `#000`, so depth/glass read)
| Token | Value | Use |
|---|---|---|
| `--surface-0` | `#0B0C0E` | app base, canvas, terminals |
| `--surface-1` | `#121417` | panels, dock, top bar |
| `--surface-2` | `#191C20` | raised cards, inputs, modals (solid) |
| `--surface-hover` | `#22262B` | hover raise |

### White (auxiliary) — type + hairlines
`--fg #F4F6F5` (body, ~15–18:1 on surfaces) · `--fg-muted #AAB2AF` (~8:1) · `--fg-dim #727B77` · `--hairline rgba(255,255,255,.08)` · `--hairline-strong rgba(255,255,255,.15)`.

### The two-step emerald ramp
Emerald is **signal — action / interactive / run-state — never a role color.** It comes in two steps that must not be confused:

- **Accent (light, on-black legible)** — `--signal` / `--accent` = `#3FBE86` (8.3:1 on obsidian). Borders, focus rings, green text, active/running indicators, small accents, Switch/checkbox "on". Hover `--signal-hover #5AD6A0`, press `--signal-press #2FA372`, tint `--signal-tint`/`--accent-tint`, focus halo `--focus-ring`.
- **Brand fill (deep racing green)** — `--brand #0F6B45` (+ `--brand-hi #128052`, `--brand-press #0B5638`). **Fill only**, always with white `--fg` text (6.0:1). This is the glossy primary button and the brand mark.

> **Rule:** never use `--brand` as text/icon on black — it fails contrast. On-black green is always `--accent`. `--on-signal #07130D` is the dark text used on a *light-emerald* fill (e.g. segmented-control active).

### Agent role colors (canvas only — a distinct triad, all clearly ≠ emerald-action)
`--orchestrator #E6B23C` (gold) · `--manager #8FA6E6` (periwinkle/steel) · `--worker #B8C2CE` (silver-slate). Each has a matching `*-tint` at 0.14 alpha for icon chips. All ≥7:1 on `--surface-2` and visually distinct from each other and from emerald.

### Semantic states
`--state-good #4FD08A` (emerald-adjacent success, distinct from the deep brand) · `--state-danger #F06A6A` (red tuned for black). Never rely on color alone — pair with a ✓/✗ mark or icon (run banners, status pills already do).

## Materials

- **Elevation** (soft, dark, layered): `--elev-1 → --elev-3` (`0 1px 2px/.40` → `0 12px 40px/.55`).
- **Gloss** (button/card top-highlight sheen — a *lightening* overlay, NOT gradient text): `--gloss: linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,0) 45%)`. Applied over the fill via `background-image`.
- **Glass** (frosted overlay): `--glass-bg rgba(18,20,23,.72)` + `backdrop-filter: blur(--glass-blur /*16px*/)` + `--glass-highlight` (inset top edge) + `--elev-3`. Blur stays ≤18px; the bg is opaque enough to hold AA text if blur fails.

### Where each material is allowed
- **Gloss:** `.btn`, `.btn.primary`, `.agent-node`. A subtle sheen, not literal 3D plastic.
- **Glass:** genuinely-elevated overlays only — `.modal`, `.topmenu-list`, `.recent-prompts-list`, and a 2px backdrop blur. **Not** on the dock/panels/top bar/cards (obsidian solids there). Glass-as-default is banned.

## Typography

`--font-sans: 'Geist Variable', system-ui, …` (Vercel's geometric-premium sans). `--font-mono: 'Geist Mono Variable', ui-monospace, …` for terminals and code `<pre>`. Loaded via `@fontsource-variable/geist` + `-geist-mono` in `src/renderer/main.tsx`.

## The two "can't-read-CSS-var" mirrors

Some libraries take JS/props, not CSS vars — keep these in sync with the tokens by hand:
1. **xterm themes** (`RunView.tsx`, `TerminalPane.tsx`): `{ background: '#0B0C0E', foreground: '#F4F6F5', cursor: '#3FBE86' }` — mirrors `--surface-0` / `--fg` / `--accent`.
2. **React Flow `<Background color>`** (`OrgChart.tsx`): `#1E2329` — mirrors `--canvas-dot`.

## Constraints

- **Contrast: AA.** Body text ≥ 4.5:1, large/UI ≥ 3:1. All shipped pairs verified (white-on-brand 6.0:1, accent-on-obsidian 8.3:1, roles ≥7:1). Bump toward `#4CCB92` if a future accent tweak drops the emerald below 3:1.
- **`prefers-reduced-motion`:** honored throughout. Gloss glow/sheen use color/opacity transitions only — no new movement is gated behind motion. Existing reduced-motion blocks (entrance, pulse, modal, banner) stay intact.
- **Full APG accessibility** (keyboard tabs/menus/dividers/radiogroups, roles/states, focus management, canvas labels) is shipped and must stay intact through visual changes.
- **This is a re-color + materials system, not a layout system.** Re-skin work re-tints and adds gloss/glass; it does not re-lay-out surfaces (that work is already done).
