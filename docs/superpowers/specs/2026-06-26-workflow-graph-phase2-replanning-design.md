# Workflow-Graph Canvas — Phase 2: Goal-Locked Mid-Run Re-Planning

**Date:** 2026-06-26
**Status:** Approved design, ready for implementation planning
**Roadmap:** #1 (workflow-graph canvas) — **Phase 2 of 3**. Phase 1 (clickable edge ordering) is SHIPPED. Phase 3 (lateral team↔team handoffs) is a separate, later spec/plan/build cycle. Background: memory `ai-manager-workflow-graph`, `ai-manager-two-tier-review`, `ai-manager-architecture`.

## Motivation

Phase 1 let the user stamp an execution **order** onto the orchestrator's top-level flow lines, and the engine runs those teams in sequence by deriving the order onto the Stage-4 `dependsOn` waves. But the plan is still authored **once**: `planNode` runs at the start, and nothing revises it as work comes back. `graph.ts` already supports loops (`goto`) and checkpoints, but no node re-plans.

The user wants the canvas's ordered stages to inform the plan **as the run proceeds**: when an earlier ordered stage finishes (e.g. a research team), the orchestrator reads what came back and, if it genuinely contradicts the plan's premise or reveals a gap, **rewrites the not-yet-run work before it runs** — while the **goal stays immutable**.

The motivating scenario (the user's): order a **research** team first (stage 1) and a **build** team second (stage 2). Research runs, the orchestrator reads it — "the plan assumed PostgreSQL, but research shows Supabase is the better fit" — rewrites the build tasks to use Supabase, and *then* the build runs, **once, on the corrected plan**. If research matches the plan, nothing changes and the run is unaffected.

This is the **proactive / between-stages** re-plan. It is deliberately *not*:
- the **reactive / post-review escalation** (build the wrong thing, then fix it) — a cheap follow-on later that reuses this same node from a different trigger;
- **lateral peer handoffs** (a worker reaching sideways to another team and getting work handed back) — that is **Phase 3**, a routing-core re-architecture (two edge types + handoff runtime + loop bounds) the current reporting tree structurally forbids.

## Goals

- When an **ordered stage** finishes, the orchestrator may **rewrite the remaining (not-yet-run) plan** based on what came back, *before* the next stage runs.
- The **goal is never modified** — the invariant is structural (no node writes `state.goal`).
- **Completed work is frozen** — executed tasks (and their files on disk) are never re-done by a re-plan; the orchestrator may only add / revise / remove the *pending* tasks.
- The re-plan is **orchestrator-judged and conservative** — it fires only when the orchestrator is confident new information warrants it; otherwise it declines and the run proceeds unchanged.
- **Hard-bounded** so a run always terminates (a re-plan cap + a per-boundary "ask once" cursor).
- **No re-plan configured → byte-for-byte today's behavior** (the dormant default).
- Composes with Phase 1: re-plan boundaries *are* the Phase 1 ordered stages; new tasks slot back into the order/`dependsOn` waves automatically.

## Non-goals (out of scope, YAGNI)

- **Reactive / post-review escalation re-plan** (the deferred two-tier-review v2: build, review fails, re-plan, redo). It reuses this node from the `integrationReview` exit — a clean later add, not Phase 2.
- **Lateral / peer-to-peer handoffs** — Phase 3 (two edge types, a handoff runtime, cycle bounds).
- **Re-planning across a non-ordered run** — with no Phase 1 order set there are no stage boundaries, so there is nothing to pause between; the feature is inert (and byte-for-byte).
- **Re-opening completed work** — executed tasks are frozen; if their output must change, the orchestrator adds a *new* task (monotonic → clean termination).
- **Touching the goal** — never.
- **A separate "should I re-plan?" gate call on healthy runs** — the judgment rides a single call that only happens *at* an ordered-stage boundary when the feature is enabled.

## Decisions locked in brainstorming

- **Trigger:** *proactive, between ordered stages* — `executeNode` pauses at a Phase-1 ordered-stage boundary; the orchestrator may rewrite the remaining work before the next stage runs. (NOT reactive/post-review; NOT peer handoffs.)
- **Scope of a re-plan:** add new tasks + revise/split/remove the **pending** (not-yet-run) tasks; **executed tasks frozen**; **goal locked**.
- **Decision:** *orchestrator-judged, information/contradiction-driven, conservative* — one read-only orchestrator call per boundary that judges-and-rewrites in a single shot and may decline.
- **Bound + gate:** new `maxReplans` setting, **default `0` (off → byte-for-byte)**; `replanAttempts` caps actual rewrites; a `replanStageCursor` ensures each boundary is offered at most once.
- **Surfacing:** a `replan` orchestration event (reason + new plan) → a Run-view banner + in-place plan update; History records the re-plans and their reasons.
- **Engine approach:** `executeNode` keeps its proven wave loop and only *pauses* at a boundary when the feature is enabled; the actual sequencing still rides the existing `dependsOn` waves + Phase-1 `deriveOrderDeps`.

## Architecture

### Control flow — one new node, one new back-edge

```
plan → route → execute ─(stage boundary; enabled + budget)→ replan ─(rewrite)→ route → execute …
                  │                                            │
            (all stages done)                             (decline) → execute (resume)
                  ▼
            domainReview → integrationReview → repair↩ → reflect → synthesize → END   (all unchanged)
```

`buildOrchestratorGraph` (`src/main/engine/nodes.ts`) adds the `replan` node and these edges:

```ts
edges: {
  plan: 'route',
  route: 'execute',
  execute: 'domainReview',     // static fall-through when execute does NOT pause
  replan: 'execute',           // static fall-through = decline/resume
  domainReview: 'integrationReview',
  integrationReview: 'reflect',
  repair: 'domainReview',
  reflect: 'synthesize',
  synthesize: END
}
```

- `executeNode` returns `goto:'replan'` only when it pauses at a boundary; otherwise it follows the static edge to `domainReview` exactly as today.
- `replanNode` returns `goto:'route'` only when it rewrites; otherwise it follows the static edge back to `execute` to resume.
- With `maxReplans === 0`, `executeNode` never pauses and `replanNode` is never entered → the path is `plan → route → execute → domainReview → …`, identical to Phase 1.

### Pure helpers (node-free, the real test coverage) — mirrors Phase 1's `workflow-order.ts`

**`src/shared/workflow-order.ts`** gains a sibling of `deriveOrderDeps` (shares the same child-map / subtree / `teamOf` logic):

```ts
/** Each owned task's ordered-stage = the Phase-1 `order` of its top-level team (0 = unordered). */
export function deriveStages(
  edges: { source: string; target: string; order?: number }[],
  orchestratorId: string,
  tasks: { id: string; ownerId: string | null }[]
): Record<string, number>
```

**`src/shared/replan.ts`** (NEW, pure):

```ts
/** The next ordered stage we are about to start AFTER a lower stage finished, or null
 *  (still on the first stage / nothing left / this boundary was already offered). */
export function pendingStageBoundary(
  tasks: Record<string, { status: TaskExecStatus; stage?: number; ownerId: string | null }>,
  replanStageCursor: number
): number | null

/** Apply a re-plan decision: freeze executed tasks, REPLACE all pending tasks with the
 *  decision's revised set (new tasks: pending, ownerId null), rebuild the plan list.
 *  Never reads or writes a goal — the invariant is structural. */
export function mergeReplan(
  plan: RunTask[],
  tasks: Record<string, TaskState>,
  decision: { tasks: RunTask[] }
): { plan: RunTask[]; tasks: Record<string, TaskState> }
```

`pendingStageBoundary` logic (pure): let `executedStages` = stages of tasks with `status !== 'pending'`, `pendingStages` = stages of `pending` tasks. If no pending → `null`. `nextStage = min(pendingStages)`, `maxExecuted = max(executedStages, 0)`. Return `nextStage` iff `nextStage >= 1 && nextStage > replanStageCursor && maxExecuted >= 1 && nextStage > maxExecuted`; else `null`. (So the *first* stage never pauses — there is no completed stage to re-plan on — and a boundary already advanced past by the cursor never re-fires.)

`mergeReplan` logic (pure): keep every task whose `status !== 'pending'` verbatim (frozen, owner + verdict intact); drop all `pending` tasks; add each `decision.tasks` entry as a fresh `TaskState` (`status:'pending'`, `ownerId:null`, `attempts:0`, `dependsOn` carried from the decision if present). Rebuild `plan` = frozen tasks in original plan order, then the decision tasks appended.

### `replanNode` + `replanStep` (`src/main/engine/nodes.ts`)

One read-only orchestrator call (mirrors `planStep`: `permissionMode:'default'`, `disallowedTools: THINK_DISALLOW`):

```ts
async function replanNode(state, _io, eng): Promise<NodeResult> {
  const maxReplans = getSettings().maxReplans ?? 0
  if (maxReplans <= 0 || state.replanAttempts >= maxReplans || eng.abort.signal.aborted) {
    return { goto: 'execute' }   // never enters here when off → no agent call → byte-for-byte
  }
  const boundary = pendingStageBoundary(state.tasks, state.replanStageCursor) ?? state.replanStageCursor
  const executed = ownedTasks(state).filter((t) => t.status !== 'pending')
  const pending  = ownedTasks(state).filter((t) => t.status === 'pending')
  const decision = await replanStep(eng, state.goal, state.orchestratorId, executed, pending)
  if (!decision.replan) {
    return { goto: 'execute', patch: { replanStageCursor: boundary } }  // asked, declined: don't re-ask this boundary
  }
  const { plan, tasks } = mergeReplan(state.plan, structuredClone(state.tasks), decision)
  const attempt = state.replanAttempts + 1
  const replans = [...(state.replans ?? []), { attempt, reason: decision.reason }]
  eng.emit({ runId: eng.runId, type: 'replan', attempt, reason: decision.reason, tasks: plan })
  return {
    patch: { plan, tasks, replans, replanAttempts: attempt, repairAttempts: 0,
             replanStageCursor: boundary, phase: 'replanning' },
    goto: 'route'
  }
}
```

`replanStep` prompt (`replanPrompt`):
- Inputs: the **GOAL, explicitly marked fixed/immutable**; the **completed** stages' tasks + their outputs; the **remaining (pending)** plan.
- Instruction: *only* revise the remaining work if what the completed work **revealed** genuinely contradicts the plan's premise, points to a materially better approach, or surfaces a gap needed for the goal — and you are confident it improves the outcome; **otherwise keep the plan**. The completed work is **done — never redo it** (its changes are on the filesystem and other tasks may depend on them). You may add, remove, revise, or split the remaining tasks. **Do not change the goal.**
- Output (parsed/sanitized like `planStep`): `{ "replan": true|false, "reason": "...", "tasks": [ { "id", "title", "description", "dependsOn": [] } ] }` (`tasks` = the revised remaining set; ignored when `replan:false`).

### `executeNode` — pause at a boundary (only when enabled)

The wave loop is unchanged except for a pause check at the top of the loop:

```ts
while (!eng.abort.signal.aborted) {
  const pending = Object.values(tasks).filter((t) => t.status === 'pending' && t.ownerId)
  if (pending.length === 0) break

  const maxReplans = getSettings().maxReplans ?? 0
  if (maxReplans > 0 && state.replanAttempts < maxReplans) {
    const boundary = pendingStageBoundary(tasks, state.replanStageCursor)
    if (boundary != null) {
      return { patch: { tasks, steps, replanStageCursor: boundary, phase: 'replanning' }, goto: 'replan' }
    }
  }
  // …unchanged: ready = depsSatisfied filter (+ cycle guard) → group by owner → mapCapped runGroup
}
```

`executeNode` advances `replanStageCursor` to the boundary as it pauses, so when `replanNode` resumes execution (whether it rewrote or declined), the loop will not re-trigger at the same boundary — guaranteeing termination. Higher stages can still pause (subject to the `replanAttempts` cap).

### `routeNode` — route only un-owned tasks; re-stamp stages

`routeNode` already assigns owners then merges `deriveOrderDeps` into `dependsOn`. Two changes:
1. Route only **un-owned** tasks: `routeTasks(eng, tasks, steps, orchestratorId, idsWhere(ownerId == null), true)`. On the first pass every task is un-owned → identical to today. On a re-plan pass only the new/revised tasks are routed; frozen tasks keep their owners.
2. After routing, stamp `task.stage = deriveStages(getEdges(), orchestratorId, owned)[id]` for every owned task (alongside the existing `deriveOrderDeps` merge). New tasks thus get their stage + order-deps, slotting into the Phase-1 waves.

### Data model — `src/shared/types.ts`

```ts
// ProjectSettings
maxReplans: number            // default 0 = off; >0 enables + bounds proactive re-plan

// TaskState
stage?: number                // Phase-1 ordered-stage of this task (0/undefined = unordered)

// RunState
replanAttempts: number        // re-plans performed this run (seed 0)
replanStageCursor: number     // highest stage boundary already offered for re-plan (seed 0)
replans?: { attempt: number; reason: string }[]

// RunRecord (History projection)
replans?: { attempt: number; reason: string }[]

// RunPhase
| 'replanning'

// OrchestrationEvent
| { runId: string; type: 'replan'; attempt: number; reason: string; tasks: RunTask[] }
```

`DEFAULT_SETTINGS.maxReplans = 0`. `getSettings()` already spreads `DEFAULT_SETTINGS` over the stored settings, so existing `graph.json` files read `0` with **no migration**. `seedRunState` sets `replanAttempts: 0` and `replanStageCursor: 0`.

### Surfacing

- **`replan` event** → `renderer/store.ts` reducer: set `run.plan = e.tasks` (the new full plan) and push `{ attempt: e.attempt, reason: e.reason }` onto a new `run.replans: { attempt, reason }[]`.
- **`RunView.tsx`**: render a `⚡ Re-planned (#k): <reason>` banner per `run.replans` entry (styled like the existing `run-attempt` line). New/revised tasks flow through their owners' rows automatically (the run tree is by agent).
- **`HistoryView.tsx`**: a small "Re-plans (n)" section listing each `{attempt, reason}` from `record.replans`.
- **`run-state.ts`**: `toRunRecord` projects `replans` (`...(s.replans ? { replans: s.replans } : {})`).

### Settings UI — `src/renderer/SettingsModal.tsx`

A numeric field (near the review/repair controls): **"Max mid-run re-plans (0 = off)"**, clamped `0..3`, bound to `maxReplans` via `updateSettings`.

## Data flow

Canvas (Phase 1): stamp top-level edge `order` → `graph.json`. At run time: `planNode` → `routeNode` (assign owners; `deriveOrderDeps`→`dependsOn`; `deriveStages`→`task.stage`) → `executeNode` waves run stage 1 → **pause at the stage-1→2 boundary** (if `maxReplans>0`) → `replanNode` (orchestrator reads stage-1 output; rewrites the pending build tasks, or declines) → `routeNode` (route only the new tasks) → `executeNode` resumes with stage 2 → … → `domainReview → integrationReview → repair → reflect → synthesize`.

## Error handling / edge cases

- **`maxReplans === 0`** → no pause, `replanNode` never entered, no extra agent call → **byte-for-byte today**.
- **No Phase-1 order set** → all tasks stage 0 → `pendingStageBoundary` returns `null` (no `>=1` boundary) → never pauses → byte-for-byte.
- **Orchestrator declines** (`replan:false`) → resume unchanged; `replanStageCursor` advances so the same boundary is not re-offered.
- **Re-plan returns malformed/empty JSON** → `runStructured` retries once then throws; `replanNode` treats a parse failure as a decline (`goto:'execute'`) so a flaky judgment never aborts a healthy run. (Mirror `reflectStep`'s non-fatal `try/catch`.)
- **Re-plan adds a task with a higher stage** → after the current stage runs, the next boundary may pause again (subject to the `replanAttempts` cap). Bounded.
- **Re-plan drops a pending task** → it simply isn't carried into the new plan; any `dependsOn` referencing a dropped id is tolerated by `depsSatisfied` (unknown ids are ignored) — no hang.
- **Goal immutability** → no node writes `state.goal`; `replanNode`'s patch never includes `goal`; `replanPrompt` never asks for one. Structural invariant.
- **Abort mid-pause** → `runGraph` checks `signal.aborted` each step; `replanNode` early-returns on abort without a call.
- **`replanStageCursor` + cap together** guarantee termination: each boundary offered once, total rewrites ≤ `maxReplans`, executed work never reverts to pending (monotonic).
- **Resume from a checkpoint mid-pause** → `cursor` was saved at `replan` (or at `execute` after the pause patch); re-entry recomputes the boundary from task statuses + the saved `replanStageCursor`, so it resumes correctly.

## Testing

- **Pure unit — `src/shared/workflow-order.test.ts`** (`deriveStages`): two ordered teams → tasks get stage 1 / 2; a nested team (orchestrator→manager→workers, ordered k) → every task under it gets stage k; unordered team → stage 0; no order anywhere → all 0.
- **Pure unit — `src/shared/replan.test.ts`**:
  - `pendingStageBoundary`: first stage (nothing executed) → `null`; stage-1 done + stage-2 pending → `2`; all done → `null`; cursor already at the boundary → `null`; unordered-only → `null`.
  - `mergeReplan`: freezes executed (`status!=='pending'`) tasks verbatim; replaces all pending with the decision set (new = pending, ownerId null); rebuilds `plan` (frozen-then-new); carries `dependsOn`; a decision that re-uses a pending id replaces it; a decision that omits a pending id drops it.
- **Integration — `src/main/engine/nodes.test.ts`** (the canned-agent + mocked-project-store seam, mirroring the existing `dependsOn`-ordering test):
  - **proactive re-plan:** `o → research(team A, order 1)`, `o → build(team B, order 2)`, `maxReplans:1`; the fake agent returns `replan:true` with a revised build task at the boundary → assert: research executes before the replan call; the replan prompt is shown the research output; the build task is replaced and runs; `replanAttempts === 1`; a `replan` event is emitted; execution order is research → (replan) → build.
  - **decline control:** same topology, fake returns `replan:false` → build runs unchanged, no rewrite, `replanAttempts === 0`, resumes to review.
  - **off control:** `maxReplans:0` → no pause, no replan call, byte-for-byte (research + build run as Phase 1; existing assertions hold).
  - **termination:** `replanStageCursor` prevents re-asking the same boundary; with `maxReplans:1` a second boundary does not produce a second rewrite.
- **Renderer** — typecheck + build (house precedent for `store.ts`/`RunView`/`HistoryView`/`SettingsModal`).

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/types.ts` | `ProjectSettings.maxReplans` (+`DEFAULT_SETTINGS=0`); `TaskState.stage?`; `RunState.replanAttempts/replanStageCursor/replans?`; `RunRecord.replans?`; `RunPhase` += `'replanning'`; `OrchestrationEvent` += `'replan'` |
| `src/shared/workflow-order.ts` | NEW pure `deriveStages(edges, orchestratorId, tasks)` (reuses the subtree logic) |
| `src/shared/workflow-order.test.ts` | `deriveStages` tests |
| `src/shared/replan.ts` | NEW pure `pendingStageBoundary` + `mergeReplan` |
| `src/shared/replan.test.ts` | NEW unit tests |
| `src/shared/run-state.ts` | `toRunRecord` projects `replans` |
| `src/main/engine/nodes.ts` | `seedRunState` (+`replanAttempts`/`replanStageCursor`); `routeNode` (route un-owned only + stamp `stage`); `executeNode` (pause at boundary when enabled); NEW `replanNode`/`replanStep`/`replanPrompt`; graph wiring (`replan` node + edges) |
| `src/main/engine/nodes.test.ts` | proactive / decline / off / termination integration tests |
| `src/renderer/store.ts` | `run.replans` + `'replan'` reducer (set plan + push notice) |
| `src/renderer/run/RunView.tsx` | re-plan banner |
| `src/renderer/run/HistoryView.tsx` | "Re-plans (n)" section |
| `src/renderer/SettingsModal.tsx` | `maxReplans` numeric field |
| `src/renderer/styles.css` | banner styling |

**Untouched:** `executeNode`'s wave-loop body (`depsSatisfied`, cycle guard, `runGroup`), `deriveOrderDeps`, the review / repair / reflect / synthesize nodes, `graph.ts`, and `project-store`'s settings plumbing (the spread in `getSettings` already covers the new default).

## Risks / edge cases

- **Byte-for-byte regression** — the load-bearing guarantee. Mitigation: the off-path adds *zero* node hops (the pause check is gated on `maxReplans>0`), `replanNode` makes no call when off, and `task.stage` is inert metadata that never feeds `depsSatisfied`. The "off control" integration test pins this.
- **Non-termination** — two independent backstops: `replanStageCursor` (each boundary offered at most once) and `replanAttempts < maxReplans` (rewrites capped). Executed work is monotonic (never reverts to pending). Tested.
- **Re-plan thrash / over-eager rewrites** — the prompt is explicitly conservative ("only if confident it materially improves the outcome; otherwise keep it"), a parse failure is treated as a decline, and the cap is low (`0..3`, default 0).
- **Stage ambiguity with unordered teams** — `deriveStages` assigns unordered teams stage 0; boundaries only fire for stages `>= 1`, so unordered work never creates a re-plan pause and behaves as in Phase 1. The user's scenario orders *both* the research and build teams, producing clean stages 1 and 2.
- **Resuming a checkpoint taken mid-pause** — the boundary is recomputed from durable task statuses + `replanStageCursor`, so resume is deterministic (Stage-1 durability still holds).
- **Composition with Phase 1** — `deriveOrderDeps` and `deriveStages` re-run in `routeNode` on each pass, so re-planned tasks inherit the canvas order; the re-plan boundaries *are* the Phase-1 stages, so the two features reinforce rather than fight.
