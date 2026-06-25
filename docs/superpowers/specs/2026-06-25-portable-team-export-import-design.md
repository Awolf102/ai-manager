# Portable Team — Export / Import (sub-project B1)

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Roadmap:** Compounding-team work, part (b). This is **B1** (snapshot export/import). A later **B2**
(a central "living team" brain with automatic cross-project sync-back + conflict merge + identity
matching) is explicitly deferred to its own spec; B1 lays the groundwork (including stable member
identity) without any always-on sync.

## Motivation

Today a team is folder-locked: the org chart (`graph.json`) and each agent's `role.md` + `memory.md`
live inside one project's `.ai-manager/`. To reuse a team you've tuned — its roster, its roles, and
the general skills its agents have learned — in a new project, you must hand-copy files.

B1 makes a team a portable artifact: **export** the current project's team to a single `.json` file,
and **import** that file into another project, seeding the new agents with their *portable* track
record. This is where sub-project A pays off: only `[portable]` lessons travel, so a team arrives in
a new project with its general software-engineering habits but a clean project-specific slate.

## Goals

- Export the open project's team (roster + roles + portable lessons) to one self-contained,
  versioned `.json` bundle, via an in-app save dialog.
- Import a bundle into the currently-open project: create the agents, wire the org chart, seed each
  agent's memory with its portable lessons, via an in-app open dialog.
- Carry a stable per-member identity so a future B2 can match teammates across projects without a
  data migration.
- Keep the transformation logic pure and unit-tested; keep the file/dialog work in the main process.

## Non-goals (out of scope)

- **B2:** central team store, automatic sync-back after runs, cross-project conflict merge, "refresh
  team from library." B1 is one-directional and manual.
- A **managed team library** UI (list of saved teams). B1 uses plain files + OS dialogs.
- Carrying **project settings** (autonomy / reviewMode / maxRepairAttempts / reflection /
  adaptiveEffort). These are operational knobs the *project owner* sets per project, not team
  knowledge — and silently importing, e.g., `full`/bypass-permissions autonomy into a new project
  would be surprising and unsafe. The new project keeps its own defaults.
- Carrying **run-specific state**: `sessionId`, run history, or the `## Task log`.
- Partial/selective export (single agent). B1 exports the whole team.

## Decisions locked in brainstorming

- **(A) Forward-compat identity:** add an optional `memberId?: string` to `AgentNodeData`. Imported
  agents carry the bundle's `memberId`; B1 itself never reads it. This is cheap insurance so B2 can
  match teammates without migrating existing graphs.
- **(B) No project settings** in the bundle (see non-goals).

## Architecture

Pure transformation core in `src/shared/team-bundle.ts` (no node/DOM imports, unit-tested), plus
impure file/graph application in `src/main/engine/project-store.ts` (which owns `graph.json` and the
agent files), wired to the renderer through new IPC methods.

### The bundle format (single versioned `.json`)

```jsonc
{
  "kind": "ai-manager-team",
  "version": 1,
  "name": "Data & Frontend Squad",      // defaults to the source project's name
  "exportedAt": "2026-06-25T09:00:00Z", // stamped by the main process at export time
  "members": [
    {
      "memberId": "…",                  // stable identity (see below)
      "name": "Dana", "kind": "worker",
      "model": "…", "permissionMode": "…", "skills": ["data:analyze"], "icon": "…",
      "position": { "x": 120, "y": 120 },
      "role": "<role.md contents>",
      "lessons": ["verify renders return 200", "write a failing test first"]  // portable text, no marker
    }
  ],
  "edges": [ { "source": "<memberId>", "target": "<memberId>" } ]  // by memberId, not node id
}
```

### `memberId` derivation (pure, no new randomness)

`memberId = node.memberId ?? node.id`. A node's `id` is already a stable UUID, so a from-scratch team
exports with stable identities for free; a team that was itself imported carries its original
`memberId` forward (identity chains correctly through export → import → re-export). Edges in the
bundle reference `memberId`, decoupling them from per-project node ids.

### Pure core — `src/shared/team-bundle.ts`

```ts
export interface TeamMember {
  memberId: string
  name: string; kind: AgentKind; model: string; permissionMode: PermissionMode
  skills?: string[]; icon: string; position: { x: number; y: number }
  role: string; lessons: string[]
}
export interface TeamBundle {
  kind: 'ai-manager-team'; version: 1
  name: string; exportedAt: string
  members: TeamMember[]
  edges: { source: string; target: string }[]   // by memberId
}

// Build a bundle from the live graph + each agent's files (exportedAt stamped by caller).
export function buildTeamBundle(args: {
  name: string
  exportedAt: string
  nodes: AgentNodeData[]
  edges: GraphEdge[]
  files: Record<string, { role: string; memory: string }>   // keyed by node id
}): TeamBundle

// Validate untrusted JSON read from disk.
export function validateTeamBundle(raw: unknown):
  | { ok: true; bundle: TeamBundle }
  | { ok: false; error: string }

// Plan the import: per member, the new agent's fields (slug uniquified against existing),
// the seeded memory.md content, and edges still keyed by memberId. The caller assigns fresh
// node ids and remaps edges memberId -> newId.
export function planTeamImport(bundle: TeamBundle, existingSlugs: string[]): {
  members: Array<{
    memberId: string; name: string; slug: string; kind: AgentKind
    model: string; permissionMode: PermissionMode; skills?: string[]; icon: string
    position: { x: number; y: number }
    role: string; memory: string   // full seeded memory.md
  }>
  edges: { source: string; target: string }[]   // by memberId
}
```

- `buildTeamBundle` filters each agent's lessons to **portable only** via `portableLessons` (below) —
  `[project]` *and* untagged are dropped (the B-side of A's asymmetry: untagged is treated as
  project for transfer). It strips the marker (the bundle stores plain portable text). It excludes
  `sessionId`, the `## Task log`, and project settings.
- `planTeamImport` uniquifies each member's slug against `existingSlugs` (reusing the existing
  `uniqueSlug` rule), offsets every imported `position` by a fixed delta (e.g. `+48px` on both axes,
  relative to the bundle's stored positions) so imported nodes are visibly distinct from any existing
  ones, and builds each member's `memory.md` via `buildSeededMemory` (below).
- `buildSeededMemory(name, portableLessonTexts)` returns a `memory.md` whose `## Lessons` section
  holds `- [portable] <text>` bullets (or `- (none yet)` when empty) and an **empty `## Task log`** —
  same header shape `mergeMemory` expects, so future reflections merge cleanly.

### Lesson extraction — `src/shared/lessons.ts`

Add `export function portableLessons(memory: string): string[]` — every `## Lessons` bullet whose
`parseLessonBullet(...).scope === 'portable'`, returned as stripped text, **uncapped** (unlike
`lessonsDigest`, which caps at 5 and includes untagged for routing). To avoid duplicating the
section scan, extract a small private `lessonBullets(memory): string[]` (raw bullets under
`## Lessons`, minus comments and the `(none yet)` placeholder) and have both `lessonsDigest` and
`portableLessons` use it. `lessonsDigest`'s external behavior is unchanged.

### Impure shell — `src/main/engine/project-store.ts`

```ts
export async function exportTeam(): Promise<TeamBundle>
export async function importTeam(bundle: TeamBundle): Promise<ProjectGraph>
```

- `exportTeam` reads the current graph (`requireCurrent`) and every agent's `role.md`/`memory.md`,
  stamps `exportedAt = new Date().toISOString()` (the impure shell owns the clock; `buildTeamBundle`
  stays pure by taking it as an argument), and returns `buildTeamBundle(...)`. The IPC handler only
  shows the save dialog and writes the file.
- `importTeam` calls `planTeamImport(bundle, existingSlugs)`, then for each planned member:
  generates a fresh node `id` (`randomUUID`), writes `agents/<slug>/role.md` + `memory.md`, and
  pushes an `AgentNodeData` (with `memberId` set). It builds a `memberId → newId` map, remaps the
  bundle edges onto it, appends them to `graph.edges`, and **saves the graph last** so a mid-import
  failure leaves the graph unchanged. Returns the updated graph.

### IPC + renderer

- `src/main/ipc.ts`: handlers `team:export` (call `exportTeam`, `dialog.showSaveDialog`, write file)
  and `team:import` (`dialog.showOpenDialog`, read file, `validateTeamBundle`, `importTeam`, return
  graph). A cancelled dialog is a no-op.
- `src/preload/index.ts`: expose `exportTeam(): Promise<{ saved: boolean; path?: string }>` and
  `importTeam(): Promise<{ imported: boolean; graph?: ProjectGraph; error?: string }>`.
- `src/renderer`: two top-bar buttons (next to the run/history icons) — Export team / Import team
  (lucide upload/download). Import success calls `setGraph(result.graph)`; errors show a message.

## Data flow

**Export:** renderer button → `team:export` → `exportTeam()` reads graph + agent files →
`buildTeamBundle` (portable-only, marker-stripped, edges by memberId) → main stamps `exportedAt`,
save dialog, writes `.json`.

**Import:** renderer button → `team:import` → open dialog → read + `validateTeamBundle` → `importTeam`
→ `planTeamImport` (uniquify slugs, offset positions, seed memory) → write agent dirs/files, assign
fresh ids, remap edges, save graph → updated graph back to the store.

## Error handling

- **No project open:** `requireCurrent` already throws `No project is open`; the handler surfaces it.
- **Invalid/corrupt bundle:** `validateTeamBundle` returns `{ ok: false, error }`; import aborts
  before any writes; the renderer shows the error.
- **Cancelled dialog:** no-op (`{ saved: false }` / `{ imported: false }`).
- **Empty team export:** allowed; produces a bundle with `members: []` (the handler may warn).
- **Mid-import fs failure:** the graph is saved last, so the on-disk graph stays consistent; orphaned
  `agents/<slug>/` dirs are possible but harmless (not referenced by the graph).

## Testing

- `src/shared/team-bundle.test.ts` (new): `buildTeamBundle` (roster fields carried; portable-only +
  marker-stripped lessons; `sessionId`/task-log/settings excluded; `memberId = memberId ?? id`; edges
  by memberId), `planTeamImport` (slug uniquification, position offset, seeded `memory.md` content,
  edges preserved by memberId), `buildSeededMemory` (lessons → `[portable]` bullets, empty task log,
  `(none yet)` when empty), `validateTeamBundle` (accepts a good bundle; rejects wrong `kind`/`version`
  and malformed members with a message).
- `src/shared/lessons.test.ts` (extend): `portableLessons` (portable only; excludes `[project]` AND
  untagged; uncapped) and that `lessonsDigest` is unchanged after the `lessonBullets` extraction.
- The impure `exportTeam`/`importTeam` and the IPC/preload/renderer wiring are verified by `typecheck`
  + `build` (consistent with the rest of main/renderer). An optional `project-store` integration test
  against a temp project dir may be added if low-cost.

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/team-bundle.ts` | **new** — `TeamBundle`/`TeamMember` types, `buildTeamBundle`, `planTeamImport`, `validateTeamBundle`, `buildSeededMemory` |
| `src/shared/team-bundle.test.ts` | **new** — pure-core tests |
| `src/shared/lessons.ts` | add `portableLessons`; extract private `lessonBullets` shared with `lessonsDigest` |
| `src/shared/lessons.test.ts` | extend — `portableLessons`; confirm `lessonsDigest` unchanged |
| `src/shared/types.ts` | add optional `memberId?: string` to `AgentNodeData` |
| `src/main/engine/project-store.ts` | add `exportTeam()` + `importTeam(bundle)` |
| `src/main/ipc.ts` | `team:export` + `team:import` handlers (dialogs + file I/O) |
| `src/preload/index.ts` | expose `exportTeam` / `importTeam` |
| `src/renderer/*` | Export/Import team top-bar buttons; refresh graph on import |

No changes to the engine, run model, or sub-project A's reflection/merge logic.

## Risks / edge cases

- **Re-importing the same bundle into the same project** creates a second copy of the team (new ids,
  uniquified slugs). That's correct snapshot semantics for B1; B2's identity matching (via `memberId`)
  is what will later allow "update in place" instead of duplicating.
- **A portable lesson mislabeled** at reflection time won't travel (or will travel wrongly) — same
  trade-off as sub-project A; correction is hand-editing `memory.md`. Out of scope here.
- **Skill ids in a bundle that the importing machine doesn't have** (`skills` references a plugin not
  installed): carried verbatim; the agent-runner already drops missing-path plugins at run time, so
  this degrades gracefully rather than failing import.
