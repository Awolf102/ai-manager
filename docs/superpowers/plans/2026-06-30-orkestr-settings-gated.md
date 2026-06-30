# Orkestr Settings & Gated Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group Settings into labeled sections with cost hints, turn the gated features into real on/off toggles, collapse the permission model to the single project Autonomy, and add enable-on-gesture for handoffs.

**Architecture:** Extract `actingModeFor` into a pure `acting-mode.ts` (TDD) and route the direct per-agent launch paths through the project Autonomy (removing the per-agent permission dropdown). Restructure `SettingsModal` into 5 sections with a small `GatedToggle`. Add a handoff enable-on-gesture confirm in `OrgChart`.

**Tech Stack:** React 19, zustand 5, electron-vite (vite 7), vitest, node-pty, @anthropic-ai/claude-agent-sdk. Foundation tokens on main.

## Global Constraints

- One permission concept: project Autonomy (`auto`/`full`/`cautious`) governs both orchestrated runs and direct per-agent Run/Terminal launches. No raw SDK enum strings in the UI.
- `actingModeFor(autonomy)`: `full→'bypassPermissions'`, `cautious→'acceptEdits'`, else `'auto'`.
- `agent.permissionMode` is left vestigial (kept in type/bundle/store; no longer read for launches). Do NOT remove the data field or change bundle/store schemas.
- Gated features as toggles: off = value `0`; toggling on sets `1` + a count input clamped to the existing max (replans/handoffs `1–3`, user-requests `1–5`). Persist via `updateSettings`.
- Settings sections (in order): Safety, Cost, Review & repair, Run behavior, Team. Cost hints on `autoAssignModels` + `adaptiveEffort`.
- Scope: `acting-mode.ts`(+test), `nodes.ts`, `pty-manager.ts`, `agent-runner.ts`, `AgentConfigPanel.tsx`, `SettingsModal.tsx`, `OrgChart.tsx`, `styles.css`. No engine-behavior changes to what the gated features DO; no Context work; no a11y pass.
- Testing: pure logic TDD'd (`acting-mode`); rest typecheck + build + live. Implementers run `npm run typecheck` (+ focused `vitest`); the controller runs the full `npm run build` (~9 min, drops agent connections) at the integration gate.
- Commit after every task.

---

### Task 1: Extract `actingModeFor` into a pure module — TDD

**Files:**
- Create: `src/main/engine/acting-mode.ts`
- Test: `src/main/engine/acting-mode.test.ts`
- Modify: `src/main/engine/nodes.ts` (replace the function with a re-export)

**Interfaces:**
- Produces: `actingModeFor(autonomy: Autonomy): PermissionMode`.

- [ ] **Step 1: Write the failing test** — create `src/main/engine/acting-mode.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { actingModeFor } from './acting-mode'

describe('actingModeFor', () => {
  it('full → bypassPermissions', () => expect(actingModeFor('full')).toBe('bypassPermissions'))
  it('cautious → acceptEdits', () => expect(actingModeFor('cautious')).toBe('acceptEdits'))
  it('auto → auto', () => expect(actingModeFor('auto')).toBe('auto'))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/engine/acting-mode.test.ts`
Expected: FAIL — cannot resolve `./acting-mode`.

- [ ] **Step 3: Create `src/main/engine/acting-mode.ts`**

```ts
import type { Autonomy, PermissionMode } from '../../shared/types'

/** Map the project Autonomy to the SDK permission mode used for acting steps. Pure. */
export function actingModeFor(autonomy: Autonomy): PermissionMode {
  if (autonomy === 'full') return 'bypassPermissions'
  if (autonomy === 'cautious') return 'acceptEdits'
  return 'auto'
}
```

- [ ] **Step 4: Re-export from `nodes.ts`** — replace the existing function definition (the `export function actingModeFor(autonomy: Autonomy): PermissionMode { … }` block) with:

```ts
export { actingModeFor } from './acting-mode'
```

Then run `npm run typecheck`. If it reports `Autonomy` (or any symbol) is now unused in `nodes.ts`, remove it from that file's imports. (Orchestrator keeps importing `actingModeFor` from `./nodes` via this re-export — do not change `orchestrator.ts`.)

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run src/main/engine/acting-mode.test.ts` → Expected: PASS (3 tests).
Run: `npm run typecheck` → Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/acting-mode.ts src/main/engine/acting-mode.test.ts src/main/engine/nodes.ts
git commit -m "feat(orkestr): extract actingModeFor into a pure acting-mode module"
```

---

### Task 2: Route direct per-agent launches through Autonomy

**Files:**
- Modify: `src/main/engine/pty-manager.ts`
- Modify: `src/main/engine/agent-runner.ts`

**Interfaces:**
- Consumes: `actingModeFor` (`./acting-mode`), `getSettings` (`./project-store`).

- [ ] **Step 1: pty-manager — use Autonomy for the spawned terminal**

In `src/main/engine/pty-manager.ts`, add imports:
```ts
import { getSettings } from './project-store'
import { actingModeFor } from './acting-mode'
```
(`buildAgentContext` is already imported from `./project-store`; add `getSettings` to that import or a new line.) In `spawnPty`, change the args entry that passes the permission mode from:
```ts
    '--permission-mode',
    agent.permissionMode
```
to:
```ts
    '--permission-mode',
    actingModeFor(getSettings().autonomy)
```

- [ ] **Step 2: agent-runner — fall back to Autonomy, not the per-agent mode**

In `src/main/engine/agent-runner.ts`, add:
```ts
import { actingModeFor } from './acting-mode'
```
(`getSettings` is already imported.) Change:
```ts
    const mode = opts.permissionMode ?? agent.permissionMode
```
to:
```ts
    const mode = opts.permissionMode ?? actingModeFor(getSettings().autonomy)
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes clean (note: `agent` may still be used elsewhere in each file — only the permission read changed; if `agent.permissionMode` was the sole use of nothing, no import changes are needed).

- [ ] **Step 4: Commit**

```bash
git add src/main/engine/pty-manager.ts src/main/engine/agent-runner.ts
git commit -m "feat(orkestr): direct per-agent launches use project Autonomy for permissions"
```

---

### Task 3: Remove the per-agent permission dropdown

**Files:**
- Modify: `src/renderer/panels/AgentConfigPanel.tsx`

- [ ] **Step 1: Remove the permission `field` block** — delete this block:

```tsx
      <div className="field">
        <label>Permission mode</label>
        <select
          value={agent.permissionMode}
          onChange={(e) => update({ permissionMode: e.target.value as PermissionMode })}
        >
          {PERMISSION_MODES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
```

- [ ] **Step 2: Remove the now-unused imports** — in the imports, drop `PERMISSION_MODES` (from the `'../../shared/types'` value import) and `PermissionMode` (from the type import). Leave `AGENT_KINDS`, `MODELS`, `AgentKind`, `AgentNodeData`, `DiscoveredPlugin`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes clean (no unused `PermissionMode`/`PERMISSION_MODES`).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/panels/AgentConfigPanel.tsx
git commit -m "feat(orkestr): remove per-agent permission dropdown (Autonomy governs all)"
```

---

### Task 4: Group Settings into 5 sections + gated toggles + cost hints

**Files:**
- Modify: `src/renderer/SettingsModal.tsx` (full restructure)
- Modify: `src/renderer/styles.css` (gated-count style)

This task is UI — verify by typecheck + live render.

- [ ] **Step 1: Rewrite `src/renderer/SettingsModal.tsx`** with the full file below (adds a local `GatedToggle`, regroups every field into the 5 sections, adds cost hints; preserves the autonomy select + Full-auto confirm + all existing handlers):

```tsx
import { useStore } from './store'
import type { Autonomy, ProjectSettings, ReviewMode } from '../shared/types'

const MODES: { id: ReviewMode; label: string; desc: string }[] = [
  { id: 'none', label: 'Review → memory only', desc: 'Review and record lessons; no redo.' },
  { id: 'once', label: '+ one repair pass', desc: 'Failed tasks get one redo, then re-review.' },
  { id: 'loop', label: '+ repair loop', desc: 'Redo until pass or max attempts.' }
]

function GatedToggle({
  label,
  desc,
  value,
  max,
  onChange
}: {
  label: string
  desc: string
  value: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={value > 0} onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
        {label}
      </label>
      {value > 0 && (
        <div className="gated-count">
          up to{' '}
          <input
            type="number"
            min={1}
            max={max}
            value={value}
            onChange={(e) => onChange(Math.max(1, Math.min(max, Number(e.target.value) || 1)))}
          />
        </div>
      )}
      <div className="radio-desc" style={{ marginTop: 4 }}>
        {desc}
      </div>
    </div>
  )
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const requestConfirm = useStore((st) => st.requestConfirm)
  if (!graph) return null
  const s = graph.settings

  const update = async (patch: Partial<ProjectSettings>): Promise<void> => {
    setGraph(await window.api.updateSettings(patch))
  }

  const onAutonomyChange = async (next: Autonomy): Promise<void> => {
    if (next === 'full' && s.autonomy !== 'full') {
      const ok = await requestConfirm({
        title: 'Enable Full auto?',
        body: 'Agents will run with NO permission checks and are not sandboxed to this project — they can read or write anything your user account can (SSH keys, other projects, system files). Only use Full auto on a throwaway or git-committed project.',
        confirmLabel: 'Enable Full auto',
        danger: true
      })
      if (!ok) return
    }
    await update({ autonomy: next })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <h3 className="settings-section">Safety</h3>
        <div className="field">
          <label>Autonomy (acting steps)</label>
          <select value={s.autonomy} onChange={(e) => void onAutonomyChange(e.target.value as Autonomy)}>
            <option value="auto">Auto — run safe commands, deny risky ones</option>
            <option value="full">Full auto — no permission checks (not sandboxed)</option>
            <option value="cautious">Cautious — edits only, no command execution</option>
          </select>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            {s.autonomy === 'auto' &&
              'Planning stays read-only; the review can run tests, and risky commands are blocked by a classifier.'}
            {s.autonomy === 'full' && (
              <span className="autonomy-danger">
                ⚠ No permission checks and NOT sandboxed to this project — agents can read or write anything
                your user account can (SSH keys, other projects, system files). Use only on a throwaway or
                git-committed project.
              </span>
            )}
            {s.autonomy === 'cautious' &&
              "Workers edit files, but commands (including the review's tests) are blocked. Also governs running an agent directly."}
          </div>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.lockBypassPermissions}
              onChange={(e) => void update({ lockBypassPermissions: e.target.checked })}
            />
            Never bypass permissions (lock)
          </label>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Forces any Full-auto or per-agent run down to "accept edits", engine-wide. A hard ceiling.
          </div>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.trustAnthropicOnly}
              onChange={(e) => void update({ trustAnthropicOnly: e.target.checked })}
            />
            Auto-trust only Anthropic-authored skills
          </label>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            {s.trustAnthropicOnly
              ? 'Only skills authored by Anthropic (in a verified anthropics-owned marketplace) are offered to agents.'
              : '⚠ Third-party skills from anthropics-owned marketplaces are also trusted — their plugin code runs under the agent’s permission mode.'}
          </div>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.blockPluginHooks}
              onChange={(e) => void update({ blockPluginHooks: e.target.checked })}
            />
            Block skills whose plugin ships hooks
          </label>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Plugin hooks run shell/HTTP/MCP commands at tool events. Blocked plugins are not offered to agents.
          </div>
        </div>

        <h3 className="settings-section">Cost</h3>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.autoAssignModels}
              onChange={(e) => void update({ autoAssignModels: e.target.checked })}
            />
            Auto-assign worker models — orchestrator picks Sonnet/Opus per worker when building a team
          </label>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            💸 Opus costs more per token than Sonnet — auto-assign reserves Opus for the harder roles.
          </div>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.adaptiveEffort}
              onChange={(e) => void update({ adaptiveEffort: e.target.checked })}
            />
            Adaptive effort — managers assign reasoning effort by task difficulty
          </label>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            💸 Higher reasoning effort spends more tokens (higher cost) on the tasks that get it.
          </div>
        </div>

        <h3 className="settings-section">Review &amp; repair</h3>
        <div className="field">
          <label>Review &amp; repair</label>
          <div className="radio-list">
            {MODES.map((m) => (
              <label key={m.id} className={`radio-row ${s.reviewMode === m.id ? 'sel' : ''}`}>
                <input
                  type="radio"
                  name="reviewMode"
                  checked={s.reviewMode === m.id}
                  onChange={() => void update({ reviewMode: m.id })}
                />
                <div>
                  <div className="radio-title">{m.label}</div>
                  <div className="radio-desc">{m.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        {s.reviewMode === 'loop' && (
          <div className="field">
            <label>Max repair attempts</label>
            <input
              type="number"
              min={1}
              max={6}
              value={s.maxRepairAttempts}
              onChange={(e) =>
                void update({ maxRepairAttempts: Math.max(1, Math.min(6, Number(e.target.value) || 1)) })
              }
            />
          </div>
        )}
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.reflection}
              onChange={(e) => void update({ reflection: e.target.checked })}
            />
            Update agent memory after runs
          </label>
        </div>

        <h3 className="settings-section">Run behavior</h3>
        <GatedToggle
          label="Mid-run re-plans"
          max={3}
          value={s.maxReplans}
          onChange={(v) => void update({ maxReplans: v })}
          desc="When you set an execution order on the canvas, the orchestrator may rewrite the not-yet-run plan between stages based on what earlier stages found. The goal never changes."
        />
        <GatedToggle
          label="Peer handoffs per step"
          max={3}
          value={s.maxHandoffs}
          onChange={(v) => void update({ maxHandoffs: v })}
          desc="When you draw a handoff edge (select an edge → Make handoff), an agent may consult that connected teammate mid-step and continue with their answer. The reporting tree is unaffected."
        />
        <GatedToggle
          label="User questions per run"
          max={5}
          value={s.maxUserRequests}
          onChange={(v) => void update({ maxUserRequests: v })}
          desc="A worker that is blocked may pause the run to ask you one question. Your answer resumes that worker. Workers only — it's sent to the agent, so don't share secrets."
        />

        <h3 className="settings-section">Team</h3>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.autoSyncTeam}
              onChange={(e) => void update({ autoSyncTeam: e.target.checked })}
            />
            Auto-sync team brain — pull lessons before a run, push after
          </label>
        </div>
        <div className="field">
          <label>Trusted-skill install threshold</label>
          <input
            type="number"
            min={0}
            step={1000}
            value={s.skillInstallThreshold}
            onChange={(e) => void update({ skillInstallThreshold: Math.max(0, Number(e.target.value) || 0) })}
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Non-Anthropic plugins are offered to agents only at/above this many installs. Anthropic plugins are always trusted.
          </div>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.skillsPackEnabled}
              onChange={(e) => void update({ skillsPackEnabled: e.target.checked })}
            />
            Skills pack — load curated design + Playwright skills as options for every agent
          </label>
        </div>
        <div className="field">
          <label>Skills-pack folder (optional)</label>
          <input
            type="text"
            placeholder="~/.ai-manager/skills-pack"
            value={s.skillsPackPath}
            onChange={(e) => void update({ skillsPackPath: e.target.value })}
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Leave blank for the default. Skills are model-invoked — available to every agent, never forced.
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add the gated-count style** to `src/renderer/styles.css`:

```css
.gated-count { display: flex; align-items: center; gap: var(--space-2); margin-top: 4px; font-size: var(--text-xs); color: var(--fg-muted); }
.gated-count input { width: 64px; }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes clean.

- [ ] **Step 4: Live-verify (controller/user)**

Note deferred: Settings shows 5 labeled sections in order; each gated feature is a checkbox that reveals a count when on and hides it when off, persisting across reopen; cost hints show under auto-assign-models + adaptive-effort; the Full-auto confirm still fires.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/SettingsModal.tsx src/renderer/styles.css
git commit -m "feat(orkestr): group Settings into 5 sections + gated toggles + cost hints"
```

---

### Task 5: Enable-on-gesture for handoffs

**Files:**
- Modify: `src/renderer/canvas/OrgChart.tsx`

**Interfaces:**
- Consumes: existing `requestConfirm`, `setGraph`, `graph.settings.maxHandoffs`, `window.api.updateSettings`, `persistEdges`.

- [ ] **Step 1: Make `convertSelected` offer to enable handoffs** — replace the existing `convertSelected` callback:

```tsx
  const convertSelected = useCallback(() => {
    if (!selectedEdge) return
    const nextKind = selectedEdge.kind === 'handoff' ? 'report' : 'handoff'
    void persistEdges(
      graph.edges.map((e) => (e.id === selectedEdge.id ? { ...e, kind: nextKind, order: undefined } : e))
    )
  }, [selectedEdge, graph.edges, persistEdges])
```

with:

```tsx
  const convertSelected = useCallback(async () => {
    if (!selectedEdge) return
    const nextKind = selectedEdge.kind === 'handoff' ? 'report' : 'handoff'
    if (nextKind === 'handoff' && graph.settings.maxHandoffs === 0) {
      const ok = await requestConfirm({
        title: 'Enable handoffs?',
        body: 'Handoffs are off, so this edge would do nothing during a run. Enable peer handoffs now?',
        confirmLabel: 'Enable'
      })
      if (ok) setGraph(await window.api.updateSettings({ maxHandoffs: 1 }))
    }
    await persistEdges(
      graph.edges.map((e) => (e.id === selectedEdge.id ? { ...e, kind: nextKind, order: undefined } : e))
    )
  }, [selectedEdge, graph.edges, graph.settings.maxHandoffs, requestConfirm, setGraph, persistEdges])
```

- [ ] **Step 2: Update the button to call the async handler** — find the "Make handoff/reporting" button and change `onClick={convertSelected}` to:

```tsx
          <button className="btn" onClick={() => void convertSelected()}>
```

(`requestConfirm` and `setGraph` are already selected in OrgChart; confirm they are — if `setGraph` isn't already pulled from the store there, add `const setGraph = useStore((s) => s.setGraph)`.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes clean.

- [ ] **Step 4: Live-verify (controller/user)**

Note deferred: with handoffs off (Settings → Run behavior toggle off), select a report edge → "Make handoff" → a confirm offers to enable; confirming flips the edge to handoff AND turns the toggle on; declining still converts the edge.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/OrgChart.tsx
git commit -m "feat(orkestr): offer to enable handoffs when drawing a handoff edge"
```

---

## Self-Review

**Spec coverage:**
- §3 grouped Settings (5 sections + cost hints) → Task 4. ✓
- §4 gated toggles (off=0/on=1+count) → Task 4 (`GatedToggle`). ✓
- §5 one permission concept (extract acting-mode; remove dropdown; direct launches use Autonomy; vestigial field) → Tasks 1, 2, 3. ✓
- §6 enable-on-gesture (handoff confirm) → Task 5. ✓
- §7 architecture (acting-mode pure module; GatedToggle sub-component) → Tasks 1, 4. ✓
- §9 testing (acting-mode TDD; rest typecheck+live) → Task 1 TDD; 2–5 typecheck+live. ✓
- §10 acceptance → all mapped; out-of-scope (§8) respected (vestigial field kept, handoff-only gesture, no engine-behavior change, no Context).

**Placeholder scan:** No TBD/TODO. Full SettingsModal + GatedToggle + all engine edits + the OrgChart change are complete code. CSS values baseline.

**Type consistency:** `actingModeFor(autonomy: Autonomy): PermissionMode` (Task 1) consumed identically in Task 2 (pty-manager, agent-runner) and via re-export by orchestrator. `GatedToggle({label, desc, value, max, onChange})` props match its three call sites in Task 4. `update(patch: Partial<ProjectSettings>)` / `window.api.updateSettings` used consistently. `requestConfirm` opts shape matches the existing usage.
