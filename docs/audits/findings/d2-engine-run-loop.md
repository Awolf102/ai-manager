# Dimension 2 — Code correctness (engine run loop)

> **Status: historical — remediated.** This is an internal audit report from the
> 2026-06 review cycle, kept for the record. Every Critical and Important finding
> below has been fixed and merged; see
> [`docs/audits/2026-06-27-remediation-cycles.md`](../2026-06-27-remediation-cycles.md)
> for the per-cycle remediation log. Do not read the findings below as open issues.


<!-- VERIFICATION-ANCHOR -->


Scope: a deep static correctness review of the orchestration run loop —
`src/main/engine/nodes.ts` (the plan→route→execute→review→repair→reflect→synthesize
graph plus replan/escalate/handoff), `src/main/engine/graph.ts` (the state-graph
runtime), and `src/main/engine/orchestrator.ts` (the start/resume/finish driver). The
hunt focused on cross-feature interference between the wave-loop, `dependsOn`, clickable
ordering, proactive replan, reactive escalate, lateral handoffs and HITL; resume /
checkpoint correctness; review/repair termination; error handling; and whether each
"off = byte-for-byte" feature truly leaves the legacy path unchanged. Findings are
ordered Critical → Important → Minor.

---

### [Critical] `mergeReplan` leaves dangling `dependsOn` after escalate/replan drops tasks — silent ordering violation

**Location** `src/shared/replan.ts:39-67` (merge), consumed via
`src/main/engine/nodes.ts:560` (`applyReplanDecision`) and read by `depsSatisfied`
`src/main/engine/nodes.ts:1078-1085`.

**What's wrong** When escalate (or a proactive replan with explicit `replaceIds`)
drops a failed task `t3` and replaces it with new tasks (`e1`, `e2`), any *frozen*
task that declared `dependsOn: ['t3']` keeps that dependency, but `t3` no longer exists
in the merged `tasks` map. `mergeReplan` never rewrites or scrubs the surviving tasks'
`dependsOn` arrays, and it never re-points them at the replacement tasks. On the next
wave, `depsSatisfied` treats the missing `t3` as "unknown id → don't wait on it"
(`nodes.ts:1081`), so the dependent task becomes immediately eligible.

**Why it matters** A task that was *required* to run after `t3` will now run before (or
in parallel with) the re-broken-up replacement work that semantically supersedes `t3`.
The dependency the planner deliberately set is silently discarded, producing
out-of-order execution (e.g. a frontend task that depended on a now-replaced backend
task runs against the not-yet-rebuilt backend). The no-deadlock guard masks the bug —
the run completes, just in the wrong order, which is exactly the "silent wrong behavior"
Critical class.

**Suggested fix** In `mergeReplan`, after building the frozen set, rewrite each frozen
task's `dependsOn` to drop ids in `replace` (and optionally re-target them onto the
decision's new task ids), or have `escalateNode`/`applyReplanDecision` pass the
replacement mapping so dependents can be re-linked.

---

### [Critical] One `replan`-flagged failure starves all `repair`-flagged siblings of their repair attempts

**Location** `src/main/engine/nodes.ts:442-452` (domainReview) and the mirror at
`nodes.ts:494-505` (integrationReview); escalate decline paths at
`nodes.ts:604-615`.

**What's wrong** Review routes to `escalate` whenever *any* failed task is flagged
`disposition === 'replan'` (`misScoped.length > 0`), and `escalateNode` re-derives the
*entire* failed set and either re-breaks-up all of them or, on a parse failure / empty
decision / budget exhaustion, returns straight to `reflect` (`nodes.ts:604`, `610`,
`613`). The `repair` branch (`nodes.ts:449`) is only reached when there are zero
`replan`-flagged failures. So a single mis-scoped task short-circuits the repair loop
for every *correctly-scoped-but-buggy* sibling.

**Why it matters** A run with five failed tasks, four of them ordinary "re-run can fix
it" failures and one mis-scoped, will, when escalate then declines (a very common path —
`maxReplans` defaults to 0, and even when on, the orchestrator may decline or emit
unparseable JSON), send all five to `reflect`/`synthesize` as permanently failed without
ever attempting the four cheap repairs that would have passed. Work that the existing
repair budget would have fixed is silently abandoned.

**Suggested fix** Split the not-passed set: send only the `replan`-disposition tasks to
`escalate`, and still run `repair` for the `repair`-disposition tasks (or fall through to
`repair` for the non-mis-scoped failures when escalate declines), rather than letting one
`replan` flag govern the whole batch.

---

### [Important] Multiple workers asking the user in the same wave: the non-chosen askers' in-flight sessions and questions are discarded

**Location** `src/main/engine/nodes.ts:304-312` (per-worker ask capture) and
`nodes.ts:362-376` (pause selection).

**What's wrong** `asksAvailable()` is evaluated per worker at prompt-build and
ask-detection time, but `userRequestCount` is not incremented until a pause is committed.
So in a single wave every worker sees the ask affordance and any number can emit an
```ask``` block. Each asking worker has its whole group reset to `pending` and pushes an
entry into the local `asks` array. Only `asks[0]` (first by plan order) is honored: it is
saved into `pendingAsk` and persisted. The other askers' captured `sessionId` and
`question` live only in the function-local `asks` array and are thrown away when the node
returns.

**Why it matters** After the user answers the chosen worker, the run resumes and the wave
loop re-runs. The other askers' tasks are still `pending`, so they are re-executed via
`runGroup` with `resume: false` and a fresh `workerPrompt` — losing the prior in-progress
session/context and re-doing work from scratch. Their original question is never surfaced
to the user. Under realistic multi-worker waves with HITL enabled this wastes a full
agent run per discarded asker and can loop them re-asking.

**Suggested fix** Either serialize ask handling (decrement availability as asks are
captured so at most one worker per wave is offered the affordance), or queue all asks and
present/resume them sequentially across multiple interrupts, threading each asker's
`sessionId`.

---

### [Important] `RunState.handoffs` is declared and projected to History but never populated by the engine

**Location** declared `src/shared/types.ts:407`; projected in
`src/shared/run-state.ts:29` (`toRunRecord`); the only handoff write path is the *event*
emit in `src/main/engine/nodes.ts:985` (`runWithHandoffs`). No node ever writes
`state.handoffs`.

**What's wrong** `runWithHandoffs` emits a live `handoff` OrchestrationEvent (which the
renderer store accumulates) but never appends to `RunState.handoffs`. Because
`toRunRecord` copies `s.handoffs` only `if (s.handoffs !== undefined)` and it is always
undefined, every persisted run and every History record permanently omits the handoffs
that actually occurred.

**Why it matters** This is the symmetric counterpart to `replans`/`userRequests`, both of
which *are* written to state and survive into History. Handoffs silently vanish from the
durable record — the History "Handoff" section the feature memo describes will always be
empty, and a crashed-then-resumed run loses all knowledge that consults happened.

**Suggested fix** In `runWithHandoffs` (or `runGroup` after it returns), accumulate the
`{askerId, peerId, ask}` entries and fold them into the returned node patch so they land
in `RunState.handoffs` and thus `toRunRecord`.

---

### [Important] Checkpoints written during a parallel wave capture non-atomic, half-updated snapshots

**Location** `src/main/engine/nodes.ts:330` (per-`runGroup` checkpoint) under the
parallel `mapCapped` at `nodes.ts:360`; same pattern in `domainReviewNode`'s parallel
reviewers (`nodes.ts:412`) which share `steps`.

**What's wrong** Up to `MAX_PARALLEL` `runGroup` invocations mutate the *shared* `tasks`
and `steps` objects concurrently and each, after its own agent call, writes a checkpoint
via `io.checkpoint({ ...state, tasks: structuredClone(tasks), steps: { ...steps } })`.
Because the snapshot is taken at an `await` boundary, a group can persist a state in which
its own task is `done` but a sibling group's task is still `running` (or vice versa) and a
sibling's `steps` entry is mid-transition. JS single-threading prevents torn objects, but
the *checkpoint* is an arbitrary interleaving, not a consistent wave snapshot.

**Why it matters** If the process crashes between two parallel groups' checkpoints, the
resumed run re-enters `executeNode` and re-runs whichever sibling tasks were still
`pending`/`running` in that snapshot — generally safe, but a group recorded as `running`
(never reset to `pending`) is filtered out by the wave loop (`status === 'pending'`) and
is neither re-run nor reviewed, so its task can be dropped from the run. The window is
narrow but real.

**Suggested fix** Reset interrupted tasks from `running`→`pending` on `executeNode`
re-entry (so a mid-flight task is always re-run), and/or checkpoint once per wave after
`mapCapped` resolves rather than from inside each concurrent `runGroup`.

---

### [Important] A `replan`-disposition failure that escalate cannot resolve is abandoned with no repair fallback

**Location** `src/main/engine/nodes.ts:599-617` (escalate decline branches).

**What's wrong** `escalateNode` returns directly to `reflect` (via `markWorkersDone` and
the static edge) on any of: budget exhausted, no failed tasks, abort, `escalateStep`
parse failure, or an empty decision (`nodes.ts:604`, `610`, `613`). In every decline case
the still-`failed` tasks are left `failed` and never get a repair pass — they flow into
`synthesize` as failures even though `maxRepairAttempts` budget may be untouched.

**Why it matters** Combined with the second Critical above, a transient JSON parse failure
in the escalate step (the orchestrator is asked for strict JSON only once here — there is
no retry path inside `escalateStep` beyond `runStructured`'s 2 tries) permanently dooms
the failed work. The user sees an incomplete result with no indication that a cheap repair
would have helped.

**Suggested fix** On an escalate decline, fall back to the normal `repair` loop for the
failed tasks (subject to `repairAttempts < maxAttempts`) instead of giving up to
`reflect`.

---

### [Important] `runStructured` retry (attempt 2) drops the handoff affordance, so a reviewer that consulted on attempt 1 cannot on the retry

**Location** `src/main/engine/nodes.ts:1031` —
`const { text } = attempt === 0 ? await runWithHandoffs(eng, base, consult) : await eng.runAgent(base)`.

**What's wrong** Only the first attempt routes through `runWithHandoffs`; the strict-JSON
retry calls `eng.runAgent(base)` directly. If a review/integration step's first attempt
returned only a handoff block (so it produced no parseable JSON), the retry runs with the
plain prompt (no `handoffSection`) and the agent has no way to repeat or complete the
consult, making the retry likely to fail the same way and throw.

**Why it matters** A reviewer that legitimately needs a peer consult to render a verdict
gets one shot; the "retry on parse failure" safety net actively removes the tool the agent
was mid-using. The whole review node then throws (caught in `domainReviewNode` at
`nodes.ts:425` → group left unreviewed, or in `integrationReviewNode` at `nodes.ts:478` →
straight to reflect, skipping repair). Off-path (maxHandoffs=0) this is inert.

**Suggested fix** Route the retry through `runWithHandoffs` as well, or strip a stray
trailing handoff/ask block before parsing so a JSON answer that merely co-occurred with a
consult block is still parseable.

---

### [Minor] `deriveStages` stamps `stage: 0` on every task even when no edge is ordered — persisted-state divergence vs. pre-feature runs

**Location** `src/shared/workflow-order.ts:81-86` and the unconditional write
`src/main/engine/nodes.ts:163-166`.

**What's wrong** `routeNode` always calls `deriveStages` and writes the result for every
task; `deriveStages` returns `0` for unordered/unowned tasks, so every `TaskState` now
carries `stage: 0`. Before the ordering feature, `TaskState.stage` was absent. The
checkpoint/History therefore differs byte-for-byte from the legacy shape.

**Why it matters** Behaviorally inert (`pendingStageBoundary` reads `stage ?? 0`, and it
is gated behind `maxReplans > 0`), but it violates the "off = byte-for-byte" claim at the
serialized-state level and slightly bloats every checkpoint.

**Suggested fix** Only set `stage` when a non-zero stage exists (skip the write when
`stage === 0`), matching the conditional `dependsOn` write a few lines above.

---

### [Minor] Review verdicts always carry `disposition: 'repair'` even when re-planning is off — state-shape divergence

**Location** `src/main/engine/nodes.ts:431` and `nodes.ts:486`; defaulted in
`reviewStep`/`integrationReviewStep` (`nodes.ts:772-779`, `804-811`).

**What's wrong** Even with `maxReplans = 0` (the prompt omits the disposition field and
the schema has none), the parser defaults `disposition` to `'repair'` and the node always
writes `t.verdict.disposition`. Pre-feature, `verdict` had no `disposition`.

**Why it matters** Inert to control flow (the `misScoped` filter requires
`disposition === 'replan'` *and* `maxReplans > 0`), but the persisted `TaskState.verdict`
shape diverges from the legacy run, again denting the byte-for-byte invariant.

**Suggested fix** Only attach `disposition` to the stored verdict when
`(getSettings().maxReplans ?? 0) > 0`.

---

### [Minor] A worker cannot chain a second ask after a HITL resume; the re-entry path does not re-detect asks

**Location** `src/main/engine/nodes.ts:237-275` (the re-entry block).

**What's wrong** When the asking worker is resumed with the user's answer, its output is
unconditionally treated as final work (`t.status = 'done'`, `nodes.ts:258-261`); the block
never runs `parseAskUser` on the resume output. If the worker, given the answer, discovers
it still needs one more clarification, that second ask is silently consumed as task output.

**Why it matters** Minor UX/correctness gap — the worker's follow-up question becomes
garbage "output" rather than a new pause. Bounded and only with HITL on.

**Suggested fix** In the re-entry block, run `parseAskUser` on the resume text (subject to
`asksAvailable()`), and re-pause with a fresh `pendingAsk` carrying the new `sessionId`
when present.

---

### [Minor] Settings are re-read live on every node, so changing settings between a crash and a resume can produce an inconsistent run

**Location** every `getSettings()` call inside a node, e.g.
`src/main/engine/nodes.ts:228`, `286`, `342`, `443`, `573`, `600`, `914`; resume entry
`src/main/engine/orchestrator.ts:85-103`.

**What's wrong** `actingMode` is snapshotted into `RunState` at seed time, but
`maxReplans`, `maxHandoffs`, `maxUserRequests`, `adaptiveEffort`, `reviewMode`,
`maxRepairAttempts` are all read fresh from `getSettings()` each time a node runs. A run
that was checkpointed mid-replan and is later resumed after the user toggled `maxReplans`
off (or lowered `maxRepairAttempts` below the already-consumed `repairAttempts`) will take
a different branch than it would have, e.g. abandoning an in-progress replan/repair cycle.

**Why it matters** Edge case (requires a settings change between crash and resume), but it
means a resumed run is not a faithful continuation of the original run's policy.

**Suggested fix** Snapshot the run-governing settings into `RunState` at `seedRunState`
(as `actingMode` already is) and read them from state inside the nodes, so a resume honors
the policy the run started under.

---

### [Minor] `nodes.ts` (1505 lines) genuinely does too much — three cohesive units should be extracted

**Location** `src/main/engine/nodes.ts` in full; the natural seams are the prompt
builders (`nodes.ts:1224-1505`, ~280 lines), the Claude "step" wrappers
(`nodes.ts:683-1037`, the `planStep`/`assignStep`/`reviewStep`/`replanStep`/`escalateStep`
/`reflectStep`/`synthesizeStep` + `runStructured`/`runWithHandoffs`/`parseJsonBlock`
cluster), and the graph nodes themselves (`nodes.ts:132-681`).

**What's wrong** A single file owns the graph wiring, all ten node bodies, all Claude
dispatch/parse plumbing, every prompt string, and ~20 state helpers. The prompts are pure
strings with no engine coupling; the step wrappers are a self-contained
"talk-to-an-agent-and-parse-JSON" layer.

**Why it matters** The file is the hardest part of the engine to reason about precisely
because the run-loop control flow is interleaved with hundreds of lines of prompt text and
JSON-parsing minutiae; this directly raised the cost of *this* audit and the
cross-feature bugs above hide in that volume.

**Suggested fix** Extract `engine/prompts.ts` (all prompt builders + `STRICT_REMINDER`)
and `engine/agent-steps.ts` (the `*Step` functions + `runStructured` + `runWithHandoffs` +
`parseJsonBlock`), leaving `nodes.ts` as the graph + node bodies + small state helpers.

---

### [Minor] `saveGraph` writes `graph.json` non-atomically while parallel `updateAgent` calls race on it during a wave

**Location** `src/main/engine/project-store.ts:152-155` (`saveGraph`), called from
`updateAgent` (`project-store.ts:233`) which the wave invokes per worker
(`src/main/engine/nodes.ts:313`, `256`, `531`).

**What's wrong** During a parallel wave, each finishing `runGroup` calls
`updateAgent({sessionId})`, and each `updateAgent` does a full `fs.writeFile` of the
shared in-memory `graph` with no tmp-file + rename. Concurrent writers and a crash
mid-write can leave a truncated/corrupt `graph.json`. (Session data itself isn't lost
because all writers mutate the same shared object, so the last write contains every node's
update — but the file write is not crash-safe.)

**Why it matters** A corrupt `graph.json` breaks the whole project, not just the run.
Mostly a durability concern (overlaps Dimension 1), surfaced here because the run loop is
what drives the concurrent writes.

**Suggested fix** Make `saveGraph` atomic (write to `${file}.tmp` then `fs.rename`), as
`run-store.ts` already does for checkpoints.

## Verification

Adversarial verification pass. Each verdict cites the exact code re-read.

- **d2-engine-run-loop-1 — confirmed (Critical).** `mergeReplan` (`src/shared/replan.ts:49-66`) drops `replace` ids and never rewrites the surviving frozen tasks' `dependsOn`; new tasks get fresh ids (`e1`/`r1` via `parseTasksAndDeps`, `nodes.ts:899`/`879`). A frozen task whose `dependsOn` referenced a dropped/replaced id is left with a dangling reference, and `depsSatisfied` (`nodes.ts:1078-1085`) explicitly treats an unknown id as "don't wait" (`if (!dep || !dep.ownerId) continue`). So a dependent runs out of order against the re-broken-up work. Real, silent ordering violation; only fires when `maxReplans>0`, but Critical when it does.

- **d2-engine-run-loop-2 — confirmed (Critical).** `domainReviewNode` 446-448 (mirror `integrationReviewNode` 498-500): ANY `disposition==='replan'` failure (`misScoped.length>0`) routes via `goto:'escalate'` BEFORE the repair branch at 449/501 is even reached. `escalateNode` decline paths (604-606 budget/empty, 610-612 parse fail, 613-615 empty tasks) all `return { patch: { steps: markWorkersDone(...), phase:'reflecting' } }` → static edge to reflect. Repair-able siblings in the same batch never get a repair pass even though `state.repairAttempts < maxAttempts`. Confirmed. Gated by `maxReplans>0`.

- **d2-engine-run-loop-3 — confirmed (Important).** `asksAvailable()` (233) gates per-worker ask detection inside `runGroup` (305-311), so every worker in a wave can push to `asks[]`. After `mapCapped` (360), 363-376 sorts and takes only `asks[0]` as `chosen`; the other askers' `sessionId` and `question` are discarded and their tasks were set back to `'pending'` (308) with no recorded `pendingAsk`, so the next wave re-runs them with `resume:false` (296). Confirmed.

- **d2-engine-run-loop-4 — confirmed (Important).** Grep over `src/main/engine` and `run-state.ts` shows the only `handoff` write is the live `eng.emit` at `nodes.ts:985`; `state.handoffs` is never assigned anywhere. `run-state.ts:29` conditionally projects `s.handoffs` but it is always `undefined`, so every persisted/History record omits handoffs — unlike `replans` (written at `applyReplanDecision`, 562) and `userRequests` (written at 366). Confirmed.

- **d2-engine-run-loop-5 — confirmed (Important).** `runGroup` checkpoints the shared `tasks`/`steps` at its own await boundary (`io.checkpoint`, 330) and runs concurrently under `mapCapped(..., MAX_PARALLEL, ...)` (360). A worker sets its group `'running'` (282) before its agent call; a checkpoint written by a sibling worker that finishes first captures the still-`'running'` group. On crash-resume the wave loop only re-runs `status==='pending'` (338) and review only looks at `status==='done'` (396), so a task stuck `'running'` is neither re-run nor reviewed — silently dropped. Confirmed; requires a crash mid-wave.

- **d2-engine-run-loop-6 — confirmed (Important).** Same code as finding 2 from the "no repair fallback" angle: `escalateNode` 604-615 all decline branches go to `phase:'reflecting'` (static edge `escalate→reflect`, `nodes.ts:111`) with no path back to `repair`, abandoning failed tasks even with `maxRepairAttempts` untouched. A transient JSON parse failure in `escalateStep` (catch at 610) permanently dooms the work. Genuinely a distinct manifestation; overlaps finding 2 but the framing (transient parse failure → permanent abandonment) is independently valid. Confirmed.

- **d2-engine-run-loop-7 — confirmed (Important).** `runStructured` retry: attempt 0 uses `runWithHandoffs(eng, base, consult)`, attempt 1 (line 1031) uses `await eng.runAgent(base)` directly — `base` has no `handoffSection` and the retry has no consult affordance. `reviewStep`/`integrationReviewStep` pass a real `consult` (766/798). A review that returned ONLY a `handoff` block on attempt 1 has no parseable JSON, so attempt 2 retries without the consult tool; if the reviewer again emits a handoff block, `parseJsonBlock` fails and `runStructured` throws (1036), and the throw is caught in `domainReviewNode` (425-426) leaving the group unreviewed (not a hard node crash, but the review is lost). The mechanism is real; "likely throws the whole review node" is slightly imprecise (domain review catches per-group; integration review's catch at 478 also recovers). Note adjusts the description but severity Important stands.

- **d2-engine-run-loop-8 — confirmed (Minor).** `routeNode` 163-166 iterates `deriveStages(...)` which returns an entry for EVERY task (`workflow-order.ts:82-85`, `out[x.id] = team ? team.order : 0`), so `tasks[taskId].stage` is written `0` even with no ordered edges. Pre-feature `TaskState` had no `stage`, so checkpoint JSON diverges byte-for-byte though behavior is inert. Confirmed Minor.

- **d2-engine-run-loop-9 — confirmed (Minor).** `domainReviewNode` 431 and `integrationReviewNode` 486 unconditionally write `t.verdict = { verdict, feedback, disposition }`; `reviewStep`/`integrationReviewStep` default `disposition:'repair'` (772-779, 804-811) even when `allowReplan` is false (`maxReplans=0`). Inert to control flow (446/498 require `maxReplans>0`) but the persisted verdict shape gains a field vs. legacy. Confirmed Minor.

- **d2-engine-run-loop-10 — confirmed (Minor).** The HITL re-entry block (238-275) unconditionally sets `t.status='done'` for the asker's tasks (259) using the resume output as task output (257-261) and never calls `parseAskUser` on `r.text`. A follow-up `ask` block is consumed as task output, not re-detected. Confirmed; Minor (a known one-shot design limit).

- **d2-engine-run-loop-11 — confirmed (Minor).** `actingMode` is snapshotted into `RunState` at `seedRunState` (84) and read as `state.actingMode`, but `maxUserRequests` (228), `adaptiveEffort` (286), `maxReplans` (342/443/573/600), `maxHandoffs` (914), and review settings (`maxAttemptsFor` via `getSettings()`, 389/457) are all read live per node via `getSettings()`. A settings change between crash and resume yields a different branch than the original policy. Confirmed Minor.

- **d2-engine-run-loop-12 — confirmed (Minor).** `nodes.ts` is 1506 lines: graph wiring (100-128), all node bodies (132-681), Claude dispatch/parse plumbing + steps (683-1037), state helpers (1039-1222), and every prompt string (1224-1505) in one file. Accurate maintainability smell. Confirmed Minor.

- **d2-engine-run-loop-13 — confirmed (Minor).** `saveGraph` (`project-store.ts:152-156`) does a plain non-atomic `fs.writeFile` of the whole graph; `updateAgent` (221-233) calls it, and `updateAgent({sessionId})` is invoked from inside the concurrent `runGroup` (`nodes.ts:313`, under `mapCapped`). `run-store.ts:33-35` already uses tmp+rename, confirming the contrast. The cited site 256 (HITL resume) is single, and 531 (repair) is also under `mapCapped` so it is a second concurrent site; 313 is the primary one. A crash mid-write can corrupt `graph.json`. Confirmed; Minor severity is fair given how narrow the crash window is.
