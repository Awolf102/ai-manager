# Phase 3 — Review, Repair Loop & Memory Learning (spec)

## Context

Phase 2 made the chain coordinate: goal → plan → route → execute → synthesize. Phase 3
closes the loop so the team **reviews its own work, optionally repairs it, and learns** —
each worker records wins/losses to `memory.md`, which is loaded on the next run. A new
**Settings** panel lets the user choose how aggressive the repair behaviour is.

## Settings

`ProjectSettings` is persisted in `.ai-manager/graph.json` (it travels with the project):

```ts
type ReviewMode = 'none' | 'once' | 'loop'
interface ProjectSettings {
  reviewMode: ReviewMode      // 'none' = review→memory only, 'once' = +1 repair, 'loop' = repair loop
  maxRepairAttempts: number   // used when reviewMode === 'loop' (default 3, clamp 1..6)
  reflection: boolean         // write reflections to memory.md after a run (default true)
}
```

Defaults: `{ reviewMode: 'loop', maxRepairAttempts: 3, reflection: true }`.

The engine collapses these to two knobs:
- `maxAttempts` = `0` (none) | `1` (once) | `maxRepairAttempts` (loop)
- `reflection` (on/off)

If `maxAttempts === 0 && !reflection`, Phase 3 is effectively off — the engine skips review
and behaves exactly like Phase 2.

A **Settings** modal opens from a gear in the top bar with: Review mode (3-option selector),
Max repair attempts (number; shown for 'loop'), and "Update agent memory after runs" toggle.
Saved via an `updateSettings` IPC that merges + persists + returns the graph.

## Engine changes (`orchestrator.ts`)

The run now tracks, during execution, two maps on `Ctx`:
- `taskOwner: Map<taskId, workerId>` — which leaf worker executed each task
- `taskResult: Map<taskId, string>` — each task's latest output

populated in `executeWorker`. After `delegate` (execute) and before synthesis:

1. **Review** (`reviewStep`) — the orchestrator runs in read-only `plan` mode with the goal,
   plan, and each task's owner + output, returning a structured verdict:
   `{ tasks: [{ taskId, verdict: 'pass'|'fail', feedback }] }`. The engine tags each with the
   owner node id and emits a `verdict` event.
2. **Repair loop** — while there are failed tasks (with a known owner) and `attempt <
   maxAttempts` and not aborted: re-dispatch each failed task to its owner via `repairWorker`
   (configured permission mode, prompt = original task + reviewer feedback + prior attempt),
   update `taskResult`, then **re-review only the previously-failed tasks** and merge their
   updated verdicts. Re-dispatches run in parallel (cap 3).
3. **Reflection** (if `reflection`) — for each distinct worker that executed tasks,
   `reflectStep` runs read-only and returns `{ win, loss, lessons[] }` given the worker's
   task(s), final output, and final verdict/feedback. The app merges it into that worker's
   `memory.md` via `applyReflection`. Emits a `reflection` event. Worker status → `reflecting`
   → `done`.
4. **Synthesis** — unchanged, but the results text + verdict summary are built from the maps
   so they reflect the post-repair state.

Review/reflection use the same fenced-`json` parse + one-retry guard as Phase 2's
plan/assign steps.

## `project-store` changes

- `getSettings()` / `updateSettings(patch)` — read/merge/persist `graph.settings` (with the
  defaults applied on load for older graphs).
- `applyReflection(agentId, { win, loss, lessons, label })` — read `memory.md`, then:
  - **Lessons:** insert each new lesson as a `- ` bullet under `## Lessons`, skipping
    near-duplicates (case-insensitive substring), and cap the section at **40** bullets
    (drop oldest).
  - **Task log:** insert a dated entry (`### <ISO date> — <label>` + `- Win:` / `- Loss:`)
    immediately under `## Task log` (newest first), capped at **30** entries.
  - If a section header is missing (user edited the file), append the header first.

## Types

- Add `ReviewMode`, `ProjectSettings`; add `settings: ProjectSettings` to `ProjectGraph`.
- `StepStatus` += `reviewing`, `reflecting`.
- `OrchestrationEvent` +=
  `{ type: 'verdict'; attempt; tasks: { taskId; nodeId: string|null; verdict; feedback }[] }`
  and `{ type: 'reflection'; nodeId; win; loss; lessons: string[] }`.
- `RunRecord` += `reviews: { attempt; tasks: {...}[] }[]` and
  `reflections: { nodeId; win; loss; lessons: string[] }[]`.
- `IPC` + `RendererApi` += `updateSettings`.

## UI

- **Settings modal** (gear in the top bar) — review-mode selector, max-attempts number,
  reflection toggle; persists via `updateSettings`.
- **Status:** new `reviewing` (orchestrator) and `reflecting` (worker) pills/rings.
- **Run view:** a **verdict line** per review attempt (✓/✗ per worker, attempt N/total) and a
  per-worker pass/fail mark derived from the latest verdict; a "memory updated: +N lessons"
  note when a reflection lands.
- Verdicts + reflections are persisted in the run record.

## Error handling

- **Bad structured output** (review/reflection): one retry, then — for review — fail the run
  with the raw text; for reflection — skip that worker's memory write (non-fatal).
- **Repair worker error:** that task → `error`, loop continues; it won't be retried again.
- **Stop/abort:** breaks the repair loop; remaining steps `skipped`; run `cancelled`; no
  further memory writes.
- **Unmatched tasks** (no owner): reviewed/flagged but never repaired or reflected.

## Permissions update (post-Phase 3 fix)

The original Phases 2–3 ran plan/route/**review**/reflect in Claude Code's `plan` permission
mode. That was wrong for the **review** step: `plan` mode is read-only *and* expects a human to
approve before anything runs, so headless review couldn't execute `pytest`/run the code to
verify — it fell back to inspection and did a plan-mode detour (plan file + ExitPlanMode hunt).

Now: planning and routing run **read-only** via `default` mode with edit/bash/web tools
withheld (no plan-mode artifacts). The **acting** steps — workers, repairs, the
review-that-runs-tests, and synthesis — obey an **Autonomy** setting
(`auto` → `auto` mode, `full` → `bypassPermissions`, `cautious` → `acceptEdits`), default
`auto`. Review runs in the acting mode but with edit tools withheld, so it can run tests to
verify without rewriting. `streamAgent` gained a `disallowedTools` option to enforce this.

## Out of scope (future)

Per-manager review; a human approval gate before memory writes; memory for
managers/orchestrator; reflection-driven role edits.

## Verification

1. In Settings, confirm the three review modes persist to `.ai-manager/graph.json`.
2. Run a goal where a worker will plausibly fall short. Confirm: orchestrator → `reviewing`;
   a verdict appears (✓/✗ per worker); a failed task is re-dispatched to its worker
   (`working` again) with the feedback; re-review; loop stops at pass or max attempts.
3. Confirm each worker's `memory.md` gains a dated Task-log entry + new Lessons bullets, and
   that a **second** run loads that memory (worker references the prior lesson).
4. Set review mode to "Review → memory only" and confirm no redo happens but memory still
   updates; set memory off and confirm no memory writes; set both off and confirm Phase 2
   behaviour (no review step).
5. Confirm verdicts + reflections are saved in `.ai-manager/runs/<ts>.json`.
