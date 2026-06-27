# Orchestrator model-tier assignment + effort-clamped-to-model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the orchestrator assign each worker a model tier at team build (Sonnet baseline, Opus for hard) and clamp every per-task reasoning effort to the worker's model's real ceiling, so we never send an out-of-range effort and the Run-view badge shows what actually ran.

**Architecture:** A new pure capability map (`shared/model-caps.ts`) plus a pure `clampEffort`. The clamp is applied at the single point where a routing assignment is built (`assignStep` in `nodes.ts`), via a pure `effortForModel` combiner — that feeds the badge, `task.effort`, and dispatch consistently. Model selection is added to the team-spawn proposal (prompt + parser), gated by a new `autoAssignModels` setting (default off = byte-for-byte).

**Tech Stack:** TypeScript, Electron, Vitest (`vitest run`), Claude Agent SDK. Pure shared modules under `src/shared/` are unit-tested in plain Node (no DOM/fs).

## Global Constraints

- **Off = byte-for-byte unchanged.** `autoAssignModels` default `false` (spawned workers keep `DEFAULT_MODEL_BY_KIND`); the effort clamp only runs when `adaptiveEffort` is on (today's gate), so an off run is identical to today.
- **Effort levels (verbatim):** `EFFORT_LEVELS = ['low','medium','high','xhigh','max']` (`shared/types.ts:81`).
- **Model ids (verbatim):** `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` (`shared/types.ts:418-422`, `MODELS`).
- **Per-model effort ceilings:** Opus 4.8 = `low|medium|high|xhigh|max`; Sonnet 4.6 = `low|medium|high|max` (no `xhigh`); Haiku 4.5 = none (no effort param).
- **Clamp semantics:** round **up** to the nearest supported level ≥ requested; if the request exceeds the model's ceiling, use the ceiling; a model with no effort levels → `undefined`. (So Sonnet + `xhigh` → `max`, Haiku + anything → `undefined`, Opus + `xhigh` → `xhigh`.)
- **Tier policy:** Sonnet baseline, Opus for hard work; Haiku is **never** auto-assigned to a worker. Managers/orchestrator unchanged (Opus).
- **Pure shared modules** (`model-caps.ts`, `team-spawn.ts`, `effort.ts`) must not import node/DOM/engine code.

## File Structure

- `src/shared/model-caps.ts` (new) — `MODEL_EFFORT_CAPS` + `clampEffort`. Pure.
- `src/shared/model-caps.test.ts` (new) — clampEffort unit tests.
- `src/main/engine/nodes.ts` (modify) — export pure `effortForModel`; apply it in `assignStep` (~`:739-744`).
- `src/main/engine/nodes.test.ts` (modify) — `effortForModel` tests.
- `src/shared/types.ts` (modify) — `SpawnedMember.model?`; `ProjectSettings.autoAssignModels` + `DEFAULT_SETTINGS`; `Assignment.assignedEffort?` (Task 6).
- `src/shared/team-spawn.ts` (modify) — `spawnTeamPrompt(assignModels)` model rubric; parse/validate `model` in `parseSpawnedTeam`; pure `pickSpawnModel`.
- `src/shared/team-spawn.test.ts` (modify) — model parse/prompt/pick tests.
- `src/main/engine/team-spawner.ts` (modify) — pass `getSettings().autoAssignModels` to `spawnTeamPrompt`.
- `src/main/engine/project-store.ts` (modify) — `applySpawnedTeam` uses `pickSpawnModel`.
- `src/renderer/SettingsModal.tsx` (modify) — `autoAssignModels` toggle.
- `src/renderer/run/RunView.tsx` + `src/shared/effort.ts` (modify, Task 6) — badge "capped" tooltip.

---

### Task 1: Capability map + `clampEffort` (pure)

**Files:**
- Create: `src/shared/model-caps.ts`
- Test: `src/shared/model-caps.test.ts`

**Interfaces:**
- Consumes: `Effort`, `EFFORT_LEVELS` from `./types`.
- Produces: `MODEL_EFFORT_CAPS: Record<string, Effort[]>`; `clampEffort(model: string, effort: Effort | undefined): Effort | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/model-caps.test.ts
import { describe, it, expect } from 'vitest'
import { clampEffort, MODEL_EFFORT_CAPS } from './model-caps'

describe('clampEffort', () => {
  it('passes through a supported level unchanged', () => {
    expect(clampEffort('claude-opus-4-8', 'xhigh')).toBe('xhigh')
    expect(clampEffort('claude-sonnet-4-6', 'high')).toBe('high')
    expect(clampEffort('claude-sonnet-4-6', 'max')).toBe('max')
  })
  it('rounds an unsupported level UP to the nearest supported (Sonnet xhigh -> max)', () => {
    expect(clampEffort('claude-sonnet-4-6', 'xhigh')).toBe('max')
  })
  it('returns undefined for a model with no effort parameter (Haiku)', () => {
    expect(clampEffort('claude-haiku-4-5', 'high')).toBeUndefined()
    expect(clampEffort('claude-haiku-4-5', 'max')).toBeUndefined()
  })
  it('returns undefined when no effort was requested', () => {
    expect(clampEffort('claude-sonnet-4-6', undefined)).toBeUndefined()
  })
  it('passes through unchanged for an unknown model (no clamp data)', () => {
    expect(clampEffort('some-future-model', 'xhigh')).toBe('xhigh')
  })
  it('caps a request above the ceiling to the ceiling', () => {
    // a hypothetical model whose ceiling is medium
    MODEL_EFFORT_CAPS['test-tiny'] = ['low', 'medium']
    expect(clampEffort('test-tiny', 'xhigh')).toBe('medium')
    delete MODEL_EFFORT_CAPS['test-tiny']
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/model-caps.test.ts`
Expected: FAIL — cannot find module `./model-caps`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/model-caps.ts
// Per-model reasoning-effort capability + clamp. Pure — no node/DOM/engine imports;
// unit-tested in plain Node like shared/effort.ts and shared/team-spawn.ts.
import type { Effort } from './types'
import { EFFORT_LEVELS } from './types'

/** Effort levels each model supports, low->high. Empty = model has no effort parameter. */
export const MODEL_EFFORT_CAPS: Record<string, Effort[]> = {
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'], // no xhigh
  'claude-haiku-4-5': [] // no effort parameter at all
}

/**
 * Clamp a requested effort to what `model` actually supports.
 * - no effort requested            -> undefined
 * - unknown model (no caps entry)  -> requested unchanged (no clamp data)
 * - model with no effort levels    -> undefined (e.g. Haiku)
 * - supported level                -> unchanged
 * - unsupported level              -> nearest supported level >= requested (round up),
 *                                     or the model's ceiling if the request exceeds it.
 */
export function clampEffort(model: string, effort: Effort | undefined): Effort | undefined {
  if (!effort) return undefined
  const caps = MODEL_EFFORT_CAPS[model]
  if (caps === undefined) return effort
  if (caps.length === 0) return undefined
  if (caps.includes(effort)) return effort
  const want = EFFORT_LEVELS.indexOf(effort)
  const sorted = [...caps].sort((a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b))
  const up = sorted.find((c) => EFFORT_LEVELS.indexOf(c) >= want)
  return up ?? sorted[sorted.length - 1]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/model-caps.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/model-caps.ts src/shared/model-caps.test.ts
git commit -m "feat(effort): per-model effort capability map + clampEffort"
```

---

### Task 2: Apply the clamp at assignment construction

**Files:**
- Modify: `src/main/engine/nodes.ts` (export `effortForModel`; use in `assignStep` ~`:739-744`)
- Test: `src/main/engine/nodes.test.ts`

**Interfaces:**
- Consumes: `clampEffort` from `../../shared/model-caps`; existing `getAgent`, `getSettings` (already imported in `nodes.ts:32-40`), `parseEffort`, `Effort`.
- Produces: `effortForModel(model: string | undefined, requested: Effort | undefined, adaptiveEnabled: boolean): Effort | undefined`.

Why here: `assignStep` is where `childId` (the chosen worker) and the raw effort first meet. The merge at `nodes.ts:201` (`tasks[a.taskId].effort = a.effort`) and the dispatch sites (`:285`, `:517`) all read this assignment/task effort, and `effortOfWorker` (the badge) reads the recorded assignment effort — so clamping once here makes the badge, the merged task effort, and the dispatched effort all consistent.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/engine/nodes.test.ts — add to imports and add a describe block.
// Add `effortForModel` to the existing import from './nodes'.
import { effortForModel } from './nodes' // (fold into the existing { ... } import)

describe('effortForModel', () => {
  it('clamps a requested effort to the worker model when adaptive is on', () => {
    expect(effortForModel('claude-sonnet-4-6', 'xhigh', true)).toBe('max')
    expect(effortForModel('claude-haiku-4-5', 'high', true)).toBeUndefined()
    expect(effortForModel('claude-opus-4-8', 'xhigh', true)).toBe('xhigh')
  })
  it('passes the requested effort through unchanged when adaptive is off', () => {
    expect(effortForModel('claude-sonnet-4-6', 'xhigh', false)).toBe('xhigh')
  })
  it('passes through unchanged when there is no assigned model (childId null)', () => {
    expect(effortForModel(undefined, 'xhigh', true)).toBe('xhigh')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/engine/nodes.test.ts -t effortForModel`
Expected: FAIL — `effortForModel` is not exported.

- [ ] **Step 3: Add the pure combiner and wire `assignStep`**

Add near the other exported helpers in `nodes.ts` (e.g. just above `maxEffort` at `:1123`), and import `clampEffort` at the top of the file:

```ts
import { clampEffort } from '../../shared/model-caps'
```

```ts
/** The effort to record/dispatch for an assignment: clamp to the worker's model
 *  when adaptive effort is on and a worker was chosen; otherwise the request as-is. */
export function effortForModel(
  model: string | undefined,
  requested: Effort | undefined,
  adaptiveEnabled: boolean
): Effort | undefined {
  if (!adaptiveEnabled || !model) return requested
  return clampEffort(model, requested)
}
```

Replace the `assignStep` return mapping at `nodes.ts:739-744`:

```ts
  return (parsed.assignments as Record<string, unknown>[]).map((a) => {
    const childId = typeof a.childId === 'string' && a.childId !== 'null' ? a.childId : null
    return {
      taskId: String(a.taskId ?? ''),
      childId,
      effort: effortForModel(
        childId ? getAgent(childId).model : undefined,
        parseEffort(a.effort),
        getSettings().adaptiveEffort
      ),
      reason: String(a.reason ?? '')
    }
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS (existing tests + the 3 new `effortForModel` tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(effort): clamp assigned effort to the worker's model in assignStep"
```

---

### Task 3: `autoAssignModels` setting + toggle

**Files:**
- Modify: `src/shared/types.ts` (`ProjectSettings` interface `:85-108`; `DEFAULT_SETTINGS` `:110-122`)
- Modify: `src/renderer/SettingsModal.tsx` (after the adaptive-effort field, `:82`)
- Test: `src/shared/types.test.ts` (create if absent; else add to an existing shared test)

**Interfaces:**
- Produces: `ProjectSettings.autoAssignModels: boolean` (default `false`).

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/settings-defaults.test.ts (new)
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from './types'

describe('DEFAULT_SETTINGS', () => {
  it('defaults autoAssignModels to false (byte-for-byte off)', () => {
    expect(DEFAULT_SETTINGS.autoAssignModels).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/settings-defaults.test.ts`
Expected: FAIL — `autoAssignModels` is `undefined` (not on `DEFAULT_SETTINGS`).

- [ ] **Step 3: Add the field, default, and toggle**

In `ProjectSettings` (after `adaptiveEffort` at `types.ts:93`):

```ts
  /** orchestrator picks each spawned worker's model tier at team build (off = static default) */
  autoAssignModels: boolean
```

In `DEFAULT_SETTINGS` (after `adaptiveEffort: true,` at `types.ts:115`):

```ts
  autoAssignModels: false,
```

In `SettingsModal.tsx`, add a field after the adaptive-effort `</div>` (`:82`):

```tsx
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.autoAssignModels}
              onChange={(e) => void update({ autoAssignModels: e.target.checked })}
            />
            Auto-assign worker models — orchestrator picks Sonnet/Opus per worker when building a team
          </label>
        </div>
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/shared/settings-defaults.test.ts && npx tsc --noEmit`
Expected: test PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/renderer/SettingsModal.tsx src/shared/settings-defaults.test.ts
git commit -m "feat(settings): add autoAssignModels toggle (default off)"
```

---

### Task 4: Model in the team-spawn proposal (pure)

**Files:**
- Modify: `src/shared/types.ts` (`SpawnedMember` `:10-17`)
- Modify: `src/shared/team-spawn.ts` (`spawnTeamPrompt`, `parseSpawnedTeam`; add `pickSpawnModel`)
- Test: `src/shared/team-spawn.test.ts`

**Interfaces:**
- Consumes: `MODELS`, `DEFAULT_MODEL_BY_KIND` from `./types`.
- Produces: `SpawnedMember.model?: string`; `spawnTeamPrompt(goal, orchestratorName, existing, offered?, assignModels?)`; `pickSpawnModel(m: SpawnedMember, autoAssign: boolean): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/team-spawn.test.ts — add. Import MODELS-aware helpers:
import { parseSpawnedTeam, spawnTeamPrompt, pickSpawnModel } from './team-spawn'

describe('spawnTeamPrompt model rubric', () => {
  it('omits the model field when assignModels is false (byte-for-byte today)', () => {
    const p = spawnTeamPrompt('g', 'Boss', [], [], false)
    expect(p).not.toMatch(/"model"/)
    expect(p).not.toMatch(/Opus/)
  })
  it('asks for a model with a tier rubric when assignModels is true', () => {
    const p = spawnTeamPrompt('g', 'Boss', [], [], true)
    expect(p).toContain('"model"')
    expect(p).toContain('claude-sonnet-4-6')
    expect(p).toContain('claude-opus-4-8')
    expect(p).not.toContain('claude-haiku-4-5') // never offered to workers
  })
})

describe('parseSpawnedTeam model', () => {
  const wrap = (m: object) => '```json\n' + JSON.stringify({ members: [m] }) + '\n```'
  it('keeps a valid model', () => {
    const r = parseSpawnedTeam(wrap({ id: 'a', name: 'A', kind: 'worker', role: 'r', model: 'claude-opus-4-8' }))
    expect(r?.[0].model).toBe('claude-opus-4-8')
  })
  it('drops an invalid model', () => {
    const r = parseSpawnedTeam(wrap({ id: 'a', name: 'A', kind: 'worker', role: 'r', model: 'gpt-5' }))
    expect(r?.[0].model).toBeUndefined()
  })
  it('rejects Haiku for a worker', () => {
    const r = parseSpawnedTeam(wrap({ id: 'a', name: 'A', kind: 'worker', role: 'r', model: 'claude-haiku-4-5' }))
    expect(r?.[0].model).toBeUndefined()
  })
})

describe('pickSpawnModel', () => {
  it('uses the proposed model when autoAssign is on and it is set', () => {
    expect(pickSpawnModel({ id: 'a', name: 'A', kind: 'worker', role: 'r', reportsTo: 'orchestrator', model: 'claude-opus-4-8' }, true)).toBe('claude-opus-4-8')
  })
  it('falls back to the kind default when autoAssign is off', () => {
    expect(pickSpawnModel({ id: 'a', name: 'A', kind: 'worker', role: 'r', reportsTo: 'orchestrator', model: 'claude-opus-4-8' }, false)).toBe('claude-sonnet-4-6')
  })
  it('falls back to the kind default when no model proposed', () => {
    expect(pickSpawnModel({ id: 'a', name: 'A', kind: 'worker', role: 'r', reportsTo: 'orchestrator' }, true)).toBe('claude-sonnet-4-6')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/team-spawn.test.ts`
Expected: FAIL — `pickSpawnModel` not exported / `model` not parsed / prompt has no rubric.

- [ ] **Step 3: Implement**

Add `model?` to `SpawnedMember` (`types.ts:16`, after `reportsTo`):

```ts
  reportsTo: string
  model?: string
  skills?: string[]
```

In `team-spawn.ts`, import the model constants:

```ts
import type { AgentKind, SpawnedMember } from './types'
import { MODELS, DEFAULT_MODEL_BY_KIND } from './types'
```

Add the `assignModels` param + rubric to `spawnTeamPrompt`. New signature and body changes:

```ts
export function spawnTeamPrompt(
  goal: string,
  orchestratorName: string,
  existing: { name: string; kind: AgentKind; role: string }[],
  offered: { id: string; description: string }[] = [],
  assignModels = false
): string {
```

Add a model block (place it just before the `Reply with ONLY this JSON` line) and include `"model"` in the example only when `assignModels`:

```ts
  const modelBlock = assignModels
    ? `\n\nFor each member, also pick a "model" from these ids by matching the difficulty of its work:\n- claude-sonnet-4-6: standard coding / well-scoped work (default)\n- claude-opus-4-8: hard, ambiguous, or wide-reaching work, or any manager\nBe economical — reserve claude-opus-4-8 for genuinely hard roles.`
    : ''
  const memberShape = assignModels
    ? '{ "id": "m1", "name": "short name", "kind": "manager|worker", "role": "<full role.md>", "reportsTo": "orchestrator", "model": "claude-sonnet-4-6", "skills": [] }'
    : '{ "id": "m1", "name": "short name", "kind": "manager|worker", "role": "<full role.md>", "reportsTo": "orchestrator", "skills": [] }'
```

Then insert `${modelBlock}` after the `Rules:` list (before "Reply with ONLY this JSON code block") and use `${memberShape}` inside the json example in place of the current hard-coded object. (The non-assignModels `memberShape` is identical to today's string, preserving byte-for-byte output when off.)

Parse + validate `model` in `parseSpawnedTeam` (inside the loop, after `kind`/`role` validation, before pushing). Add:

```ts
    const model =
      typeof o.model === 'string' &&
      MODELS.some((m) => m.id === o.model) &&
      !(kind === 'worker' && o.model === 'claude-haiku-4-5')
        ? (o.model as string)
        : undefined
```

and set it on the member object:

```ts
    const member: SpawnedMember = { id, name, kind, role, reportsTo: String(o.reportsTo ?? 'orchestrator').trim() || 'orchestrator' }
    if (model) member.model = model
    if (skills.length) member.skills = skills
```

Add the pure picker at the end of `team-spawn.ts`:

```ts
/** The model to create a spawned member with: the proposed model when auto-assign is on
 *  and valid, otherwise the kind's static default. */
export function pickSpawnModel(m: SpawnedMember, autoAssign: boolean): string {
  return autoAssign && m.model ? m.model : DEFAULT_MODEL_BY_KIND[m.kind]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/team-spawn.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/team-spawn.ts src/shared/team-spawn.test.ts
git commit -m "feat(spawn): orchestrator proposes per-worker model (parsed, validated, off-safe)"
```

---

### Task 5: Wire model selection into team build

**Files:**
- Modify: `src/main/engine/team-spawner.ts` (`:27`)
- Modify: `src/main/engine/project-store.ts` (`applySpawnedTeam` `:781`)

**Interfaces:**
- Consumes: `spawnTeamPrompt(..., assignModels)`, `pickSpawnModel` from `../../shared/team-spawn`; existing `getSettings`.

- [ ] **Step 1: Pass the setting into the prompt**

In `team-spawner.ts:27`, add the `assignModels` argument:

```ts
  const base = spawnTeamPrompt(opts.goal, getAgent(opts.orchestratorId).name, agents, offered, getSettings().autoAssignModels)
```

(`getSettings` is already imported in `team-spawner.ts`; if not, add it to the existing import from `./project-store`.)

- [ ] **Step 2: Apply the chosen model when creating the agent**

In `project-store.ts`, import `pickSpawnModel`:

```ts
import { spawnTeamPrompt, parseSpawnedTeam, pickSpawnModel } from '../../shared/team-spawn'
```

Replace `applySpawnedTeam`'s `model:` line (`:781`):

```ts
      model: pickSpawnModel(m, getSettings().autoAssignModels),
```

(`getSettings` is defined in `project-store.ts`; use the existing reference.)

- [ ] **Step 3: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/main/engine/team-spawner.ts src/main/engine/project-store.ts
git commit -m "feat(spawn): apply orchestrator-chosen worker models at team build (gated by autoAssignModels)"
```

---

### Task 6 (optional polish): "capped" tooltip on the effort badge

The badge already shows the clamped effort (correct after Task 2). This adds a tooltip noting when the displayed value was capped down from a higher requested level.

**Files:**
- Modify: `src/shared/types.ts` (`Assignment` interface, near `effort?` at `:362`)
- Modify: `src/main/engine/nodes.ts` (`assignStep`)
- Modify: `src/shared/effort.ts` (helper)
- Modify: `src/renderer/run/RunView.tsx` (badge `title`, `:152`)
- Test: `src/shared/effort.test.ts` (create if absent)

**Interfaces:**
- Produces: `Assignment.assignedEffort?: Effort` (the pre-clamp request, only when it differs from `effort`); `cappedFrom(assignments: Assignment[], workerId: string): Effort | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/effort.test.ts (new)
import { describe, it, expect } from 'vitest'
import { cappedFrom } from './effort'
import type { Assignment } from './types'

const a = (over: Partial<Assignment>): Assignment => ({ taskId: 't', childId: 'w', effort: 'max', reason: '', ...over })

describe('cappedFrom', () => {
  it('returns the original requested effort when a worker task was capped', () => {
    expect(cappedFrom([a({ effort: 'max', assignedEffort: 'xhigh' })], 'w')).toBe('xhigh')
  })
  it('returns undefined when nothing was capped', () => {
    expect(cappedFrom([a({ effort: 'high' })], 'w')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/effort.test.ts`
Expected: FAIL — `cappedFrom` not exported.

- [ ] **Step 3: Implement**

Add to `Assignment` (`types.ts`, after `effort?: Effort` at `:362`):

```ts
  /** the manager's pre-clamp requested effort, recorded only when it was capped to the model */
  assignedEffort?: Effort
```

In `nodes.ts` `assignStep`, record the original when it differs. Replace the mapping body from Task 2 with:

```ts
  return (parsed.assignments as Record<string, unknown>[]).map((a) => {
    const childId = typeof a.childId === 'string' && a.childId !== 'null' ? a.childId : null
    const requested = parseEffort(a.effort)
    const effort = effortForModel(childId ? getAgent(childId).model : undefined, requested, getSettings().adaptiveEffort)
    const out: Assignment = { taskId: String(a.taskId ?? ''), childId, effort, reason: String(a.reason ?? '') }
    if (requested && effort && requested !== effort) out.assignedEffort = requested
    return out
  })
```

Add to `effort.ts`:

```ts
/** If any of a worker's tasks had its effort capped to the model, the highest
 *  pre-clamp effort that was requested; otherwise undefined. */
export function cappedFrom(assignments: Assignment[], workerId: string): Effort | undefined {
  let best: Effort | undefined
  for (const a of assignments) {
    if (a.childId !== workerId || !a.assignedEffort) continue
    if (!best || EFFORT_LEVELS.indexOf(a.assignedEffort) > EFFORT_LEVELS.indexOf(best)) best = a.assignedEffort
  }
  return best
}
```

In `RunView.tsx` at the badge (`:152`), compute and use the capped note:

```tsx
                const capped = isLeaf ? cappedFrom(allAssignments, id) : undefined
```

and change the badge `title`:

```tsx
                <span className={`run-eff eff-${eff}`} title={capped ? `effort ${eff} (capped from ${capped} — model limit)` : `assigned effort: ${eff}`}>
```

(Import `cappedFrom` alongside the existing `effortOfWorker` import from `../../shared/effort`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/shared/effort.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/engine/nodes.ts src/shared/effort.ts src/shared/effort.test.ts src/renderer/run/RunView.tsx
git commit -m "feat(ui): badge tooltip notes when effort was capped to the model"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx vitest run` — all green
- [ ] `npm run build` — succeeds
- [ ] Manual: with `autoAssignModels` off + `adaptiveEffort` on, a Sonnet worker assigned an xhigh task shows **MAX** in the badge (not XHIGH) and dispatches at max; with `autoAssignModels` on, Build-team proposes Opus for a hard worker and Sonnet for standard; with both off, behavior is identical to today.

## Self-review notes

- **Spec coverage:** capability map (T1), routing clamp (T2), build-time model assignment (T4/T5), `autoAssignModels` setting (T3), badge/tooltip (T6), off-parity (defaults in T3, gates in T2/T5) — all covered.
- **Clamp site refinement vs spec:** spec named `nodes.ts:285/:517`; the plan clamps once upstream at `assignStep` (`:739-744`), which those sites and the badge both read from — strictly better, same intent.
- **Clamp direction:** round **up** (Sonnet xhigh→max), matching the approved design preview (spec text corrected to match).
- **Type consistency:** `clampEffort`, `effortForModel`, `pickSpawnModel`, `cappedFrom`, `assignedEffort` used with identical signatures across tasks.
