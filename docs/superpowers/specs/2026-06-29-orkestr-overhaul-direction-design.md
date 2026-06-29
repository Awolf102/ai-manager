# Orkestr — Visual + UX Overhaul: Direction & Decomposition

**Date:** 2026-06-29
**Status:** Design direction approved. This is the umbrella spec for the Phase-2 overhaul/rebrand. It is intentionally NOT a per-screen design — it locks the brand direction (voice + token system) and decomposes the work into sub-projects. Each sub-project below gets its own brainstorm → spec → plan → build cycle.

---

## 1. Goal

Turn the generic-looking dark Electron tool "AI Manager" into **Orkestr** — a cohesive, intentional, "polished-not-AI-slop" product with a shared visual language, a sensible information architecture, and several new capabilities. The app must stay usable at every step; the overhaul ships as an ordered series of sub-projects, not one big-bang rewrite.

Visual *execution* (pixels, per-screen layouts) happens later in each sub-project using the design skills + live iteration. This spec sets direction and structure only.

---

## 2. Brand direction

### 2.1 Name & identity
- **Display name:** `Orkestr` everywhere visible (vowel-dropped "orchestra"; *orkester* = Danish for orchestra — it fits a tool that conducts a team of agents).
- **Internal identifiers stay stable:** data dirs `~/.ai-manager/` and per-project `.ai-manager/` are unchanged, so existing projects, checkpoints, and skills need no migration. The rebrand is a visible-string swap only.
- **Wordmark/logo direction (hand-off note for a designer, not final art):** a calm, lowercase-leaning `Orkestr` wordmark; the mark evokes a conductor's gesture — a single confident arc / upbeat / baton stroke — rendered in the rose/cream signal against the deep-indigo base.

### 2.2 Voice — "calm conductor"
Composed, confident, precise. Minimal copy that gets out of the way; the orchestra metaphor expressed as *composure*, not whimsy. This tone governs button labels, field labels, empty states, error copy, the FAQ/"how to prompt" guide, and the plain-English run narration. Reference feel: Linear / Things — quiet precision, never chatty, never cute.

### 2.3 Token system — "refined warm-dark"
A warm-dark theme. Depth comes from layered surfaces + hairline borders — **no gradients, no glassmorphism, no emoji-as-UI**. A true, restrained type scale and spacing scale. Restraint is the anti-slop principle: the bright accent appears sparingly; deep indigo + plum do the quiet heavy lifting.

**Core palette (locked, user-supplied):**

| Token role | Hex | Use |
| --- | --- | --- |
| Base / canvas background | `#1F1A38` (deep indigo) | App background, canvas, deepest surface |
| Elevated surface / hover | `#7B506F` (plum) | Panels, raised cards, hover/secondary states (tinted/darkened as needed for layering) |
| Signal / accent | `#DD99BB` (rose) | Primary actions, focus rings, selection, links — **used sparingly** |
| Foreground text | `#EAD7D1` (pale blush cream) | Primary text on dark |
| Muted text / dividers | `#DBCDC6` (warm greige) | Secondary/muted text, subtle dividers |

Plum and indigo will be expanded into a small tint/shade ramp during Foundation execution (e.g. 2–3 elevation levels between `#1F1A38` and `#7B506F`); the five hexes above are the anchors. Contrast (text on every surface, focus visibility) is verified during Foundation.

**Semantic state colors:** success/green and danger/red are retained as distinct semantic tokens, tuned to read correctly against the warm-dark surfaces (not part of the brand five).

**Motion:** restrained and intentional — short, eased transitions that reinforce hierarchy (panel open/close, selection, run state changes). No decorative/bouncy motion. Specific curves/durations are set in Foundation.

### 2.4 Agent role colors
The three role colors are the canvas's primary chroma and must stay legible and distinct from the rose signal:
- **Orchestrator:** gold `#f0b54a` — **keep** (pops on indigo).
- **Worker:** teal `#4fd1c5` — **keep** (cool contrast on plum/indigo).
- **Manager:** **re-map off lavender** (`#b08cff` clashed with the plum chrome + rose signal). New direction: a distinct **cool periwinkle/blue**, clearly bluer than the rose. Starting value `#8EA2F0` (tunable in Foundation); it must remain visibly separate from both the rose signal and teal worker.

The rose signal is reserved for interactive chrome (actions/focus/selection) and is never used as a role color, so role membership and interactivity never get confused.

---

## 3. Decomposition into sub-projects

Seven units. **0** is a foundation; **1** is the structural shell everything re-homes into; **2–6** are surfaces. Each is an independent brainstorm → spec → plan → build cycle.

### 0 · Foundation (design system)
The CSS token system (color ramp, type scale, spacing scale, elevation, radius, motion) + a small set of restyled shared primitives: **Button, Input/Textarea, Modal shell, Panel chrome, Badge, Toast/notification**. Includes the Orkestr rebrand string swap and the warm-dark palette + re-mapped manager color. The **single Toast/notification primitive lands here** — it is the mechanism for the "one non-blocking error surface" criterion that later surfaces wire into. No new screens; everything depends on this.

### 1 · App shell + panel system + top-bar IA
- **Preset dock zones + resize:** named regions — left rail, right inspector, bottom dock — each resizable by dragging its divider and collapsible; the canvas always holds center. A couple of placement swaps (inspector left/right, dock bottom/right). Layout persists per project.
- **Top-bar IA pass:** group + label today's crowded icon-only row (switch project, history, export/import, team sync ↑/↓, context, settings, add agent); make actions findable.
- **FAQ / "how to prompt" button:** a question-mark icon button to the **left of the bold app-name header**, opening a short guide on prompting the tool well.
- **Disambiguate the two "Run" buttons** (full-team vs per-node terminal) and resolve "opening a terminal hides the live run."

### 2 · Run experience
- **Narration ↔ terminal as toggle tabs at full height** — replace today's stacked vertical split; click to view either one full-height. Keep the History tab + its AI overview in the dock as-is.
- **"Run complete" success state** that renders `run.final` in the live run (today only History shows it; live success is invisible while failure is loud).
- **Per-run error surfacing** via the Foundation Toast — fix `GoalBar` "Run" failing silently and runs that fail while on another dock tab showing nothing.

### 3 · Canvas
- **Octopus / pyramid auto-layout** (replaces place-on-a-line): orchestrator top-center; workers wired directly to the orchestrator sit around its top arch; managers in a horizontal row below with the orchestrator centered over them; each manager's workers fan out below, **staggered** (alternating higher/lower between adjacent teams) so cards never collide. Auto-sort on team change; allow manual nudges; preserve report-tree curved-dashed edges, edge-ordering, and lateral handoff edges. (Reference screenshot drives visual execution.)
- **Node-card redesign** on the new tokens + role colors.
- **Edge legend + coach-marks** making report-vs-handoff edges and edge ordering discoverable; **enable-on-gesture** for handoffs (drawing a handoff edge offers to turn the feature on).

### 4 · Goal & prompt
- **Focus-to-expand / blur-to-collapse** on the goal textarea (it already auto-grows as you type; this adds expand-on-focus to read/edit the whole prompt, collapse on blur).
- **Quick-reuse past-prompts picker:** a lightweight select-and-insert picker that drops a previous goal back into the textbox, each shown as a **short auto-generated label** (a few words: what it added/changed/removed) — not the full text. In addition to the History tab + AI overview (those stay).

### 5 · Settings & gated features
- **Grouped Settings** into **Safety / Cost / Review / Team** sections with **cost hints** (e.g. on `autoAssignModels`, `adaptiveEffort`).
- **One unified permission concept** — collapse the per-agent permission dropdown (a silent no-op during orchestrated runs, overridden by `actingMode`) into a single concept; **never show raw SDK enum strings**.
- **Real on/off toggles** for the gated features (`maxReplans` / `maxHandoffs` / `maxUserRequests`, default 0 = off) so copy matches behavior, with **enable-on-gesture** where natural.

### 6 · Context
- **Unify into one Context panel** with two kinds:
  - **Attached files** — copied into `.ai-manager/context/` and injected into prompts (today's behavior; good for images/specs; snapshot persists if the source changes).
  - **Referenced folders** — a path the agents **read on demand** with their file tools; scales to whole codebases; nothing copied. This is the "point the team at a folder" feature.
- **Per-agent/role scoping:** every item defaults to all agents; an advanced control scopes it to chosen nodes/roles (e.g. only web-developer / software-engineer / task-manager nodes).
- This is the one mostly-*new* sub-project; the rest are reshape + restyle.

---

## 4. Ship order

Foundation and Shell are non-negotiably first — everything else re-homes into the new shell. Surface order is **pain-first** (fix the loudest audit complaints earliest, keep the tool feeling better every cycle):

**0 Foundation → 1 Shell + IA → 2 Run experience → 3 Canvas → 4 Goal/prompt → 5 Settings & gated → 6 Context.**

---

## 5. Deferred-in audit UX criteria (acceptance criteria, mapped)

The 2026-06-27 audit (`docs/audits/2026-06-27-tool-audit.md`) flagged UX Importants deliberately left for the overhaul because it rebuilds these surfaces. Each must be satisfied by its sub-project:

| Audit item | Owning sub-project(s) |
| --- | --- |
| #28 One non-blocking error surface (toast/notification); fix silent `GoalBar` "Run" failure | Foundation (Toast) + Run experience (wiring) |
| #29 "Run complete" success state + render `run.final` live | Run experience |
| #21 One permission concept; no raw SDK enum strings | Settings & gated |
| #32 Real on/off toggles for replans/handoffs/user-requests; enable-on-gesture | Settings & gated (+ Canvas for handoff edges) |
| #33 IA: two identical Run buttons, terminal hides live run, undiscoverable edge semantics, icon-only top bar | Shell + IA (top bar, run buttons) + Canvas (edge legend/coach-marks) |
| #34 Grouped Settings (Safety/Cost/Review/Team) + cost hints | Settings & gated |

**Not folded in:** the audit's security/data-loss UX (delete-confirms #8/#31, Full-auto danger styling #9) is owned by the separate remediation cycles U1 + S1 (`docs/audits/2026-06-27-remediation-cycles.md`), not this overhaul.

---

## 6. Out of scope (this phase)

- **Light theme** — deferred. The token system should not actively *prevent* a later warm-light theme, but warm-dark is the only theme we build now.
- **Command palette / keyboard shortcuts**, **first-run/empty-state pass** — known optional adds, intentionally left out to keep the overhaul focused.
- **Per-screen visual designs** — produced inside each sub-project's own cycle, not here.

---

## 7. Success criteria for the overhaul

1. Every screen reads as one product (shared tokens + primitives), not independently styled surfaces.
2. The warm-dark Orkestr palette and voice are applied consistently; nothing reads as generic-AI-blue/dark-dashboard slop.
3. All deferred audit UX criteria in §5 are satisfied by the end of their owning sub-projects.
4. The app stays usable after every sub-project ships (no broken intermediate states).
5. Internal data dirs and existing projects/checkpoints/skills keep working without migration.
