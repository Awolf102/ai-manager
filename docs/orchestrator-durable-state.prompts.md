# Implementation prompts — Durable orchestrator state

Staged prompts to implement `docs/orchestrator-durable-state.md`. Each stage is independently
shippable; run `npm run typecheck` after each and stop for review before the next. Hand a
prompt to Claude Code in this repo, or paste it as a goal to your own AI Manager orchestrator
(the meta move — the app refactoring its own engine).

Guardrails that apply to every stage:

- Do NOT touch the agent execution layer (`agent-runner.ts`, `streamAgent`, `pty-manager.ts`),
  auth, or the per-step permission-mode logic (`THINK_DISALLOW` / `EDIT_TOOLS` / Autonomy).
- Keep `shared/types.ts` free of node/DOM imports (it's imported by both processes).
- `RunState` must stay JSON-serializable — never store `WebContents` or `AbortController` in it.
- Use TDD where there's logic to test (merge/reducer/resume); run `npm run typecheck` +
  `npm run build` before claiming done.

---

## Stage 1 — Checkpointer (durability, no behavior change)

```
Goal: persist orchestration runs incrementally so a crash or quit mid-run no longer loses
state, with NO change to externally observable behavior.

Context to read first: docs/orchestrator-durable-state.md (Stage 1), src/main/engine/
orchestrator.ts, src/main/engine/project-store.ts (saveRun/listRuns/loadRun), src/shared/
types.ts (RunRecord/RunStepRecord).

Do:
1. Add the RunState / TaskState / RunPhase / LiveRunStatus types to src/shared/types.ts as
   specified in the design doc. Keep RunRecord as a DERIVED projection of RunState (add a
   pure `toRunRecord(state): RunRecord` helper) so HistoryView and loadRun/listRuns are
   unaffected.
2. Create src/main/engine/run-store.ts implementing RunStore.put/get/listResumable:
   - writes .ai-manager/runs/<runId>.json
   - debounced trailing write (~250ms), force-flush on phase change and terminal status
   - atomic write (tmp file + rename)
   - listResumable() returns states with status running|interrupted
   Keep loadRun/listRuns in project-store.ts working for BOTH old timestamp-named files and
   new runId-named files.
3. Refactor orchestrator.ts so the live state is a single RunState object instead of the
   Ctx Maps (taskOwner/taskResult/steps → state.tasks + state.steps records). Call
   store.put(state) after each existing transition (after plan, after each worker finishes,
   after each verdict, after each repair, after reflect, after synth). Do NOT restructure
   control flow yet — same linear execute(), just check-pointed.

Verify: start a run, kill the app (or throw) midway, reopen — confirm the partial run JSON
exists with the completed tasks recorded. typecheck + build green. No change to a normal
run's final RunRecord shape (diff a before/after run JSON to confirm).
```

---

## Stage 2 — Local graph runtime

```
Goal: replace the linear execute() with an explicit, resumable node graph, so control flow is
inspectable data and a run resumes from its last checkpoint by re-running only unfinished work.

Read first: docs/orchestrator-durable-state.md (Stage 2), the Stage-1 orchestrator.ts.

Do:
1. Create src/main/engine/graph.ts with: END, Interrupt, NodeIO, NodeResult, GraphNode,
   CompiledGraph, runGraph(), resumeGraph() — exactly as sketched in the design doc.
   Unit-test runGraph with fake nodes: linear path, goto override, abort mid-run, a node
   that throws (→ status 'error', checkpointed), and an interrupt (→ status 'interrupted',
   cursor unchanged).
2. Carve the existing steps into nodes: plan, route, execute, review, repair, reflect,
   synthesize.
   - route runs the existing recursive delegate() logic but ONLY assigns ownerId per task +
     fills assignmentsByNode; it does not execute.
   - execute is a flat reducer over state.tasks: run every pending task whose deps are
     satisfied via mapCapped(MAX_PARALLEL=3), set status running→done, and call
     io.checkpoint(state) after EACH task. On resume, already-done tasks are skipped.
   - review → conditional goto 'repair' when any owned task failed and attempts remain, else
     goto 'reflect'. repair re-dispatches failed tasks (worker --resume) then goto 'review'.
     Move repair-attempt counting onto TaskState.attempts + state.reviewNo.
3. Rewire startRun to seed RunState (cursor 'plan') and call runGraph. Add resumeRun(wc,
   runId, input?) calling resumeGraph. Keep stopRun via the in-memory handles map.

Verify: a normal run produces the same final report and RunRecord as Stage 1 (parity test).
Kill mid-execute with 2 of 4 tasks done, call resumeRun — confirm only the remaining 2 run
and the review/repair/synth complete. typecheck + build green.
```

---

## Stage 3 — Interrupts, human-in-the-loop, resume-on-launch

```
Goal: let a node pause the run for a human decision and resume from the checkpoint; add a
memory-write approval gate and a resume-on-launch prompt.

Read first: docs/orchestrator-durable-state.md (Stage 3), src/main/ipc.ts, src/preload/
index.ts, src/renderer/run/* (RunView), src/renderer/SettingsModal.tsx.

Do:
1. Add a `requireMemoryApproval` boolean to ProjectSettings (default false) + the Settings UI
   toggle. When on, reflectNode returns { interrupt: { kind:'approve-memory', prompt,
   payload: reflection } } BEFORE applyReflection. On resume it reads state.resumeInput
   ({ approved, edited? }), applies or skips the merge, clears resumeInput, continues.
2. IPC: add resumeRun and discardRun channels (shared/types.ts IPC + RendererApi + preload
   bridge + ipc.ts handlers). Add OrchestrationEvent variant { type:'interrupt'; interrupt }.
3. Renderer: when an 'interrupt' event arrives, render the proposed memory diff with
   Approve / Edit / Reject; the choice calls resumeRun(runId, decision).
4. On project open, call store.listResumable(); if any, show a Run-view banner offering
   Resume (→ resumeRun(runId)) or Discard (→ discardRun).

Verify: with the setting on, a run pauses at reflect; approving writes memory.md, rejecting
leaves it unchanged; both then synthesize. Force-quit during execute, reopen — the resume
banner appears and resuming finishes the run. typecheck + build green.
```

---

## Stage 4 — Task dependencies (optional)

```
Goal: support cross-task sequencing using the dependsOn field already on TaskState.

Read first: docs/orchestrator-durable-state.md (Stage 4), planNode, executeNode.

Do:
1. Extend the plan JSON schema + planPrompt so the orchestrator may emit dependsOn: [taskId]
   per task (optional; default none → current behavior).
2. depsSatisfied(task, state) = every dep task is status 'done' or 'passed'. executeNode
   already loops over ready tasks, so a topological wave runs automatically; checkpoint
   between waves.
3. Guard against cycles / unresolvable deps: cap waves, and mark any still-unready task
   'failed' with a clear message; surface it in the verdict/synth.

Verify: a goal whose plan has B depends-on A runs A fully before B starts (assert via task
start order in the run JSON). A→B→A cycle terminates and reports the unresolved tasks.
typecheck + build green.
```
