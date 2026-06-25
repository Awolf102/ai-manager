# Living Team — Manual Brain Sync (B2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project push its newly-learned `[portable]` lessons into a shared "team brain" file and pull the brain's accumulated lessons into its agents — on manual triggers (two buttons), with a project↔brain link established implicitly on first sync.

**Architecture:** A pure merge core in `src/shared/team-brain.ts` (no node/DOM imports, unit-tested); impure file/graph/link work in `project-store.ts`; dialogs in `ipc.ts`; two buttons + a linked indicator in the renderer. Reuses B1 (`TeamBundle`, `buildTeamBundle`, `validateTeamBundle`, `memberId`) and A (`portableLessons`, `formatLessonBullet`, `parseLessonBullet`, `lessonBullets`).

**Tech Stack:** TypeScript, vitest, electron-vite. Commands: `npx vitest run`, `npm run typecheck`, `npm run build`.

## Global Constraints

- **The brain is a B1 bundle file + a `teamId`** (`TeamBundle.teamId?`). The first sync against a `teamId`-less file adopts it (assigns + writes a `teamId`).
- **Only `[portable]` lessons sync.** Push uses `buildTeamBundle` (already portable-only); pull merges only the brain's `lessons` and preserves each agent's `## Task log` and `[project]` lessons.
- **All merges are union + dedup-by-text** (case-insensitive on the stripped text) — lossless, idempotent. No destructive conflict handling.
- **`memberId` is the join key.** `syncToTeam` persists `memberId = node.id` onto any node lacking one. Pull matches `(node.memberId ?? node.id) === member.memberId`.
- **Allow roster growth on push:** a project member absent from the brain is added as a new brain member. Existing brain members' roster fields are NOT updated (lessons only).
- **Implicit linking:** push first-time = save dialog; pull first-time = open dialog; B1 `importTeam` of a `teamId`-bearing bundle records the link. The link lives in `ProjectGraph.linkedTeam?: { teamId, path }`.
- **Pull never creates agents** (B1 import does that). Pure core has NO `electron`/`node:fs`/DOM imports.
- **Atomicity:** brain written in one `writeFile`; graph saved after.
- **All 89 existing tests must stay green.** Renderer/IPC verified by `typecheck` + `build` (no renderer harness).
- **Git:** commit per task; append the trailer as the last line (after a blank line): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Pure merge core (`src/shared/team-brain.ts`) + `TeamBundle.teamId`

**Files:**
- Modify: `src/shared/team-bundle.ts` (add `teamId?` to `TeamBundle`)
- Create: `src/shared/team-brain.ts`
- Test: `src/shared/team-brain.test.ts`

**Interfaces:**
- Consumes: `TeamBundle` (`./team-bundle`), `AgentNodeData` (`./types`); `formatLessonBullet`, `lessonBullets`, `parseLessonBullet` (`./lessons`).
- Produces:
  - `mergeBrainPush(brain: TeamBundle, projectBundle: TeamBundle): TeamBundle`
  - `planBrainPull(brain: TeamBundle, nodes: AgentNodeData[]): { agentId: string; lessons: string[] }[]`
  - `mergeLessons(memory: string, newPortableTexts: string[]): string`

- [ ] **Step 1: Add `teamId?` to `TeamBundle`**

In `src/shared/team-bundle.ts`, in the `TeamBundle` interface, add after `version: 1`:

```ts
  /** stable team identity — present in a "team brain"; absent in a plain snapshot */
  teamId?: string
```

- [ ] **Step 2: Write the failing tests**

Create `src/shared/team-brain.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mergeBrainPush, planBrainPull, mergeLessons } from './team-brain'
import type { TeamBundle, TeamMember } from './team-bundle'
import type { AgentNodeData } from './types'

const mem = (memberId: string, lessons: string[]): TeamMember => ({
  memberId, name: memberId, kind: 'worker', model: 'm', permissionMode: 'acceptEdits',
  icon: 'i', position: { x: 0, y: 0 }, role: '', lessons
})
const bundle = (members: TeamMember[], edges: { source: string; target: string }[] = [], teamId = 'T1'): TeamBundle =>
  ({ kind: 'ai-manager-team', version: 1, teamId, name: 'S', exportedAt: 'X', members, edges })

describe('mergeBrainPush', () => {
  it('unions lessons for a matching member and preserves brain-only members + teamId', () => {
    const out = mergeBrainPush(bundle([mem('a', ['t1']), mem('z', ['zl'])], [], 'T1'), bundle([mem('a', ['t1', 't2'])], [], 'T2'))
    expect(out.teamId).toBe('T1')
    expect(out.members.find((m) => m.memberId === 'a')!.lessons).toEqual(['t1', 't2'])
    expect(out.members.find((m) => m.memberId === 'z')!.lessons).toEqual(['zl'])
  })
  it('adds a project member absent from the brain (growth)', () => {
    const out = mergeBrainPush(bundle([mem('a', ['x'])]), bundle([mem('b', ['y'])]))
    expect(out.members.map((m) => m.memberId).sort()).toEqual(['a', 'b'])
  })
  it('unions edges by source+target', () => {
    const out = mergeBrainPush(
      bundle([mem('a', [])], [{ source: 'a', target: 'b' }]),
      bundle([mem('a', [])], [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }])
    )
    expect(out.edges).toEqual([{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }])
  })
})

describe('planBrainPull', () => {
  const nodes: AgentNodeData[] = [
    { id: 'n1', name: 'A', slug: 'a', kind: 'worker', icon: 'i', model: 'm', permissionMode: 'acceptEdits', position: { x: 0, y: 0 }, memberId: 'a' },
    { id: 'n2', name: 'B', slug: 'b', kind: 'worker', icon: 'i', model: 'm', permissionMode: 'acceptEdits', position: { x: 0, y: 0 } }
  ]
  it('matches members to nodes by memberId (with id fallback) and skips unmatched', () => {
    const out = planBrainPull(bundle([mem('a', ['l1']), mem('n2', ['l2']), mem('ghost', ['l3'])]), nodes)
    expect(out).toEqual([{ agentId: 'n1', lessons: ['l1'] }, { agentId: 'n2', lessons: ['l2'] }])
  })
})

describe('mergeLessons', () => {
  it('adds new portable lessons, dedups vs existing, preserves task log + project lessons', () => {
    const memory = '# Memory\n\n## Lessons\n- [portable] write tests first\n- [project] api key in config\n\n## Task log\n### 2026 — g\n- Win: w\n'
    const next = mergeLessons(memory, ['verify renders', 'write tests first'])
    expect(next).toContain('- [portable] verify renders')
    expect((next.match(/write tests first/g) || []).length).toBe(1)
    expect(next).toContain('- [project] api key in config')
    expect(next).toContain('### 2026 — g')
  })
  it('is a no-op when nothing is new', () => {
    const memory = '## Lessons\n- [portable] x\n\n## Task log\n'
    expect(mergeLessons(memory, ['x'])).toBe(memory)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/shared/team-brain.test.ts`
Expected: FAIL — `Failed to resolve import "./team-brain"`.

- [ ] **Step 4: Create `src/shared/team-brain.ts`**

```ts
// Pure merge core for the living-team (team brain) feature. No node/DOM imports.
import type { AgentNodeData } from './types'
import type { TeamBundle } from './team-bundle'
import { formatLessonBullet, lessonBullets, parseLessonBullet } from './lessons'

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function unionLessons(existing: string[], incoming: string[]): string[] {
  const out = [...existing]
  const seen = new Set(existing.map(norm))
  for (const l of incoming) {
    const n = norm(l)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(l)
  }
  return out
}

/** PUSH merge: union each project member's lessons into the matching brain member
 * (by memberId); add project members absent from the brain (growth); brain-only
 * members untouched; union edges. The brain's teamId is preserved. */
export function mergeBrainPush(brain: TeamBundle, projectBundle: TeamBundle): TeamBundle {
  const members = brain.members.map((m) => ({ ...m }))
  const byId = new Map(members.map((m) => [m.memberId, m]))
  for (const pm of projectBundle.members) {
    const existing = byId.get(pm.memberId)
    if (existing) existing.lessons = unionLessons(existing.lessons, pm.lessons)
    else {
      const copy = { ...pm }
      members.push(copy)
      byId.set(copy.memberId, copy)
    }
  }
  const key = (e: { source: string; target: string }): string => `${e.source} ${e.target}`
  const edges = [...brain.edges]
  const seen = new Set(brain.edges.map(key))
  for (const e of projectBundle.edges) {
    const k = key(e)
    if (!seen.has(k)) { seen.add(k); edges.push(e) }
  }
  return { ...brain, members, edges }
}

/** PULL plan: for each brain member with a matching project node (by memberId,
 * id fallback), the portable lesson texts to merge into that agent. */
export function planBrainPull(
  brain: TeamBundle,
  nodes: AgentNodeData[]
): { agentId: string; lessons: string[] }[] {
  const out: { agentId: string; lessons: string[] }[] = []
  for (const m of brain.members) {
    const node = nodes.find((n) => (n.memberId ?? n.id) === m.memberId)
    if (node) out.push({ agentId: node.id, lessons: m.lessons })
  }
  return out
}

function replaceLessonsSection(memory: string, bullets: string[]): string {
  const body = bullets.map((b) => `- ${b}`).join('\n')
  const lines = memory.split('\n')
  const hIdx = lines.findIndex((l) => /^##\s+lessons\s*$/i.test(l.trim()))
  if (hIdx === -1) {
    const sep = memory.length === 0 || memory.endsWith('\n') ? '' : '\n'
    return `${memory}${sep}\n## Lessons\n${body}\n`
  }
  let end = lines.length
  for (let i = hIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) { end = i; break }
  }
  return [...lines.slice(0, hIdx + 1), '', body, '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
}

/** Merge new portable lesson texts into memory.md's `## Lessons` as `- [portable] …`,
 * dedup-by-text against existing bullets, newest-first, cap 40. Task log + other
 * sections untouched. Returns the original string when nothing is new. */
export function mergeLessons(memory: string, newPortableTexts: string[]): string {
  const existing = lessonBullets(memory)
  const seen = new Set(existing.map((b) => norm(parseLessonBullet(b).text)))
  const fresh: string[] = []
  for (const t of newPortableTexts) {
    const text = t.trim()
    const n = norm(text)
    if (!n || seen.has(n)) continue
    seen.add(n)
    fresh.push(formatLessonBullet('portable', text))
  }
  if (fresh.length === 0) return memory
  return replaceLessonsSection(memory, [...fresh, ...existing].slice(0, 40))
}
```

- [ ] **Step 5: Run the team-brain tests + full suite + typecheck**

Run: `npx vitest run src/shared/team-brain.test.ts` → PASS.
Run: `npx vitest run` → all green. Run: `npm run typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/team-brain.ts src/shared/team-brain.test.ts src/shared/team-bundle.ts
git commit -m "feat(team): pure team-brain merge core (push/pull/mergeLessons) + TeamBundle.teamId"
```

---

### Task 2: `syncToTeam` / `refreshFromTeam` / link in `project-store.ts`

**Files:**
- Modify: `src/shared/types.ts` (add `linkedTeam?` to `ProjectGraph`)
- Modify: `src/main/engine/project-store.ts` (`getLinkedTeam`, `syncToTeam`, `refreshFromTeam`; extend `importTeam`)
- Test: `src/main/engine/project-store.test.ts` (add a sync round-trip)

**Interfaces:**
- Consumes: `mergeBrainPush`, `planBrainPull`, `mergeLessons` (`shared/team-brain`); `buildTeamBundle`, `validateTeamBundle`, `TeamBundle` (`shared/team-bundle`); existing `requireCurrent`, `readRole`, `readMemory`, `writeMemory`, `saveGraph`, `randomUUID`, `fs`, `join`.
- Produces:
  - `getLinkedTeam(): { teamId: string; path: string } | null`
  - `syncToTeam(brainPath: string, fallbackTeamId: string): Promise<{ brain: TeamBundle; graph: ProjectGraph }>`
  - `refreshFromTeam(brain: TeamBundle, brainPath: string): Promise<{ updated: number; graph: ProjectGraph }>`
  - `importTeam(bundle, brainPath?)` — records `linkedTeam` when `bundle.teamId` and `brainPath` are present.

- [ ] **Step 1: Add `linkedTeam` to `ProjectGraph`**

In `src/shared/types.ts`, in `interface ProjectGraph`, add after `settings: ProjectSettings`:

```ts
  /** the team brain this project syncs portable lessons with (B2 living team) */
  linkedTeam?: { teamId: string; path: string }
```

- [ ] **Step 2: Write the failing test**

In `src/main/engine/project-store.test.ts`, extend the existing import from `'./project-store'` to add `setEdges, syncToTeam, refreshFromTeam`, and add this test (it reuses the existing `tmpProject` helper + the `fs`/`join`/`tmpdir` imports already in the file):

```ts
describe('team brain sync', () => {
  it('pushes portable lessons to a brain and pulls new ones into another project', async () => {
    const brainPath = join(await tmpProject(), 'brain.aimteam.json')

    // project 1: a team learns a portable + a project lesson, then pushes
    await openProject(await tmpProject())
    await createAgent({ name: 'Dana', kind: 'worker' })
    const g1 = await createAgent({ name: 'Quinn', kind: 'worker' })
    const dana = g1.nodes.find((n) => n.name === 'Dana')!
    const quinn = g1.nodes.find((n) => n.name === 'Quinn')!
    await setEdges([{ id: 'e1', source: dana.id, target: quinn.id }])
    await writeMemory(dana.id, '# Memory: Dana\n\n## Lessons\n- [portable] write tests first\n- [project] api key in config\n\n## Task log\n')

    const push = await syncToTeam(brainPath, 'team-1')
    expect(push.graph.linkedTeam).toEqual({ teamId: 'team-1', path: brainPath })
    const brain = JSON.parse(await fs.readFile(brainPath, 'utf8'))
    expect(brain.teamId).toBe('team-1')
    expect(brain.edges).toHaveLength(1)
    expect(brain.members.find((m: { name: string }) => m.name === 'Dana').lessons).toEqual(['write tests first'])

    // project 2: import the team (links + seeds), then pull a newly-added brain lesson
    await openProject(await tmpProject())
    await importTeam(brain, brainPath)
    const updatedBrain = {
      ...brain,
      members: brain.members.map((m: { name: string; lessons: string[] }) =>
        m.name === 'Dana' ? { ...m, lessons: [...m.lessons, 'verify renders'] } : m
      )
    }
    const pull = await refreshFromTeam(updatedBrain, brainPath)
    expect(pull.updated).toBe(1)
    const dana2 = pull.graph.nodes.find((n) => n.name === 'Dana')!
    const mem2 = await readMemory(dana2.id)
    expect(mem2).toContain('- [portable] verify renders')
    expect(mem2).toContain('- [portable] write tests first')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "team brain sync"`
Expected: FAIL — `syncToTeam`/`refreshFromTeam` are not exported (`is not a function`).

- [ ] **Step 4: Extend the team-bundle import + add the functions**

In `src/main/engine/project-store.ts`, change the existing team-bundle import to add `validateTeamBundle`:

```ts
import { buildTeamBundle, planTeamImport, validateTeamBundle, type TeamBundle } from '../../shared/team-bundle'
```

Add next to it:

```ts
import { mergeBrainPush, planBrainPull, mergeLessons } from '../../shared/team-brain'
```

Add the functions (in the `// ---------- portable team (export / import) ----------` area):

```ts
export function getLinkedTeam(): { teamId: string; path: string } | null {
  return requireCurrent().graph.linkedTeam ?? null
}

/** PUSH: this project's portable lessons into the brain file at brainPath. */
export async function syncToTeam(
  brainPath: string,
  fallbackTeamId: string
): Promise<{ brain: TeamBundle; graph: ProjectGraph }> {
  const { graph } = requireCurrent()
  for (const n of graph.nodes) if (!n.memberId) n.memberId = n.id
  const files: Record<string, { role: string; memory: string }> = {}
  for (const n of graph.nodes) files[n.id] = { role: await readRole(n.id), memory: await readMemory(n.id) }
  const projectBundle = buildTeamBundle({
    name: graph.project.name,
    exportedAt: new Date().toISOString(),
    nodes: graph.nodes,
    edges: graph.edges,
    files
  })
  let existing: TeamBundle | null = null
  try {
    const v = validateTeamBundle(JSON.parse(await fs.readFile(brainPath, 'utf8')))
    if (v.ok) existing = v.bundle
  } catch {
    existing = null // fresh brain
  }
  const teamId = existing?.teamId ?? fallbackTeamId
  const base: TeamBundle = existing
    ? { ...existing, teamId }
    : { kind: 'ai-manager-team', version: 1, teamId, name: graph.project.name, exportedAt: new Date().toISOString(), members: [], edges: [] }
  const brain: TeamBundle = { ...mergeBrainPush(base, projectBundle), teamId, exportedAt: new Date().toISOString() }
  await fs.writeFile(brainPath, JSON.stringify(brain, null, 2), 'utf8')
  graph.linkedTeam = { teamId, path: brainPath }
  const saved = await saveGraph()
  return { brain, graph: saved }
}

/** PULL: merge the brain's portable lessons into matching agents' memory.md. */
export async function refreshFromTeam(
  brain: TeamBundle,
  brainPath: string
): Promise<{ updated: number; graph: ProjectGraph }> {
  const { graph } = requireCurrent()
  const teamId = brain.teamId ?? randomUUID()
  if (!brain.teamId) await fs.writeFile(brainPath, JSON.stringify({ ...brain, teamId }, null, 2), 'utf8')
  let updated = 0
  for (const p of planBrainPull(brain, graph.nodes)) {
    if (p.lessons.length === 0) continue
    const memory = await readMemory(p.agentId)
    const next = mergeLessons(memory, p.lessons)
    if (next !== memory) {
      await writeMemory(p.agentId, next)
      updated++
    }
  }
  graph.linkedTeam = { teamId, path: brainPath }
  const saved = await saveGraph()
  return { updated, graph: saved }
}
```

- [ ] **Step 5: Extend `importTeam` to record the link**

In `importTeam`, change the signature to accept an optional path:

```ts
export async function importTeam(bundle: TeamBundle, brainPath?: string): Promise<ProjectGraph> {
```

Just before the final `return saveGraph()` in `importTeam`, add:

```ts
  if (bundle.teamId && brainPath) graph.linkedTeam = { teamId: bundle.teamId, path: brainPath }
```

- [ ] **Step 6: Run the test, full suite, typecheck**

Run: `npx vitest run src/main/engine/project-store.test.ts` → PASS.
Run: `npx vitest run` → all green (the B1 `importTeam` round-trip still passes — the new param is optional).
Run: `npm run typecheck` → no errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(team): syncToTeam/refreshFromTeam + project link; round-trip tested"
```

---

### Task 3: IPC + preload (`team:syncTo`, `team:refreshFrom`)

**Files:**
- Modify: `src/shared/types.ts` (2 `IPC` channels + 2 `RendererApi` methods)
- Modify: `src/main/ipc.ts` (2 handlers; pass the import path to `importTeam`)
- Modify: `src/preload/index.ts` (2 methods)

**Interfaces:**
- Consumes: `store.getLinkedTeam`, `store.syncToTeam`, `store.refreshFromTeam`, `validateTeamBundle`.
- Produces:
  - `RendererApi.syncToTeam: () => Promise<{ synced: boolean; graph?: ProjectGraph; teamPath?: string }>`
  - `RendererApi.refreshFromTeam: () => Promise<{ refreshed: boolean; graph?: ProjectGraph; updated?: number; error?: string }>`

**Note:** no unit test (electron dialogs); verified by `typecheck` + `build`.

- [ ] **Step 1: Add channels + RendererApi methods (`src/shared/types.ts`)**

In `export const IPC = { … }`, add after `importTeam: 'team:import'` (add a comma to that line):

```ts
  syncTeam: 'team:syncTo',
  refreshTeam: 'team:refreshFrom'
```

In `export interface RendererApi`, add after the `importTeam(...)` method:

```ts
  syncToTeam: () => Promise<{ synced: boolean; graph?: ProjectGraph; teamPath?: string }>
  refreshFromTeam: () => Promise<{ refreshed: boolean; graph?: ProjectGraph; updated?: number; error?: string }>
```

- [ ] **Step 2: Add the handlers + pass the import path (`src/main/ipc.ts`)**

Add `import { randomUUID } from 'node:crypto'` at the top (`fs` from `node:fs` and `validateTeamBundle` are already imported from B1).

Change the B1 import handler's call from `await store.importTeam(v.bundle)` to:

```ts
    const graph = await store.importTeam(v.bundle, r.filePaths[0])
```

Add, before the closing `}` of `registerIpc()`:

```ts
  // ---- team brain (B2 living team) ----
  ipcMain.handle(IPC.syncTeam, async () => {
    const linked = store.getLinkedTeam()
    let brainPath: string
    if (linked) brainPath = linked.path
    else {
      const r = await dialog.showSaveDialog({
        title: 'Sync to team',
        defaultPath: 'team.aimteam.json',
        filters: [{ name: 'AI Manager team', extensions: ['json'] }]
      })
      if (r.canceled || !r.filePath) return { synced: false }
      brainPath = r.filePath
    }
    const { graph } = await store.syncToTeam(brainPath, randomUUID())
    return { synced: true, graph, teamPath: brainPath }
  })
  ipcMain.handle(IPC.refreshTeam, async () => {
    const linked = store.getLinkedTeam()
    let brainPath: string
    if (linked) brainPath = linked.path
    else {
      const r = await dialog.showOpenDialog({
        title: 'Refresh from team',
        properties: ['openFile'],
        filters: [{ name: 'AI Manager team', extensions: ['json'] }]
      })
      if (r.canceled || r.filePaths.length === 0) return { refreshed: false }
      brainPath = r.filePaths[0]
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(brainPath, 'utf8'))
    } catch {
      return { refreshed: false, error: 'That team file is not valid JSON.' }
    }
    const v = validateTeamBundle(parsed)
    if (!v.ok) return { refreshed: false, error: v.error }
    const { updated, graph } = await store.refreshFromTeam(v.bundle, brainPath)
    return { refreshed: true, updated, graph }
  })
```

- [ ] **Step 3: Expose in preload (`src/preload/index.ts`)**

In `const api: RendererApi = { … }`, add after the `importTeam: …` line (add a comma to it):

```ts
  syncToTeam: () => ipcRenderer.invoke(IPC.syncTeam),
  refreshFromTeam: () => ipcRenderer.invoke(IPC.refreshTeam)
```

- [ ] **Step 4: Verify typecheck + build + suite**

Run: `npm run typecheck` → no errors. Run: `npm run build` → clean. Run: `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat(team): IPC + preload for team-brain sync (push/pull)"
```

---

### Task 4: Renderer — Sync/Refresh buttons + linked indicator (`App.tsx`)

**Files:**
- Modify: `src/renderer/App.tsx` (icons import + two buttons + linked indicator)
- Modify: `src/renderer/styles.css` (`.team-link` indicator)

**Note:** no unit test (renderer); verified by `typecheck` + `build`.

- [ ] **Step 1: Add the icons**

In `src/renderer/App.tsx` line 2, change the lucide import to:

```ts
import { Clock, CloudDownload, CloudUpload, Download, FolderOpen, Plus, Settings as SettingsIcon, Upload, Users } from 'lucide-react'
```

- [ ] **Step 2: Add the indicator + two buttons**

In the `<div className="topbar">`, immediately after the B1 Import button (the `<button>` whose icon is `<Download size={14} />`, ending `</button>` on the line before the Settings button), insert:

```tsx
        {graph.linkedTeam && (
          <span className="team-link" title={`Linked team brain: ${graph.linkedTeam.path}`}>
            <Users size={12} /> {graph.linkedTeam.path.split(/[\\/]/).pop()}
          </span>
        )}
        <button
          className="btn"
          title="Sync this project's portable lessons to the team brain"
          onClick={async () => {
            const r = await window.api.syncToTeam()
            if (r.synced && r.graph) setGraph(r.graph)
          }}
        >
          <CloudUpload size={14} />
        </button>
        <button
          className="btn"
          title="Refresh this project's agents from the team brain"
          onClick={async () => {
            const r = await window.api.refreshFromTeam()
            if (r.refreshed && r.graph) {
              setGraph(r.graph)
              window.alert(`Updated ${r.updated} agent(s) from the team brain.`)
            } else if (r.error) {
              window.alert(r.error)
            }
          }}
        >
          <CloudDownload size={14} />
        </button>
```

- [ ] **Step 3: Add the `.team-link` style**

Append to `src/renderer/styles.css`:

```css
.team-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
```

- [ ] **Step 4: Verify typecheck + build + suite**

Run: `npm run typecheck` → no errors. Run: `npm run build` → clean. Run: `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(team): Sync/Refresh team-brain buttons + linked indicator"
```

---

## Final verification

- [ ] `npx vitest run` → all green (89 existing + new `team-brain` + sync round-trip tests).
- [ ] `npm run typecheck` → no errors. `npm run build` → clean.
- [ ] **Live smoke (manual):** in project A, run a goal so an agent learns a portable lesson → click **Sync to team** → save `team.aimteam.json` (linked indicator appears). In project B, **Import** that file → run/learn a different lesson → **Sync to team** (same file). Back in project A, **Refresh from team** → confirm A's agent gained project B's portable lesson (and kept its task log + project-specific lessons).

## Self-review notes (spec coverage)

- Brain = bundle + `teamId` → Task 1 (`TeamBundle.teamId`) + Task 2 (adoption).
- Push (union by memberId, growth, edge union) → Task 1 `mergeBrainPush` + Task 2 `syncToTeam`.
- Pull (match by memberId, lessons-only merge, preserve task log/project lessons) → Task 1 `planBrainPull`/`mergeLessons` + Task 2 `refreshFromTeam`.
- `memberId` persistence on push → Task 2 `syncToTeam`.
- Implicit linking (save/open dialogs; import auto-links) → Task 3 handlers + Task 2 `importTeam`.
- `ProjectGraph.linkedTeam` → Task 2. Linked indicator → Task 4.
- Error handling (bad JSON / invalid bundle / cancel) → Task 3 handlers.
- Pure core no node/DOM imports; merges lossless/idempotent → Task 1.
