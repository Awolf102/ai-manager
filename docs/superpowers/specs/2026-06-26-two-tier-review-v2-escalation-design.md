# Two-Tier Review v2 — Escalation Re-Planning

**Date:** 2026-06-26
**Status:** Approved design, ready for implementation planning
**Roadmap:** #1 (the deferred two-tier-review v2 follow-on, after the workflow-graph Phases 1–3 arc shipped). Background: memory `ai-manager-two-tier-review`, `ai-manager-workflow-graph`, `ai-manager-architecture`.

## Motivation

The run loop has two responses to a failed task today, and a third was deliberately deferred:

- **repair** (shipped) — re-run the *same* task with the reviewer's feedback, in place; the task definition is assumed correct, only the implementation was buggy. Bounded by `repairAttempts < maxAttempts`.
- **proactive re-plan** (Phase 2) — *between ordered stages*, the orchestrator rewrites the not-yet-run plan based on what earlier stages produced. Bounded by `replanAttempts < maxReplans`.
- **escalation re-plan (this spec, v2)** — the missing reactive response: when a reviewer judges a task is **mis-scoped** (the plan broke the work down wrong, so repairing that one task can never fix it), the orchestrator **re-breaks-up** the failed work instead of repairing it.

The orchestrator's integration-review prompt already detects plan-level gaps ("if the plan itself is missing something needed for the goal, note it in the feedback... **you cannot re-plan here**"). v2 removes that limitation: a reviewer can mark a failure as mis-scoped, and the engine acts on it by re-planning the failed work — reusing the Phase-2 re-plan machinery from the review exit instead of an execute-stage boundary.

## Goals

- A reviewer (manager domain review, or the orchestrator's integration review) can **classify each failure** as `repair` (buggy) or `replan` (mis-scoped).
- When any failure is flagged `replan` (and re-plan budget remains), the run **escalates**: the orchestrator re-breaks-up the **not-passed (failed)** tasks (passed tasks frozen) → route → execute → review.
- **The goal is never touched** (same structural invariant as Phase 2).
- **Unified budget:** escalation shares Phase 2's `maxReplans` setting + `replanAttempts` counter — one "mid-run re-plan" budget covering proactive *and* reactive re-plans.
- **Off by default → byte-for-byte today** (`maxReplans === 0`): reviewers aren't even asked to classify, the escalate branch is gated off, and the escalate node is never entered.
- **Hard-bounded & terminating** via the shared `replanAttempts < maxReplans` cap.
- **Reuses Phase 2's surfacing** (the `replan` event → Run-view banner + History) — no renderer changes.

## Non-goals (out of scope, YAGNI)

- **A separate escalation setting/counter.** Escalation is unified under `maxReplans`/`replanAttempts` (one budget, one termination guarantee).
- **Mixed dual response in one review exit.** When a mis-scope is flagged, escalation re-plans the *whole* not-passed set (the orchestrator may keep, split, merge, drop, or add) — the engine does not run repair on some failures and escalate others in the same exit. (`repair`-flagged failures inside an escalating exit are subsumed by the re-plan.)
- **Re-opening passed work.** Passed tasks are frozen (their work stands); escalation only replaces the failed/not-passed tasks. (Monotonic, like Phase 2.)
- **New UI / settings.** Reuses the `maxReplans` field and the `replan` event surfacing.

## Decisions locked in brainstorming

- **Trigger = reviewer classifies the failure** (`disposition: 'repair' | 'replan'`); any `replan` flag (with budget) escalates. Per-issue + judged (consistent with Phase 2's "orchestrator picks"); works for flat and hierarchical teams.
- **Escalation re-plans the not-passed set as a whole** (passed frozen), reusing a generalized `mergeReplan`.
- **Unified under `maxReplans`/`replanAttempts`** (default 0 = off = byte-for-byte).
- **Surfacing reuses the Phase-2 `replan` event** — no store/RunView/History changes.

## Architecture

### Data model — `src/shared/types.ts`

`TaskState.verdict` gains an optional disposition (the only type change):

```ts
verdict?: { verdict: 'pass' | 'fail'; feedback: string; disposition?: 'repair' | 'replan' }
```

`disposition` is meaningful only on a `fail`; absent ⇒ treated as `'repair'` (today's behavior). No new settings, events, or `RunState`/`RunRecord` fields — escalation reuses `maxReplans`, `replanAttempts`, the `replan` event, and `run.replans`/`record.replans`.

### Review classification — `reviewStep` / `integrationReviewStep` + prompts (`src/main/engine/nodes.ts`)

- `reviewStep` and `integrationReviewStep` parse an optional per-task `disposition` from the verdict JSON; for a `fail` it is `'replan'` iff the model returns exactly that, else `'repair'`. They set `t.verdict = { verdict, feedback, disposition }`.
- `reviewPrompt` and `integrationReviewPrompt` take an `allowReplan: boolean` (= `getSettings().maxReplans > 0`). When `true`, they add a disposition instruction + schema field:
  > For each "fail", set `"disposition"`: `"repair"` if the task is correctly scoped but the implementation is buggy or incomplete (re-running it can fix it), or `"replan"` if the **task itself is mis-scoped** — the plan broke the work down wrong and it should be re-broken-up rather than re-run.

  When `allowReplan` is `false` (i.e. `maxReplans === 0`), the prompt is **identical to today** → byte-for-byte. The reviewStep/integrationReviewStep pass `allowReplan` from settings.

### Control flow — escalate branch at both review exits

`domainReviewNode` and `integrationReviewNode`, after recording verdicts, gain an escalate branch that takes priority over repair:

```ts
const failed    = Object.values(tasks).filter((t) => t.ownerId && t.status === 'failed')
const misScoped = failed.filter((t) => t.verdict?.disposition === 'replan')
const maxReplans = getSettings().maxReplans ?? 0
if (maxReplans > 0 && misScoped.length > 0 && state.replanAttempts < maxReplans && !eng.abort.signal.aborted) {
  return { patch: { tasks, steps, reviews, phase: 'replanning' }, goto: 'escalate' }   // NEW
}
if (failed.length > 0 && state.repairAttempts < maxAttempts && !eng.abort.signal.aborted) {
  return { patch: { tasks, steps, reviews, phase: 'repairing' }, goto: 'repair' }       // today
}
return { patch: { tasks, steps, reviews, phase: ... }, goto: <integrationReview | reflect> } // today
```

(`domainReview` else-target is `integrationReview`; `integrationReview` else-target is `reflect` — unchanged.)

### The `escalate` node (review-exit re-plan)

New graph node `escalate`, static edge `escalate: 'reflect'` (the give-up fallback). It re-breaks-up the failed work:

1. Gate (defensive): `maxReplans <= 0 || replanAttempts >= maxReplans || aborted` → `goto 'reflect'`.
2. `passed` = owned tasks `status === 'passed'`; `failed` = owned tasks `status === 'failed'`.
3. `escalateStep(eng, goal, orchestratorId, passed, failed)` → `{ reason, tasks, deps }` (the revised breakdown of the failed work). On parse-failure → `goto 'reflect'` (graceful give-up; failed tasks stay failed, surfaced in synthesis — same as today's "repair budget exhausted").
4. Apply via the shared helper (below) with `replaceIds = failed task ids`: `mergeReplan` freezes everything not in `replaceIds` (the passed tasks), drops the failed, adds the revised tasks (pending, un-owned). Increment `replanAttempts`, reset `repairAttempts: 0`, push `run.replans`, emit the `replan` event, `goto 'route'`.

`routeNode` then routes only the new un-owned tasks; `executeNode` runs them; review runs again. (Same re-entry path Phase 2 already uses.)

### Reuse — generalize `mergeReplan` + a shared apply helper

- `src/shared/replan.ts` `mergeReplan(plan, tasks, decision, replaceIds?)` — add an **optional** `replaceIds: string[]`. When omitted it defaults to the `pending` task ids (so Phase 2 and its tests are unchanged); the escalate caller passes the **failed** ids. Logic generalizes to: freeze every task **not** in `replaceIds`; drop the `replaceIds` tasks; add `decision.tasks` (pending, un-owned, `dependsOn` from `decision.deps`).
- `src/main/engine/nodes.ts` — extract a small shared helper used by **both** `replanNode` (Phase 2) and the new `escalate` node:
  ```ts
  function applyReplanDecision(state, decision, replaceIds, extraPatch?) →
    { plan, tasks } = mergeReplan(state.plan, structuredClone(state.tasks), decision, replaceIds)
    attempt = state.replanAttempts + 1
    replans = [...(state.replans ?? []), { attempt, reason: decision.reason }]
    emit { type:'replan', attempt, reason, tasks: plan }
    return patch { plan, tasks, replans, replanAttempts: attempt, repairAttempts: 0, phase:'replanning', ...extraPatch }
  ```
  `replanNode` keeps its `replanStageCursor` handling via `extraPatch`; `escalate` needs no cursor.

### `escalateStep` / `escalatePrompt`

A read-only orchestrator call (mirrors `replanStep`: `permissionMode:'default'`, `THINK_DISALLOW`), framed for re-breaking-up failed work:
- Inputs: the **GOAL (explicitly LOCKED)**; the plan; the **passed/kept** tasks + outputs (done — do not redo); the **failed** tasks + their feedback (judged mis-scoped).
- Instruction: these tasks did not pass review because they are **mis-scoped** — re-break-up the failed work into a corrected set of tasks (split / merge / drop / add). Keep the passed work; do **not** change the goal.
- Output JSON: `{ "reason": "...", "tasks": [ { id, title, description, dependsOn? } ] }` — parsed/sanitized via the shared `parseTasksAndDeps(raw, 'e')` (the Phase-2 helper; `'e'` id-prefix for escalation auto-ids). (No `replan: boolean` — reaching `escalate` already means the reviewer flagged a mis-scope; an empty/parse-failed result is treated as a decline → `goto 'reflect'`.)

## Data flow

`execute → domainReview` (managers classify failures) → if any `replan` + budget → `escalate` (orchestrator re-breaks-up the failed set; passed frozen) → `route` (new tasks) → `execute` → `domainReview` … → `integrationReview` (orchestrator may also escalate) → `repair`/`reflect` as today. With `maxReplans = 0`: classification is never requested, the escalate branch is gated off, the run behaves exactly as today (repair loop + reflect).

## Error handling / edge cases

- **`maxReplans === 0`** → review prompts unchanged (no disposition asked), escalate branch gated off, `escalate` never entered → **byte-for-byte today**.
- **Fail without a `replan` disposition** (default `repair`) → no escalation; the existing repair path runs.
- **`replan` flagged but budget exhausted** (`replanAttempts >= maxReplans`) → escalate branch skipped → falls through to repair (if budget) or reflect → terminates.
- **`escalateStep` parse-failure / empty tasks** → `goto 'reflect'` (graceful give-up; failed tasks stay failed, surfaced in synthesis — mirrors today's give-up and the Phase-2 decline pattern).
- **Mixed dispositions in one exit** (`repair` + `replan`) → escalation re-plans the whole not-passed set; `repair`-flagged failures are subsumed by the re-plan (the orchestrator decides their fate). No dual response.
- **Shared budget with Phase 2** → proactive and escalation re-plans both consume `replanAttempts`; total mid-run re-plans ≤ `maxReplans`. Terminates. After an escalation, `executeNode`'s Phase-2 pause may still fire on the new tasks (same budget bounds it).
- **Goal immutability** → no node writes `state.goal`; `escalatePrompt` marks it locked and never asks for a new one; the escalate patch excludes `goal`.
- **Flat teams** → `domainReview` (orchestrator-as-reviewer) can flag `replan` and escalate; `integrationReview` is skipped as today. Escalation works for both team shapes.

## Testing

- **Pure unit — `src/shared/replan.test.ts`**: `mergeReplan(plan, tasks, decision, replaceIds)` with `replaceIds` = the failed ids → freezes passed tasks, drops the failed, adds the revised set; and the existing no-`replaceIds` calls (default pending) still pass unchanged.
- **`src/main/engine/nodes.test.ts`** (canned-agent seam):
  - **domain escalation:** `maxReplans:1`; a manager review fails a task with `disposition:'replan'`; assert the run goes to `escalate` (not repair), the orchestrator's escalate step re-breaks-up the failed task, the revised tasks route + execute + pass, `replanAttempts === 1`, a `replan` event fired; the passed task is frozen (not re-run).
  - **integration escalation:** the orchestrator's integration review flags a mis-scope → escalate.
  - **repair still works:** a `fail` with `disposition:'repair'` (or absent) → repair path, no escalation (regression guard).
  - **off control:** `maxReplans:0` → review prompts carry no disposition instruction, no escalation, repair/reflect as today (byte-for-byte; existing two-tier tests hold).
  - **cap:** escalation stops at `maxReplans` (a persistently mis-scoped task eventually falls through to repair/reflect; bounded).
- **No renderer tests** — the feature reuses the Phase-2 `replan` surfacing (already covered); typecheck + build remain green.

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/types.ts` | `TaskState.verdict.disposition?: 'repair' \| 'replan'` |
| `src/shared/replan.ts` (+ `.test.ts`) | `mergeReplan` gains optional `replaceIds` (defaults to pending ids) |
| `src/main/engine/nodes.ts` (+ `.test.ts`) | `reviewStep`/`integrationReviewStep` parse `disposition` + `allowReplan`-gated prompt; `reviewPrompt`/`integrationReviewPrompt` add the disposition instruction when `allowReplan`; `domainReviewNode`/`integrationReviewNode` add the escalate branch; NEW `escalate` node + `escalateStep`/`escalatePrompt`; shared `applyReplanDecision` helper (also used by `replanNode`); graph wiring (`escalate` node + `escalate: 'reflect'` edge) |

**Untouched:** the renderer (store/RunView/History reuse the `replan` event), `SettingsModal` (reuses `maxReplans`), `executeNode`'s wave loop, the Phase-2 `replan` node's behavior (its `mergeReplan` call defaults to pending), `graph.ts`.

## Risks / edge cases

- **Byte-for-byte regression** — the load-bearing guarantee. Mitigation: the disposition prompt instruction AND the escalate branch are both gated on `maxReplans > 0`; with it `0`, review prompts and review-exit control flow are identical to today. Pinned by the "off control" test.
- **Non-termination** — the shared `replanAttempts < maxReplans` cap bounds total re-plans (proactive + escalation); passed work is frozen (monotonic). Tested by the cap case.
- **`mergeReplan` refactor regressing Phase 2** — `replaceIds` is optional and defaults to the prior pending-id behavior, so Phase 2 callers/tests are unchanged; verified by re-running the existing `replan.test.ts` + Phase-2 nodes tests.
- **Reviewer over-flagging `replan`** — a reviewer that marks everything mis-scoped would burn the re-plan budget; bounded by `maxReplans` (small, default 0). The prompt is explicit that `replan` is only for genuinely mis-scoped tasks, not buggy ones.
- **Escalate vs repair precedence** — escalation takes priority when any failure is `replan`-flagged; the subsumed `repair` failures get re-done as part of the new plan. Documented so it isn't mistaken for a lost repair.
