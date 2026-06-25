# Dynamic Team Spawning — Orchestrator Builds the Team

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Roadmap:** Dynamic agent spawning (#1). The named follow-on to orchestrator-drafted roles: the
orchestrator now also **creates** the agents + topology, not just roles for a team you placed.

## Motivation

Today you build the team by hand (place agents, set kinds/topology) and can have the orchestrator
draft *roles* for them. Dynamic spawning closes the loop: the orchestrator reads the goal and proposes
a whole **hierarchical** team — managers + workers, with roles and a reporting structure — which you
review and create with one click. It keeps the free-form, human-in-control philosophy: nothing is
created until you Apply, and your existing agents are never touched.

## Goals

- A **Build team** button: the orchestrator proposes a hierarchical team (agents + complete `role.md`
  each + a reporting tree) from the goal, considering the existing roster so it doesn't duplicate.
- An **editable preview** (names + roles) of the proposed org tree; **Apply** creates the agents on the
  canvas and wires the reporting edges; **Cancel** writes nothing.
- The proposal call is **read-only** (creates nothing); creation is a separate, explicit step.
- Cycle-safe by construction (no reporting loop can reach the routing engine).

## Non-goals (out of scope)

- **Auto-spawn at run start** — on-demand button only.
- **Replacing / deleting** existing agents — spawning only adds (non-destructive).
- **Editing topology or kind in the preview** — restructure on the canvas after creation.
- The orchestrator **creating itself** — one orchestrator must already exist as the author.
- Proposing **models/skills** — new agents get the default model-by-kind + `acceptEdits`; you tune after.

## Decisions locked in brainstorming

- On-demand **Build team** button + editable preview + Apply (non-destructive, mirrors Draft roles).
- The orchestrator may design a **hierarchy** (manager layers), not just a flat team.
- **Add under the orchestrator** — existing agents kept; the orchestrator is told about them to avoid
  duplicating specialties.
- **(A)** Any invalid/cyclic `reportsTo` is reset to `"orchestrator"` (prevents infinite routing recursion).
- **(B)** Preview is editable on **names + roles**; `kind`/reporting are shown read-only.

## Architecture

Pure prompt/parse in `src/shared/team-spawn.ts`; the read-only orchestrator call in
`src/main/engine/team-spawner.ts` (injected `runAgent` seam); creation in
`project-store.applySpawnedTeam`; IPC `team:spawn` (propose) + `team:applySpawn` (create); a GoalBar
button + a tree preview modal. Reuses the orchestrator-drafted-roles patterns (`rosterForDrafting`,
the read-only `THINK_DISALLOW` call, retry-once) and B1's `importTeam` creation pattern (fresh ids,
slug uniquification, edge remap).

### Shared type — `src/shared/types.ts`

```ts
/** One agent the orchestrator proposes when building a team. reportsTo is another
 *  member's temp `id` or the literal "orchestrator" (cycle-free after parsing). */
export interface SpawnedMember {
  id: string            // temp id, used only to express reportsTo
  name: string
  kind: 'manager' | 'worker'
  role: string          // full role.md
  reportsTo: string     // a member id, or "orchestrator"
}
```
Plus `IPC.spawnTeam: 'team:spawn'`, `IPC.applySpawn: 'team:applySpawn'`, and the two `RendererApi`
methods (below). `SpawnedMember` lives in `types.ts` (not `team-spawn.ts`) so `team-spawn.ts`,
`team-spawner.ts`, `RendererApi`, and `applySpawnedTeam` all import it without a circular dependency.

### Pure core — `src/shared/team-spawn.ts`

```ts
export function spawnTeamPrompt(
  goal: string,
  orchestratorName: string,
  existing: { name: string; kind: AgentKind; role: string }[]
): string

export function parseSpawnedTeam(text: string): SpawnedMember[] | null
```

- `spawnTeamPrompt` asks the orchestrator to design a team for the goal: each member with a temp `id`,
  `name`, `kind` (manager|worker), a complete `role.md`, and `reportsTo` (another member's id or
  `"orchestrator"`); managers may have workers (or managers) reporting to them; specialties must be
  **distinct**; and it must **not duplicate** the listed existing members. JSON shape:
  `{ "members": [ { "id", "name", "kind", "role", "reportsTo" } ] }`.
- `parseSpawnedTeam`: parse the last ```json block; keep members with a non-empty `id`, `name`,
  `role` and `kind ∈ {manager, worker}`; dedup by `id` (first wins); then **break cycles** —
  for each member, walk its `reportsTo` chain (it must terminate at `"orchestrator"`); if it
  references an unknown id, itself, or forms a loop, reset that member's `reportsTo` to
  `"orchestrator"`. Returns `null` if no usable members. The result is always a forest rooted at the
  orchestrator.

### Read-only proposal — `src/main/engine/team-spawner.ts`

```ts
export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

export async function spawnTeam(
  opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string },
  runAgent?: AgentRunner // defaults to streamAgent; injected in tests
): Promise<SpawnedMember[]>
```
Gathers the existing roster via `rosterForDrafting()` (the non-orchestrator agents as "existing"
context), builds `spawnTeamPrompt(goal, getAgent(orchestratorId).name, existing.agents)`, runs the
orchestrator **read-only** (`permissionMode: 'default'`, `disallowedTools: THINK_DISALLOW`,
`header: false`), parses with `parseSpawnedTeam`, retries once with a strict reminder, then throws.
Returns the validated members — **creates nothing**.

### Creation — `src/main/engine/project-store.ts`

```ts
export async function applySpawnedTeam(members: SpawnedMember[], orchestratorId: string): Promise<ProjectGraph>
```
Modeled on `importTeam`: for each member, a fresh `randomUUID()` node id, slug uniquified against
existing, `agents/<slug>/role.md` = the member's role, a fresh `memory.md` (the empty template),
`AgentNodeData` with `icon = iconForName(name, kind)`, `model = DEFAULT_MODEL_BY_KIND[kind]`,
`permissionMode: 'acceptEdits'`, and a **layered position** under the orchestrator (row = reporting
depth, column = index within the depth, relative to the orchestrator's position). Then wire edges:
each member's parent = `reportsTo === 'orchestrator' ? orchestratorId : tempId→newId`; push
`{ id: '<parent>-><child>', source, target }`. One `saveGraph()` at the end.

### IPC + preload

- `team:spawn` handler: `spawnTeam({ goal, orchestratorId, wc: e.sender, abort: new AbortController(), runId: 'spawn-team' })` in try/catch → `{ ok: true, members }` / `{ ok: false, error }`.
- `team:applySpawn` handler: `applySpawnedTeam(input.members, input.orchestratorId)` → `{ graph }`.
- `RendererApi`:
  - `spawnTeam: (input: { goal: string; orchestratorId: string }) => Promise<{ ok: boolean; members?: SpawnedMember[]; error?: string }>`
  - `applySpawnedTeam: (input: { members: SpawnedMember[]; orchestratorId: string }) => Promise<ProjectGraph>`

### Renderer

- **`GoalBar.tsx`**: a **Build team** button next to Draft roles. Enabled when an orchestrator is
  targeted, the goal is non-empty, and no run is active (unlike Draft roles it does NOT require existing
  specialists — it creates them). Click → spinner → `window.api.spawnTeam(...)` → open the preview with
  the proposed members, or `window.alert(error)`.
- **`TeamSpawnModal.tsx`** (new): the members listed **indented by reporting depth** (the org tree),
  each with a kind badge, an **editable name** input, and an **editable role** textarea. **Apply** →
  `window.api.applySpawnedTeam({ members: edited, orchestratorId })` → `setGraph(result)` → close.
  **Cancel** writes nothing.

## Data flow

Build team → `team:spawn` → `spawnTeam` (roster → prompt → orchestrator read-only → `parseSpawnedTeam`,
retry once) → members → editable tree preview → Apply → `team:applySpawn` → `applySpawnedTeam` (create
agents + roles + reporting edges) → updated graph → canvas refreshes.

## Error handling

- **No orchestrator / no goal / a run active:** button disabled with a hint.
- **Unparseable proposal after one retry:** `{ ok: false, error }`; nothing created.
- **Invalid/cyclic `reportsTo`:** reset to `"orchestrator"` in `parseSpawnedTeam` (never reaches creation).
- **Cancelled preview:** no writes.
- The proposal call is read-only; only Apply mutates the graph (one atomic `saveGraph`).

## Testing

- `src/shared/team-spawn.test.ts` (new): `spawnTeamPrompt` (includes goal, orchestrator name, existing
  members, the manager/worker + reportsTo + JSON requirements); `parseSpawnedTeam` (parses a tree;
  drops bad-kind/empty-role; resets unknown `reportsTo` to orchestrator; **breaks a cycle** —
  `a→b→a` becomes a forest; self-report `a→a` → orchestrator).
- `src/main/engine/team-spawner.test.ts` (new): mock `project-store` (`rosterForDrafting`, `getAgent`)
  + inject a canned `runAgent` returning a team JSON; assert `spawnTeam` returns the validated members
  and retries-once-then-throws on bad output.
- `src/main/engine/project-store.test.ts` (extend): `applySpawnedTeam` creates the agents, writes the
  proposed roles, and wires edges (manager→worker; worker→orchestrator) in a temp project — assert the
  node count, an agent's role content, and the edge from the orchestrator/manager.
- IPC/preload/renderer (button + modal) verified by `typecheck` + `build`.

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/types.ts` | `SpawnedMember` type; 2 `IPC` channels; 2 `RendererApi` methods |
| `src/shared/team-spawn.ts` | **new** — `spawnTeamPrompt`, `parseSpawnedTeam` (validate + cycle-break) |
| `src/shared/team-spawn.test.ts` | **new** — pure tests |
| `src/main/engine/team-spawner.ts` | **new** — `spawnTeam` (read-only proposal, seam) |
| `src/main/engine/team-spawner.test.ts` | **new** — seam tests |
| `src/main/engine/project-store.ts` | `applySpawnedTeam` (create agents + roles + reporting edges) |
| `src/main/engine/project-store.test.ts` | extend — `applySpawnedTeam` temp-project test |
| `src/main/ipc.ts` | `team:spawn` + `team:applySpawn` handlers |
| `src/preload/index.ts` | expose `spawnTeam` / `applySpawnedTeam` |
| `src/renderer/run/GoalBar.tsx` | Build-team button + open the modal |
| `src/renderer/TeamSpawnModal.tsx` | **new** — tree preview (editable names + roles) |

No changes to the orchestration graph, run model, or the team-brain features.

## Risks / edge cases

- **A weird/oversized proposal** (too many agents, odd hierarchy) — the editable preview is the guard;
  you prune/rename before Apply, and can delete/re-parent on the canvas after.
- **Name collisions** with existing agents — slugs are uniquified on create (B1's rule); duplicate
  display names are allowed (the user can rename in the preview).
- **A role too goal-specific** — same trade-off as Draft roles; editable in the preview, and roles are
  durable (not re-spawned automatically).
- **Empty proposal** (orchestrator returns nothing usable) — surfaced as an error; nothing created.
