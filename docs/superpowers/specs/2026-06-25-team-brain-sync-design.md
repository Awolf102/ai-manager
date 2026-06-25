# Living Team — Manual Brain Sync (sub-project B2a)

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Roadmap:** Compounding-team work, part (b2a). Builds on B1 (export/import) and A (portable/project
lesson tagging). A later **B2b** (automatic triggers — push-after-reflection, pull-at-run-start) is
explicitly deferred to its own spec.

## Motivation

B1 makes a team portable as a one-time snapshot. B2 makes it a *living* entity: a central "team
brain" that accumulates the team's portable lessons across every project it works in, so improvements
compound rather than fork. B2a delivers this on **manual** triggers — two buttons, **Sync to team**
(push) and **Refresh from team** (pull) — leaving the always-on automation to B2b. The hard part (the
shared store + the lossless merge) lives here; B2b is later wiring.

## Goals

- A project can **push** its newly-learned `[portable]` lessons into a shared team-brain file, and
  **pull** the brain's accumulated lessons into its agents — both on demand.
- The brain is a **B1 bundle file plus a `teamId`** (a superset of a B1 bundle — still importable),
  so the two features unify on one on-disk format.
- A project **links** to its brain once (implicitly, on first sync) and syncs silently thereafter.
- All merges are **union + dedup-by-text** — lossless, commutative, idempotent.

## Non-goals (deferred / out of scope)

- **B2b** automatic triggers (push after a run's reflection; pull at run start).
- **Concurrency locking** for multiple writers (single-user app, one project open at a time).
- **Conflict resolution beyond union** — lessons are additive; there are no destructive conflicts.
- **Pull creating agents** — pull only merges lessons into agents that already match by `memberId`;
  creating a roster in a fresh project is B1 import's job.
- **Syncing roles/models/skills of *existing* members** — B2a syncs *lessons*. (Roster *growth* does
  carry a new member's full roster; existing members' roster fields are left as the brain has them.)
- A managed-library UI; sharing/permissions.

## Decisions locked in brainstorming

- **(A) Allow roster growth on push:** a project agent not yet in the brain is *added* as a new brain
  member (assigned a `memberId` if it lacks one). Push doesn't only update known members.
- **(B) Implicit linking:** the link is established by the first sync click — **Sync to team** first
  time opens a save dialog (create/choose the brain file), **Refresh from team** first time opens an
  open dialog (choose the brain). A B1 *import* of a file that already carries a `teamId` also links.
  No separate "Link…" button.

## Architecture

Pure merge core in `src/shared/team-brain.ts` (no node/DOM imports, unit-tested); impure
file/graph/link work in `project-store.ts`; dialogs in `ipc.ts`; two buttons + a linked indicator in
the renderer. Reuses B1 (`TeamBundle`, `buildTeamBundle`, `validateTeamBundle`, `memberId`) and A
(`portableLessons`, `formatLessonBullet`, `parseLessonBullet`, `lessonBullets`).

### Format & link changes

- `TeamBundle.teamId?: string` — present in a brain; absent in a plain B1 snapshot. The first sync
  against a `teamId`-less file **adopts** it: a `teamId` is assigned and written back (promoting any
  bundle to a brain).
- `ProjectGraph.linkedTeam?: { teamId: string; path: string }` — which brain this project syncs with.
- `AgentNodeData.memberId?` already exists (B1). `syncToTeam` persists `memberId = node.id` onto any
  node lacking one (stable identity for future syncs).

### Pure core — `src/shared/team-brain.ts`

```ts
import type { AgentNodeData, TeamBundle } from './types'
import { formatLessonBullet, lessonBullets, parseLessonBullet } from './lessons'

/** PUSH merge: union each project member's lessons into the matching brain member
 * (by memberId, dedup-by-text); add project members absent from the brain (growth).
 * Brain-only members are untouched. Keeps the brain's teamId. Edges are unioned. */
export function mergeBrainPush(brain: TeamBundle, projectBundle: TeamBundle): TeamBundle

/** PULL plan: for each brain member with a matching project node (by memberId),
 * the portable lesson texts to merge into that agent. Unmatched members skipped. */
export function planBrainPull(
  brain: TeamBundle,
  nodes: AgentNodeData[]
): { agentId: string; lessons: string[] }[]

/** Merge new portable lesson texts into a memory.md `## Lessons` section: as
 * `- [portable] <text>`, dedup-by-text against existing bullets, newest-first,
 * cap 40. The `## Task log` and all other content are untouched. */
export function mergeLessons(memory: string, newPortableTexts: string[]): string
```

- `mergeBrainPush`: match by `memberId`. Matching member → `lessons = unionDedup(brain.lessons,
  proj.lessons)` (case-insensitive text dedup, brain order first). New member → push the whole
  `TeamMember`. Edges → `brain.edges ∪ projectBundle.edges` deduped by `source+target`.
- `mergeLessons`: reuses `lessonBullets`/`parseLessonBullet` to dedup by stripped text against
  existing bullets and `formatLessonBullet('portable', …)` to write — same dedup-by-text rule as
  `mergeMemory`, but lessons-only (no task-log entry per pull). (Minor logic overlap with
  `mergeMemory`'s Lessons transform is accepted to keep pull side-effect-free; not refactoring A.)

### Impure shell — `src/main/engine/project-store.ts`

```ts
export function getLinkedTeam(): { teamId: string; path: string } | null

/** PUSH: ensure every node has a memberId; build the project as a bundle; read the
 * brain at brainPath (adopt its teamId, or use fallbackTeamId for a fresh/teamId-less
 * file); mergeBrainPush; write the brain file; record linkedTeam; saveGraph. */
export async function syncToTeam(brainPath: string, fallbackTeamId: string): Promise<{
  brain: TeamBundle
  graph: ProjectGraph
}>

/** PULL: read+validate the brain at brainPath; planBrainPull; mergeLessons into each
 * matched agent's memory.md; record linkedTeam (adopting/assigning teamId); saveGraph. */
export async function refreshFromTeam(brainPath: string): Promise<{
  updated: number
  graph: ProjectGraph
}>
```

- `syncToTeam`: assigns `memberId = node.id` to any node missing one (persisted). Builds the project
  via the existing `buildTeamBundle`. If `brainPath` exists and validates as a bundle, reads it and
  uses its `teamId` (or `fallbackTeamId` if it lacks one, writing it back); otherwise starts a fresh
  brain `{ kind, version:1, teamId: fallbackTeamId, name, exportedAt, members:[], edges:[] }`. Writes
  the merged brain (atomic). Records `graph.linkedTeam`. `importTeam` (B1) is extended to record
  `linkedTeam` when the imported bundle carries a `teamId`.
- `refreshFromTeam`: reads + `validateTeamBundle`; if the brain lacks a `teamId`, assigns one and
  writes it back (adoption). Applies `planBrainPull`, merging each agent's lessons via `mergeLessons`
  + `writeMemory`. Records `linkedTeam`. Returns the number of agents updated.

### IPC + preload

- `team:syncTo` handler: `getLinkedTeam()` → if linked, use its `path`; else `dialog.showSaveDialog`
  (default `<project>.aimteam.json`). `fallbackTeamId = randomUUID()`. Call `syncToTeam`. Cancelled →
  `{ synced: false }`. Returns `{ synced: true, graph, teamPath }`.
- `team:refreshFrom` handler: `getLinkedTeam()` → if linked, use its `path`; else
  `dialog.showOpenDialog`. Read file → `JSON.parse` (bad JSON → `{ refreshed:false, error }`) →
  `validateTeamBundle` (invalid → `{ refreshed:false, error }`) → `refreshFromTeam`. Returns
  `{ refreshed: true, graph, updated }`.
- `RendererApi`: `syncToTeam: () => Promise<{ synced: boolean; graph?: ProjectGraph; teamPath?: string }>`;
  `refreshFromTeam: () => Promise<{ refreshed: boolean; graph?: ProjectGraph; updated?: number; error?: string }>`.

### Renderer

Two top-bar buttons next to B1's Export/Import: **Sync to team** (push) and **Refresh from team**
(pull). Both `setGraph(result.graph)` on success so the linked indicator updates; refresh shows a
confirmation like `Updated N agents from the team brain.` (`N` = `result.updated`, the count of agents
whose memory was merged), errors via `window.alert`. A small **linked-team indicator** in the top bar
shows the brain file's basename when `graph.linkedTeam` is set (and nothing when unlinked).

## Data flow

**Push:** button → `team:syncTo` → resolve brain path (link or save dialog) → `syncToTeam` (ensure
memberIds → `buildTeamBundle` → read/merge brain → write brain → record link) → updated graph back.

**Pull:** button → `team:refreshFrom` → resolve brain path (link or open dialog) → read+validate →
`refreshFromTeam` (`planBrainPull` → `mergeLessons` into each agent's memory → record link) → graph +
count back.

## Error handling

- **No project open:** `requireCurrent` throws `No project is open`; handler surfaces it.
- **Invalid/corrupt brain on pull:** `validateTeamBundle` fails → `{ refreshed:false, error }`; no
  memory writes happen.
- **Cancelled dialog:** no-op (`{ synced:false }` / `{ refreshed:false }`).
- **Push atomicity:** the brain file is written in one `writeFile`; the graph (`linkedTeam`,
  `memberId`s) is saved after the brain write succeeds.
- **Pull partial failure:** memory merges are per-agent `writeMemory`s; a mid-pull failure leaves
  already-merged agents updated (acceptable — merges are idempotent, re-running pull is safe).
- **No matches on pull** (brain members share no `memberId` with the project): `updated: 0`, surfaced
  to the user (likely they should B1-import the team first).

## Testing

- `src/shared/team-brain.test.ts` (new): `mergeBrainPush` (union lessons by memberId; add new member;
  brain-only member untouched; edge union; teamId preserved), `planBrainPull` (match by memberId;
  skip unmatched; correct lessons per agent), `mergeLessons` (dedup-by-text vs existing; cap;
  `[portable]` tagging; `## Task log` + project-specific lessons preserved).
- `src/main/engine/project-store.test.ts` (extend): a filesystem round-trip — create a project +
  agents, `syncToTeam` (assert a brain file written with `teamId` + members + portable lessons +
  `linkedTeam` recorded), add a lesson / a new agent, `syncToTeam` again (assert the brain grew),
  then `refreshFromTeam` from a *different* project (assert lessons merged into the matching agent).
- IPC/preload/renderer verified by `typecheck` + `build` (no renderer harness).

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/team-brain.ts` | **new** — `mergeBrainPush`, `planBrainPull`, `mergeLessons` |
| `src/shared/team-brain.test.ts` | **new** — pure-core tests |
| `src/shared/types.ts` | `TeamBundle.teamId?`, `ProjectGraph.linkedTeam?`, 2 IPC channels, 2 RendererApi methods |
| `src/main/engine/project-store.ts` | `getLinkedTeam`, `syncToTeam`, `refreshFromTeam`; `importTeam` records `linkedTeam` when bundle has a `teamId` |
| `src/main/engine/project-store.test.ts` | extend — sync round-trip |
| `src/main/ipc.ts` | `team:syncTo` + `team:refreshFrom` handlers (dialogs + file I/O) |
| `src/preload/index.ts` | expose `syncToTeam` / `refreshFromTeam` |
| `src/renderer/*` | Sync/Refresh buttons + linked-team indicator |

## Risks / edge cases

- **Adopting a plain B1 bundle as a brain** writes a `teamId` into the user's file on first sync —
  intended (promotes any bundle to a living brain), but it does mutate a file the user may think of as
  a static snapshot. Acceptable; the file remains a valid bundle.
- **A moved/renamed brain file** breaks the stored `path`; the next sync's dialog re-links it (the
  `teamId` still matches). No data loss.
- **Roster growth re-adding a removed member:** if an agent was deleted from the brain elsewhere, a
  push re-adds it (growth is additive). Expected for B2a; B2b/identity policy can refine later.
- **Existing members' role drift:** changing an agent's role in a project does not update the brain's
  copy (B2a syncs lessons only). Noted; a future enhancement could sync roster fields.
