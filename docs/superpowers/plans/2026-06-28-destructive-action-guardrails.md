# Destructive-action Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent deletion confirmed + recoverable (soft-delete to trash) and gate role-draft overwrite behind a confirmation, so no destructive action silently destroys accreted work.

**Architecture:** Engine `deleteAgent` moves the agent folder to `.ai-manager/.trash/` instead of `fs.rm`. The renderer gets a reusable promise-based `ConfirmDialog` (wired through the zustand store) that gates delete-agent (panel button + canvas keyboard via React Flow `onBeforeDelete`) and role-draft Apply.

**Tech Stack:** TypeScript, Electron (main + renderer), React 19, zustand, @xyflow/react, vitest, electron-vite.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-28-destructive-action-guardrails-design.md`. Branch: `fix/destructive-action-guardrails`.
- Soft-delete: move `agents/<slug>` → `.ai-manager/.trash/<slug>-<Date.now()>/` via `fs.rename`, guarded by `existsSync`. Do NOT scan `agents/` anywhere (agents are enumerated from `graph.json`).
- `ConfirmOpts = { title: string; body: string; confirmLabel?: string; danger?: boolean }`; `requestConfirm(opts): Promise<boolean>`; `resolveConfirm(v: boolean): void`. Store is `create<AppState>((set, get) => …)`.
- Confirm gates ONLY: delete-agent (both entry points) and role-draft Apply. Edge-delete and Team-spawn stay UNCHANGED.
- Reuse existing CSS: `.modal`, `.modal-backdrop`, `.modal-actions`, `.btn`, `.btn.danger`, `.btn.primary`. Mount `<ConfirmDialog />` once at the App root (near `<HitlModal />`).
- YAGNI: no restore UI, no trash auto-prune / "empty trash", no role backup, no toast/undo.
- Renderer has no component-test harness — renderer changes are verified by `npm run typecheck` + `npm run build` only. The engine soft-delete IS unit-tested.
- Constants already in `project-store.ts`: `AIM_DIR='.ai-manager'`, `AGENTS_DIR='agents'`, `aimPath(projectPath, ...parts)`. `existsSync` and `fs` (node:fs/promises) already imported.

---

### Task 1: Soft-delete agent folder to trash (engine, TDD)

**Files:**
- Modify: `src/main/engine/project-store.ts` (add `TRASH_DIR`; rewrite `deleteAgent` body at `:236-244`)
- Test: `src/main/engine/project-store.test.ts` (add `deleteAgent` to imports + `existsSync` import + new describe block)

**Interfaces:**
- Produces: `deleteAgent(agentId: string): Promise<ProjectGraph>` (signature unchanged; behavior: soft-delete to trash).

- [ ] **Step 1: Write the failing test**

In `src/main/engine/project-store.test.ts`, add `existsSync` to the node:fs import and `deleteAgent` to the project-store import:
```ts
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
```
Add `deleteAgent,` to the `} from './project-store'` import list (e.g. after `createAgent,`).

Append this block at the end of the file:
```ts
describe('deleteAgent soft-delete', () => {
  it('moves the agent folder to .trash (preserving memory.md) and drops the node + its edges', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    await createAgent({ name: 'Boss', kind: 'orchestrator' })
    const g0 = await createAgent({ name: 'Dana', kind: 'worker' })
    const dana = g0.nodes.find((n) => n.name === 'Dana')!
    const boss = g0.nodes.find((n) => n.name === 'Boss')!
    await writeMemory(dana.id, '# Memory: Dana\n\n## Lessons\n- [portable] keep this\n\n## Task log\n')
    await setEdges([{ id: 'e1', source: boss.id, target: dana.id }])

    const agentDir = join(proj, '.ai-manager', 'agents', dana.slug)
    expect(existsSync(agentDir)).toBe(true)

    const after = await deleteAgent(dana.id)

    expect(after.nodes.find((n) => n.id === dana.id)).toBeUndefined()
    expect(after.edges).toHaveLength(0)
    expect(existsSync(agentDir)).toBe(false)

    const trash = join(proj, '.ai-manager', '.trash')
    const entries = await fs.readdir(trash)
    const moved = entries.find((e) => e.startsWith(`${dana.slug}-`))
    expect(moved).toBeDefined()
    const mem = await fs.readFile(join(trash, moved!, 'memory.md'), 'utf8')
    expect(mem).toContain('[portable] keep this')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "soft-delete"`
Expected: FAIL — the current `deleteAgent` `fs.rm`s the folder, so no `.trash` dir exists and `fs.readdir(trash)` throws `ENOENT` (or `moved` is undefined).

- [ ] **Step 3: Implement the soft-delete**

In `src/main/engine/project-store.ts`, add the constant next to the others (after `const AGENTS_DIR = 'agents'`):
```ts
const TRASH_DIR = '.trash'
```
Replace the body of `deleteAgent` (currently `:236-244`) so the `fs.rm(...)` line becomes a move-to-trash:
```ts
export async function deleteAgent(agentId: string): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const node = graph.nodes.find((n) => n.id === agentId)
  if (!node) return graph
  graph.nodes = graph.nodes.filter((n) => n.id !== agentId)
  graph.edges = graph.edges.filter((e) => e.source !== agentId && e.target !== agentId)
  // soft-delete: move the agent's folder to trash so role.md/memory.md stay recoverable
  const src = aimPath(path, AGENTS_DIR, node.slug)
  if (existsSync(src)) {
    await fs.mkdir(aimPath(path, TRASH_DIR), { recursive: true })
    await fs.rename(src, aimPath(path, TRASH_DIR, `${node.slug}-${Date.now()}`))
  }
  return saveGraph()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/engine/project-store.test.ts`
Expected: PASS — the new soft-delete test plus all pre-existing project-store tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(u1): soft-delete agent folder to .trash instead of fs.rm"
```

---

### Task 2: Reusable ConfirmDialog (store + component + mount)

**Files:**
- Modify: `src/renderer/store.ts` (add `ConfirmOpts` type; `confirm` state; `requestConfirm`/`resolveConfirm` actions)
- Create: `src/renderer/ConfirmDialog.tsx`
- Modify: `src/renderer/App.tsx` (import + mount `<ConfirmDialog />`)
- Modify: `src/renderer/styles.css` (add `.confirm-body`)

**Interfaces:**
- Produces:
  ```ts
  export type ConfirmOpts = { title: string; body: string; confirmLabel?: string; danger?: boolean }
  // on the store:
  requestConfirm(opts: ConfirmOpts): Promise<boolean>
  resolveConfirm(v: boolean): void
  ```

- [ ] **Step 1: Add confirm state + actions to the store**

In `src/renderer/store.ts`, add the exported type near the other type exports (top of file, after the imports):
```ts
export type ConfirmOpts = { title: string; body: string; confirmLabel?: string; danger?: boolean }
```
Add these three members to the `interface AppState { … }` block (`store.ts:65-90`):
```ts
  confirm: { opts: ConfirmOpts; resolve: (v: boolean) => void } | null
  requestConfirm: (opts: ConfirmOpts) => Promise<boolean>
  resolveConfirm: (v: boolean) => void
```
Add these to the object returned by `create<AppState>((set, get) => ({ … }))` (anywhere among the actions, before the closing `}))` at `:234`):
```ts
  confirm: null,
  requestConfirm: (opts) => new Promise<boolean>((resolve) => set({ confirm: { opts, resolve } })),
  resolveConfirm: (v) => {
    const c = get().confirm
    if (c) {
      c.resolve(v)
      set({ confirm: null })
    }
  },
```

- [ ] **Step 2: Create the ConfirmDialog component**

Create `src/renderer/ConfirmDialog.tsx`:
```tsx
import { useEffect } from 'react'
import { useStore } from './store'

export default function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm)
  const resolveConfirm = useStore((s) => s.resolveConfirm)

  useEffect(() => {
    if (!confirm) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') resolveConfirm(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, resolveConfirm])

  if (!confirm) return null
  const { title, body, confirmLabel, danger } = confirm.opts
  return (
    <div className="modal-backdrop" onClick={() => resolveConfirm(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="confirm-body">{body}</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => resolveConfirm(false)}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => resolveConfirm(true)}>
            {confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Mount it at the App root**

In `src/renderer/App.tsx`, add the import alongside the other modal imports (near `import HitlModal from './HitlModal'`):
```tsx
import ConfirmDialog from './ConfirmDialog'
```
Add the element next to `<HitlModal />` (around line 271):
```tsx
      <HitlModal />
      <ConfirmDialog />
```

- [ ] **Step 4: Add the body style**

In `src/renderer/styles.css`, add:
```css
.confirm-body {
  margin: 8px 0;
  font-size: 13px;
  line-height: 1.45;
}
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both PASS (no type errors; renderer bundle rebuilt). The promise-based `requestConfirm` and the new component compile.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store.ts src/renderer/ConfirmDialog.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(u1): add reusable promise-based ConfirmDialog"
```

---

### Task 3: Gate the destructive actions

**Files:**
- Modify: `src/renderer/panels/AgentConfigPanel.tsx` (`remove()` confirm)
- Modify: `src/renderer/canvas/OrgChart.tsx` (`onBeforeDelete` confirm for node deletions)
- Modify: `src/renderer/RoleDraftModal.tsx` (`apply()` confirm)

**Interfaces:**
- Consumes: `requestConfirm(opts: ConfirmOpts): Promise<boolean>` from the store (Task 2).

- [ ] **Step 1: Confirm before the panel "Delete agent" button**

In `src/renderer/panels/AgentConfigPanel.tsx`, add a selector next to the other `useStore` calls:
```ts
  const requestConfirm = useStore((s) => s.requestConfirm)
```
Replace `remove` (`:24-27`):
```ts
  const remove = async (): Promise<void> => {
    const ok = await requestConfirm({
      title: 'Delete agent?',
      body: `"${agent.name}" and its saved memory will be moved to trash (.ai-manager/.trash) — recoverable from disk.`,
      confirmLabel: 'Delete agent',
      danger: true
    })
    if (!ok) return
    setGraph(await window.api.deleteAgent(agent.id))
    select(null)
  }
```

- [ ] **Step 2: Confirm canvas/keyboard node deletions via onBeforeDelete**

In `src/renderer/canvas/OrgChart.tsx`, add a selector next to the other `useStore` calls:
```ts
  const requestConfirm = useStore((s) => s.requestConfirm)
```
Add this callback (place it near `onNodesDelete`):
```ts
  const onBeforeDelete = useCallback(
    async ({ nodes: del }: { nodes: AgentFlowNode[]; edges: Edge[] }): Promise<boolean> => {
      if (del.length === 0) return true // edge-only deletion — no confirm
      const names = del.map((n) => graph.nodes.find((g) => g.id === n.id)?.name ?? 'agent')
      return requestConfirm({
        title: del.length === 1 ? 'Delete agent?' : `Delete ${del.length} agents?`,
        body: `${names.join(', ')} — saved memory will be moved to trash (.ai-manager/.trash), recoverable from disk.`,
        confirmLabel: 'Delete',
        danger: true
      })
    },
    [graph.nodes, requestConfirm]
  )
```
Add the prop to `<ReactFlow>` (next to `onNodesDelete={onNodesDelete}`):
```tsx
      onBeforeDelete={onBeforeDelete}
```
(`AgentFlowNode` and `Edge` are already imported. If tsc flags the prop type, import `type OnBeforeDelete` from `@xyflow/react` and annotate the callback as `OnBeforeDelete<AgentFlowNode, Edge>`.)

- [ ] **Step 3: Confirm before role-draft Apply**

In `src/renderer/RoleDraftModal.tsx`, add the store import at the top:
```ts
import { useStore } from './store'
```
Inside the component, add:
```ts
  const requestConfirm = useStore((s) => s.requestConfirm)
```
Replace the start of `apply` so it confirms before doing any writes (`:9-11`):
```ts
  const apply = async (): Promise<void> => {
    const n = edited.length
    const ok = await requestConfirm({
      title: `Overwrite ${n} role${n === 1 ? '' : 's'}?`,
      body: `This replaces the current role for ${n} agent${n === 1 ? '' : 's'} with the drafted version${n === 1 ? '' : 's'}. Existing roles will be overwritten.`,
      confirmLabel: 'Overwrite roles',
      danger: true
    })
    if (!ok) return
    setApplying(true)
    try {
```
(The rest of `apply` — the `for (const d of edited) { … }` loop, `onClose()`, and the `finally { setApplying(false) }` — is unchanged.)

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both PASS. The three call sites consume `requestConfirm` correctly; `onBeforeDelete` type-checks against the ReactFlow instance.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/panels/AgentConfigPanel.tsx src/renderer/canvas/OrgChart.tsx src/renderer/RoleDraftModal.tsx
git commit -m "feat(u1): confirm before deleting agents and overwriting roles"
```

---

### Task 4: Full-suite verification

**Files:** none (verification gate).

- [ ] **Step 1: Run the whole suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: vitest all green (294 — the prior 293 plus the new soft-delete test), typecheck clean (node + web), build clean.

- [ ] **Step 2: Manual smoke notes (no code; for the eventual live check)**

Confirm by reading the diff that: (a) `project-store.ts` `deleteAgent` no longer calls `fs.rm` and uses `fs.rename` to `.trash`; (b) `<ConfirmDialog />` is mounted once in `App.tsx`; (c) all three call sites `await requestConfirm(...)` and bail on `false`; (d) `onBeforeDelete` returns `true` for edge-only deletions (edge delete stays frictionless). Live check later: delete an agent (button + Delete key) → dialog appears → Cancel aborts, Confirm moves the folder to `.ai-manager/.trash`; Draft roles → Apply prompts; deleting an edge does NOT prompt.

- [ ] **Step 3: Confirm clean tree**

```bash
git status --short   # expect clean
```

---

## Self-Review

**Spec coverage:**
- §1 soft-delete (`deleteAgent` → trash, `TRASH_DIR`, `existsSync` guard) → Task 1 (+ test). ✓
- §2 store `ConfirmOpts`/`confirm`/`requestConfirm`/`resolveConfirm` + ConfirmDialog component + App mount + `.confirm-body` → Task 2. ✓
- §3 wiring: AgentConfigPanel, OrgChart `onBeforeDelete`, RoleDraftModal → Task 3. ✓
- Edge-delete + Team-spawn unchanged → no task touches them. ✓
- Test (project-store soft-delete; renderer via typecheck+build) → Task 1 Step 1 + Tasks 2/3 Step "typecheck and build" + Task 4. ✓

**Placeholder scan:** none — every code step shows full code; commands have expected output. The only conditional ("if tsc flags the prop type…") is concrete fallback guidance, not a placeholder.

**Type consistency:** `ConfirmOpts` and `requestConfirm(opts): Promise<boolean>` defined in Task 2 are consumed identically in Task 3 (all three sites `await requestConfirm({title, body, confirmLabel, danger})` and branch on the boolean). `deleteAgent` signature unchanged across Task 1 and its callers. `onBeforeDelete` uses already-imported `AgentFlowNode`/`Edge`.
