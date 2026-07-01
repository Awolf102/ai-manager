# Token Efficiency — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorm) → ready for implementation plan
**Feature:** Phase-3 #6 — opt-in controls that reduce token spend per run.

## Summary

Add a new **"Token Efficiency"** section to Settings holding four independent,
opt-in controls that reduce token usage during headless runs. Every control is
**OFF by default**; with all four off the engine is **byte-for-byte identical to
today**. The controls attach at existing seams (system-prompt assembly, the
effort pipeline, worker-model dispatch, the scaffolding-prompt builders), so no
new execution path is introduced.

This is foundational for later Phase-3 work: the "advisor" assistant will
recommend these knobs, and any future pricing/efficiency tiering meters against
them.

## Goals

- Give the user opt-in levers to trade some quality/verbosity for lower token
  cost, chosen per project in Settings.
- Keep each lever independent and clearly named.
- Guarantee zero behavior change when everything is off.
- Stay on-brand with the shipped Obsidian & Emerald design system.

## Non-goals / scope

- **No hard "code-only" guarantee.** The engine drives the `claude` CLI via the
  Agent SDK's `query()`, which does **not** expose `output_config.format`.
  "Code-only" is a strongly-worded system-prompt instruction (soft): Claude
  minimizes prose but is not schema-constrained. This limitation is accepted.
- **No aggressive dynamic-context trimming in v1.** "Lighter internal prompts"
  trims only the app's *static instruction prose*, not the injected role text,
  lessons, or memory (that is where the largest input-token savings live *and*
  where routing/review/learning quality regresses hardest). Deliberately
  deferred.
- **Interactive PTY sessions are untouched.** These levers apply to headless
  runs only (orchestration runs + the manual "Run" button where applicable).
- **No per-run override UI.** Control is per-project via Settings only. A per-run
  picker is a possible later addition (YAGNI for v1).

## Settings surface

A new left-pane section **"Token Efficiency"** in `SettingsModal`, following the
existing two-pane section pattern and reusing the `Switch` primitive and design
tokens. Four controls; the three parameterized ones reveal a sub-selector only
when their toggle is on:

| Control | Sub-control shown when ON | OFF state |
|---|---|---|
| **Concise output** | Level select: *Terse* / *Code-only* | Normal |
| **Effort thrift** | Ceiling select: *Low* / *Medium* / *High* | (no cap) |
| **Cheap-model workers** | Tier select: *Sonnet 4.6* / *Haiku 4.5* (default Haiku) | (workers keep their own model) |
| **Lighter internal prompts** | — | (full prompts) |

### `ProjectSettings` additions (flat fields, off/neutral defaults)

```ts
// shared/types.ts — added to ProjectSettings
outputMode: 'normal' | 'terse' | 'code-only'   // default 'normal'
effortThrift: boolean                           // default false
effortThriftCeiling: Effort                     // default 'medium' (consulted only when effortThrift)
cheapModelWorkers: boolean                      // default false
cheapModelTier: string                          // default 'claude-haiku-4-5' (consulted only when cheapModelWorkers)
lightPrompts: boolean                           // default false
```

`DEFAULT_SETTINGS` sets all of the above to the neutral/off values so existing
projects and new projects are unchanged until the user opts in.

## The four levers — engine behavior

### 1. Concise output

- New pure module `shared/token-efficiency.ts` exporting
  `outputModeInstruction(mode: OutputMode): string`.
  - `'normal'` → `''` (no append).
  - `'terse'` → an instruction to minimize prose: no preamble, no summary,
    answer with the essentials only.
  - `'code-only'` → an instruction to output only code and essential results.
- Both non-normal instructions **explicitly preserve required structured/JSON
  replies** (routing/assign/review/plan steps must still emit their fenced JSON
  block; the wording states that any required code/JSON block is exempt from the
  "no prose" rule).
- Appended in `agent-runner.ts` `streamAgent`, at the single point where the
  system-prompt `append` is assembled (currently
  `composeAppend(role, memory, context, folders) + headlessNote(pack.names)`).
  Reads `getSettings().outputMode`. When `'normal'`, the append string is
  identical to today.
- Applies to every headless agent run (workers, managers, orchestrator, and the
  manual "Run" button, which also goes through `streamAgent`).

### 2. Effort thrift

- New pure helper (in `shared/token-efficiency.ts` or `shared/model-caps.ts`)
  that caps an effort value **down** to a ceiling:
  `capEffort(effort: Effort | undefined, ceiling: Effort): Effort`.
- Applied at the single upstream site `assignStep` in `nodes.ts` (the site that
  already feeds the badge, the task-effort merge, and dispatch consistently, per
  the model-effort-clamp design), composed with the existing
  `effortForModel`/`clampEffort`:
  - When `effortThrift` is on, the effective per-task effort is
    `min(assigned, ceiling)`, then clamped to the worker's model ceiling as
    today.
  - Thrift must take effect **even when `adaptiveEffort` is off** — in that case
    it forces the ceiling as the dispatched effort rather than leaving effort
    unset (CLI default). The dispatch reads in `nodes.ts` (currently gated on
    `adaptiveEffort`) are adjusted so a thrift ceiling is honored regardless of
    `adaptiveEffort`.
- When `effortThrift` is off, the effort pipeline is unchanged.
- Interaction: if a worker is forced to Haiku (lever 3), Haiku has no effort
  param and effort is dropped by `clampEffort` as today — consistent.

### 3. Cheap-model workers

- Add an optional `modelOverride?: string` to `StreamAgentOptions`;
  `streamAgent` uses `opts.modelOverride ?? agent.model` when building the SDK
  `options.model`. Nothing else in `streamAgent` changes.
- In `nodes.ts`, worker dispatch (execute + repair paths) passes
  `modelOverride = settings.cheapModelTier` **only for worker steps** when
  `cheapModelWorkers` is on. Manager/orchestrator steps (routing, review,
  synthesis, planning) never receive an override, preserving their reasoning
  quality.
- Transient: never mutates the stored `agent.model` in the graph. Off =
  byte-for-byte (no override passed).
- Independent of `autoAssignModels`; when both would set a worker's model, the
  run-time bias wins at dispatch.

### 4. Lighter internal prompts (conservative v1)

- The scaffolding-prompt builders (`assignPrompt`, `workerPrompt`, the review
  and plan prompt builders in `nodes.ts`) gain trimmed variants of their
  **static instruction prose** — the verbose rubric explanations and repeated
  guidance are condensed; the dynamic content (role text slices, lessons, task
  lists, memory) is unchanged.
- Selected by the `lightPrompts` flag at the call site (a builder-level branch
  or a passed boolean). When off, the exact current prompt strings are used.
- Net effect: modest input-token savings per step at low quality risk. The
  large, high-risk savings (capping injected role/lesson/memory text) are out of
  scope for v1.

## Off = byte-for-byte guarantee

Each lever is guarded by its own flag with a neutral default, so a project with
all four off produces identical bytes to today for:

- the system-prompt `append` (Concise output),
- the per-task effort values and dispatch (Effort thrift),
- the dispatched worker model (Cheap-model workers),
- every scaffolding prompt string (Lighter internal prompts).

Unit tests assert this per lever.

## Files touched (anticipated)

- `src/shared/types.ts` — new `ProjectSettings` fields + `DEFAULT_SETTINGS`.
- `src/shared/token-efficiency.ts` — **new** pure module: `OutputMode`,
  `outputModeInstruction`, `capEffort` (or `capEffort` in `shared/model-caps.ts`).
- `src/main/engine/agent-runner.ts` — append output-mode instruction; add
  `modelOverride` to `StreamAgentOptions` and use it.
- `src/main/engine/nodes.ts` — apply effort thrift at `assignStep` + honor it at
  dispatch regardless of `adaptiveEffort`; pass worker `modelOverride`; trimmed
  prompt variants gated on `lightPrompts`.
- `src/renderer/SettingsModal.tsx` — new "Token Efficiency" section (Switch +
  conditional sub-selectors), reusing existing section styling.
- Tests: `src/shared/token-efficiency.test.ts` (+ `model-caps.test.ts` if
  `capEffort` lands there), and `nodes.test.ts` additions for the effort/model
  wiring and off = byte-for-byte.

## Testing plan

- **Pure unit tests:** `outputModeInstruction` (all three modes, required-JSON
  preservation wording present for non-normal), `capEffort` (caps down, ceiling
  respected, undefined handling), worker-model resolution
  (`modelOverride ?? agent.model`), trimmed-prompt builders vs. full builders.
- **Off = byte-for-byte:** with all flags off, assert the assembled append, the
  effort pipeline output, the dispatched model, and each prompt string are
  unchanged.
- **Integration (nodes.test.ts):** a run with each lever on exercises its seam
  (effort thrifted at dispatch; worker model overridden; append carries the
  instruction).
- **Gates:** `npm run typecheck`, `npm run test` (implementers); `npm run build`
  at the integration gate; `npm run lint` (renderer touched → react-hooks gate);
  and a **user on-device Settings smoke** (the automated gates do not render
  `App.tsx`).

## Design-system notes

The new Settings section consumes existing tokens and the `Switch` primitive,
matches the two-pane Settings layout, and adds no new colors/materials — emerald
stays a signal color (Switch "on"), obsidian surfaces throughout. No new motion.
AA + reduced-motion inherited from the shared components.
