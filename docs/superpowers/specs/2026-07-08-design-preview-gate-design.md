# Design-Preview Approval Gate — Design

**Phase-3 feature (user-requested 2026-07-08, after the Ferrum dogfood run).** Date: 2026-07-08. Status: approved, pre-implementation.

## Origin & goal

In a real large-team build (Ferrum, a Rust learning platform), a visual designer *organically* produced a self-contained HTML "design system" preview page — palette, type scale, components, app-shell — and the user loved it: *"If it did that for every app, it would be amazing."*

**Goal:** make that experience a first-class, opt-in tool feature. When enabled, early in a build the run **produces a self-contained brand/style HTML preview, pauses, and shows it to the user in an iframe**; the user **approves** (build proceeds using the approved design) or **requests changes** (the preview is regenerated and re-shown). A separate toggle lets a curated, de-branded structural guide steer the preview's *format*.

When both new settings are off, behavior is **byte-for-byte** identical to today (same discipline as #9/#16).

## Design decisions (all user-picked in brainstorm)

- **Standalone gate, no team rework.** Not tied to the shipped `visionMode` (which means "pure creative project, no engineering" — the wrong fit; Ferrum was a normal mixed design+engineering team). The gate produces the preview itself regardless of team shape, so it works for any app build.
- **Generation = a dedicated gate node** running one focused agent call (the orchestrator — always present), not a reliance on the team happening to include a designer.
- **Approval UX = approve, or request-changes → regenerate** (a revision loop), not approve/reject-only and not live in-iframe editing (a v2, needs a bidirectional channel the runtime lacks).
- **Inspiration guide = a de-branded FORMAT/structure exemplar** — teaches section structure + token-driven, self-contained approach only; the generator chooses fonts/colors/mood to fit *this* project's domain (art-shop → expressive; B2B SaaS → minimal). Styles never carry over from the exemplar.
- **Approved preview is a real artifact** at `<project>/design-preview.html` (keepable, like Ferrum's `design-system/preview.html`), not hidden in `.ai-manager/`.
- **Rendering via `srcdoc`** (read file → inline), not a localhost serve.

## Settings (2 new, both default `false` ⇒ byte-for-byte)

On `ProjectSettings` (`src/shared/types.ts`) + `DEFAULT_SETTINGS`:
```ts
/** when true, the run pauses early to show a design-system preview for approval before building */
designPreview: boolean            // default false
/** when true, inject the shipped de-branded structural guide into the preview generator (only meaningful when designPreview is on) */
usePreMadeInspirationGuide: boolean  // default false
```
UI: a new **"Design preview"** `SettingSection` in `SettingsModal.tsx` with two `Switch`/`SettingRow`s. The `usePreMadeInspirationGuide` control is disabled (via the existing `gated-control` pattern) unless `designPreview` is on. Both mirror the `visionMode` toggle exactly.

## The gate node + graph seam

New `designPreviewGateNode(state, io, eng)` in `nodes.ts`, following the existing node shape (returns a `NodeResult` with `patch`/`goto`/`interrupt`).

`buildOrchestratorGraph` wires it **conditionally** on `getSettings().designPreview`:
- **off:** edges include `route → execute` (today's map, untouched).
- **on:** `route → designPreviewGate`, `designPreviewGate → execute`.

Conditional wiring (rather than an always-present node that no-ops when off) is what preserves byte-for-byte: with the setting off, the node set, edge map, and checkpoint transitions are exactly today's. The gate reuses the generic `graph.ts` interrupt/resume mechanism (a node returning `{ interrupt }` halts the run, checkpoints, and `resumeGraph` re-enters the same cursor with `state.resumeInput`) — **no change to `graph.ts` or the resume plumbing.**

Placement (after `route`, before `execute`) means the plan/task breakdown already exists and the approved design is available when the build (`execute`) begins.

## Preview generation

On entry (not resuming), the gate runs **one focused acting agent call** via `eng.runAgent` as the **orchestrator** (always present; capable). The prompt is a new pure builder `designPreviewPrompt(goal, guide?)` (in `src/shared/design-preview.ts`) instructing the agent to **Write one self-contained HTML page to `<project>/design-preview.html`** containing: brand direction → color palette → type scale (with px/weight/tracking/line-height specs) → key components → an app-shell mock. Two hard rules in the prompt:

1. **Self-contained.** Inline CSS; system-font stack or embedded fonts; **no external CDN / `@import` / remote fonts** — the production CSP (`default-src 'self'`) blocks external subresources in the iframe, so an external font would silently fall back. (This is exactly the trap in Ferrum's own `@import` of Google Fonts.)
2. **Domain-fit visual direction.** Choose fonts/colors/mood suited to *this* goal's domain, not a fixed style.

The gate call runs in **acting mode** (it must use the `Write` tool). It is a normal `eng.runAgent` call, so a non-`claude-sdk` harness (future) dispatches through the same seam. The prompt scopes the agent to produce **only** the preview file (no other edits, no starting the build).

### Error handling (fail-open)

If generation does not produce `design-preview.html` (agent error, or it wrote nothing), the gate **logs and proceeds to `execute`** — it never blocks or breaks a build on a preview failure. This mirrors the best-effort, double-walled posture of the auto-sync/narration paths. (The user simply gets no preview that run, as if the setting were off for that run.) A generation call that throws is caught the same way.

### Inspiration guide (when `usePreMadeInspirationGuide` on)

`src/shared/design-preview.ts` exports a curated constant `INSPIRATION_GUIDE` — a **compact, de-branded structural exemplar** (the section layout + a small self-contained skeleton + principles: token-driven, self-contained, choose domain-appropriate style). It is injected into `designPreviewPrompt` with an explicit instruction to **adopt its STRUCTURE and token-driven, self-contained approach, but NOT its colors/fonts** — pick a visual direction that fits the goal. When the setting is off, no injection and the prompt is byte-identical to the guide-off branch (default parameter `guide = ''`, no trailing prose — the `visionMode` prompt-bias convention).

## Pause → approve / request-changes → regenerate

After generation the gate reads the produced file's existence and returns:
```ts
return {
  patch: { phase: 'design-preview', designPreviewIteration: n },
  interrupt: { kind: 'design-preview', prompt: 'Review the design preview', payload: { previewPath, iteration: n } }
}
```
The generic driver halts the run (`status: 'interrupted'`, checkpoint). Renderer `applyOrchestration('interrupt')` gains a `'design-preview'` branch alongside `ask-user`/`follow-through`, populating `run.pendingInterrupt = { kind: 'design-preview', previewPath, iteration }`.

A new **`DesignPreviewModal.tsx`** shows when `run.pendingInterrupt.kind === 'design-preview'`. It reads the file (see Rendering) and offers:
- **Approve** → `resumeRun(runId, { decision: 'approve' })`.
- **Request changes** + a free-text note → `resumeRun(runId, { decision: 'changes', feedback })`.

On resume the gate node re-enters and reads `state.resumeInput`:
- `{ decision: 'approve' }` → mark approved (persist a flag on `RunState`, e.g. `designPreviewApproved: true`), `goto: 'execute'`.
- `{ decision: 'changes', feedback }` → re-run the generator with `feedback` appended to the prompt, rewrite `design-preview.html`, increment iteration, and **return another `interrupt`** (re-pause). Human-in-the-loop bounds the loop; `iteration` is tracked for display only.

**No runtime change is needed for the object-shaped resume:** `resumeInput` is already typed `unknown` end-to-end (`IPC.resumeRun(runId, answer?: unknown)` → `orchestrator.resumeRun(resumeInput?)` → `resumeGraph`), so passing `{ decision, feedback }` instead of a bare string is transparent to the plumbing; only the gate node interprets it. A new store action (mirroring `answerInterrupt`) sends the object.

## How the approved design reaches the build

The preview file at `<project>/design-preview.html` sits in the agents' `cwd`. When `designPreview` is on **and** the preview was approved, the `execute`-stage worker prompt gains **one line**: *"An approved design-system preview is at `design-preview.html` — build the UI to match its palette, type, and components."* Threaded like the `visionMode` QA reframe: a parameter on `workerPrompt`, gated so the off/not-approved path is byte-identical.

## Rendering (iframe)

`DesignPreviewModal` reads the file via a new **`readDesignPreview(path): Promise<string>`** IPC (mirrors `env:read`/`readRole` — main-process reads the file, returns its text) and frames it with:
```tsx
<iframe srcdoc={html} sandbox="allow-same-origin" title="Design preview" />
```
No server, no port, no process lifecycle. Self-contained HTML + inline CSS render under the CSP (`style-src 'unsafe-inline'` is already allowed). `srcdoc` (`about:srcdoc`) is same-origin, expected to satisfy `frame-src 'self'`.

**Verify-at-implementation:** confirm `about:srcdoc` frames under the production CSP. If Chromium blocks it, fall back to the #9 localhost-serve pattern (`server-manager` → `frame-src http://localhost:*`). The spec's primary path is `srcdoc`; the fallback is a known, already-shipped mechanism, so this risk is contained.

## Byte-for-byte invariant (load-bearing)

`designPreview` off ⇒ `buildOrchestratorGraph` produces exactly today's node/edge map (`route → execute`); the gate node never runs; `designPreviewPrompt` is not called; the `execute` worker prompt is byte-identical (the reference line is gated on on+approved); both settings are inert; `graph.json` and every run are identical to today. `usePreMadeInspirationGuide` is only ever read inside the (already-gated) generation path.

## IPC / preload / RendererApi

- **`design-preview:read`** (`readDesignPreview(path)`) → main reads `<path>` (validated to be within the current project), returns text. Mirrors `readRole`/`env:read`.
- **Resume** reuses the existing `IPC.resumeRun` (no new channel) — the renderer passes the `{ decision, feedback? }` object as the existing `answer?: unknown` argument.
- Preload bridge + `RendererApi` method type for `readDesignPreview`.

## Testing

- **Pure/unit** (`src/shared/design-preview.test.ts`): `designPreviewPrompt` — guide-off branch is byte-identical (exact-equality), guide-on injects `INSPIRATION_GUIDE` + the domain-fit/no-styles clause; `INSPIRATION_GUIDE` is well-formed and self-contained (no external `http`/`@import`).
- **Engine** (`nodes.test.ts` injected-runner seam, canned `runAgent` returning a stub that "writes" HTML): with `designPreview` on, the graph routes `route → designPreviewGate`; the gate returns an `interrupt` of kind `design-preview`; resume `{decision:'approve'}` → `goto: 'execute'` + approved flag; resume `{decision:'changes',feedback}` → regenerates and re-interrupts (iteration increments); with `designPreview` off, the graph is `route → execute` and the full existing pipeline is unchanged (byte-for-byte).
- **Graph-wiring** unit: `buildOrchestratorGraph` off ⇒ node/edge map deep-equals today's; on ⇒ includes the gate node between route and execute.
- **UI:** no renderer unit test (house convention) → on-device smoke (toggle on; run a UI goal; the run pauses; the modal frames the preview; Approve proceeds and the build follows it; Request-changes regenerates; toggle off ⇒ no pause).
- **Integration gates:** implementers run `npm run typecheck` + `npm run test`; controller runs `npm run build`. **`npm run lint` is required** (renderer changes: the new modal + store + SettingsModal).

## Files

- `src/shared/types.ts` — `designPreview` + `usePreMadeInspirationGuide` on `ProjectSettings`/`DEFAULT_SETTINGS`; `RunState` gains `designPreviewApproved?`/`designPreviewIteration?` (checkpoint-only, undefined on old runs → degrade safely, the `repairAttempts` precedent).
- `src/shared/design-preview.ts` — **new**; `designPreviewPrompt(goal, guide?)` (pure) + `INSPIRATION_GUIDE` constant.
- `src/main/engine/nodes.ts` — `designPreviewGateNode`; conditional wiring in `buildOrchestratorGraph`; the gated worker-prompt reference line.
- `src/main/engine/project-store.ts` (or a small sibling) — read the preview file for the IPC; path validation.
- `src/main/ipc.ts` + `src/preload/index.ts` + `RendererApi` — `design-preview:read`.
- `src/renderer/store.ts` — `'design-preview'` interrupt kind + a resume action.
- `src/renderer/DesignPreviewModal.tsx` — **new**; iframe + Approve / Request-changes.
- `src/renderer/SettingsModal.tsx` — the "Design preview" section (2 toggles, gated).

## Out of scope (v1)

- **Live in-iframe editing** of the preview (needs a bidirectional renderer↔engine channel; approve/request-changes→regenerate covers "tweak" for now).
- **Guaranteeing design roles on the team** / the "Build creative vision team" composition setting (a separable feature; can follow later, and can decide then whether to reuse/extend `visionMode`).
- **Per-project custom inspiration guides** (ship one curated default; a user override file can come later).
- **Reworking `visionMode`** — untouched.
- Using a design-manager agent as the generator when the team has one (v1 uses the orchestrator; a later refinement).
