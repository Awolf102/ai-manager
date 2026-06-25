# Dynamic Team Spawning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Build team" button that has the orchestrator propose a hierarchical team (agents + roles + reporting structure) from the goal, shown in an editable preview, created on the canvas only on Apply.

**Architecture:** Pure prompt/parse (with cycle-breaking) in `src/shared/team-spawn.ts`; the read-only orchestrator call in `src/main/engine/team-spawner.ts` (injected seam); creation in `project-store.applySpawnedTeam` (modeled on B1's `importTeam`); IPC `team:spawn` (propose) + `team:applySpawn` (create); a GoalBar button + a tree preview modal. Reuses the role-drafting patterns (`rosterForDrafting`, read-only `THINK_DISALLOW`, retry-once).

**Tech Stack:** TypeScript, vitest, electron-vite. Commands: `npx vitest run`, `npm run typecheck`, `npm run build`.

## Global Constraints

- **Hierarchy with a temp-id tree:** each `SpawnedMember` has a temp `id`, `name`, `kind` (`manager`|`worker`), a complete `role`, and `reportsTo` (another member's id or the literal `"orchestrator"`).
- **Cycle-safe before creation:** `parseSpawnedTeam` resets any `reportsTo` that is unknown, self-referential, or cyclic to `"orchestrator"`. The result is always a forest rooted at the orchestrator (a reporting loop must never reach the router).
- **Read-only proposal:** the orchestrator call uses `permissionMode: 'default'` + `disallowedTools: ['Edit','Write','MultiEdit','NotebookEdit','Bash','WebFetch','WebSearch']` + `header: false`; it creates nothing.
- **Non-destructive:** nothing is created until Apply; existing agents are never deleted (spawning only adds). New agents get `DEFAULT_MODEL_BY_KIND[kind]` + `permissionMode: 'acceptEdits'` + a fresh empty `memory.md`.
- **Reuse, don't re-implement:** `spawnTeam` reuses `rosterForDrafting` for existing context; `applySpawnedTeam` follows `importTeam`'s create-then-remap-edges pattern (`randomUUID` ids, `uniqueSlug`, `${parent}->${child}` edge ids).
- **Parse retries once** with a strict reminder, then throws.
- **`parseJsonBlock`'s fence regex uses `\x60{3}`** (the backtick char) — copy it exactly; do not substitute literal backticks.
- **All 105 existing tests must stay green.** IPC/renderer verified by `typecheck` + `build`.
- **Git:** commit per task; append the trailer as the last line (after a blank line): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: `SpawnedMember` type + pure `team-spawn.ts`

**Files:**
- Modify: `src/shared/types.ts` (`SpawnedMember` interface)
- Create: `src/shared/team-spawn.ts`
- Test: `src/shared/team-spawn.test.ts`

**Interfaces:**
- Consumes: `AgentKind`, `SpawnedMember` (`./types`).
- Produces:
  - `interface SpawnedMember { id: string; name: string; kind: 'manager' | 'worker'; role: string; reportsTo: string }`
  - `spawnTeamPrompt(goal: string, orchestratorName: string, existing: { name: string; kind: AgentKind; role: string }[]): string`
  - `parseSpawnedTeam(text: string): SpawnedMember[] | null`

- [ ] **Step 1: Add the `SpawnedMember` type (`src/shared/types.ts`)**

Add near `AgentNodeData` (anywhere top-level in the file):

```ts
/** One agent the orchestrator proposes when building a team. `reportsTo` is another
 *  member's temp `id` or the literal "orchestrator" (cycle-free after parsing). */
export interface SpawnedMember {
  id: string
  name: string
  kind: 'manager' | 'worker'
  role: string
  reportsTo: string
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/shared/team-spawn.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { spawnTeamPrompt, parseSpawnedTeam } from './team-spawn'

describe('spawnTeamPrompt', () => {
  it('includes the goal, orchestrator name, existing members, and the JSON shape', () => {
    const p = spawnTeamPrompt('build a shop', 'Boss', [{ name: 'Dana', kind: 'worker', role: 'data' }])
    expect(p).toContain('build a shop')
    expect(p).toContain('Boss')
    expect(p).toContain('Dana')
    expect(p).toMatch(/distinct/i)
    expect(p).toContain('"members"')
    expect(p).toContain('reportsTo')
  })
})

describe('parseSpawnedTeam', () => {
  it('parses a hierarchical team', () => {
    const text = '```json\n{"members":[{"id":"m1","name":"Lead","kind":"manager","role":"# Role: Lead","reportsTo":"orchestrator"},{"id":"w1","name":"Dev","kind":"worker","role":"# Role: Dev","reportsTo":"m1"}]}\n```'
    expect(parseSpawnedTeam(text)).toEqual([
      { id: 'm1', name: 'Lead', kind: 'manager', role: '# Role: Lead', reportsTo: 'orchestrator' },
      { id: 'w1', name: 'Dev', kind: 'worker', role: '# Role: Dev', reportsTo: 'm1' }
    ])
  })
  it('drops bad-kind / empty-role members and dedups ids', () => {
    const text = '```json\n{"members":[{"id":"w1","name":"A","kind":"worker","role":"r","reportsTo":"orchestrator"},{"id":"w1","name":"dup","kind":"worker","role":"r2","reportsTo":"orchestrator"},{"id":"x","name":"B","kind":"boss","role":"r","reportsTo":"orchestrator"},{"id":"y","name":"C","kind":"worker","role":"  ","reportsTo":"orchestrator"}]}\n```'
    expect(parseSpawnedTeam(text)!.map((m) => m.id)).toEqual(['w1'])
  })
  it('resets an unknown reportsTo to orchestrator', () => {
    const text = '```json\n{"members":[{"id":"w1","name":"A","kind":"worker","role":"r","reportsTo":"ghost"}]}\n```'
    expect(parseSpawnedTeam(text)![0].reportsTo).toBe('orchestrator')
  })
  it('breaks a reporting cycle so every member reaches the orchestrator', () => {
    const text = '```json\n{"members":[{"id":"a","name":"A","kind":"manager","role":"r","reportsTo":"b"},{"id":"b","name":"B","kind":"manager","role":"r","reportsTo":"a"}]}\n```'
    const out = parseSpawnedTeam(text)!
    const byId = new Map(out.map((m) => [m.id, m]))
    const reaches = (id: string): boolean => {
      let cur = byId.get(id)!.reportsTo
      let hops = 0
      while (cur !== 'orchestrator') {
        if (!byId.has(cur) || hops++ > 5) return false
        cur = byId.get(cur)!.reportsTo
      }
      return true
    }
    expect(reaches('a')).toBe(true)
    expect(reaches('b')).toBe(true)
  })
  it('returns null when there are no usable members', () => {
    expect(parseSpawnedTeam('no json')).toBeNull()
    expect(parseSpawnedTeam('```json\n{"members":[]}\n```')).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/shared/team-spawn.test.ts`
Expected: FAIL — `Failed to resolve import "./team-spawn"`.

- [ ] **Step 4: Create `src/shared/team-spawn.ts`**

```ts
// Pure prompt-building + output-parsing (with cycle-breaking) for dynamic team spawning.
// No node/DOM imports — unit-tested in plain Node, used by the engine.
import type { AgentKind, SpawnedMember } from './types'

export function spawnTeamPrompt(
  goal: string,
  orchestratorName: string,
  existing: { name: string; kind: AgentKind; role: string }[]
): string {
  const existingList = existing.length
    ? existing.map((a) => `- ${a.name} (${a.kind}): ${a.role.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
    : '(none yet)'
  return `You are ${orchestratorName}, the lead orchestrator. Design the team of specialists you need to achieve this goal. Propose each teammate as a worker or a manager, give each a complete role.md, and define who reports to whom.

GOAL:
${goal}

ALREADY ON THE TEAM (do NOT duplicate these specialties — propose only what's missing):
${existingList}

Rules:
- Make every specialty DISTINCT and COMPLEMENTARY.
- Use managers only when the work genuinely splits into areas that each need several workers; otherwise keep it flat (workers reporting directly to you).
- Each member's "reportsTo" is the "id" of another member you propose, or the literal "orchestrator" (you). A manager may have workers (or managers) reporting to it.
- Each "role" is a complete role.md: a "# Role" title, "## Specialty", "## Responsibilities", "## How you work", "## Constraints".

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "members": [ { "id": "m1", "name": "short name", "kind": "manager|worker", "role": "<full role.md>", "reportsTo": "orchestrator" } ] }
\`\`\``
}

export function parseSpawnedTeam(text: string): SpawnedMember[] | null {
  const parsed = parseJsonBlock(text)
  const raw = (parsed as { members?: unknown })?.members
  if (!Array.isArray(raw)) return null
  const seen = new Set<string>()
  const members: SpawnedMember[] = []
  for (const r of raw) {
    const o = r as { id?: unknown; name?: unknown; kind?: unknown; role?: unknown; reportsTo?: unknown }
    const id = String(o.id ?? '').trim()
    const name = String(o.name ?? '').trim()
    const kind = o.kind === 'manager' ? 'manager' : o.kind === 'worker' ? 'worker' : null
    const role = String(o.role ?? '').trim()
    if (!id || seen.has(id) || !name || !kind || !role) continue
    seen.add(id)
    members.push({ id, name, kind, role, reportsTo: String(o.reportsTo ?? 'orchestrator').trim() || 'orchestrator' })
  }
  if (members.length === 0) return null
  breakCycles(members)
  return members
}

/** Reset any reportsTo that is unknown, self-referential, or cyclic to "orchestrator". */
function breakCycles(members: SpawnedMember[]): void {
  const byId = new Map(members.map((m) => [m.id, m]))
  for (const m of members) {
    const path = new Set<string>([m.id])
    let cur = m.reportsTo
    while (cur !== 'orchestrator') {
      if (!byId.has(cur) || path.has(cur)) {
        m.reportsTo = 'orchestrator'
        break
      }
      path.add(cur)
      cur = byId.get(cur)!.reportsTo
    }
  }
}

function parseJsonBlock(text: string): unknown {
  const candidates: string[] = []
  const fences = [...text.matchAll(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/gi)]
  if (fences.length) candidates.push(fences[fences.length - 1][1])
  candidates.push(text)
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      // try the next candidate
    }
  }
  return null
}
```

- [ ] **Step 5: Run the tests + typecheck**

Run: `npx vitest run src/shared/team-spawn.test.ts` → PASS.
Run: `npx vitest run` → all green. Run: `npm run typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/team-spawn.ts src/shared/team-spawn.test.ts
git commit -m "feat(spawn): SpawnedMember type + pure spawnTeamPrompt/parseSpawnedTeam (cycle-safe)"
```

---

### Task 2: `spawnTeam` read-only proposal (`team-spawner.ts`)

**Files:**
- Create: `src/main/engine/team-spawner.ts`
- Test: `src/main/engine/team-spawner.test.ts`

**Interfaces:**
- Consumes: `streamAgent`/`StreamAgentOptions` (`./agent-runner`); `rosterForDrafting`, `getAgent` (`./project-store`); `spawnTeamPrompt`, `parseSpawnedTeam` (`shared/team-spawn`); `SpawnedMember` (`shared/types`).
- Produces: `spawnTeam(opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string }, runAgent?: AgentRunner): Promise<SpawnedMember[]>`

- [ ] **Step 1: Write the failing tests**

Create `src/main/engine/team-spawner.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  roster: { agents: [{ id: 'w1', name: 'Dana', kind: 'worker', role: 'r' }], edges: [] }
}))
vi.mock('./project-store', () => ({
  rosterForDrafting: async () => h.roster,
  getAgent: (id: string) => ({ id, name: 'Boss' })
}))
vi.mock('./agent-runner', () => ({ streamAgent: async () => ({ text: '' }) }))

import { spawnTeam, type AgentRunner } from './team-spawner'

const opts = () => ({
  goal: 'g',
  orchestratorId: 'o',
  wc: {} as never,
  abort: new AbortController(),
  runId: 's'
})

describe('spawnTeam', () => {
  it('returns the validated proposed team', async () => {
    const runAgent: AgentRunner = async () => ({
      text: '```json\n{"members":[{"id":"m1","name":"Lead","kind":"manager","role":"# Role","reportsTo":"orchestrator"}]}\n```'
    })
    expect(await spawnTeam(opts(), runAgent)).toEqual([
      { id: 'm1', name: 'Lead', kind: 'manager', role: '# Role', reportsTo: 'orchestrator' }
    ])
  })

  it('retries once, then throws on persistently unparseable output', async () => {
    let calls = 0
    const runAgent: AgentRunner = async () => {
      calls++
      return { text: 'nope' }
    }
    await expect(spawnTeam(opts(), runAgent)).rejects.toThrow(/did not return a valid team/)
    expect(calls).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/engine/team-spawner.test.ts`
Expected: FAIL — `Failed to resolve import "./team-spawner"`.

- [ ] **Step 3: Create `src/main/engine/team-spawner.ts`**

```ts
// Standalone (non-graph) orchestrator call that proposes a hierarchical team for a
// goal. Read-only — returns the validated proposal; the renderer creates it via the
// applySpawn IPC after the user approves.
import type { WebContents } from 'electron'
import type { SpawnedMember } from '../../shared/types'
import type { StreamAgentOptions } from './agent-runner'
import { streamAgent } from './agent-runner'
import { getAgent, rosterForDrafting } from './project-store'
import { spawnTeamPrompt, parseSpawnedTeam } from '../../shared/team-spawn'

const THINK_DISALLOW = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']
const STRICT_REMINDER =
  '\n\nIMPORTANT: Your previous reply could not be parsed. Reply with ONLY the JSON code block described above — no prose before or after.'

export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

export async function spawnTeam(
  opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string },
  runAgent: AgentRunner = streamAgent
): Promise<SpawnedMember[]> {
  const { agents } = await rosterForDrafting()
  const base = spawnTeamPrompt(opts.goal, getAgent(opts.orchestratorId).name, agents)
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await runAgent({
      wc: opts.wc,
      agentId: opts.orchestratorId,
      prompt: attempt === 0 ? base : base + STRICT_REMINDER,
      runId: opts.runId,
      stepId: opts.orchestratorId,
      permissionMode: 'default',
      disallowedTools: THINK_DISALLOW,
      abort: opts.abort,
      header: false
    })
    last = text
    const members = parseSpawnedTeam(text)
    if (members && members.length > 0) return members
  }
  throw new Error(`${getAgent(opts.orchestratorId).name} did not return a valid team. Last output:\n${last.slice(0, 400)}`)
}
```

- [ ] **Step 4: Run the tests, full suite, typecheck**

Run: `npx vitest run src/main/engine/team-spawner.test.ts` → PASS.
Run: `npx vitest run` → all green. Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/team-spawner.ts src/main/engine/team-spawner.test.ts
git commit -m "feat(spawn): spawnTeam read-only proposal (seam-tested, retry-once)"
```

---

### Task 3: `applySpawnedTeam` creation (`project-store.ts`)

**Files:**
- Modify: `src/main/engine/project-store.ts` (`applySpawnedTeam`; add `SpawnedMember` to the types import)
- Test: `src/main/engine/project-store.test.ts`

**Interfaces:**
- Consumes: `SpawnedMember` (`shared/types`); existing `requireCurrent`, `slugify`/`uniqueSlug` (`shared/slug`), `memoryTemplate`, `iconForName`, `DEFAULT_MODEL_BY_KIND`, `aimPath`, `AGENTS_DIR`, `fs`, `join`, `randomUUID`, `saveGraph`.
- Produces: `applySpawnedTeam(members: SpawnedMember[], orchestratorId: string): Promise<ProjectGraph>`

- [ ] **Step 1: Write the failing test**

In `src/main/engine/project-store.test.ts`, extend the existing import from `'./project-store'` to add `applySpawnedTeam` (and `readRole` if not already present), then add:

```ts
describe('applySpawnedTeam', () => {
  it('creates the proposed agents with roles + reporting edges', async () => {
    await openProject(await tmpProject())
    const g = await createAgent({ name: 'Boss', kind: 'orchestrator' })
    const boss = g.nodes.find((n) => n.name === 'Boss')!
    const after = await applySpawnedTeam(
      [
        { id: 'm1', name: 'Lead', kind: 'manager', role: '# Role: Lead\nA backend lead.', reportsTo: 'orchestrator' },
        { id: 'w1', name: 'API Dev', kind: 'worker', role: '# Role: API', reportsTo: 'm1' }
      ],
      boss.id
    )
    expect(after.nodes).toHaveLength(3) // Boss + Lead + API Dev
    const lead = after.nodes.find((n) => n.name === 'Lead')!
    const apiDev = after.nodes.find((n) => n.name === 'API Dev')!
    expect(lead.kind).toBe('manager')
    expect(await readRole(lead.id)).toContain('backend lead')
    expect(after.edges.some((e) => e.source === boss.id && e.target === lead.id)).toBe(true) // Boss → Lead
    expect(after.edges.some((e) => e.source === lead.id && e.target === apiDev.id)).toBe(true) // Lead → API Dev
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "applySpawnedTeam"`
Expected: FAIL — `applySpawnedTeam is not a function`.

- [ ] **Step 3: Implement `applySpawnedTeam`**

In `src/main/engine/project-store.ts`, add `SpawnedMember` to the `import type { … } from '../../shared/types'` list. Then add the function (near `importTeam`):

```ts
/** Create the orchestrator's proposed team: new agents (fresh ids, uniquified slugs,
 * proposed roles, fresh memory), wired by reportsTo, laid out under the orchestrator. */
export async function applySpawnedTeam(
  members: SpawnedMember[],
  orchestratorId: string
): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const base = graph.nodes.find((n) => n.id === orchestratorId)?.position ?? { x: 120, y: 120 }
  const byTemp = new Map(members.map((m) => [m.id, m]))
  const depthOf = (m: SpawnedMember): number => {
    let d = 1
    let cur = m.reportsTo
    let hops = 0
    while (cur !== 'orchestrator' && byTemp.has(cur) && hops++ < members.length) {
      d++
      cur = byTemp.get(cur)!.reportsTo
    }
    return d
  }
  const perDepth = new Map<number, number>()
  const taken = new Set(graph.nodes.map((n) => n.slug))
  const idByTemp = new Map<string, string>()
  for (const m of members) {
    const id = randomUUID()
    idByTemp.set(m.id, id)
    const slug = uniqueSlug(slugify(m.name), taken)
    taken.add(slug)
    const d = depthOf(m)
    const col = perDepth.get(d) ?? 0
    perDepth.set(d, col + 1)
    const dir = aimPath(path, AGENTS_DIR, slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'role.md'), m.role, 'utf8')
    await fs.writeFile(join(dir, 'memory.md'), memoryTemplate(m.name), 'utf8')
    graph.nodes.push({
      id,
      name: m.name,
      slug,
      kind: m.kind,
      icon: iconForName(m.name, m.kind),
      model: DEFAULT_MODEL_BY_KIND[m.kind],
      permissionMode: 'acceptEdits',
      position: { x: base.x + col * 220, y: base.y + d * 150 }
    })
  }
  for (const m of members) {
    const childId = idByTemp.get(m.id)!
    const parentId = m.reportsTo === 'orchestrator' ? orchestratorId : idByTemp.get(m.reportsTo)
    if (parentId) graph.edges.push({ id: `${parentId}->${childId}`, source: parentId, target: childId })
  }
  return saveGraph()
}
```

- [ ] **Step 4: Run the test, full suite, typecheck, build**

Run: `npx vitest run src/main/engine/project-store.test.ts` → PASS.
Run: `npx vitest run` → all green. Run: `npm run typecheck` → no errors. Run: `npm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(spawn): applySpawnedTeam (create agents + roles + reporting edges)"
```

---

### Task 4: IPC + preload (`team:spawn`, `team:applySpawn`)

**Files:**
- Modify: `src/shared/types.ts` (2 `IPC` channels + 2 `RendererApi` methods)
- Modify: `src/main/ipc.ts` (2 handlers)
- Modify: `src/preload/index.ts` (2 methods)

**Interfaces:**
- Consumes: `spawnTeam` (`./engine/team-spawner`), `store.applySpawnedTeam`, `SpawnedMember` (`shared/types`).
- Produces:
  - `RendererApi.spawnTeam: (input: { goal: string; orchestratorId: string }) => Promise<{ ok: boolean; members?: SpawnedMember[]; error?: string }>`
  - `RendererApi.applySpawnedTeam: (input: { members: SpawnedMember[]; orchestratorId: string }) => Promise<ProjectGraph>`

**Note:** no unit test (electron); verified by `typecheck` + `build`.

- [ ] **Step 1: Add channels + RendererApi methods (`src/shared/types.ts`)**

In `export const IPC = { … }`, add after `draftRoles: 'roles:draft'` (add a comma to that line):

```ts
  spawnTeam: 'team:spawn',
  applySpawn: 'team:applySpawn'
```

In `export interface RendererApi`, add after the `draftRoles(...)` method:

```ts
  spawnTeam: (input: { goal: string; orchestratorId: string }) => Promise<{
    ok: boolean
    members?: SpawnedMember[]
    error?: string
  }>
  applySpawnedTeam: (input: { members: SpawnedMember[]; orchestratorId: string }) => Promise<ProjectGraph>
```

(`SpawnedMember` is already exported from this file — Task 1.)

- [ ] **Step 2: Add the handlers (`src/main/ipc.ts`)**

Add `import { spawnTeam } from './engine/team-spawner'` near the other engine imports, and add `SpawnedMember` to the existing `import type { … } from '../shared/types'` list.

Add, before the closing `}` of `registerIpc()`:

```ts
  // ---- team spawning ----
  ipcMain.handle(
    IPC.spawnTeam,
    async (e: IpcMainInvokeEvent, input: { goal: string; orchestratorId: string }) => {
      try {
        const members = await spawnTeam({
          goal: input.goal,
          orchestratorId: input.orchestratorId,
          wc: e.sender,
          abort: new AbortController(),
          runId: 'spawn-team'
        })
        return { ok: true, members }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle(
    IPC.applySpawn,
    (_e, input: { members: SpawnedMember[]; orchestratorId: string }) =>
      store.applySpawnedTeam(input.members, input.orchestratorId)
  )
```

- [ ] **Step 3: Expose in preload (`src/preload/index.ts`)**

In `const api: RendererApi = { … }`, add after the `draftRoles: …` line (add a comma to it):

```ts
  spawnTeam: (input) => ipcRenderer.invoke(IPC.spawnTeam, input),
  applySpawnedTeam: (input) => ipcRenderer.invoke(IPC.applySpawn, input)
```

- [ ] **Step 4: Verify typecheck + build + suite**

Run: `npm run typecheck` → no errors. Run: `npm run build` → clean. Run: `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat(spawn): IPC + preload for team spawning"
```

---

### Task 5: Renderer — Build-team button + preview modal

**Files:**
- Create: `src/renderer/TeamSpawnModal.tsx`
- Modify: `src/renderer/run/GoalBar.tsx`
- Modify: `src/renderer/styles.css` (`.spawn-name`, `.spawn-kind`)

**Interfaces:**
- Consumes: `window.api.spawnTeam`, `window.api.applySpawnedTeam`, `SpawnedMember`.

**Note:** no unit test (renderer); verified by `typecheck` + `build`. Reuses `.modal-wide`/`.draft-list`/`.draft-role` (from the roles modal).

- [ ] **Step 1: Create `src/renderer/TeamSpawnModal.tsx`**

```tsx
import { useState } from 'react'
import { useStore } from './store'
import type { SpawnedMember } from '../shared/types'

export default function TeamSpawnModal({
  members,
  orchestratorId,
  onClose
}: {
  members: SpawnedMember[]
  orchestratorId: string
  onClose: () => void
}) {
  const setGraph = useStore((s) => s.setGraph)
  const [edited, setEdited] = useState<SpawnedMember[]>(members)
  const [applying, setApplying] = useState(false)

  const byId = new Map(edited.map((m) => [m.id, m]))
  const depthOf = (m: SpawnedMember): number => {
    let d = 0
    let cur = m.reportsTo
    let hops = 0
    while (cur !== 'orchestrator' && byId.has(cur) && hops++ < edited.length) {
      d++
      cur = byId.get(cur)!.reportsTo
    }
    return d
  }

  const apply = async (): Promise<void> => {
    setApplying(true)
    try {
      setGraph(await window.api.applySpawnedTeam({ members: edited, orchestratorId }))
      onClose()
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Proposed team ({edited.length})</h2>
        <div className="draft-list">
          {edited.map((m, i) => (
            <div key={m.id} className="field" style={{ marginLeft: depthOf(m) * 20 }}>
              <label>
                <span className="spawn-kind">{m.kind}</span>
                <input
                  className="spawn-name"
                  value={m.name}
                  onChange={(e) =>
                    setEdited((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                  }
                />
              </label>
              <textarea
                className="draft-role"
                value={m.role}
                onChange={(e) =>
                  setEdited((prev) => prev.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))
                }
              />
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={applying}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void apply()} disabled={applying}>
            {applying ? 'Creating…' : 'Apply — create team'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire the button + modal into `src/renderer/run/GoalBar.tsx`**

Change the imports at the top to:

```ts
import { useState } from 'react'
import { Network, Play, Sparkles, Square, Target } from 'lucide-react'
import { useStore } from '../store'
import RoleDraftModal from '../RoleDraftModal'
import TeamSpawnModal from '../TeamSpawnModal'
import type { SpawnedMember } from '../../shared/types'
```

After the existing `const [drafts, setDrafts] = useState<…>(null)` line, add:

```ts
  const [spawning, setSpawning] = useState(false)
  const [spawned, setSpawned] = useState<SpawnedMember[] | null>(null)
  const canBuild = !!target && !!goal.trim() && !running && !spawning

  const buildTeam = async (): Promise<void> => {
    if (!target || !goal.trim() || running || spawning) return
    setSpawning(true)
    try {
      const r = await window.api.spawnTeam({ goal: goal.trim(), orchestratorId: target.id })
      if (r.ok && r.members && r.members.length) setSpawned(r.members)
      else window.alert(r.error ?? 'Could not build a team.')
    } finally {
      setSpawning(false)
    }
  }
```

In the JSX, add the Build-team button immediately after the Draft-roles button (the `<button>` with `<Sparkles … /> {drafting ? 'Drafting…' : 'Draft roles'}`):

```tsx
      <button
        className="btn"
        onClick={() => void buildTeam()}
        disabled={!canBuild}
        title="Have the orchestrator design and create a team for this goal"
      >
        <Network size={14} /> {spawning ? 'Building…' : 'Build team'}
      </button>
```

And add the modal render immediately after the `{drafts && <RoleDraftModal … />}` line:

```tsx
      {spawned && target && (
        <TeamSpawnModal members={spawned} orchestratorId={target.id} onClose={() => setSpawned(null)} />
      )}
```

- [ ] **Step 3: Add the styles (`src/renderer/styles.css`)**

Append:

```css
.spawn-name {
  background: var(--panel-2);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 13px;
  font-weight: 550;
}
.spawn-kind {
  display: inline-block;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
  margin-right: 6px;
}
```

- [ ] **Step 4: Verify typecheck + build + suite**

Run: `npm run typecheck` → no errors. Run: `npm run build` → clean. Run: `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/TeamSpawnModal.tsx src/renderer/run/GoalBar.tsx src/renderer/styles.css
git commit -m "feat(spawn): Build-team button + editable tree preview modal"
```

---

## Final verification

- [ ] `npx vitest run` → all green (105 existing + new `team-spawn`, `team-spawner`, `applySpawnedTeam` tests).
- [ ] `npm run typecheck` → no errors. `npm run build` → clean.
- [ ] **Live smoke (manual):** in a project with just an orchestrator, type a goal → **Build team** → the preview shows a sensible hierarchy (managers/workers, indented) with distinct roles → tweak a name/role → **Apply** → the agents + reporting edges appear on the canvas under the orchestrator. Cancel writes nothing. Run the goal and confirm routing flows down the new tree.

## Self-review notes (spec coverage)

- Build-team button (goal + orchestrator) → Task 5.
- Hierarchical proposal (id/name/kind/role/reportsTo) → Task 1 (`spawnTeamPrompt`).
- Cycle-break before creation → Task 1 (`parseSpawnedTeam`/`breakCycles`).
- Read-only proposal + retry-once → Task 2 (`spawnTeam`).
- Existing-roster context (no duplicates) → Task 2 (`rosterForDrafting` → prompt).
- Non-destructive create (add only) + edges + layout → Task 3 (`applySpawnedTeam`).
- Editable names + roles, kind/reporting read-only, tree indentation → Task 5 (`TeamSpawnModal`).
- IPC propose + apply → Task 4.
