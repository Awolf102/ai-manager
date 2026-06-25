# Portable Team — Export / Import (B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the current project's team (roster + roles + portable lessons) to a single portable `.json` bundle, and import a bundle into another project — seeding new agents with their portable track record while their project-specific slate stays clean.

**Architecture:** A pure, unit-tested transformation core in `src/shared/` (`team-bundle.ts`, plus `lessons.ts`/`slug.ts` helpers) with no node/DOM imports; impure filesystem/graph application in `src/main/engine/project-store.ts`; wired to the renderer through new IPC methods and two top-bar buttons. Only `[portable]` lessons travel (the transfer side of the portable/project asymmetry from sub-project A).

**Tech Stack:** TypeScript, vitest, electron-vite (CJS main + React renderer). Commands: `npx vitest run`, `npm run typecheck`, `npm run build`.

## Global Constraints

- **Only `[portable]` lessons travel.** `[project]` AND untagged lessons are excluded from a bundle (untagged is treated as project for transfer). The `## Task log`, `sessionId`, run history, and project settings are never bundled.
- **`memberId = node.memberId ?? node.id`** at export. Imported agents store the bundle's `memberId`; B1 itself never reads `memberId` (it's forward-compat for B2). `memberId` is a new optional field on `AgentNodeData`.
- **Bundle identity:** `kind: 'ai-manager-team'`, `version: 1`. Edges in a bundle are keyed by `memberId`, remapped to fresh node ids on import.
- **Single source of truth:** the lesson marker convention lives only in `src/shared/lessons.ts`; the slug rule lives only in `src/shared/slug.ts`. Do not re-implement either elsewhere.
- **Pure vs impure split:** everything in `src/shared/` is pure (no `electron`/`node:fs`/DOM). All file I/O and dialogs live in main (`project-store.ts`, `ipc.ts`).
- **Import atomicity:** `importTeam` writes agent files first and calls `saveGraph()` **last**, so a mid-import failure leaves `graph.json` unchanged.
- **All 74 existing tests must stay green.** Refactors (`lessonsDigest`, `slugify`/`uniqueSlug`) must not change existing behavior.
- **Renderer/IPC has no unit-test harness** — `ipc.ts`, `preload`, and the renderer button changes are verified by `typecheck` + `build`, consistent with the rest of the app.
- **Git:** repo is initialized. Each task's final commit appends the trailer as its last line (after a blank line): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Lesson reading helpers (`portableLessons`) + refactor `lessonsDigest`

**Files:**
- Modify: `src/shared/lessons.ts` (add `lessonBullets`, `portableLessons`)
- Modify: `src/main/engine/nodes.ts` (refactor `lessonsDigest` to use `lessonBullets`; extend the `shared/lessons` import)
- Test: `src/shared/lessons.test.ts` (add `portableLessons` cases)

**Interfaces:**
- Consumes: `parseLessonBullet` (existing).
- Produces:
  - `export function lessonBullets(memory: string): string[]` — cleaned raw bullets under `## Lessons` (markers still attached; comments/whitespace cleaned; blanks and `(none yet)` dropped).
  - `export function portableLessons(memory: string): string[]` — `portable`-scoped lesson texts, uncapped, marker stripped.

- [ ] **Step 1: Write the failing tests**

In `src/shared/lessons.test.ts`, add this `describe` and extend the import:

```ts
import { parseLessonBullet, formatLessonBullet, portableLessons } from './lessons'

describe('portableLessons', () => {
  it('returns only portable lesson texts, marker stripped', () => {
    const mem = '## Lessons\n- [portable] write tests first\n- [project] api key in config\n- untagged legacy\n'
    expect(portableLessons(mem)).toEqual(['write tests first'])
  })

  it('is uncapped (unlike lessonsDigest) and ignores the placeholder', () => {
    const mem = '## Lessons\n- (none yet)\n' + Array.from({ length: 8 }, (_, i) => `- [portable] L${i}`).join('\n')
    expect(portableLessons(mem)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'])
  })

  it('returns [] when there is no Lessons section', () => {
    expect(portableLessons('# Memory\n\n## Task log\n- did stuff')).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/lessons.test.ts -t "portableLessons"`
Expected: FAIL — `portableLessons is not a function` (import is `undefined`).

- [ ] **Step 3: Add `lessonBullets` + `portableLessons` to `src/shared/lessons.ts`**

Append:

```ts
/** Cleaned raw lesson bullets under `## Lessons` (marker still attached). Comments
 * and whitespace are normalized; blank lines and the `(none yet)` placeholder are dropped. */
export function lessonBullets(memory: string): string[] {
  const lines = memory.split('\n')
  const start = lines.findIndex((l) => /^##\s+lessons\s*$/i.test(l.trim()))
  if (start === -1) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (/^##\s+/.test(raw)) break // next section
    if (!raw.startsWith('- ')) continue
    const bullet = raw.slice(2).replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim()
    if (!bullet || /^\(none yet\)$/i.test(bullet)) continue
    out.push(bullet)
  }
  return out
}

/** All `portable`-scoped lesson texts (uncapped, marker stripped). `project` and
 * untagged are excluded — the transfer side of the portable/project asymmetry. */
export function portableLessons(memory: string): string[] {
  return lessonBullets(memory)
    .map((b) => parseLessonBullet(b))
    .filter((l) => l.scope === 'portable')
    .map((l) => l.text)
}
```

- [ ] **Step 4: Refactor `lessonsDigest` in `nodes.ts` to reuse `lessonBullets`**

Extend the existing import line in `src/main/engine/nodes.ts`:

```ts
import { formatLessonBullet, lessonBullets, parseLessonBullet, type LessonScope } from '../../shared/lessons'
```

Replace the whole `lessonsDigest` function body with:

```ts
export function lessonsDigest(memory: string, maxLessons = 5, maxLen = 160): string[] {
  const out: string[] = []
  for (const bullet of lessonBullets(memory)) {
    if (out.length >= maxLessons) break
    const { scope, text } = parseLessonBullet(bullet)
    if (scope === 'project') continue // project-specific trivia is not a routing signal
    out.push(text.length > maxLen ? text.slice(0, maxLen) + '…' : text)
  }
  return out
}
```

- [ ] **Step 5: Run the full suite to verify pass (incl. unchanged `lessonsDigest` tests)**

Run: `npx vitest run`
Expected: PASS — new `portableLessons` tests pass; the existing `lessonsDigest` tests in `nodes.test.ts` still pass (behavior unchanged).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` → no errors.

```bash
git add src/shared/lessons.ts src/shared/lessons.test.ts src/main/engine/nodes.ts
git commit -m "feat(team): add portableLessons + share the Lessons scan with lessonsDigest"
```

---

### Task 2: Extract slug helpers to `shared/slug.ts` + add `AgentNodeData.memberId`

**Files:**
- Create: `src/shared/slug.ts`
- Test: `src/shared/slug.test.ts`
- Modify: `src/main/engine/project-store.ts` (import slug helpers; remove local copies)
- Modify: `src/shared/types.ts` (add `memberId?: string` to `AgentNodeData`)

**Interfaces:**
- Produces:
  - `export function slugify(name: string): string`
  - `export function uniqueSlug(base: string, taken: Set<string>): string`
  - `AgentNodeData.memberId?: string`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/slug.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { slugify, uniqueSlug } from './slug'

describe('slugify', () => {
  it('lowercases, replaces non-alphanumerics with dashes, trims dashes', () => {
    expect(slugify('  Data & Frontend!! ')).toBe('data-frontend')
  })
  it('falls back to "agent" for an empty result', () => {
    expect(slugify('@@@')).toBe('agent')
  })
})

describe('uniqueSlug', () => {
  it('returns the base when free', () => {
    expect(uniqueSlug('dana', new Set())).toBe('dana')
  })
  it('suffixes -2, -3 … when taken', () => {
    expect(uniqueSlug('dana', new Set(['dana', 'dana-2']))).toBe('dana-3')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/slug.test.ts`
Expected: FAIL — `Failed to resolve import "./slug"`.

- [ ] **Step 3: Create `src/shared/slug.ts`**

```ts
// Filesystem-safe slug rules — the single source of truth, used by project-store
// (agent dirs) and team import (uniquifying imported agents). Pure.

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  )
}

export function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base
  let i = 2
  while (taken.has(slug)) slug = `${base}-${i++}`
  return slug
}
```

- [ ] **Step 4: Run the slug tests to verify pass**

Run: `npx vitest run src/shared/slug.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Use the shared helpers in `project-store.ts`**

In `src/main/engine/project-store.ts`, add to the imports (next to `import { iconForName } from '../../shared/icons'`):

```ts
import { slugify, uniqueSlug } from '../../shared/slug'
```

Delete the two local function definitions `function slugify(...) {...}` and `function uniqueSlug(...) {...}` (the `// ---------- slug helpers ----------` block). The call sites (`createAgent`) are unchanged.

- [ ] **Step 6: Add `memberId` to `AgentNodeData`**

In `src/shared/types.ts`, inside `interface AgentNodeData`, add after the `sessionId?` line:

```ts
  /** stable team-member identity that survives export/import (used by the portable-team feature) */
  memberId?: string
```

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npx vitest run` → all green (project-store still uses the same slug rule).
Run: `npm run typecheck` → no errors.

- [ ] **Step 8: Commit**

```bash
git add src/shared/slug.ts src/shared/slug.test.ts src/main/engine/project-store.ts src/shared/types.ts
git commit -m "refactor(team): extract slug rule to shared/slug.ts; add AgentNodeData.memberId"
```

---

### Task 3: Pure team-bundle core (`src/shared/team-bundle.ts`)

**Files:**
- Create: `src/shared/team-bundle.ts`
- Test: `src/shared/team-bundle.test.ts`

**Interfaces:**
- Consumes: `AgentNodeData`, `GraphEdge`, `AgentKind`, `PermissionMode` (types); `formatLessonBullet`, `portableLessons` (`shared/lessons`); `slugify`, `uniqueSlug` (`shared/slug`).
- Produces: `TeamBundle`, `TeamMember` types; `buildSeededMemory`, `buildTeamBundle`, `validateTeamBundle`, `planTeamImport`.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/team-bundle.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  buildTeamBundle,
  buildSeededMemory,
  validateTeamBundle,
  planTeamImport,
  type TeamBundle
} from './team-bundle'
import type { AgentNodeData, GraphEdge } from './types'

const node = (over: Partial<AgentNodeData>): AgentNodeData => ({
  id: 'id1', name: 'Dana', slug: 'dana', kind: 'worker', icon: 'i',
  model: 'm', permissionMode: 'acceptEdits', position: { x: 10, y: 20 }, ...over
})

describe('buildSeededMemory', () => {
  it('seeds portable lessons as [portable] bullets with an empty task log', () => {
    const mem = buildSeededMemory('Dana', ['write tests first', 'verify renders'])
    expect(mem).toContain('## Lessons')
    expect(mem).toContain('- [portable] write tests first')
    expect(mem).toContain('- [portable] verify renders')
    expect(mem).toContain('## Task log')
    expect(mem).not.toMatch(/###/) // no log entries
  })
  it('uses the (none yet) placeholder when there are no lessons', () => {
    expect(buildSeededMemory('Dana', [])).toContain('- (none yet)')
  })
})

describe('buildTeamBundle', () => {
  const nodes = [node({ id: 'a', name: 'Dana', skills: ['data:analyze'] }), node({ id: 'b', name: 'Quinn', slug: 'quinn' })]
  const edges: GraphEdge[] = [{ id: 'e1', source: 'a', target: 'b' }]
  const files = {
    a: { role: 'role A', memory: '## Lessons\n- [portable] write tests first\n- [project] secret path\n' },
    b: { role: 'role B', memory: '## Lessons\n- (none yet)\n' }
  }

  it('carries roster fields, role, and portable-only lessons', () => {
    const bundle = buildTeamBundle({ name: 'Squad', exportedAt: 'T', nodes, edges, files })
    expect(bundle.kind).toBe('ai-manager-team')
    expect(bundle.version).toBe(1)
    const dana = bundle.members.find((m) => m.name === 'Dana')!
    expect(dana.role).toBe('role A')
    expect(dana.lessons).toEqual(['write tests first']) // project + untagged excluded
    expect(dana.skills).toEqual(['data:analyze'])
  })

  it('derives memberId as node.memberId ?? node.id and keys edges by memberId', () => {
    const withMember = [node({ id: 'a', name: 'Dana', memberId: 'mem-a' }), node({ id: 'b', name: 'Quinn', slug: 'quinn' })]
    const bundle = buildTeamBundle({ name: 'Squad', exportedAt: 'T', nodes: withMember, edges, files })
    expect(bundle.members.find((m) => m.name === 'Dana')!.memberId).toBe('mem-a')
    expect(bundle.members.find((m) => m.name === 'Quinn')!.memberId).toBe('b')
    expect(bundle.edges).toEqual([{ source: 'mem-a', target: 'b' }])
  })
})

describe('validateTeamBundle', () => {
  const good: TeamBundle = {
    kind: 'ai-manager-team', version: 1, name: 'S', exportedAt: 'T',
    members: [{ memberId: 'm', name: 'Dana', kind: 'worker', model: 'm', permissionMode: 'acceptEdits', icon: 'i', position: { x: 0, y: 0 }, role: '', lessons: [] }],
    edges: []
  }
  it('accepts a well-formed bundle', () => {
    const r = validateTeamBundle(good)
    expect(r.ok).toBe(true)
  })
  it('rejects wrong kind / version / shape with a message', () => {
    expect(validateTeamBundle({ ...good, kind: 'nope' }).ok).toBe(false)
    expect(validateTeamBundle({ ...good, version: 2 }).ok).toBe(false)
    expect(validateTeamBundle({ ...good, members: 'x' }).ok).toBe(false)
    expect(validateTeamBundle(null).ok).toBe(false)
  })
})

describe('planTeamImport', () => {
  const bundle: TeamBundle = {
    kind: 'ai-manager-team', version: 1, name: 'S', exportedAt: 'T',
    members: [
      { memberId: 'm1', name: 'Dana', kind: 'worker', model: 'm', permissionMode: 'acceptEdits', skills: ['data:analyze'], icon: 'i', position: { x: 10, y: 20 }, role: 'role A', lessons: ['write tests first'] }
    ],
    edges: []
  }
  it('uniquifies slugs against existing, offsets positions, seeds memory, carries memberId/skills', () => {
    const plan = planTeamImport(bundle, ['dana'])
    const m = plan.members[0]
    expect(m.slug).toBe('dana-2') // 'dana' taken
    expect(m.memberId).toBe('m1')
    expect(m.skills).toEqual(['data:analyze'])
    expect(m.position).toEqual({ x: 58, y: 68 }) // +48 offset
    expect(m.memory).toContain('- [portable] write tests first')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/team-bundle.test.ts`
Expected: FAIL — `Failed to resolve import "./team-bundle"`.

- [ ] **Step 3: Create `src/shared/team-bundle.ts`**

```ts
// Pure transformation core for the portable-team feature: build a bundle from a
// project's graph + agent files, validate an untrusted bundle, and plan an import.
// No node/DOM imports — unit-tested in plain Node, used by the main process.

import type { AgentKind, AgentNodeData, GraphEdge, PermissionMode } from './types'
import { formatLessonBullet, portableLessons } from './lessons'
import { slugify, uniqueSlug } from './slug'

const POSITION_OFFSET = 48

export interface TeamMember {
  memberId: string
  name: string
  kind: AgentKind
  model: string
  permissionMode: PermissionMode
  skills?: string[]
  icon: string
  position: { x: number; y: number }
  role: string
  lessons: string[] // portable lesson texts, marker stripped
}

export interface TeamBundle {
  kind: 'ai-manager-team'
  version: 1
  name: string
  exportedAt: string
  members: TeamMember[]
  edges: { source: string; target: string }[] // by memberId
}

/** A fresh memory.md seeded with portable lessons and an empty task log. */
export function buildSeededMemory(name: string, lessons: string[]): string {
  const body = lessons.length > 0 ? lessons.map((t) => `- ${formatLessonBullet('portable', t)}`).join('\n') : '- (none yet)'
  return `# Memory: ${name}

This is your persistent brain. Read it before each task and learn from it. After a
task, record what worked and what didn't so you don't repeat mistakes.

## Lessons
<!-- One bullet per lesson. Keep the sharpest, most reusable insights here. -->
${body}

## Task log
<!-- Newest first. For each task: what you attempted, the outcome, wins, and losses. -->
`
}

/** Build a portable bundle from the live graph + each agent's role/memory files. */
export function buildTeamBundle(args: {
  name: string
  exportedAt: string
  nodes: AgentNodeData[]
  edges: GraphEdge[]
  files: Record<string, { role: string; memory: string }>
}): TeamBundle {
  const memberIdByNode = new Map(args.nodes.map((n) => [n.id, n.memberId ?? n.id]))
  const members: TeamMember[] = args.nodes.map((n) => {
    const f = args.files[n.id] ?? { role: '', memory: '' }
    const member: TeamMember = {
      memberId: memberIdByNode.get(n.id)!,
      name: n.name,
      kind: n.kind,
      model: n.model,
      permissionMode: n.permissionMode,
      icon: n.icon,
      position: n.position,
      role: f.role,
      lessons: portableLessons(f.memory)
    }
    if (n.skills && n.skills.length) member.skills = n.skills
    return member
  })
  const edges = args.edges
    .filter((e) => memberIdByNode.has(e.source) && memberIdByNode.has(e.target))
    .map((e) => ({ source: memberIdByNode.get(e.source)!, target: memberIdByNode.get(e.target)! }))
  return { kind: 'ai-manager-team', version: 1, name: args.name, exportedAt: args.exportedAt, members, edges }
}

/** Validate untrusted JSON read from disk. */
export function validateTeamBundle(
  raw: unknown
): { ok: true; bundle: TeamBundle } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Not a team bundle (not an object).' }
  const b = raw as Record<string, unknown>
  if (b.kind !== 'ai-manager-team') return { ok: false, error: 'Not an AI Manager team bundle.' }
  if (b.version !== 1) return { ok: false, error: `Unsupported team bundle version: ${String(b.version)}.` }
  if (!Array.isArray(b.members)) return { ok: false, error: 'Team bundle has no members array.' }
  for (const m of b.members) {
    const mm = m as Record<string, unknown>
    if (typeof mm.memberId !== 'string' || typeof mm.name !== 'string' || typeof mm.kind !== 'string') {
      return { ok: false, error: 'Team bundle has a malformed member.' }
    }
  }
  if (b.edges !== undefined && !Array.isArray(b.edges)) return { ok: false, error: 'Team bundle edges are malformed.' }
  return { ok: true, bundle: raw as TeamBundle }
}

export interface PlannedMember {
  memberId: string
  name: string
  slug: string
  kind: AgentKind
  model: string
  permissionMode: PermissionMode
  skills?: string[]
  icon: string
  position: { x: number; y: number }
  role: string
  memory: string
}

/** Plan an import into a project: per-member fields (slug uniquified, position
 * offset, memory seeded) and edges still keyed by memberId. The caller assigns
 * fresh node ids and remaps the edges. */
export function planTeamImport(
  bundle: TeamBundle,
  existingSlugs: string[]
): { members: PlannedMember[]; edges: { source: string; target: string }[] } {
  const taken = new Set(existingSlugs)
  const members: PlannedMember[] = bundle.members.map((m) => {
    const slug = uniqueSlug(slugify(m.name), taken)
    taken.add(slug)
    const planned: PlannedMember = {
      memberId: m.memberId,
      name: m.name,
      slug,
      kind: m.kind,
      model: m.model,
      permissionMode: m.permissionMode,
      icon: m.icon,
      position: { x: m.position.x + POSITION_OFFSET, y: m.position.y + POSITION_OFFSET },
      role: m.role,
      memory: buildSeededMemory(m.name, m.lessons)
    }
    if (m.skills && m.skills.length) planned.skills = m.skills
    return planned
  })
  return { members, edges: bundle.edges }
}
```

- [ ] **Step 4: Run the team-bundle tests to verify pass**

Run: `npx vitest run src/shared/team-bundle.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` → no errors.

```bash
git add src/shared/team-bundle.ts src/shared/team-bundle.test.ts
git commit -m "feat(team): pure team-bundle core (build/validate/plan + seeded memory)"
```

---

### Task 4: `exportTeam` + `importTeam` in `project-store.ts` (impure) + round-trip test

**Files:**
- Modify: `src/main/engine/project-store.ts` (add `exportTeam`, `importTeam`; import team-bundle core)
- Test: `src/main/engine/project-store.test.ts` (add a round-trip integration test)

**Interfaces:**
- Consumes: `buildTeamBundle`, `planTeamImport`, `TeamBundle` (`shared/team-bundle`); existing `requireCurrent`, `readRole`, `readMemory`, `saveGraph`, `aimPath`, `AGENTS_DIR`, `fs`, `join`, `randomUUID` (all in `project-store.ts`).
- Produces:
  - `export async function exportTeam(): Promise<TeamBundle>`
  - `export async function importTeam(bundle: TeamBundle): Promise<ProjectGraph>`

- [ ] **Step 1: Write the failing test**

In `src/main/engine/project-store.test.ts`, add (the file already mocks `electron` at the top):

```ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  openProject,
  createAgent,
  writeMemory,
  readMemory,
  exportTeam,
  importTeam
} from './project-store'

async function tmpProject(): Promise<string> {
  const dir = join(tmpdir(), `aim-test-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe('team export/import round-trip', () => {
  it('exports portable lessons only and re-imports the team into a fresh project', async () => {
    await openProject(await tmpProject())
    await createAgent({ name: 'Dana', kind: 'worker' })
    const graph = await createAgent({ name: 'Quinn', kind: 'worker' })
    const dana = graph.nodes.find((n) => n.name === 'Dana')!
    await writeMemory(
      dana.id,
      '# Memory: Dana\n\n## Lessons\n- [portable] write tests first\n- [project] api key in config\n\n## Task log\n'
    )

    const bundle = await exportTeam()
    expect(bundle.kind).toBe('ai-manager-team')
    expect(bundle.members).toHaveLength(2)
    const danaMember = bundle.members.find((m) => m.name === 'Dana')!
    expect(danaMember.lessons).toEqual(['write tests first']) // project lesson excluded

    await openProject(await tmpProject()) // fresh, empty project
    const after = await importTeam(bundle)
    expect(after.nodes).toHaveLength(2)
    const imported = after.nodes.find((n) => n.name === 'Dana')!
    expect(imported.memberId).toBe(danaMember.memberId)
    const mem = await readMemory(imported.id)
    expect(mem).toContain('- [portable] write tests first')
    expect(mem).not.toContain('api key in config')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "round-trip"`
Expected: FAIL — `exportTeam`/`importTeam` are not exported (`is not a function`).

- [ ] **Step 3: Implement `exportTeam` + `importTeam`**

In `src/main/engine/project-store.ts`, add the import (next to the other `../../shared/*` imports):

```ts
import { buildTeamBundle, planTeamImport, type TeamBundle } from '../../shared/team-bundle'
```

Add these functions (e.g. after `importTeam`'s siblings in the orchestration-helpers area — anywhere top-level is fine):

```ts
// ---------- portable team (export / import) ----------

/** Snapshot the open project's team into a portable bundle (portable lessons only). */
export async function exportTeam(): Promise<TeamBundle> {
  const { graph } = requireCurrent()
  const files: Record<string, { role: string; memory: string }> = {}
  for (const n of graph.nodes) {
    files[n.id] = { role: await readRole(n.id), memory: await readMemory(n.id) }
  }
  return buildTeamBundle({
    name: graph.project.name,
    exportedAt: new Date().toISOString(),
    nodes: graph.nodes,
    edges: graph.edges,
    files
  })
}

/** Add a bundle's team into the open project: new agents (fresh ids, uniquified
 * slugs, seeded memory), remapped edges. Saves the graph LAST for atomicity. */
export async function importTeam(bundle: TeamBundle): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const plan = planTeamImport(bundle, graph.nodes.map((n) => n.slug))
  const idByMember = new Map<string, string>()
  for (const m of plan.members) {
    const id = randomUUID()
    idByMember.set(m.memberId, id)
    const dir = aimPath(path, AGENTS_DIR, m.slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'role.md'), m.role, 'utf8')
    await fs.writeFile(join(dir, 'memory.md'), m.memory, 'utf8')
    const node: AgentNodeData = {
      id,
      name: m.name,
      slug: m.slug,
      kind: m.kind,
      icon: m.icon,
      model: m.model,
      permissionMode: m.permissionMode,
      memberId: m.memberId,
      position: m.position
    }
    if (m.skills) node.skills = m.skills
    graph.nodes.push(node)
  }
  for (const e of plan.edges) {
    const source = idByMember.get(e.source)
    const target = idByMember.get(e.target)
    if (source && target) graph.edges.push({ id: `${source}->${target}`, source, target })
  }
  return saveGraph()
}
```

- [ ] **Step 4: Run the round-trip test, then the full suite + typecheck + build**

Run: `npx vitest run src/main/engine/project-store.test.ts` → PASS.
Run: `npx vitest run` → all green.
Run: `npm run typecheck` → no errors.
Run: `npm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(team): exportTeam + importTeam (filesystem + graph), round-trip tested"
```

---

### Task 5: IPC + preload wiring (`team:export`, `team:import`)

**Files:**
- Modify: `src/shared/types.ts` (add two `IPC` channels + two `RendererApi` methods)
- Modify: `src/main/ipc.ts` (two handlers with dialogs + file I/O)
- Modify: `src/preload/index.ts` (expose `exportTeam` / `importTeam`)

**Interfaces:**
- Consumes: `store.exportTeam`, `store.importTeam`, `validateTeamBundle`.
- Produces:
  - `RendererApi.exportTeam: () => Promise<{ saved: boolean; path?: string }>`
  - `RendererApi.importTeam: () => Promise<{ imported: boolean; graph?: ProjectGraph; error?: string }>`

**Note:** no unit test (electron dialogs); verified by `typecheck` + `build`.

- [ ] **Step 1: Add IPC channels + RendererApi methods (`src/shared/types.ts`)**

In `export const IPC = { … }`, add after `loadRun: 'runs:load'` (add a comma to that line):

```ts
  exportTeam: 'team:export',
  importTeam: 'team:import'
```

In `export interface RendererApi`, add after `loadRun(...)`:

```ts
  exportTeam: () => Promise<{ saved: boolean; path?: string }>
  importTeam: () => Promise<{ imported: boolean; graph?: ProjectGraph; error?: string }>
```

- [ ] **Step 2: Add the main handlers (`src/main/ipc.ts`)**

Extend the imports: change `import { dialog, ipcMain } from 'electron'` is already present; add `import { promises as fs } from 'node:fs'` at the top, and `import { validateTeamBundle } from '../shared/team-bundle'`.

Add, before the closing `}` of `registerIpc()`:

```ts
  // ---- portable team ----
  ipcMain.handle(IPC.exportTeam, async () => {
    const bundle = await store.exportTeam()
    const r = await dialog.showSaveDialog({
      title: 'Export team',
      defaultPath: `${bundle.name || 'team'}.aimteam.json`,
      filters: [{ name: 'AI Manager team', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return { saved: false }
    await fs.writeFile(r.filePath, JSON.stringify(bundle, null, 2), 'utf8')
    return { saved: true, path: r.filePath }
  })
  ipcMain.handle(IPC.importTeam, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Import team',
      properties: ['openFile'],
      filters: [{ name: 'AI Manager team', extensions: ['json'] }]
    })
    if (r.canceled || r.filePaths.length === 0) return { imported: false }
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(r.filePaths[0], 'utf8'))
    } catch {
      return { imported: false, error: 'That file is not valid JSON.' }
    }
    const v = validateTeamBundle(parsed)
    if (!v.ok) return { imported: false, error: v.error }
    const graph = await store.importTeam(v.bundle)
    return { imported: true, graph }
  })
```

- [ ] **Step 3: Expose in preload (`src/preload/index.ts`)**

In `const api: RendererApi = { … }`, add after `loadRun: (file) => ipcRenderer.invoke(IPC.loadRun, file)` (add a comma to that line):

```ts
  exportTeam: () => ipcRenderer.invoke(IPC.exportTeam),
  importTeam: () => ipcRenderer.invoke(IPC.importTeam)
```

- [ ] **Step 4: Verify typecheck + build**

Run: `npm run typecheck` → no errors.
Run: `npm run build` → clean.
Run: `npx vitest run` → all green (regression guard; no tested code touched besides types).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat(team): IPC + preload for team export/import"
```

---

### Task 6: Renderer — Export / Import team buttons (`App.tsx`)

**Files:**
- Modify: `src/renderer/App.tsx` (two top-bar buttons)

**Interfaces:**
- Consumes: `window.api.exportTeam()`, `window.api.importTeam()`, `setGraph`.

**Note:** no unit test (renderer has no harness); verified by `typecheck` + `build`.

- [ ] **Step 1: Add the icons to the import**

In `src/renderer/App.tsx`, change line 2 to include upload/download icons:

```ts
import { Clock, Download, FolderOpen, Plus, Settings as SettingsIcon, Upload } from 'lucide-react'
```

- [ ] **Step 2: Add the two buttons**

In the `<div className="topbar">`, immediately after the "Run history" button (the one with `<Clock size={14} />`), insert:

```tsx
        <button
          className="btn"
          title="Export team to a file"
          onClick={async () => {
            await window.api.exportTeam()
          }}
        >
          <Upload size={14} />
        </button>
        <button
          className="btn"
          title="Import a team into this project"
          onClick={async () => {
            const r = await window.api.importTeam()
            if (r.imported && r.graph) setGraph(r.graph)
            else if (r.error) window.alert(r.error)
          }}
        >
          <Download size={14} />
        </button>
```

(`setGraph` is already pulled from the store at the top of `App` — `const setGraph = useStore((s) => s.setGraph)`.)

- [ ] **Step 3: Verify typecheck + build**

Run: `npm run typecheck` → no errors.
Run: `npm run build` → clean.
Run: `npx vitest run` → all green.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(team): Export/Import team buttons in the top bar"
```

---

## Final verification

After all six tasks:

- [ ] Run: `npx vitest run` → all green (74 existing + new `portableLessons`, `slug`, `team-bundle`, and round-trip tests).
- [ ] Run: `npm run typecheck` → no errors.
- [ ] Run: `npm run build` → clean.
- [ ] **Live smoke (manual):** in a project with a team, click Export → save a `.json`; open/switch to another project folder → click Import → pick the file → confirm the roster + edges appear, and an imported agent's `memory.md` has its `[portable]` lessons but no `[project]`/task-log entries.

## Self-review notes (spec coverage)

- Bundle format + memberId derivation → Task 3 (`buildTeamBundle`).
- Portable-only transfer (drop project + untagged) → Task 1 (`portableLessons`) + Task 3.
- Seeded memory (portable lessons + empty task log) → Task 3 (`buildSeededMemory`).
- Slug uniquify / position offset → Task 2 (`shared/slug`) + Task 3 (`planTeamImport`).
- `AgentNodeData.memberId` (decision A) → Task 2.
- No settings/sessionId/task-log carried (decision B + non-goals) → Task 3 (excluded by construction).
- Export/import filesystem + graph, save-graph-last atomicity → Task 4.
- Validation + error surfacing → Task 3 (`validateTeamBundle`) + Task 5 (handler) + Task 6 (alert).
- IPC/preload/renderer surface → Tasks 5–6.
- Testing strategy (pure core unit-tested; wiring via typecheck+build) → Tasks 1–4 tests; 5–6 build-verified.
