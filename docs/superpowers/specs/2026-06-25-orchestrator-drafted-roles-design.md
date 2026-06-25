# Orchestrator-Drafted Agent Roles

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Roadmap:** "Orchestrator auto-writes agent roles from the goal" (#1). Agent *creation*/dynamic
spawning is named as a separate future feature, explicitly out of scope here.

## Motivation

An agent's `role.md` decides routing — the orchestrator/managers match tasks to specialists by their
role text. Today `role.md` is a hand-edited template; left generic ("General-purpose specialist"),
routing has nothing to distinguish agents by, so it routes poorly. This feature lets the **orchestrator
author a tailored, complementary role for each agent from the goal**, on demand, with a preview — so a
user builds the team (names/kinds/topology) by hand and lets the orchestrator fill in the specialties.

## Goals

- A **Draft roles** button drafts a complete, tailored `role.md` for each non-orchestrator agent,
  given the goal + the full roster, so specialties come out **distinct and complementary**.
- The drafts appear in an **editable preview**; nothing on disk changes until the user clicks Apply.
- The drafting logic is pure-testable (prompt + parse) with the agent call behind an injected seam.

## Non-goals (out of scope)

- **Agent creation / dynamic spawning** — the orchestrator does not decide *what* agents to create
  here; it only writes roles for the team that already exists. (Named as a future feature.)
- **Automatic drafting** at run start or per-run re-tailoring — drafting is on-demand only.
- **Drafting memory/brains** — `memory.md` already self-authors via reflection.
- **Drafting the orchestrator's own role** — the orchestrator keeps its general planning role.

## Decisions locked in brainstorming

- **Scope:** roles for existing agents only (spawning is a future feature).
- **Trigger:** on-demand button (durable roles, not per-run / not auto).
- **Shape:** whole-team draft (complementary) + **editable preview** with Apply/Cancel.
- **(A)** draft only **non-orchestrator** agents (managers + workers).
- **(B)** the orchestrator writes the **whole `role.md`** (tailored, following the template structure).
- **(C)** preview roles are **editable** before Apply.

## Architecture

Pure prompt/parse in `src/shared/role-draft.ts`; the impure orchestrator call in a new
`src/main/engine/role-drafter.ts` (roster from `project-store`, agent via `streamAgent` behind a seam);
IPC `roles:draft`; Apply reuses the existing `writeRole` IPC; renderer = a GoalBar button + a preview
modal.

### Pure core — `src/shared/role-draft.ts`

```ts
export interface DraftRosterAgent { id: string; name: string; kind: AgentKind; role: string }

/** The prompt the orchestrator gets: the goal, the full non-orchestrator roster (id/name/kind/current
 * role excerpt) + topology, asking for ONE complete, complementary role.md per agent. */
export function draftRolesPrompt(
  goal: string,
  roster: DraftRosterAgent[],
  edges: { source: string; target: string }[]
): string

/** Parse the orchestrator's JSON block into drafts, keeping only known agent ids. Returns null
 * when the output has no usable `roles` array (caller retries once, then errors). */
export function parseDraftedRoles(
  text: string,
  knownIds: string[]
): { agentId: string; role: string }[] | null
```

- The prompt asks for ONLY a fenced JSON block: `{ "roles": [ { "agentId", "role" } ] }`, where each
  `role` is a **complete `role.md`** — a tailored `## Specialty` + `## Responsibilities` plus the
  standard `## How you work` / `## Constraints`, following the existing worker/manager template shape,
  framed as a **durable specialty** (informed by the goal, not narrowly overfit to it). It instructs
  the orchestrator to make specialties **distinct and non-overlapping** across the roster.
- `parseDraftedRoles` extracts the last fenced ```json block, reads `roles`, drops entries whose
  `agentId` isn't in `knownIds` or whose `role` is empty, and returns `{ agentId, role }[]`.

### Impure caller — `src/main/engine/role-drafter.ts`

```ts
export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

export async function draftRoles(
  opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string },
  runAgent?: AgentRunner // defaults to streamAgent; injected in tests
): Promise<{ agentId: string; name: string; role: string }[]>
```

- Gathers the roster via a new `project-store` helper `rosterForDrafting()` → `{ agents:
  DraftRosterAgent[]; edges }` (non-orchestrator agents with their current role + the graph edges).
- Runs the orchestrator agent **read-only**: `permissionMode: 'default'` + the existing
  `THINK_DISALLOW` tool set (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`/`Bash`/`WebFetch`/`WebSearch`)
  — it may read project files to inform roles but cannot edit anything.
- Parses with `parseDraftedRoles`; on `null`, retries **once** with a strict "reply with ONLY the JSON
  block" reminder (the `runStructured` pattern), then throws.
- Maps each draft's `agentId → name` from the roster and returns `{ agentId, name, role }[]` —
  **drafts only; nothing is written.**

### Roster helper — `src/main/engine/project-store.ts`

`export async function rosterForDrafting(): Promise<{ agents: DraftRosterAgent[]; edges: GraphEdge[] }>`
— the current graph's non-orchestrator nodes (id/name/kind + `readRole`) and its edges.

### IPC + preload

- `src/main/ipc.ts`: handler `roles:draft` → `draftRoles({ goal, orchestratorId, wc: e.sender,
  abort: new AbortController(), runId: 'draft-roles' }, …)`; returns `{ ok: true, drafts }` or
  `{ ok: false, error }`.
- `src/preload/index.ts`: `draftRoles(input: { goal: string; orchestratorId: string }) =>
  Promise<{ ok: boolean; drafts?: { agentId: string; name: string; role: string }[]; error?: string }>`.
- **Apply** reuses the existing `writeRole(agentId, content)` IPC (the renderer loops it per draft).

### Renderer

- **`GoalBar.tsx`**: a `Draft roles` button next to Run. Enabled when an orchestrator is targeted, the
  goal box is non-empty, there's ≥1 non-orchestrator agent, and no run is active. Click → spinner →
  `window.api.draftRoles(...)` → on success opens the preview modal with the drafts; on error,
  `window.alert(error)`.
- **`RoleDraftModal.tsx`** (new): lists each draft (agent name + an **editable** `<textarea>` holding
  the proposed `role.md`), with **Apply** (loops `window.api.writeRole(agentId, edited)` then closes)
  and **Cancel** (closes, writes nothing).

## Data flow

Click **Draft roles** → `roles:draft` → `draftRoles` (roster from `rosterForDrafting` →
`draftRolesPrompt` → orchestrator read-only → `parseDraftedRoles`, retry once) → drafts back to the
renderer → editable preview → **Apply** loops `writeRole` → roles updated on disk.

## Error handling

- **No orchestrator / no goal / no non-orchestrator agents:** button disabled with a hint (no call).
- **Unparseable orchestrator output after one retry:** `{ ok: false, error }`; nothing written.
- **`agentId`s not in the roster:** dropped by `parseDraftedRoles`.
- **Cancelled preview:** no writes.
- The call is read-only, so a failed/odd draft can never mutate files; only Apply writes.

## Testing

- `src/shared/role-draft.test.ts` (new): `draftRolesPrompt` (includes the goal, every roster agent,
  and the topology; asks for distinct specialties + the JSON shape) and `parseDraftedRoles` (parses a
  good block; drops unknown `agentId`s and empty roles; returns `null` for a block with no `roles`).
- `src/main/engine/role-drafter.test.ts` (new): mock `project-store` (`rosterForDrafting`) + inject a
  canned `runAgent` returning role JSON; assert `draftRoles` returns `{ agentId, name, role }` for the
  roster, maps names correctly, and retries once then throws on persistently-bad output.
- IPC/preload/renderer (button + modal) verified by `typecheck` + `build` (no renderer harness).

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/role-draft.ts` | **new** — `draftRolesPrompt`, `parseDraftedRoles`, `DraftRosterAgent` |
| `src/shared/role-draft.test.ts` | **new** — pure tests |
| `src/main/engine/role-drafter.ts` | **new** — `draftRoles` (roster → orchestrator read-only → parse) |
| `src/main/engine/role-drafter.test.ts` | **new** — seam-injected tests |
| `src/main/engine/project-store.ts` | add `rosterForDrafting()` |
| `src/shared/types.ts` | `IPC.draftRoles` channel + `RendererApi.draftRoles` method |
| `src/main/ipc.ts` | `roles:draft` handler |
| `src/preload/index.ts` | expose `draftRoles` |
| `src/renderer/run/GoalBar.tsx` | Draft-roles button + open the modal |
| `src/renderer/RoleDraftModal.tsx` | **new** — editable preview + Apply/Cancel |

No changes to the run/orchestration graph, memory, or the team-brain features.

## Risks / edge cases

- **A drafted role too narrowly tied to the goal** (overfit) — mitigated by prompting for a *durable
  specialty* and by the editable preview; the user can broaden it before Apply. The role is not
  re-drafted automatically afterward.
- **Latency** — one orchestrator call; the button shows a spinner; it's read-only so it's safe to
  cancel by closing.
- **Large rosters** — the prompt grows with the team; role excerpts are truncated to keep it bounded.
- **A manager's role vs its children** — the topology is given to the orchestrator so a manager's role
  can describe coordinating its specific reports; no special handling beyond that.
