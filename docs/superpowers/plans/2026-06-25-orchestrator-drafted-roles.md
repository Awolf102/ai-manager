# Orchestrator-Drafted Agent Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Draft roles" button that has the orchestrator author a complete, complementary `role.md` for each non-orchestrator agent from the goal, shown in an editable preview, written only on Apply.

**Architecture:** Pure prompt/parse in `src/shared/role-draft.ts`; the orchestrator call in `src/main/engine/role-drafter.ts` (roster from `project-store`, agent via `streamAgent` behind an injected seam, read-only); IPC `roles:draft`; Apply reuses the existing `writeRole` IPC; renderer = a GoalBar button + a preview modal.

**Tech Stack:** TypeScript, vitest, electron-vite (CJS main + React renderer). Commands: `npx vitest run`, `npm run typecheck`, `npm run build`.

## Global Constraints

- **Draft only non-orchestrator agents** (managers + workers). The orchestrator keeps its general planning role and is never given a drafted role.
- **Whole `role.md` per agent**, with **distinct, complementary** specialties (the orchestrator sees the full roster + topology), framed as **durable** specialties (informed by the goal, not overfit).
- **The orchestrator runs READ-ONLY:** `permissionMode: 'default'` + `disallowedTools: ['Edit','Write','MultiEdit','NotebookEdit','Bash','WebFetch','WebSearch']`. It may read project files but cannot edit anything.
- **Nothing is written until Apply.** `draftRoles` returns drafts only; Apply loops the existing `writeRole(agentId, content)` IPC.
- **Parse retries once** with a strict reminder, then throws (the `runStructured` pattern).
- **Pure core has no node/DOM imports.** `draftRoles` takes an injected `runAgent` (default `streamAgent`) so it's unit-testable with a canned agent.
- **All 96 existing tests must stay green.** Renderer/IPC verified by `typecheck` + `build` (no renderer harness).
- **Git:** commit per task; append the trailer as the last line (after a blank line): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Pure prompt + parse (`src/shared/role-draft.ts`)

**Files:**
- Create: `src/shared/role-draft.ts`
- Test: `src/shared/role-draft.test.ts`

**Interfaces:**
- Consumes: `AgentKind` (`./types`).
- Produces:
  - `interface DraftRosterAgent { id: string; name: string; kind: AgentKind; role: string }`
  - `draftRolesPrompt(goal: string, roster: DraftRosterAgent[], edges: { source: string; target: string }[]): string`
  - `parseDraftedRoles(text: string, knownIds: string[]): { agentId: string; role: string }[] | null`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/role-draft.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { draftRolesPrompt, parseDraftedRoles, type DraftRosterAgent } from './role-draft'

const roster: DraftRosterAgent[] = [
  { id: 'w1', name: 'Dana', kind: 'worker', role: 'general' },
  { id: 'w2', name: 'Quinn', kind: 'worker', role: 'general' }
]

describe('draftRolesPrompt', () => {
  it('includes the goal, every roster agent, the topology, and the JSON shape', () => {
    const p = draftRolesPrompt('build a data app', roster, [{ source: 'm1', target: 'w1' }])
    expect(p).toContain('build a data app')
    expect(p).toContain('id: w1')
    expect(p).toContain('Dana')
    expect(p).toContain('Quinn')
    expect(p).toMatch(/distinct/i)
    expect(p).toContain('"roles"')
  })
})

describe('parseDraftedRoles', () => {
  it('parses roles for known agents', () => {
    const text = '```json\n{"roles":[{"agentId":"w1","role":"# Role: Dana"},{"agentId":"w2","role":"# Role: Quinn"}]}\n```'
    expect(parseDraftedRoles(text, ['w1', 'w2'])).toEqual([
      { agentId: 'w1', role: '# Role: Dana' },
      { agentId: 'w2', role: '# Role: Quinn' }
    ])
  })
  it('drops unknown agent ids and empty roles', () => {
    const text = '```json\n{"roles":[{"agentId":"ghost","role":"x"},{"agentId":"w1","role":"   "},{"agentId":"w2","role":"ok"}]}\n```'
    expect(parseDraftedRoles(text, ['w1', 'w2'])).toEqual([{ agentId: 'w2', role: 'ok' }])
  })
  it('returns null when there is no roles array', () => {
    expect(parseDraftedRoles('no json here', ['w1'])).toBeNull()
    expect(parseDraftedRoles('```json\n{"nope":1}\n```', ['w1'])).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/role-draft.test.ts`
Expected: FAIL — `Failed to resolve import "./role-draft"`.

- [ ] **Step 3: Create `src/shared/role-draft.ts`**

```ts
// Pure prompt-building + output-parsing for orchestrator-drafted agent roles.
// No node/DOM imports — unit-tested in plain Node, used by the engine.
import type { AgentKind } from './types'

export interface DraftRosterAgent {
  id: string
  name: string
  kind: AgentKind
  role: string
}

export function draftRolesPrompt(
  goal: string,
  roster: DraftRosterAgent[],
  edges: { source: string; target: string }[]
): string {
  const nameById = new Map(roster.map((a) => [a.id, a.name]))
  const agents = roster
    .map(
      (a) =>
        `- id: ${a.id}\n  name: ${a.name} (${a.kind})\n  current role: ${a.role.replace(/\s+/g, ' ').slice(0, 400)}`
    )
    .join('\n')
  const topology =
    edges.map((e) => `${nameById.get(e.source) ?? e.source} → ${nameById.get(e.target) ?? e.target}`).join('\n') ||
    '(no reporting links)'
  return `You are the lead orchestrator. Draft a tailored role for each specialist on your team so they are well-suited to this goal. Each role becomes that agent's role.md and is reused across future goals, so write a DURABLE specialty (informed by the goal, not narrowly tied to it).

GOAL:
${goal}

YOUR TEAM (write one role per agent; make their specialties DISTINCT and COMPLEMENTARY — no two agents should share the same focus):
${agents}

REPORTING STRUCTURE (source delegates work down to target):
${topology}

For each agent, write a COMPLETE role.md in this shape:
# Role: <name> (<Worker|Manager>)

## Specialty
<1-3 sentences naming this agent's distinct focus on this team>

## Responsibilities
- <bullet>
- <bullet>

## How you work
- <bullet>

## Constraints
- You operate inside this one project folder.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "roles": [ { "agentId": "<id>", "role": "<the full role.md markdown>" } ] }
\`\`\``
}

export function parseDraftedRoles(
  text: string,
  knownIds: string[]
): { agentId: string; role: string }[] | null {
  const parsed = parseJsonBlock(text)
  const roles = (parsed as { roles?: unknown })?.roles
  if (!Array.isArray(roles)) return null
  const known = new Set(knownIds)
  const out: { agentId: string; role: string }[] = []
  for (const r of roles) {
    const o = r as { agentId?: unknown; role?: unknown }
    const agentId = String(o.agentId ?? '')
    const role = String(o.role ?? '').trim()
    if (known.has(agentId) && role) out.push({ agentId, role })
  }
  return out
}

function parseJsonBlock(text: string): unknown {
  const candidates: string[] = []
  const fences = [...text.matchAll(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/gi)]
  // (\x60 = backtick; matches a ```json … ``` fenced block without literal backticks here)
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

(Note: `parseJsonBlock` mirrors the private one in `nodes.ts`; small intentional duplication keeps this module pure and standalone.)

- [ ] **Step 4: Run the tests + typecheck**

Run: `npx vitest run src/shared/role-draft.test.ts` → PASS.
Run: `npx vitest run` → all green. Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/role-draft.ts src/shared/role-draft.test.ts
git commit -m "feat(roles): pure draftRolesPrompt + parseDraftedRoles"
```

---

### Task 2: `rosterForDrafting` in `project-store.ts`

**Files:**
- Modify: `src/main/engine/project-store.ts` (add `rosterForDrafting`)
- Test: `src/main/engine/project-store.test.ts` (add a roster test)

**Interfaces:**
- Consumes: `DraftRosterAgent` (`shared/role-draft`); existing `requireCurrent`, `readRole`, `GraphEdge`.
- Produces: `rosterForDrafting(): Promise<{ agents: DraftRosterAgent[]; edges: GraphEdge[] }>` — the current graph's non-orchestrator agents (id/name/kind + current role) and its edges.

- [ ] **Step 1: Write the failing test**

In `src/main/engine/project-store.test.ts`, extend the existing import from `'./project-store'` to add `writeRole, rosterForDrafting`, and add:

```ts
describe('rosterForDrafting', () => {
  it('returns non-orchestrator agents with their roles, plus edges', async () => {
    await openProject(await tmpProject())
    await createAgent({ name: 'Boss', kind: 'orchestrator' })
    const g = await createAgent({ name: 'Dana', kind: 'worker' })
    const boss = g.nodes.find((n) => n.name === 'Boss')!
    const dana = g.nodes.find((n) => n.name === 'Dana')!
    await setEdges([{ id: 'e1', source: boss.id, target: dana.id }])
    await writeRole(dana.id, '# Role: Dana\nA data specialist.')

    const { agents, edges } = await rosterForDrafting()
    expect(agents.map((a) => a.name)).toEqual(['Dana']) // orchestrator excluded
    expect(agents[0].role).toContain('data specialist')
    expect(edges).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "rosterForDrafting"`
Expected: FAIL — `rosterForDrafting is not a function`.

- [ ] **Step 3: Implement `rosterForDrafting`**

In `src/main/engine/project-store.ts`, add the import (next to the other `../../shared/*` imports):

```ts
import type { DraftRosterAgent } from '../../shared/role-draft'
```

Add the function (near the other orchestration helpers, e.g. after `rolesOf`):

```ts
/** Non-orchestrator agents (id/name/kind + current role) and the graph edges — for role drafting. */
export async function rosterForDrafting(): Promise<{ agents: DraftRosterAgent[]; edges: GraphEdge[] }> {
  const { graph } = requireCurrent()
  const agents: DraftRosterAgent[] = []
  for (const n of graph.nodes) {
    if (n.kind === 'orchestrator') continue
    agents.push({ id: n.id, name: n.name, kind: n.kind, role: await readRole(n.id) })
  }
  return { agents, edges: graph.edges }
}
```

- [ ] **Step 4: Run the test, full suite, typecheck**

Run: `npx vitest run src/main/engine/project-store.test.ts` → PASS.
Run: `npx vitest run` → all green. Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(roles): rosterForDrafting (non-orchestrator agents + edges)"
```

---

### Task 3: `draftRoles` orchestrator call (`src/main/engine/role-drafter.ts`)

**Files:**
- Create: `src/main/engine/role-drafter.ts`
- Test: `src/main/engine/role-drafter.test.ts`

**Interfaces:**
- Consumes: `streamAgent`/`StreamAgentOptions` (`./agent-runner`); `rosterForDrafting`, `getAgent` (`./project-store`); `draftRolesPrompt`, `parseDraftedRoles` (`shared/role-draft`).
- Produces:
  - `type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>`
  - `draftRoles(opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string }, runAgent?: AgentRunner): Promise<{ agentId: string; name: string; role: string }[]>`

- [ ] **Step 1: Write the failing tests**

Create `src/main/engine/role-drafter.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  roster: {
    agents: [
      { id: 'w1', name: 'Dana', kind: 'worker', role: 'general' },
      { id: 'w2', name: 'Quinn', kind: 'worker', role: 'general' }
    ],
    edges: [{ source: 'm1', target: 'w1' }]
  }
}))

vi.mock('./project-store', () => ({
  rosterForDrafting: async () => h.roster,
  getAgent: (id: string) => ({ id, name: 'Boss' })
}))
vi.mock('./agent-runner', () => ({ streamAgent: async () => ({ text: '' }) }))

import { draftRoles, type AgentRunner } from './role-drafter'

const opts = () => ({
  goal: 'build it',
  orchestratorId: 'o',
  wc: {} as never,
  abort: new AbortController(),
  runId: 'draft'
})

describe('draftRoles', () => {
  it('returns a named role draft for each roster agent', async () => {
    const runAgent: AgentRunner = async () => ({
      text: '```json\n{"roles":[{"agentId":"w1","role":"# Role: Dana\\nA"},{"agentId":"w2","role":"# Role: Quinn\\nB"}]}\n```'
    })
    expect(await draftRoles(opts(), runAgent)).toEqual([
      { agentId: 'w1', name: 'Dana', role: '# Role: Dana\nA' },
      { agentId: 'w2', name: 'Quinn', role: '# Role: Quinn\nB' }
    ])
  })

  it('retries once, then throws on persistently unparseable output', async () => {
    let calls = 0
    const runAgent: AgentRunner = async () => {
      calls++
      return { text: 'no json here' }
    }
    await expect(draftRoles(opts(), runAgent)).rejects.toThrow(/did not return valid role drafts/)
    expect(calls).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/engine/role-drafter.test.ts`
Expected: FAIL — `Failed to resolve import "./role-drafter"`.

- [ ] **Step 3: Create `src/main/engine/role-drafter.ts`**

```ts
// Standalone (non-graph) orchestrator call that drafts a tailored role.md for each
// non-orchestrator agent. Read-only — returns drafts only; the renderer writes them
// via the existing writeRole IPC after the user approves.
import type { WebContents } from 'electron'
import type { StreamAgentOptions } from './agent-runner'
import { streamAgent } from './agent-runner'
import { getAgent, rosterForDrafting } from './project-store'
import { draftRolesPrompt, parseDraftedRoles } from '../../shared/role-draft'

const THINK_DISALLOW = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']
const STRICT_REMINDER =
  '\n\nIMPORTANT: Your previous reply could not be parsed. Reply with ONLY the JSON code block described above — no prose before or after.'

export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

export async function draftRoles(
  opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string },
  runAgent: AgentRunner = streamAgent
): Promise<{ agentId: string; name: string; role: string }[]> {
  const { agents, edges } = await rosterForDrafting()
  if (agents.length === 0) return []
  const knownIds = agents.map((a) => a.id)
  const nameById = new Map(agents.map((a) => [a.id, a.name]))
  const base = draftRolesPrompt(opts.goal, agents, edges)
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
    const parsed = parseDraftedRoles(text, knownIds)
    if (parsed && parsed.length > 0) {
      return parsed.map((r) => ({ agentId: r.agentId, name: nameById.get(r.agentId) ?? r.agentId, role: r.role }))
    }
  }
  throw new Error(
    `${getAgent(opts.orchestratorId).name} did not return valid role drafts. Last output:\n${last.slice(0, 400)}`
  )
}
```

- [ ] **Step 4: Run the tests, full suite, typecheck**

Run: `npx vitest run src/main/engine/role-drafter.test.ts` → PASS.
Run: `npx vitest run` → all green. Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/role-drafter.ts src/main/engine/role-drafter.test.ts
git commit -m "feat(roles): draftRoles orchestrator call (read-only, seam-tested)"
```

---

### Task 4: IPC + preload (`roles:draft`)

**Files:**
- Modify: `src/shared/types.ts` (1 `IPC` channel + 1 `RendererApi` method)
- Modify: `src/main/ipc.ts` (handler)
- Modify: `src/preload/index.ts` (method)

**Interfaces:**
- Consumes: `draftRoles` (`./engine/role-drafter`).
- Produces: `RendererApi.draftRoles: (input: { goal: string; orchestratorId: string }) => Promise<{ ok: boolean; drafts?: { agentId: string; name: string; role: string }[]; error?: string }>`.

**Note:** no unit test (electron); verified by `typecheck` + `build`.

- [ ] **Step 1: Add the channel + RendererApi method (`src/shared/types.ts`)**

In `export const IPC = { … }`, add after `refreshTeam: 'team:refreshFrom'` (add a comma to that line):

```ts
  draftRoles: 'roles:draft'
```

In `export interface RendererApi`, add after the `refreshFromTeam(...)` method:

```ts
  draftRoles: (input: { goal: string; orchestratorId: string }) => Promise<{
    ok: boolean
    drafts?: { agentId: string; name: string; role: string }[]
    error?: string
  }>
```

- [ ] **Step 2: Add the handler (`src/main/ipc.ts`)**

Add `import { draftRoles } from './engine/role-drafter'` near the other engine imports.

Add, before the closing `}` of `registerIpc()`:

```ts
  // ---- role drafting ----
  ipcMain.handle(
    IPC.draftRoles,
    async (e: IpcMainInvokeEvent, input: { goal: string; orchestratorId: string }) => {
      try {
        const drafts = await draftRoles({
          goal: input.goal,
          orchestratorId: input.orchestratorId,
          wc: e.sender,
          abort: new AbortController(),
          runId: 'draft-roles'
        })
        return { ok: true, drafts }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
```

- [ ] **Step 3: Expose in preload (`src/preload/index.ts`)**

In `const api: RendererApi = { … }`, add after the `refreshFromTeam: …` line (add a comma to it):

```ts
  draftRoles: (input) => ipcRenderer.invoke(IPC.draftRoles, input)
```

- [ ] **Step 4: Verify typecheck + build + suite**

Run: `npm run typecheck` → no errors. Run: `npm run build` → clean. Run: `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat(roles): IPC + preload for draftRoles"
```

---

### Task 5: Renderer — Draft button + preview modal

**Files:**
- Modify: `src/renderer/run/GoalBar.tsx` (Draft-roles button + open the modal)
- Create: `src/renderer/RoleDraftModal.tsx`
- Modify: `src/renderer/styles.css` (`.modal-wide`, `.draft-list`, `.draft-role`)

**Interfaces:**
- Consumes: `window.api.draftRoles`, `window.api.writeRole`.

**Note:** no unit test (renderer); verified by `typecheck` + `build`.

- [ ] **Step 1: Create the preview modal `src/renderer/RoleDraftModal.tsx`**

```tsx
import { useState } from 'react'

type Draft = { agentId: string; name: string; role: string }

export default function RoleDraftModal({ drafts, onClose }: { drafts: Draft[]; onClose: () => void }) {
  const [edited, setEdited] = useState<Draft[]>(drafts)
  const [applying, setApplying] = useState(false)

  const apply = async (): Promise<void> => {
    setApplying(true)
    try {
      for (const d of edited) await window.api.writeRole(d.agentId, d.role)
      onClose()
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Draft roles ({edited.length})</h2>
        <div className="draft-list">
          {edited.map((d, i) => (
            <div key={d.agentId} className="field">
              <label>{d.name}</label>
              <textarea
                className="draft-role"
                value={d.role}
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
            {applying ? 'Applying…' : 'Apply roles'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire the button + modal into `src/renderer/run/GoalBar.tsx`**

Change the import line at the top:

```ts
import { useState } from 'react'
import { Play, Sparkles, Square, Target } from 'lucide-react'
import { useStore } from '../store'
import RoleDraftModal from '../RoleDraftModal'
```

Inside the `GoalBar` component, after the existing `const [goal, setGoal] = useState('')`, add:

```ts
  const [drafting, setDrafting] = useState(false)
  const [drafts, setDrafts] = useState<{ agentId: string; name: string; role: string }[] | null>(null)
  const hasSpecialists = (graph?.nodes.some((n) => n.kind !== 'orchestrator')) ?? false
  const canDraft = !!target && !!goal.trim() && hasSpecialists && !running && !drafting

  const draftRoles = async (): Promise<void> => {
    if (!target || !goal.trim() || !hasSpecialists || running || drafting) return
    setDrafting(true)
    try {
      const r = await window.api.draftRoles({ goal: goal.trim(), orchestratorId: target.id })
      if (r.ok && r.drafts) setDrafts(r.drafts)
      else window.alert(r.error ?? 'Could not draft roles.')
    } finally {
      setDrafting(false)
    }
  }
```

In the returned JSX, add the Draft-roles button immediately before the `running ? … : …` Run/Stop block, and render the modal at the end of the `.goalbar` div. The button:

```tsx
        <button
          className="btn"
          onClick={() => void draftRoles()}
          disabled={!canDraft}
          title="Have the orchestrator draft roles for the team from this goal"
        >
          <Sparkles size={14} /> {drafting ? 'Drafting…' : 'Draft roles'}
        </button>
```

And, just before the closing `</div>` of `.goalbar`:

```tsx
        {drafts && <RoleDraftModal drafts={drafts} onClose={() => setDrafts(null)} />}
```

- [ ] **Step 3: Add the modal styles (`src/renderer/styles.css`)**

Append:

```css
.modal-wide {
  width: 640px;
  max-width: 90vw;
  max-height: 86vh;
  overflow: auto;
}
.draft-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.draft-role {
  width: 100%;
  min-height: 150px;
  resize: vertical;
  background: var(--panel-2);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 7px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
```

- [ ] **Step 4: Verify typecheck + build + suite**

Run: `npm run typecheck` → no errors. Run: `npm run build` → clean. Run: `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/run/GoalBar.tsx src/renderer/RoleDraftModal.tsx src/renderer/styles.css
git commit -m "feat(roles): Draft-roles button + editable preview modal"
```

---

## Final verification

- [ ] `npx vitest run` → all green (96 existing + new `role-draft`, `rosterForDrafting`, `role-drafter` tests).
- [ ] `npm run typecheck` → no errors. `npm run build` → clean.
- [ ] **Live smoke (manual):** build a team (an orchestrator + a couple workers with generic roles), type a goal, click **Draft roles** → confirm the preview shows a distinct tailored role per non-orchestrator agent → tweak one → **Apply** → open an agent's role editor and confirm the new role.md landed. Confirm **Cancel** writes nothing, and that the orchestrator's own role is untouched.

## Self-review notes (spec coverage)

- Button in GoalBar (goal + target orchestrator) → Task 5.
- Draft non-orchestrator agents only → Task 2 (`rosterForDrafting` filter) + Task 3.
- Whole role.md, complementary/durable, JSON shape → Task 1 (`draftRolesPrompt`).
- Read-only orchestrator call + retry-once → Task 3 (`draftRoles`).
- Parse, drop unknown ids → Task 1 (`parseDraftedRoles`).
- Drafts-only / Apply via existing `writeRole` → Task 3 (returns drafts) + Task 5 (modal Apply loop).
- Editable preview, Apply/Cancel → Task 5.
- Error handling (disabled button, error alert, nothing written on cancel) → Task 5 + Task 4 handler.
- Testability (pure prompt/parse; seam-injected draftRoles) → Tasks 1, 3.
