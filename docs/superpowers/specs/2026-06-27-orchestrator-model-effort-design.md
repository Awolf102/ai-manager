# Orchestrator model-tier assignment + effort-clamped-to-model

**Date:** 2026-06-27
**Status:** Design approved, pending spec review
**Branch:** `feat/orchestrator-model-effort`

## Problem

Two related gaps in how AI-Manager assigns reasoning effort and models:

1. **Effort can exceed the worker's model.** The orchestrator/router assigns a per-task
   reasoning effort by difficulty (`low|medium|high|xhigh|max`, `nodes.ts:1242-1258`)
   **without considering which model the chosen worker runs.** A Sonnet 4.6 worker can be
   handed `xhigh`, but Sonnet 4.6 has no `xhigh` tier (it tops out at `max`), and Haiku 4.5
   has no effort parameter at all. The Claude Agent SDK silently downgrades the effort to
   the model's real ceiling (`sdk.d.ts`: "after any silent downgrade for the selected
   model"), so nothing errors — but the Run-view effort badge shows the **assigned** effort
   (`effortOfWorker`, `shared/effort.ts`), which can overstate what actually ran (the
   observed "XHIGH" badge on a Sonnet worker).

2. **The orchestrator does not choose worker models.** Spawned/drafted workers get a static
   default (`DEFAULT_MODEL_BY_KIND` → worker = `claude-sonnet-4-6`, `types.ts:434-438`).
   The orchestrator never matches a worker's model tier to the difficulty of its work.

## Goal

1. **Build-time model assignment:** when the orchestrator builds/drafts a team, it picks each
   worker's model tier — Sonnet 4.6 baseline, Opus 4.8 for hard/ambiguous/wide-reaching work.
2. **Effort clamped to model:** every per-task effort is clamped to the worker's model's real
   effort ceiling before dispatch, so we never send an out-of-range value and the badge
   reflects what actually ran.

Together these add the requested capability and fix the badge mismatch at the source.

## Decisions (locked during brainstorming)

- **Model granularity:** per-worker, decided at team build. A worker keeps one model for the
  whole run; only effort varies per task. (Not per-task dynamic model override.)
- **Tier policy:** 2-tier — Sonnet 4.6 baseline, Opus 4.8 for hard work. **Haiku 4.5 is NEVER
  auto-assigned to any member (worker or manager)** (it has no thinking/effort, so effort would
  be a silent no-op; managers do reasoning-heavy review/QA work and default to Opus). The parser
  rejects a proposed Haiku model regardless of kind.
- **Badge when clamped:** show the clamped (actual) value only; a tooltip notes any downgrade.
- **`autoAssignModels` setting:** default **off** = byte-for-byte unchanged (spawned workers
  keep today's static Sonnet default). On = orchestrator picks model tiers.
- **Effort-clamp:** always on. It only ever corrects an out-of-range value and is a pure no-op
  when `adaptiveEffort` is off (effort is `undefined`), so it needs no setting of its own.

## Components

### 1. `shared/model-caps.ts` (new, pure)

Single source of truth for per-model effort capability. Pure module, unit-tested in plain
Node — no DOM/fs imports — matching `shared/effort.ts` and `shared/narrate.ts`.

```ts
// Ordered low→high; the last entry is the model's ceiling. Empty = no effort param.
export const MODEL_EFFORT_CAPS: Record<string, Effort[]> = {
  'claude-opus-4-8':   ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],   // no xhigh
  'claude-haiku-4-5':  [],                                  // no effort parameter
}

/** Clamp a requested effort to what the model supports: round UP to the nearest
 *  supported level ≥ requested (e.g. Sonnet `xhigh` → `max`); cap at the model's
 *  ceiling if the request exceeds it; `undefined` when the model has no effort
 *  parameter (Haiku) or no effort was requested; pass through for an unknown model. */
export function clampEffort(model: string, effort: Effort | undefined): Effort | undefined
```

Clamp direction is **round up** so a task judged harder-than-`high` is not silently
reduced below its intended difficulty (Sonnet has `high` and `max` but no `xhigh`, so
`xhigh` → `max`). This matches the approved design example.

Rationale for a static map over querying the SDK's `ModelInfo.effort`: only 3 models,
deterministic, synchronous (no async in the routing hot path), trivially unit-testable.
Adding a future model is one map entry. (SDK `ModelInfo` is the fallback if the model set
ever grows large.) Unknown model id → treat as "no clamp data": return the requested effort
unchanged (defensive; never throws).

### 2. Routing-time clamp — `nodes.ts` (`assignStep`)

Clamp at the single point where an assignment is built (`assignStep`, `nodes.ts:739-744`) —
where the chosen worker (`childId`) and the raw effort first meet — via a pure combiner:

```ts
export function effortForModel(model: string | undefined, requested: Effort | undefined, adaptiveEnabled: boolean): Effort | undefined {
  if (!adaptiveEnabled || !model) return requested
  return clampEffort(model, requested)
}
// assignStep: effort: effortForModel(childId ? getAgent(childId).model : undefined, parseEffort(a.effort), getSettings().adaptiveEffort)
```

This is the right single site: the merge at `nodes.ts:201` (`tasks[a.taskId].effort = a.effort`),
the dispatch sites (`:285`, `:517`), and the badge (`effortOfWorker`, which reads the recorded
assignment effort) all read this value — so clamping once here makes the badge, the merged task
effort, and the dispatched effort consistent, and guarantees the value reaching
`agent-runner.ts:132` is valid for `agent.model`. Applies to **all** workers regardless of how
they were created (correctness fix, not gated by `autoAssignModels`).

**Parity:** `adaptiveEffort` off → `effortForModel` returns the request unchanged (today's
behavior — raw effort recorded, dispatch already passes `undefined` via the `:285`/`:517` gate)
→ byte-for-byte unchanged. On → clamp only ever adjusts effort to a model-valid level.

### 3. Build-time model assignment — `team-spawn.ts` (prompt + parser), `team-spawner.ts`, `applySpawnedTeam`

(Note: `role-drafter.ts` is **not** a model site — it drafts role.md for agents that already
exist; it never creates agents, so it never picks a model. Model assignment happens only at
team spawn.)

Extend the orchestrator's team/role proposal so each proposed **worker** carries a `model`,
chosen via a tier rubric aligned with the existing effort rubric (`nodes.ts:1242`) so model and
effort stay coherent:

- **Opus 4.8** — hard, ambiguous, or wide-reaching workers (headroom for xhigh/max)
- **Sonnet 4.6** — standard coding workers (default)
- Managers / orchestrator — Opus (unchanged)
- **Haiku 4.5 — never auto-assigned (parser rejects it for any member)**

Parsing: read the `model` field from the proposal, validate against `MODELS` (`types.ts:418`),
fall back to `DEFAULT_MODEL_BY_KIND[kind]` when missing/invalid. Gated by `autoAssignModels`
(default off → ignore any proposed model, use the static default = byte-for-byte). Only affects
orchestrator-spawned/drafted agents; **manually-created agents keep the user's explicit model.**

### 4. UI / badge — `RunView.tsx`, `shared/effort.ts`

Because the clamp happens at assignment time, the stored assignment effort is already the real
value, so the existing `effortOfWorker` badge auto-corrects (a Sonnet worker's xhigh task now
shows **MAX**). No structural UI change required for honesty. Polish: a tooltip on the badge
noting a downgrade when the originally-assigned effort was higher than the clamped value (carry
the pre-clamp value alongside the assignment for the tooltip; optional, low priority).

### 5. Settings — `autoAssignModels`

New boolean setting, default **false**. Surfaced in `SettingsModal.tsx` near the existing
"Adaptive effort" toggle. Off = orchestrator model proposals are ignored and spawned workers
use `DEFAULT_MODEL_BY_KIND` (today's behavior). The effort-clamp has no setting (always on,
no-op when effort is off).

## Scope / guardrails

- Effort-clamp applies to every worker (manual + spawned).
- Model auto-assign applies only to orchestrator-spawned/drafted teams; manual model choices
  are never overridden.
- No per-task model override; model stays a per-worker property.
- Capability map covers the 3 current models; new models = one entry each.
- Both new behaviors have an off path that is byte-for-byte identical to today
  (`autoAssignModels` off; `adaptiveEffort` off).

## Testing

- **`clampEffort` unit tests (pure):** every model × every effort level — Opus `xhigh`→`xhigh`,
  Sonnet `xhigh`→`max`, Sonnet `max`→`max`, Haiku (any)→`undefined`, `undefined` in→`undefined`
  out, unknown model→passthrough.
- **Proposal parser tests:** worker `model` valid → applied; missing/invalid → `DEFAULT_MODEL_BY_KIND`
  fallback; Haiku proposed for any member (worker or manager) → rejected to fallback.
- **Engine test:** a Sonnet worker assigned an `xhigh` task reaches `agent-runner` with
  `effort = max`; a Haiku worker reaches it with `effort = undefined`.
- **Off-parity tests:** `adaptiveEffort` off → no effort, unchanged; `autoAssignModels` off →
  spawned workers get static defaults, unchanged.

## Files touched

- `src/shared/model-caps.ts` (new) + `model-caps.test.ts`
- `src/main/engine/nodes.ts` (export `effortForModel`; clamp in `assignStep`)
- `src/shared/team-spawn.ts` (`spawnTeamPrompt` model rubric, `parseSpawnedTeam` validate, `pickSpawnModel`)
- `src/main/engine/team-spawner.ts` (pass `autoAssignModels` to the prompt)
- `src/main/engine/project-store.ts` (`applySpawnedTeam` uses `pickSpawnModel`)
- `src/shared/types.ts` (`SpawnedMember.model?`, `autoAssignModels` in Settings + default, `Assignment.assignedEffort?`)
- `src/renderer/SettingsModal.tsx` (toggle)
- `src/renderer/run/RunView.tsx` + `src/shared/effort.ts` (optional capped tooltip)
- Tests alongside each.

## Out of scope

- Per-task dynamic model selection / per-dispatch model override.
- Auto-assigning Haiku to any member (worker or manager).
- Querying SDK `ModelInfo` for capabilities (static map suffices for 3 models).
- Changing manually-created agents' models.
