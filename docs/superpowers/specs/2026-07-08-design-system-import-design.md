# Import & Enhance a Design System — Design

**Phase-3 feature (user-requested 2026-07-08, sibling to the design-preview gate).** Date: 2026-07-08. Status: approved, pre-implementation.

## Goal

Let a user **import an existing design system** (a self-contained HTML file — e.g. a Claude-made design system exported to `.html`) as the project's persistent design reference, so the build follows it and the creative team does **not** need to generate a new look. Optionally, have the **creative/design team enhance** the imported design (using the design skills), then **compare before/after** and adopt or discard (unless a headless toggle auto-applies).

When no design system is imported and the enhance flow is never used, behavior is **byte-for-byte** identical to today.

## Origin & relationship to the design-preview gate

Built after the design-preview gate (merge `a14ab25`). That gate *generates* a design preview during a run; this feature lets the user *bring their own* design system as a persistent, project-level artifact. Both write the same file — `<project>/design-preview.html` — which the build already reads. Importing a design system **skips the generate-gate** (you have a design). They are the two ways to establish the project's design: generate vs. import.

## Design decisions (all user-picked in brainstorm)

- **Format = a self-contained HTML file.** The build agents READ `design-preview.html` as a file (tokens, component markup, CSS motion, written notes), so a self-contained HTML captures everything that matters for a design *reference* (the iframe preview is secondary). External CDN/fonts are the only fidelity risk; the FAQ prompt steers the export to be self-contained.
- **Placement = a standalone project-level "Design system" button + modal** (not tied to a run). The imported design persists on the project.
- **Both halves this cycle** (import + enhance).
- **Enhance = a focused pass (Approach 1), not a spawned 7-agent run** — one design-capable agent call that channels the creative team's roles/perspectives and is **equipped with the full curated design-skill set** (see Skills). Deterministic, fast, reuses the design-preview generation seam.
- **Enhance direction = preset chips + free-text.**
- **Approval = before/after by default; a `autoApplyEnhancements` toggle auto-adopts (headless).**
- **A FAQ button** in the modal hands over the ready-to-paste extraction prompt for a self-contained export.

## Data model

- **`ProjectGraph.designSystem?: { fileName: string; addedAt: string; source: 'imported' | 'enhanced' }`** — persistent marker (absent ⇒ byte-for-byte). `fileName` is the original uploaded name (display only).
- **`<project>/design-preview.html`** — the live design the build reads (imported, or enhanced-adopted). Reuses the existing artifact + `readDesignPreview()` IPC.
- **`<project>/.ai-manager/design-enhanced.html`** — the transient enhanced *candidate*, kept separate so the current design is the "before" until the user adopts.
- **`ProjectSettings.autoApplyEnhancements: boolean`** (default `false`) — when true, an enhancement is adopted directly without the before/after gate.
- **`DESIGN_SKILLS: string[]`** (shared constant) — the curated design-skill names forced onto the enhance pass: `emil-design-eng`, `ui-ux-pro-max`, `impeccable`, `design-taste-frontend`, `high-end-visual-design`, `redesign-existing-projects`, `review-animations`. (These ship in `~/.ai-manager/skills-pack/skills/`; whatever is present resolves, the rest are ignored by the SDK.)

## Part A — Import

### UI
Top-bar **"Design system"** button (lucide `Palette`, next to Context/Env) → **`DesignSystemModal`**:
- **Upload** a `.html` file — reuse the Context-files upload pipeline: file picker + canvas/modal drag-drop via `webUtils.getPathForFile`. Validate extension `.html`/`.htm` and a size cap (mirror the context-file 25 MB cap).
- **Preview** — the imported HTML in a `srcdoc` iframe (`sandbox="allow-same-origin"`, same as `DesignPreviewModal`).
- **FAQ** button — a small panel with the copy-paste extraction prompt (below) + a "Copy" button + a one-line "why self-contained" note.
- **Remove** — clears the marker (and deletes `design-preview.html`).

### FAQ extraction prompt (shipped constant)
> "Produce ONE self-contained .html file of this design system: inline all CSS in a `<style>` tag, inline the icons as SVG and the fonts (or use a system-font stack), and include the color/type/spacing tokens, the component examples, the motion (CSS keyframes/transitions), and the written usage notes. Do NOT reference any external stylesheet, CDN, or font URL — everything must be inline so it renders and reads correctly offline."

### Main
- `importDesignSystem(sourcePath: string): Promise<ProjectGraph>` (project-store) — validate extension + size; copy the file to `<project>/design-preview.html`; set `graph.designSystem = { fileName: basename(sourcePath), addedAt, source: 'imported' }`; `saveGraph()` last.
- `removeDesignSystem(): Promise<ProjectGraph>` — clear `graph.designSystem`; delete `design-preview.html` (best-effort); `saveGraph()`.

### How it reaches the build
- **Gate-skip:** `buildOrchestratorGraph`'s `gate = getSettings().designPreview && !getGraph().designSystem`. With no import, `designSystem` is absent ⇒ `!undefined === true` ⇒ the condition is exactly today's; the generate-gate only skips when a design system is present.
- **Worker reference:** at run start, seed `designPreviewApproved = true` when `getGraph().designSystem` exists, so the existing approved-design worker-prompt line ("build the UI to match design-preview.html …") fires for imported/enhanced designs. No new prompt text.

## Part B — Enhance

### UI (in `DesignSystemModal`)
An **"Enhance with the design team"** button → a panel: **preset chips** (multi-select) — *Polish & refine · Modernize · Add motion & micro-interactions · Improve accessibility & contrast* — plus a **free-text** box. A "Run enhancement" action triggers the pass.

### The enhance pass (a standalone action, not a graph run)
`enhanceDesignSystem(directions: string[], note: string): Promise<void>` (new `main/engine/design-enhancer.ts`, mirroring `manifest-detector`/`role-drafter`: a one-shot `streamAgent` call, retry-once, `runAgent` seam for tests):
1. Read the current `design-preview.html` (the "before"); if none, error surfaced to the modal.
2. Run **one acting agent call** (as the orchestrator) with a pure `enhanceDesignPrompt(currentHtml, directions, note)`:
   - **Creative-team framing** (a `visionBias`-style block: "Approach this as a creative team — Creative Director for direction, Art Director for visual hierarchy, Visual Designer for execution, motion designer for micro-interactions — and apply your design-craft skills.")
   - The selected directions + free-text.
   - Instruction to **enhance the given design system** (keep its identity; improve craft) and **Write the result to `.ai-manager/design-enhanced.html`** as a **self-contained** HTML page (same no-external-CDN rule).
   - The current HTML embedded as the starting point.
3. **Forced design skills** (see Skills) so the pass has the full design toolkit regardless of the general skills-pack toggle.

### Before/after approval
After the candidate is written, the modal shows a **side-by-side comparison** — two `srcdoc` iframes: **Before (current)** = `readDesignPreview()`, **After (enhanced)** = a new `readEnhancedDesign()` IPC. Actions:
- **Adopt** → `adoptEnhancement()`: copy `.ai-manager/design-enhanced.html` → `design-preview.html`; set `designSystem.source = 'enhanced'`; delete the candidate; `saveGraph()`.
- **Discard** → `discardEnhancement()`: delete the candidate; keep the current design.

When **`autoApplyEnhancements`** is on, the pass adopts the candidate directly (no before/after) and the modal just reports the result.

## Skills (the design-craft toolkit for the enhance)

Every agent run already merges the skills-pack (`agent-runner.ts:174–178`), and the pack ships the design skills. To **guarantee** the design skills on the enhance pass even if the general pack is off, extend the runner seam:
- `StreamAgentOptions.extraSkillNames?: string[]` — when set, `streamAgent` additionally attaches `packSkillOptions(resolvePackPath(''), extraSkillNames)` (the pack plugin filtered to those skill names), merged via `mergeSkillOptions` with whatever it already assembled. **Unset ⇒ byte-for-byte** (skills logic unchanged).
- The enhance call passes `extraSkillNames: DESIGN_SKILLS`. The SDK filters to skills actually present, so a missing skill is simply ignored.

## Off-path / byte-for-byte

No `designSystem` marker + `autoApplyEnhancements` false (default) + no enhance call + no `extraSkillNames` ⇒ `buildOrchestratorGraph`, the worker prompt, `streamAgent`'s skill assembly, and every run are identical to today; `graph.json` gains no field. Same discipline as #9/#16/#the-gate.

## IPC / preload / RendererApi

New channels (mirror the `context:*` / `design-preview:read` seams):
- `designSystem:import` (path?) → `importDesignSystem` (path optional → main opens a `.html` file dialog, like `addContext`).
- `designSystem:remove` → `removeDesignSystem`.
- `designSystem:view` → the `designSystem` marker (+ whether `design-preview.html` exists).
- `designSystem:enhance` (directions, note) → `enhanceDesignSystem`.
- `designSystem:readEnhanced` → `.ai-manager/design-enhanced.html` text or `''`.
- `designSystem:adoptEnhancement` / `designSystem:discardEnhancement`.
Reuse `design-preview:read` for the "before". Preload bridge + `RendererApi` types for each.

## Testing

- **Pure** (`shared/design-enhance.ts.test`): `enhanceDesignPrompt` (creative-team framing + directions + self-contained rule; empty directions+note still valid); `DESIGN_SKILLS` well-formed; the design-system presence predicate.
- **Engine/store**: `importDesignSystem` copies to `design-preview.html` + sets the marker (+ extension/size rejects); `removeDesignSystem`; `buildOrchestratorGraph` skips the gate when `designSystem` present and is byte-for-byte when absent; run seeds `designPreviewApproved` from the marker; `enhanceDesignSystem` (runAgent seam) writes the candidate; adopt copies candidate→live + flips source; discard deletes candidate. `streamAgent` with `extraSkillNames` unset = byte-for-byte skill assembly (exact-equality); set = merges the pack-filtered skills.
- **Renderer**: no unit (house convention) → on-device smoke (import a .html; FAQ copy; preview; enhance with a preset; before/after; adopt/discard; auto-apply toggle).
- **Gates**: implementers typecheck + test; renderer tasks also lint; controller build.

## Files (indicative)

- `src/shared/types.ts` — `ProjectGraph.designSystem`, `ProjectSettings.autoApplyEnhancements`, IPC enum + RendererApi additions.
- `src/shared/design-enhance.ts` (+test) — `enhanceDesignPrompt`, `DESIGN_SKILLS`.
- `src/main/engine/project-store.ts` — `importDesignSystem`, `removeDesignSystem`, `readEnhancedDesign`, `adoptEnhancement`, `discardEnhancement`, `hasDesignSystem`/marker view.
- `src/main/engine/design-enhancer.ts` (+test) — `enhanceDesignSystem` (runAgent seam).
- `src/main/engine/agent-runner.ts` — `StreamAgentOptions.extraSkillNames` + merge in the skill assembly.
- `src/main/engine/nodes.ts` — `buildOrchestratorGraph` gate condition (`&& !designSystem`); run seeds `designPreviewApproved` from the marker (in the orchestrator drive / seedRunState).
- `src/main/ipc.ts` + `src/preload/index.ts` — the new channels.
- `src/renderer/DesignSystemModal.tsx` (new) + top-bar button in `App.tsx` + store actions.

## Out of scope (v1)

- **Non-HTML imports** (design tokens JSON, images, folders, direct tool API/connect) — HTML only; the agents read the source so it's robust. Direct-connect is a bigger tool-specific lift, deferred.
- **A spawned 7-agent enhancement run** (Approach 2) — deferred; Approach 1 delivers team-quality craft via the forced design skills + framing.
- **Cross-project / team-default design systems** (the "your team's projects use this by default" idea) — project-level only for v1.
- **Editing the imported HTML in-app** — upload/enhance/adopt only.
