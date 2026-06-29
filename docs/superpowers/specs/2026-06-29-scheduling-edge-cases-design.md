# Spec — R3: Scheduling edge cases (#22 multi-asker HITL, #26 self-dep, #15 staged team writes)

**Date:** 2026-06-29
**Cycle:** R3 — the final item of the `nodes.ts` run-loop cluster (after HITL+R2 and R1).
**Audit findings:** #22 (multi-asker HITL), #26 (`deriveOrderDeps` self-dep), #15 (staged team writes →
orphans). Three independent edge-case integrity fixes in three disjoint files, batched as one cycle.

---

## Background & root causes (verified against source)

### #26 — `deriveOrderDeps` self-dependency (`src/shared/workflow-order.ts`)
When a worker is shared across two ordered top-level teams, its tasks appear in BOTH the "earlier" team-task
set and the "current" one, so `out[id] = earlier` includes `id` itself (`workflow-order.ts:55-60`). The self-dep
filter `x !== id` lives only in `parseTasksAndDeps` (`nodes.ts:705`), NOT where `deriveOrderDeps`'s output is
merged into `t.dependsOn` (`nodes.ts:158-162`), so the self-dep survives. `depsSatisfied(t)` is then permanently
false for that task; only the wave-loop cycle-guard (run-everything-when-nothing-ready) keeps the run from
hanging. Record-integrity defect.

### #15 — staged team writes leave orphans on failure (`src/main/engine/project-store.ts`, must-fix)
`importTeam` (`project-store.ts:765-797`) and `applySpawnedTeam` (`project-store.ts:799-849`) both loop
`fs.mkdir`/`fs.writeFile` of each member's `role.md`/`memory.md` AND push graph nodes, then `saveGraph()` only
at the very end. If a write throws partway (disk full, permission) or the app crashes mid-loop, the filesystem
holds files for partially-created members while `graph.json` has none of them, and the in-memory `graph` holds
nodes that were never persisted (a subsequent unrelated `saveGraph` could then persist a half-built team).
There is no rollback. The docstring even claims "Saves the graph LAST for atomicity" — the opposite of atomic.

### #22 — multiple same-wave askers discarded (`src/main/engine/nodes.ts`)
`asksAvailable()` is `userRequestCount < maxUserRequests`, evaluated per worker at prompt-build/ask-detection
time, but `userRequestCount` is not incremented until a pause commits. So in one parallel wave every worker
sees the ask affordance and any number can emit an ` ```ask ``` ` block. Each asking worker has its group reset
to `pending` and pushes onto the local `asks` array — but only `asks[0]` (first by plan order) is honored
(saved to `pendingAsk`, persisted). The other askers' captured `sessionId`/`question` live only in the local
array and are discarded when the node returns. On resume, the wave loop re-runs them via `runGroup` with
`resume:false` and a fresh prompt — losing their in-progress session, re-doing work, and never surfacing their
question (and potentially re-looping the ask).

---

## Goals

1. **#26:** `deriveOrderDeps` never emits a self-dependency.
2. **#15:** `importTeam`/`applySpawnedTeam` are transactional w.r.t. errors — on any failure (file write or
   `saveGraph`) the project is left exactly as before the call (no orphan dirs, no half-mutated graph).
3. **#22:** No same-wave asker's session/question is discarded. Every asker's captured session is resumed
   (never re-run from scratch). The user is prompted for each asker's question **up to the `maxUserRequests`
   budget**; asks beyond the budget auto-continue the worker's session with a "no answer; use your judgment"
   message. (Chosen policy: queue & present sequentially, per the audit's suggested fix.)

## Non-goals (YAGNI)

- The deeper "a worker shared across two ordered teams produces mutual deps between its own sibling tasks" —
  #26 fixes only the literal self-dep the audit flagged; the cycle-guard already handles any residual mutual
  deps. (A shared worker across ordered teams is itself an unusual topology.)
- Full crash-atomicity of team writes (a journal/2-phase commit) — #15 fixes the realistic *error* path with
  rollback; a hard-kill mid-op orphan remains a documented residual.
- The broader graph-mutation concurrency story (a concurrent unrelated `saveGraph` racing a bulk team add) —
  that is P2 mutex territory, out of scope here.
- Any renderer/Settings change. Off-path behavior must be byte-for-byte unchanged.

---

## Design

### #26 — filter self-references in `deriveOrderDeps` (`src/shared/workflow-order.ts`)
In the dep-building loop, exclude the task's own id and skip an entry that becomes empty:
```ts
for (let k = 0; k < teamTasks.length; k++) {
  const earlier = [...new Set(teamTasks.slice(0, k).flat())]
  if (earlier.length === 0) continue
  for (const id of teamTasks[k]) {
    const deps = earlier.filter((e) => e !== id) // never depend on yourself (shared-worker case)
    if (deps.length) out[id] = deps
  }
}
```
Pure-function fix; the `nodes.ts` merge site is left unchanged (the source no longer emits a self-dep).

### #15 — transactional team writes (`src/main/engine/project-store.ts`)
Introduce two small module-local helpers and route both functions through them:

- `rollbackDirs(dirs: string[]): Promise<void>` — best-effort `fs.rm(dir, {recursive, force})` for each
  (swallow per-dir errors).
- `commitTeamAdditions(graph, writes, newNodes, newEdges, linkedTeam?): Promise<ProjectGraph>` — where
  `writes: { dir: string; role: string; memory: string }[]`:
  1. Write all member files first, tracking `createdDirs`. On any error → `rollbackDirs(createdDirs)`; rethrow
     (graph untouched).
  2. Snapshot `graph.nodes.length`, `graph.edges.length`, `graph.linkedTeam`; push `newNodes`/`newEdges`; set
     `linkedTeam` if given; `await saveGraph()`. On error → truncate `graph.nodes`/`graph.edges` back to the
     snapshot lengths (push-only, so truncation reverts), restore `linkedTeam`, `rollbackDirs(createdDirs)`,
     rethrow.

Refactor `importTeam` and `applySpawnedTeam` to compute all ids/slugs/layout/edges **without any fs or graph
mutation**, build the three local arrays (`writes`, `newNodes`, `newEdges`), and call `commitTeamAdditions`.
Happy-path output is byte-for-byte identical (same files written, same nodes/edges pushed, same `saveGraph`
result) — only the *ordering* (all files, then graph) and the error handling change. Update the misleading
"Saves the graph LAST for atomicity" docstring.

*Assumption noted in code:* slugs are uniquified against the in-memory graph, so a created dir is new; rollback
removing it is safe. (A pre-existing orphan dir from a prior failed import is itself the pre-existing concern
this fix reduces.)

### #22 — queue & drain same-wave asks, bounded by budget (`src/main/engine/nodes.ts` + `src/shared/types.ts`)
**State:** add `askQueue?: { ownerId: string; taskIds: string[]; sessionId?: string; question: string }[]` to
`RunState` (`types.ts`) — the asks still to be presented after the current `pendingAsk`. (Same element shape as
the existing `pendingAsk`.) It is checkpoint-only (not added to `RunRecord`/`toRunRecord` — transient, cleared
when drained). Add `askQueue: undefined` to the executeNode `scrub` object so every non-ask return clears it.

**Capture** (executeNode, after the wave's `mapCapped`, when `asks.length > 0`, sorted by plan order):
- `slots = maxUserRequests - userRequestCount` (remaining budget; ≥1, since `asksAvailable()` held during the
  wave). `present = asks.slice(0, slots)`; `overflow = asks.slice(slots)`.
- For each `overflow` asker: resume its captured session with the existing no-answer continuation
  (`answerResumePrompt('')` / the Skip prompt — the same path a Skip uses), capture+redact output into its
  tasks/steps, mark done. No budget consumed (it was never presented). (On a resume error, mirror the existing
  resume catch.)
- `pendingAsk = present[0]`; `askQueue = present.slice(1)` (omit when empty); push `present[0]`'s question into
  `userRequests`; return the interrupt for `present[0]` (carry `askQueue` in the patch).

**Resume re-entry** (executeNode, when `state.resumeInput !== undefined && state.pendingAsk`):
- Resume `pendingAsk`'s session with the answer, redact + capture output, mark its tasks done, checkpoint,
  `userRequestCount += 1` (all exactly as today).
- **Then drain:** if `state.askQueue?.length`, pop the next → set `pendingAsk = next`, `askQueue = rest`, push
  `next.question` into `userRequests`, and return a fresh `ask-user` interrupt for `next` (do NOT fall through
  to the wave loop). When the queue is empty, fall through to the wave loop as today.

**Single-asker path (the common case) is byte-for-byte:** one ask → `present=[a0]`, `askQueue` empty/omitted,
one pause, one resume, no drain → identical to today. `maxUserRequests=0` → no asks → unchanged. S5 redaction
applies at the same single capture point for each drained ask; P3 crash-resume re-shows `pendingAsk` and the
persisted `askQueue` drains afterward.

---

## Files

- `src/shared/workflow-order.ts` — `deriveOrderDeps` self-filter. Test: `src/shared/workflow-order.test.ts`.
- `src/main/engine/project-store.ts` — `rollbackDirs` + `commitTeamAdditions`; refactor `importTeam`/
  `applySpawnedTeam`. Test: the existing project-store test file(s).
- `src/main/engine/nodes.ts` — capture + resume-drain for the ask queue; `scrub` clears `askQueue`.
- `src/shared/types.ts` — add `askQueue?` to `RunState` (no `RunRecord` change).
- Test: `src/main/engine/nodes.test.ts`.
- No renderer changes.

## Tests (TDD, additive)

**#26:** shared worker across two ordered teams → that worker's task has NO self-dep (and keeps its legit
cross-team deps); the existing ordering tests (non-shared) stay green; unordered → `{}` unchanged.

**#15:** (a) happy path unchanged (files written + nodes/edges saved) for both `importTeam` and
`applySpawnedTeam`; (b) a forced `fs.writeFile` failure mid-loop → no graph node added, no orphan dir left
(rollback), error propagated; (c) a forced `saveGraph` failure → graph reverted to its prior nodes/edges/
linkedTeam AND created dirs removed, error propagated.

**#22:** (a) two workers ask in one wave with `maxUserRequests=2` → two sequential pauses, each resumes its OWN
captured session (assert each asker's `resume` call uses its `sessionId`, not a fresh run), both questions
recorded in `userRequests`; (b) two ask with `maxUserRequests=1` → one pause, the overflow asker's session is
resumed with the no-answer continuation (not re-run fresh) and its task completes; (c) single asker →
byte-for-byte one pause/one resume (existing HITL tests stay green); (d) `maxUserRequests=0` → unchanged.

## Acceptance criteria

- `deriveOrderDeps` output never contains `id` in `out[id]`.
- A failed `importTeam`/`applySpawnedTeam` leaves the project exactly as before (no orphan dirs, graph
  unchanged); the happy path is byte-for-byte unchanged.
- No same-wave asker is re-run from scratch; questions are presented up to `maxUserRequests`, the rest
  auto-continue; single-asker and `maxUserRequests=0` paths byte-for-byte.
- Full suite + `tsc` (node+web) + `build` green.

## Risks

- **Serial-file:** R3 is the last `nodes.ts` cluster item — run alone (the others are merged). `nodes.ts`,
  `project-store.ts`, `workflow-order.ts`, `types.ts` are all touched but the three fixes are in disjoint
  regions; still implement as three tasks.
- **#22 resume machinery:** the drain reuses the existing single resume capture point (S5 redaction intact) and
  the existing interrupt shape — verify the single-asker and `maxUserRequests=0` paths are byte-for-byte (a
  reviewer focus). The persisted `askQueue` must be cleared on every terminal/scrub path so it never leaks into
  a later wave.
- **#15 rollback safety:** `rollbackDirs` must only remove dirs created in this op; confirm slug uniquification
  guarantees fresh dirs (documented assumption).
