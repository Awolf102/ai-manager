# Spec — R1: Replan/escalate state integrity (`mergeReplan` hardening)

**Date:** 2026-06-29
**Cycle:** R1 — the second item of the `nodes.ts` run-loop cluster (after the HITL+R2 batched cycle).
**Audit findings:** #6, #7, #13 (the `mergeReplan` defects). Tracker row: `R1 | Replan/escalate state integrity`.
**Status of the path:** un-gated. The live-verification session (#35) confirmed re-plan/escalation **won't
fire naturally** (the orchestrator plans well + adapts in-task), so there is no live repro — but the bugs are
**deterministic, unit-testable defects** in a pure function. R1 proceeds via code + unit tests.

---

## Background & root causes (verified against source)

`mergeReplan` (`src/shared/replan.ts:39-67`) folds an orchestrator re-plan/escalation decision into the run:
it **freezes** the tasks not being replaced (e.g. already-passed work) and **replaces** the rest with the
decision's revised tasks. It is called from `applyReplanDecision` (`nodes.ts:555`) on two paths:
- **Proactive replan** (`replanNode`): `replaceIds = undefined` → defaults to all `pending` ids.
- **Escalation** (`escalateNode`): `replaceIds = the failed task ids`; passed tasks are frozen.

Decision tasks come from `parseTasksAndDeps(raw, 'r'|'e')` (`nodes.ts:691`), which uses the **LLM-supplied
`id` verbatim** when it's a non-empty string (only auto-generating `r{n}`/`e{n}` when absent), and filters
each task's `dependsOn` to the decision's **own** task ids. So the collision vector is real: the orchestrator
can hand back a revised task whose id equals an existing/frozen task's id.

Three defects result:
- **#6 — clobbers frozen/passed tasks.** `next[rt.id] = {…fresh pending un-owned TaskState…}` blindly
  overwrites a frozen task when a decision id collides with a kept id. A passed task's result is replaced by an
  empty pending task → the run re-executes already-passed work and the original output is lost.
- **#7 — duplicate plan id / plan↔tasks inconsistency.** `plan = [...frozenInOrder, ...newTasks]` puts both
  the frozen task and the colliding new task into the plan array, while the `tasks` map holds only one entry
  for that id. `formatResults` (which iterates `state.plan`) then renders the id twice and the map/plan disagree.
- **#13 — dangling `dependsOn`.** Frozen tasks are copied verbatim including their original `dependsOn`; if a
  dependency target was among the replaced (dropped) tasks, the dep now points at a non-existent task.
  (`depsSatisfied` tolerates unknown ids, so this does not crash — it is a record-integrity defect.)

**Off-path:** `maxReplans` defaults to `0`, so `mergeReplan` is never reached on a default run. The fix is
**byte-for-byte off-path by construction**, and even when `maxReplans>0`, a non-colliding decision behaves
exactly as today (the existing happy-path tests prove this).

---

## Goal

`mergeReplan` produces a structurally consistent result for **any** decision the orchestrator returns:
1. Passed/frozen tasks are **never** clobbered.
2. The merged `plan` has **unique** ids that **exactly match** `Object.keys(tasks)` (1:1, no duplicates).
3. No task's `dependsOn` references an id absent from the merged tasks.

## Non-goals (YAGNI)

- Changing `parseTasksAndDeps` (its decision-internal dep filtering stays; `mergeReplan` becomes
  self-defensive regardless, so it is correct independent of its caller).
- The replan/escalate **node routing** — verified correct (proactive passes `replaceIds=undefined`=pending;
  escalation passes the failed ids; both `goto: 'route'` after the merge).
- Adding new **cross-set** dependencies (a new task depending on a frozen task) — not a flagged defect.
- Any renderer/Settings/`types.ts` change. No behavior change on the `maxReplans=0` path.

---

## Design

All changes are inside the pure `mergeReplan` (`src/shared/replan.ts`). The invariant it will guarantee:
**final ids = frozen ids ∪ decision ids with no overlap; `plan` = those ids (frozen-in-order, then new) with
no duplicates; every `dependsOn` references an id present in the result.**

### 1. Collision-safe id assignment — re-id, never clobber
- Compute `replace` and `frozen` as today.
- Seed a `used: Set<string>` from the frozen ids.
- Iterate `decision.tasks` **in order**. For each task, take its desired id; if it is already in `used` (a
  frozen id, or an id taken by an earlier decision task), allocate a **fresh deterministic id** via a helper
  `freshId(base, used)`: return `base` if free, else `base + '~' + n` for the smallest `n ≥ 2` not in `used`
  (no randomness — deterministic for tests). Record `oldId → finalId` in a `remap` only when it changed.
- Add the task to `next` under `finalId` as a fresh `{ ownerId: null, status: 'pending', attempts: 0,
  output: '' }` (plus `dependsOn` per step 2). Mark `finalId` used.
- Non-colliding ids are kept unchanged → existing behavior preserved.

This preserves the passed/frozen task **and** keeps the re-planned task (no work lost) — the policy chosen
over "frozen-wins-drop," which would silently discard requested re-planned work.

### 2. Dependency remap + dangling cleanup
- For each new task: `dependsOn = (decision.deps[oldId] ?? []).map(d => remap[d] ?? d)`, then **filter to ids
  present in the final `next`** (drops danglers; also drops a self-reference if one survives). Omit the
  `dependsOn` key entirely when the result is empty (keeps output shape identical to today for the no-dep case).
- **Re-filter every frozen task's `dependsOn`** against the final `next` so a replaced-target dependency no
  longer dangles. Only rewrite a frozen task's `dependsOn` when it actually changes (avoid needless churn /
  shape changes for unaffected frozen tasks).

"repointed-or-dropped" is implemented as **drop** — safe because `depsSatisfied` already skips unknown ids and
a dropped dependency cannot wrongly block execution.

### 3. Consistent plan
- `plan = [...frozenInOrder, ...newTasks]` where `newTasks` use the **final** (possibly re-ided) ids.
- Uniqueness is now guaranteed by step 1, so `plan` ids `=== Object.keys(next)` exactly (asserted in tests).

---

## Files

- Modify: `src/shared/replan.ts` — rewrite `mergeReplan` body (and a small `freshId` helper). `pendingStageBoundary` unchanged.
- Test: `src/shared/replan.test.ts` — additive integrity tests (below).
- No other files.

## Tests (TDD, additive to the existing suite)

1. **Collision (proactive):** a decision task reuses a **frozen executed** id → frozen task preserved verbatim
   (status/output intact), the new task present under a fresh id, and it appears in the plan.
2. **Collision (escalation):** `replaceIds = [failed]`, a decision task reuses a **passed** id → the passed
   task preserved; new task present under a fresh id.
3. **Plan/tasks consistency:** after any merge, assert `plan` ids are unique and `=== Object.keys(tasks)`
   (a small shared invariant helper used across the new cases).
4. **Decision-internal duplicate ids:** decision returns two tasks with the same id → both kept, second
   re-ided; ids unique.
5. **Dangling dep — new task:** a new task's dep points at a replaced/unknown id → dropped (not present in its
   `dependsOn`).
6. **Dangling dep — frozen task:** a frozen task depends on a replaced (dropped) id → that dep removed; deps on
   still-present tasks retained.
7. **Re-id deps remap:** a new task depends on a sibling new task whose id got re-ided → the dep points at the
   **new** id (not the stale one).
8. **No-collision regression:** the existing happy-path tests (freeze/replace/deps/replaceIds) stay green
   byte-for-byte (non-colliding decisions are unchanged).

## Acceptance criteria

- Passed/frozen tasks always survive a replan/escalation (never clobbered).
- Merged `plan` and `tasks` are always consistent: unique ids, 1:1 correspondence.
- No `dependsOn` references an id absent from the merged tasks.
- `maxReplans = 0` path byte-for-byte unchanged; non-colliding decisions byte-for-byte unchanged.
- Full suite + `tsc` (node+web) + `build` green.

## Risks

- **Serial-file note:** R1 touches `src/shared/replan.ts` (and its test) — *not* `nodes.ts` directly — so it
  does not collide with R3. Still run the cluster serially per the tracker; this cycle's surface is small.
- **Determinism:** `freshId` must be deterministic (suffix scan, no randomness) so tests are stable and resume
  is unaffected.
- **Output-shape parity:** for non-colliding, no-dangling decisions the returned objects must be shaped exactly
  as today (omit empty `dependsOn`, don't rewrite unaffected frozen tasks) — a reviewer focus area to confirm
  the off-path/no-collision byte-for-byte claim.
