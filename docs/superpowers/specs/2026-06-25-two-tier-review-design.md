# Two-Tier Review — Managers as Domain QA Specialists

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Roadmap:** Two-tier review (#1). The meatiest active design item — it touches the core run loop
(`nodes.ts`). Pairs with dynamic-spawn (which CREATES managers) and compounding-team memory (which lets
them GET BETTER).

## Motivation

Today routing is hierarchical (a manager sub-assigns tasks to its children via `routeTasks`), but
**review/test/repair/reflect are centralized on the orchestrator**: `reviewNode` runs one pass as
`state.orchestratorId` over every `done` task, `repairNode` re-runs the worker with the orchestrator's
feedback, and `reflectNode` writes memory for WORKERS only. Net: the orchestrator bottlenecks all
checking, and manager nodes have no runtime teeth.

Two-tier review makes managers **earn their keep at runtime**:
- **Managers = depth.** Each manager does deep DOMAIN review + testing of its own subtree — running the
  app/tests, catching domain bugs, giving specific feedback, and handing cleaner code up. The manager
  owns testing so workers focus on building. Managers **compound QA expertise** in memory (the existing
  reflect → memory → `lessonsDigest` loop) so their reviews sharpen over runs.
- **Orchestrator = breadth.** It keeps the broader review — comparing the *integrated* result against the
  PLAN + GOAL ("did we build the right thing?") — now lighter because managers pre-filtered domain bugs.

## Goals

- Split review into two tiers: a per-manager **domain review** of each subtree, then one orchestrator
  **integration review** against the plan + goal.
- Make repair and reflect hierarchy-aware: failed tasks loop back through their manager's domain review;
  managers (and the orchestrator's integration pass) reflect on their QA work into their own `memory.md`.
- Encourage more domain managers: soften `spawnTeamPrompt`'s flat bias and document review/test/reflect
  in the manager role template.
- **Preserve today's behavior exactly for flat (no-manager) teams** — the second tier activates only when
  managers exist.

## Non-goals (out of scope)

- **v2 escalation / mid-run re-planning** — a manager kicking a mis-scoped task back to the orchestrator
  to re-break-up the plan. That is the same capability as goal-locked mid-run re-planning in the
  workflow-graph arc; build it once, later. In v1 the orchestrator surfaces an unfixable "wrong
  plan / missing capability" concern in the final report rather than re-planning.
- **Deep multi-level hierarchical review** — in a tree `O → M → SM → workers`, only the *immediate*
  manager of a leaf (`SM`) does domain review; a manager whose children are themselves managers does not
  add a review pass in v1. (Literally two tiers: leaf-manager domain review + orchestrator integration.)
- **Managers editing files** — managers review and test (acting mode, may run the app/tests) but do not
  edit; only workers repair. Same constraint the orchestrator reviewer already has.
- **New `ProjectSettings`** — reuses `reviewMode`/`maxRepairAttempts`/`reflection`/`autonomy`/
  `adaptiveEffort`; no new setting.

## Decisions locked in brainstorming

- **Review model:** immediate-manager domain review per subtree + one orchestrator integration pass
  (depth vs breadth). Flat workers reporting straight to the orchestrator are reviewed by the orchestrator
  (today's behavior).
- **Manager reflection IN v1** — the compounding-QA loop; generalized rule: *every node that reviews
  reflects on its QA work* (managers + the orchestrator's integration pass). Workers still reflect on
  implementation.
- **Spawn-bias softening IN v1** — encourage a domain manager when a cluster of several related roles
  benefits from dedicated review/QA, not only "several workers".
- **(a)** A leaf task's reviewer is its **immediate manager** (`parentOf` the owner).
- **(b)** Repair always returns to **`domainReview`** (managers re-verify the fix), then integration runs.
- **(c)** Integration failures use the same `TaskVerdict`/repair machinery; an unfixable plan-level
  problem is surfaced, not re-planned (v2).
- **Backward compatibility:** no managers → `domainReview` = orchestrator reviews all (today's single
  pass), `integrationReview` skipped, no new reflection — byte-for-byte today's behavior.

## Architecture

The graph today is `plan → route → execute → review → reflect → synth` with `repair → review`. The change
**splits `review` into `domainReview` + `integrationReview`** and re-points `repair → domainReview`. The
node/edge structure, checkpointing, and resume are otherwise unchanged.

```
plan → route → execute → domainReview → integrationReview → reflect → synthesize → END
                              │   ↑                 │
                   (failures) ▼   │ (re-verify)     │ (failures)
                            repair ┘                │
                              ▲────────────────────-┘
```

### Graph wiring — `nodes.ts` `buildOrchestratorGraph`

```ts
edges: {
  plan: 'route',
  route: 'execute',
  execute: 'domainReview',
  domainReview: 'integrationReview',
  integrationReview: 'reflect',
  repair: 'domainReview',        // was 'review'
  reflect: 'synthesize',
  synthesize: END
}
nodes: { plan, route, execute, domainReview, integrationReview, repair, reflect, synthesize }
```
Both review nodes use `phase: 'reviewing'`; `RunPhase` is unchanged. `repair` uses `phase: 'repairing'`.

### Topology helpers — `nodes.ts` (pure, exported, unit-tested) + `project-store.ts`

```ts
// project-store.ts — the inverse of childrenOf (each node has ≤1 parent in the reporting tree)
export function parentOf(nodeId: string): AgentNodeData | null

// nodes.ts — the set of nodes that performed a review this run (drives reflection)
export function reviewerIdsOf(state: RunState): string[]
//   = unique parentOf(t.ownerId) for owned tasks WHERE that parent.kind === 'manager'
//     ∪ { state.orchestratorId } when hasManagers(state) (i.e. the integration pass ran)
//   (flat teams → empty: the orchestrator-as-domain-reviewer is excluded; integration didn't run)

// nodes.ts — does this run have a real second tier?
export function hasManagers(state: RunState): boolean
//   = some owned task whose parentOf(ownerId).kind === 'manager'
```
`reviewerOf(ownerId)` = `parentOf(ownerId)` — the agent that domain-reviews that task. For a flat worker
this is the orchestrator; for a managed worker it is the manager.

### `domainReview` node (tier 1 — depth)

Replaces today's `reviewNode`, generalized from one reviewer to one-per-immediate-manager:
- Guards (preserve today's): if review is disabled (`!doReview`) or there are no owned tasks →
  `goto: 'reflect'`. If there are owned tasks but none currently need review (all already `passed`, e.g. on
  resume) → `goto: 'integrationReview'`. Otherwise `toReview` = owned tasks with `status === 'done'`.
- **Group `toReview` by `reviewerOf(t.ownerId)`** (the immediate manager; orchestrator for flat workers).
- For each reviewer group **in parallel** (`mapCapped(groups, MAX_PARALLEL, …)`): set the reviewer's
  status `reviewing`, build the existing **domain `reviewPrompt`** over that group's items
  (`taskId/title/asked/ownerName/output`), run the reviewer agent with `permissionMode: state.actingMode`
  (so it can start the app / run tests / curl endpoints — but not edit), parse `TaskVerdict[]`, set each
  task's `verdict` + `status` (`pass`→`passed`, `fail`→`failed`).
- Append one `reviews` round entry (verdicts across all groups); emit a `verdict` event.
- **Loop decision:** if any task `failed` AND `state.repairAttempts < maxAttempts` AND not aborted →
  `goto: 'repair'`. Otherwise (all passed, or repair budget exhausted) → `goto: 'integrationReview'`.

For a flat team this is exactly today: one group (reviewer = orchestrator) over all `done` tasks, same
prompt, same loop.

### `integrationReview` node (tier 2 — breadth)

New node; runs only when the team is genuinely two-tier:
- If review is disabled (`!doReview`) or `!hasManagers(state)` (flat team) → `goto: 'reflect'` immediately
  (no-op; preserves today's behavior).
- Otherwise the **orchestrator** does ONE pass over the *assembled* result: a new **`integrationReviewPrompt`**
  that gives the goal, the plan, and a digest of all task outputs grouped by area, and asks: *do the pieces
  fit together; is anything missing or off-goal; does the integrated whole satisfy the plan + goal?* —
  explicitly NOT a re-check of per-task domain detail (the managers did that). `permissionMode:
  state.actingMode` (it may run the integrated app). Returns `TaskVerdict[]` (it may fail specific tasks
  that need rework to satisfy the goal/integration; feedback may also name a plan-level gap).
- Apply verdicts (same as domain). Append a `reviews` round; emit `verdict`.
- **Loop decision:** if any task `failed` AND `state.repairAttempts < maxAttempts` → `goto: 'repair'`
  (which returns to `domainReview`, so the fix is re-verified by its manager before integration re-runs).
  Otherwise → `goto: 'reflect'`. Mark workers `done` before leaving (as today).

### `repair` node — unchanged actor, new return target

Mechanics unchanged (re-run the failed task's **worker** with `repairPrompt(goal, task, feedback)`, set
`status: 'done'`, clear `verdict`), with two adjustments:
- Increment a new `state.repairAttempts` once per `repair` invocation (the loop bound; see below).
- `goto: 'domainReview'` (was `'review'`).

### Loop bound — `RunState.repairAttempts`

Add `repairAttempts: number` (default 0) to `RunState`. `repair` increments it once per invocation. Both
review nodes gate `→ repair` on `repairAttempts < maxAttempts` (where `maxAttempts = maxAttemptsFor(settings)`
as today: `none`→0, `once`→1, `loop`→`maxRepairAttempts`). This decouples the bound from the `reviews`-log
length (which now grows by two entries per round) and is identical to today's effective cap for the flat
case (one repair per round). Old checkpoints without the field default to 0 via the seed/merge.

### `reflect` node (hierarchy-aware)

- **Workers** reflect on implementation — unchanged (today's `reflectPrompt`, per `workerIdsOf`).
- **Reviewers** (`reviewerIdsOf(state)`) reflect on their **QA work** via a new
  **`qaReflectPrompt`**: given the tasks they reviewed, their verdicts, and the outcomes, capture
  `win/loss/lessons` focused on *what domain bugs/pitfalls to watch for, what to test/verify next time,
  what "good" looks like in their area*. Lessons carry the same `[portable]`/`[project]` scope tagging
  (reuses `normalizeLessonInput`); `applyReflection` merges them into the reviewer's `memory.md`.
- Because `reviewerIdsOf` is empty for flat teams, **flat teams keep worker-only reflection** (unchanged).
- Workers and reviewers are disjoint sets (managers/orchestrator never own tasks), so no node reflects
  twice. `reviewerIdsOf` derives the orchestrator's inclusion from `hasManagers(state)` (integration runs
  iff `hasManagers`), so no new persisted flag is needed.

### Prompts

- **`reviewPrompt`** (domain) — unchanged text (run-it/verify-assets domain check), now issued per manager.
- **`integrationReviewPrompt`** (new) — goal + plan + grouped output digest; "do the pieces fit, is
  anything missing or off-goal, does the whole satisfy the plan+goal; you may run the integrated app;
  fail specific tasks that need rework; if the plan itself is missing something, say so in feedback."
  Returns the same `{ tasks: [{taskId, verdict, feedback}] }` JSON.
- **`qaReflectPrompt`** (new) — QA-focused reflection for reviewers; same `{win, loss, lessons:[{text,
  scope}]}` JSON as `reflectPrompt`.

### Role template + spawn prompt — `project-store.ts` / `shared/team-spawn.ts`

- **Manager role template** gains a review/test/reflect section: "Review your team's output in your domain
  against the goal. Run the app/tests and verify it actually works — don't trust the worker's report. You
  own testing, so your workers can focus on building. Give specific, actionable feedback for anything that
  fails. Reflect on what you caught so your future reviews get sharper." (Applies to NEW managers; the
  engine's domain-review/qa-reflect prompts drive ALL existing managers regardless.)
- **`spawnTeamPrompt`** flat-bias line softened: propose a **domain manager** when a distinct area of work
  (a cluster of several related roles/subsystems) would benefit from dedicated review + testing +
  accumulated QA expertise — not only when there are many workers; a manager with a single worker is
  overhead, so group several related roles under a QA-capable manager.

## Data flow

route (assigns `ownerId` to leaf workers) → execute → **domainReview** (each leaf's immediate manager
reviews its group; orchestrator for flat workers) → [fail → repair (worker fixes) → domainReview] →
**integrationReview** (orchestrator: integrated result vs plan+goal; skipped if no managers) → [fail →
repair → domainReview → integrationReview] → **reflect** (workers on implementation + reviewers on QA) →
synthesize.

## Error handling

- **No managers (flat team):** domainReview = orchestrator reviews all (today's pass); integrationReview
  skipped; no reviewer reflection. Byte-for-byte today's behavior.
- **`reviewMode: 'none'` + `reflection: false`:** review/reflect skipped exactly as today (the
  `doReview`/`settings.reflection` guards are preserved in both nodes).
- **Repair budget exhausted:** review nodes stop looping and proceed (domain → integration → reflect)
  with the failures recorded; the orchestrator's integration pass and synth surface them.
- **A reviewer agent throws / returns unparseable verdicts:** that group's tasks are treated as
  unreviewed for the round (left `done`, surfaced; mirrors today's tolerance) — never crashes the run; the
  per-group work is wrapped so one reviewer's failure doesn't sink the others (like `mapCapped` worker
  isolation today).
- **Abort:** every node checks `eng.abort.signal.aborted` and bails to the next safe transition (as today).
- **Unfixable plan-level gap (v2 case):** integration feedback names it; no re-plan in v1.

## Testing

All via the existing deterministic seam (`nodes.test.ts` drives the whole pipeline with a canned
`runAgent` keyed by agent id + prompt markers; `h.memory` map mocks `readMemory`/`applyReflection`):

- **Two-tier happy path** (`O → M → W1, W2`): assert `M` performs the domain review (its prompt sees only
  its workers' tasks), `O` performs the integration review (its prompt references the plan/goal/whole), and
  both `M` and `O` reflect (QA reflect prompt issued; lessons merged to their memory). Workers reflect too.
- **Two-tier repair loop**: a domain `fail` from `M` → `repair` re-runs the worker → back to `domainReview`
  (M re-reviews) → pass → integration pass → reflect. Assert the fix is re-reviewed by `M` before integration,
  and `repairAttempts` bounds the loop.
- **Integration-failure loop**: integration `fail` from `O` → repair → domainReview → integrationReview;
  assert it routes through domain re-review and terminates at the cap.
- **Flat-topology regression** (`O → W1, W2`, no managers): exactly one orchestrator review pass, NO
  integration pass, NO manager/orchestrator reflection — assert call counts match today's behavior.
- **Pure helpers**: `parentOf`, `reviewerIdsOf` (manager-parents ∪ orchestrator-when-integration; empty
  for flat), `hasManagers`.
- **Marker tests**: softened `spawnTeamPrompt` (manager-when-cluster guidance) + manager role template
  (review/test/reflect section) + the new `integrationReviewPrompt`/`qaReflectPrompt` shapes.

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/types.ts` | `RunState.repairAttempts: number` (additive) |
| `src/main/engine/project-store.ts` | `parentOf(nodeId)`; manager role-template review/test/reflect section |
| `src/main/engine/nodes.ts` | split `reviewNode` → `domainReview` + `integrationReview`; `repair → domainReview` + increment `repairAttempts`; hierarchy-aware `reflectNode`; new `reviewerIdsOf`/`hasManagers` + group-by-reviewer; new `integrationReviewPrompt` + `qaReflectPrompt`; graph wiring |
| `src/main/engine/nodes.test.ts` | two-tier happy path, repair loop, integration-failure loop, flat regression, helper units, prompt markers |
| `src/shared/team-spawn.ts` | soften the flat-bias line (encourage domain managers for clusters) |
| `src/shared/team-spawn.test.ts` | marker test for the softened guidance |

No changes to the IPC layer, the renderer, the run record/history shape, or the team/brain features.

## Risks / edge cases

- **Extra review passes (latency/tokens)** — each manager adds a review call, plus the integration pass.
  Mitigated: flat teams unaffected; the spawn threshold stays "a cluster of several roles" (no
  one-worker managers); domain reviews run in parallel (`MAX_PARALLEL`).
- **Manager doesn't actually test** — the domain `reviewPrompt` already mandates running the app/verifying
  assets; managers get acting mode so they CAN; the role template reinforces it.
- **Loop non-termination** — bounded by `repairAttempts < maxAttempts` on both review nodes; repair always
  routes through domain re-review then integration, never a tight integration↔repair loop.
- **Deep trees** — only immediate managers domain-review in v1; manager-of-managers route only. Documented
  non-goal; deeper hierarchical review is a future extension.
- **Mixed topology** (orchestrator has both direct workers and managers) — handled naturally: domainReview
  groups by immediate parent (orchestrator reviews its direct workers; managers review theirs); integration
  + orchestrator reflection still run once.
- **Old checkpoints** — `repairAttempts` defaults to 0 on resume; no migration needed.
