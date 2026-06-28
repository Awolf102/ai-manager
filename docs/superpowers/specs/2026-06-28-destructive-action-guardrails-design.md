# Destructive-action guardrails — design (fix cycle U1)

**Date:** 2026-06-28
**Source:** Audit `docs/audits/2026-06-27-tool-audit.md` — finding #8 (Critical) + #31 (Important); triage cycle **U1** in `docs/audits/2026-06-27-remediation-cycles.md`.
**Status:** approved design, ready for implementation plan.

## Problem

The renderer has **zero confirmation dialogs** (`grep window.confirm src/renderer` → none), and two flows destroy accreted work silently:

- **Delete agent** (Critical #8) — the panel "Delete agent" button (`AgentConfigPanel.tsx:24-27,114`) and the canvas Delete/Backspace key (`OrgChart.tsx:103-111`) both call `window.api.deleteAgent` with no confirmation; `deleteAgent` (`project-store.ts:236-244`) `fs.rm(..., {recursive:true, force:true})`s the agent's dir, **irreversibly destroying `role.md` and the accreted `memory.md`** — the exact "compounding memory" the product exists to grow. One stray keystroke loses it.
- **Role-draft Apply** (Important #31) — `RoleDraftModal.apply()` (`RoleDraftModal.tsx:9-20`) overwrites every listed agent's `role.md` via `writeRole` with no warning, so "Draft roles → Apply" silently replaces hand-tuned roles.

(Edge deletion at `OrgChart.tsx:95-101` is reversible by redrawing — low stakes. Team-spawn Apply at `TeamSpawnModal.tsx:30-40` *creates* agents additively with uniquified slugs — not destructive. Both are out of scope.)

## Goal

No destructive action silently destroys accreted work:
1. Agent deletion is **confirmed** AND **recoverable** (soft-delete to a trash folder), so even a confirmed-then-regretted delete can be restored from disk.
2. Role-draft Apply is **confirmed** before overwriting hand-tuned roles.

Without adding friction to non-destructive flows (edge delete, team-spawn, normal edits stay as-is).

## Components

### §1 — Soft-delete in the engine (`src/main/engine/project-store.ts`)

`deleteAgent` moves the agent dir to trash instead of removing it:

```ts
const TRASH_DIR = '.trash'   // alongside AGENTS_DIR, at the top with the other constants

export async function deleteAgent(agentId: string): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const node = graph.nodes.find((n) => n.id === agentId)
  if (!node) return graph
  graph.nodes = graph.nodes.filter((n) => n.id !== agentId)
  graph.edges = graph.edges.filter((e) => e.source !== agentId && e.target !== agentId)
  // soft-delete: move the agent's app-managed folder to trash so role.md/memory.md are recoverable
  const src = aimPath(path, AGENTS_DIR, node.slug)
  if (existsSync(src)) {
    await fs.mkdir(aimPath(path, TRASH_DIR), { recursive: true })
    await fs.rename(src, aimPath(path, TRASH_DIR, `${node.slug}-${Date.now()}`))
  }
  return saveGraph()
}
```

- Trash path: `.ai-manager/.trash/<slug>-<epoch-ms>/`. `existsSync` and `aimPath` are already imported; `fs` is the `node:fs/promises` already used.
- A trashed dir never reappears: agents are enumerated from `graph.json` nodes, never by scanning `agents/` (the only `readdir` of an `.ai-manager` subdir is the **runs** dir at `project-store.ts:464`). `.trash/` is a sibling of `agents/`.
- The `existsSync` guard replaces the old `force:true` (a missing dir is a no-op).
- No restore UI, no auto-prune, no "empty trash" this cycle (YAGNI — recoverable manually from disk). The timestamp suffix prevents collisions across repeated deletes of the same slug.

### §2 — Reusable in-app ConfirmDialog (renderer)

A promise-based confirm wired through the existing zustand store (`create<AppState>((set, get) => …)`).

**Store (`src/renderer/store.ts`)** — add to `AppState` and the store body:
```ts
export type ConfirmOpts = { title: string; body: string; confirmLabel?: string; danger?: boolean }

// AppState:
confirm: { opts: ConfirmOpts; resolve: (v: boolean) => void } | null
requestConfirm: (opts: ConfirmOpts) => Promise<boolean>
resolveConfirm: (v: boolean) => void

// store body:
confirm: null,
requestConfirm: (opts) => new Promise<boolean>((resolve) => set({ confirm: { opts, resolve } })),
resolveConfirm: (v) => {
  const c = get().confirm
  if (c) { c.resolve(v); set({ confirm: null }) }
},
```

**Component (`src/renderer/ConfirmDialog.tsx`, new)** — rendered once at the App root; renders nothing when no confirm is pending:
```tsx
import { useEffect } from 'react'
import { useStore } from './store'

export default function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm)
  const resolveConfirm = useStore((s) => s.resolveConfirm)
  useEffect(() => {
    if (!confirm) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') resolveConfirm(false) }
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
          <button className="btn" onClick={() => resolveConfirm(false)}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => resolveConfirm(true)}>
            {confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

**Mount (`src/renderer/App.tsx`)** — add `<ConfirmDialog />` alongside the existing `<HitlModal />` (~line 271).

**CSS (`src/renderer/styles.css`)** — `.confirm-body { margin: 8px 0; font-size: 13px; line-height: 1.45; }` (reuses the existing `.modal`, `.modal-backdrop`, `.modal-actions`, `.btn`/`.btn.danger`/`.btn.primary`).

### §3 — Wiring the gated actions

- **`AgentConfigPanel.tsx`** — `remove()` awaits a confirm first:
  ```ts
  const requestConfirm = useStore((s) => s.requestConfirm)
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

- **`OrgChart.tsx`** — add React Flow's `onBeforeDelete` to gate keyboard/canvas deletions; confirm only when nodes are involved (edge-only deletions pass straight through):
  ```ts
  const requestConfirm = useStore((s) => s.requestConfirm)
  const onBeforeDelete = useCallback(
    async ({ nodes: del }: { nodes: { id: string }[]; edges: Edge[] }) => {
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
  and pass `onBeforeDelete={onBeforeDelete}` to `<ReactFlow>`. (`onBeforeDelete` returning `false` cancels; returning `true` lets the existing `onNodesDelete`/`onEdgesDelete` run unchanged.)

- **`RoleDraftModal.tsx`** — `apply()` awaits a confirm before the `writeRole` loop:
  ```ts
  const requestConfirm = useStore((s) => s.requestConfirm)
  // inside apply(), before setApplying(true):
  const n = edited.length
  const ok = await requestConfirm({
    title: `Overwrite ${n} role${n === 1 ? '' : 's'}?`,
    body: `This replaces the current role for ${n} agent${n === 1 ? '' : 's'} with the drafted version${n === 1 ? '' : 's'}. Existing roles will be overwritten.`,
    confirmLabel: 'Overwrite roles',
    danger: true
  })
  if (!ok) return
  ```
  (Confirm-only — no role backup; `role.md` is lower-stakes than `memory.md` and the user can re-draft. Keeps scope tight.)

- **Edge delete / Team-spawn:** unchanged.

## Data flow

```
Delete agent (button OR canvas key)
  → requestConfirm() → ConfirmDialog → resolve(true/false)
  → if true: deleteAgent → fs.rename(agents/<slug> → .trash/<slug>-<ts>) → graph updated
Role-draft Apply
  → requestConfirm() → if true: writeRole loop (overwrite)
```

## Error handling

- Any confirm dismissal (Cancel / backdrop / Esc) resolves `false`; nothing is deleted/overwritten.
- A missing agent dir on delete is a no-op (the `existsSync` guard). A `rename` failure surfaces via the existing IPC error path (won't occur within one filesystem).
- `requestConfirm` always resolves (no leaked pending promise): the dialog is the only resolver and every button/backdrop/Esc path calls `resolveConfirm`.

## Testing

- **`src/main/engine/project-store.test.ts`** (real behavior, engine is unit-tested here): create a project + an agent with `memory.md` content; call `deleteAgent`; assert (a) the graph node and its edges are gone, (b) `agents/<slug>` no longer exists, (c) a `.trash/<slug>-*` dir exists containing `memory.md` with the original content. Optionally assert deleting a node also drops edges referencing it.
- **ConfirmDialog + renderer wiring:** verified by `npm run typecheck` + `npm run build`. This repo has no renderer component-test harness (all tests are `src/shared/*` and `src/main/engine/*`); adding one is out of scope.

## "Off = byte-for-byte"?

N/A — this is a safety fix that intentionally changes behavior (deletion now goes to trash; destructive actions now prompt). Non-destructive flows are unchanged.

## Files touched

- `src/main/engine/project-store.ts` — `TRASH_DIR` const; `deleteAgent` soft-delete via `fs.rename`.
- `src/main/engine/project-store.test.ts` — soft-delete test.
- `src/renderer/store.ts` — `ConfirmOpts` type; `confirm` state; `requestConfirm`/`resolveConfirm`.
- `src/renderer/ConfirmDialog.tsx` — new reusable dialog.
- `src/renderer/App.tsx` — mount `<ConfirmDialog />`.
- `src/renderer/panels/AgentConfigPanel.tsx` — confirm before delete.
- `src/renderer/canvas/OrgChart.tsx` — `onBeforeDelete` confirm for node deletions.
- `src/renderer/RoleDraftModal.tsx` — confirm before overwrite.
- `src/renderer/styles.css` — `.confirm-body`.
