# Phase 2 — Orchestration Engine (spec)

## Context

Phase 1 shipped the foundation: a free-form org chart of Claude Code agents, each with a
role + memory file, runnable headless (Agent SDK) or as an interactive `claude` PTY, all
on one project folder. Phase 2 makes the chain **work together autonomously**: you give a
goal to the Orchestrator and the chain plans, delegates, executes, and reports back.

**Scope (locked in):** engine only — plan → route → execute → synthesize. **No** memory
writes, **no** formal pass/fail verdict, **no** cross-task dependencies (all Phase 3+).

## Execution model — recursive delegation

A run walks the existing graph topology (`edges`: `source` delegates to `target`),
driven by each node's `kind`:

- **Orchestrator** (root of the run): given the goal, produces a **plan** = an ordered
  list of tasks. Then acts as a router for its own direct children.
- **Router** (any orchestrator/manager that has children): reads the **role files** of its
  direct children and emits **assignments** mapping each task to the best-matching child
  (or `null` = unmatched, flagged). For each child:
  - child has children (manager) → **recurse**: it re-routes its assigned tasks among its
    own workers.
  - child is a leaf (worker) → it **executes** its assigned task(s).
- **Worker** (leaf): runs its assigned task(s) on the project; returns a result.
- **Bubble up**: a router collects its children's results and summarizes; the orchestrator
  produces the **final synthesis** (what was built, measured against the goal).

This supports the canonical Orchestrator→Manager(s)→Workers shape and variations
(orchestrator→workers directly, deeper chains, a worker shared by two managers).

### Which orchestrator
The goal targets the **selected** node if it is an orchestrator; else the sole
orchestrator. If there are zero orchestrators, the goal bar is disabled with a hint. If
there are multiple and none selected, prompt the user to select one.

### Structured steps (reliability)
Plan and assignment steps instruct the agent to emit a single fenced ` ```json ` block
matching a fixed schema; the engine parses the **last** json block from the step's final
text, validates shape, and **retries once** with a stricter reminder on failure. A second
failure fails the run with a clear error surfaced in the Run view.

- **Plan schema:** `{ "tasks": [{ "id": string, "title": string, "description": string }] }`
- **Assignment schema:** `{ "assignments": [{ "taskId": string, "childId": string | null, "reason": string }] }`
  — `childId` must be one of the router's direct children; the engine validates and treats
  unknown/`null` as unmatched.

### Permission modes per step
- **Plan / route steps** run in Claude Code **`plan`** permission mode — read-only, so the
  orchestrator/managers may explore the codebase to plan but cannot edit files.
- **Worker execution** and the **final synthesis** run in the agent's **configured** mode
  (default `acceptEdits`) so real work happens.

### Concurrency
Sibling steps (a router's children, a worker's multiple tasks) run **in parallel, capped at
3** concurrent agent runs via a small semaphore.

### Sessions
Each step runs with the agent's role+memory appended (as today) and its `cwd` = project.
The orchestrator/manager planning context (goal, plan, child roles, collected results) is
passed in the prompt. Worker/step `sessionId` is captured and saved as today, so a later
manual **Run** or **Terminal** can `--resume`.

## UI — combined run view + canvas lighting

- **Goal bar** above the canvas: a text input + **Run** / **Stop**. Shows the target
  orchestrator's name; disabled (with hint) when no orchestrator exists.
- **Canvas node status:** each `AgentNode` shows a status ring + label driven by run state:
  `idle | planning | assigning | working | done | error | skipped`.
- **Run view:** a pinned **▸ Run** tab in the existing bottom dock. Left = the live **chain
  tree** (agents grouped by depth, each with status + assigned task titles); right = the
  **streamed output** of the selected step (defaults to the most recently active). Reuses
  the existing per-agent `AgentStreamEvent` stream.
- **Stop** aborts every in-flight agent run (abort controllers) and marks remaining steps
  `skipped`.

## Components & changes

- **`src/main/engine/agent-runner.ts`** — extract a reusable
  `streamAgent({ wc, agentId, prompt, permissionMode?, resume?, runId, stepId, label })`
  that streams `AgentStreamEvent` (tagged with `agentId` + `stepId`) and resolves
  `{ text, sessionId }`. The existing manual `runHeadless` becomes a thin caller.
- **`src/main/engine/orchestrator.ts`** (new) — the run state machine: `startRun(wc, { goal, orchestratorId })`, `stopRun(runId)`. Builds the child/role context from
  `project-store`, performs plan/route/execute/synthesize, enforces the concurrency cap,
  parses structured output, emits `OrchestrationEvent`s, and saves a run record.
- **`src/main/engine/project-store.ts`** — add helpers: `childrenOf(nodeId)`,
  `rolesOf(nodeIds)`, and `saveRun(record)` → `.ai-manager/runs/<ts>.json`.
- **`src/shared/types.ts`** — add `RunTask`, `Assignment`, `StepStatus`,
  `OrchestrationEvent`, `RunRecord`, `StartRunInput`; extend `IPC` + `RendererApi` with
  `startRun`, `stopRun`, `onOrchestration`.
- **`src/main/ipc.ts`** + **`src/preload/index.ts`** — wire the new channels.
- **Renderer:**
  - `runStore.ts` (or extend `store.ts`) — run id, per-node status map, plan, assignments,
    selected step, final result.
  - `GoalBar.tsx` — goal input + Run/Stop, target resolution.
  - `AgentNode.tsx` — add the status ring/label from run state.
  - `RunView.tsx` — chain tree (left) + selected step output via an xterm pane (right),
    shown as a pinned dock tab.
  - `App.tsx` — mount the goal bar above the canvas; pin the Run tab when a run is active.

## Error handling

- **No orchestrator / unselected ambiguity:** goal bar disabled or prompts to select.
- **Bad structured output:** one retry, then fail the run with the raw text shown.
- **Unmatched tasks:** flagged in the assignment and surfaced as `skipped` steps + noted in
  the synthesis context ("these tasks had no matching worker").
- **Agent error / crash:** that step → `error`; siblings continue; the parent notes the
  failure in its collected results; the run completes with partial results rather than
  hanging.
- **Stop:** aborts in-flight runs; remaining steps → `skipped`; run marked `cancelled`.

## Out of scope (Phase 3+)

Memory-file writes & self-reflection; explicit pass/fail review verdict; task
dependencies/sequencing; multi-orchestrator goals; retry/repair loops.

## Verification

1. Build a 3-tier graph (Orchestrator → Manager → 2–3 Workers with distinct roles).
2. Enter a goal, **Run**. Confirm: orchestrator status → `planning`, a plan appears in the
   Run view; manager → `assigning`, assignments appear (task → worker, unmatched flagged);
   workers → `working` in parallel (≤3), each streaming output; nodes light up on the
   canvas in step.
3. Confirm workers actually modify the project folder; the orchestrator emits a final
   synthesis; the run is saved to `.ai-manager/runs/`.
4. **Stop** mid-run halts in-flight agents and marks the rest `skipped`.
5. Feed deliberately bad output (e.g., a role that won't emit JSON) and confirm the retry
   + clear failure path.
