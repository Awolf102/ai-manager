# Large Team Mode + Director role — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `director` AgentKind (a strategic router+reviewer tier), an opt-in Large Team Mode (broad planning + director spawn/draft + adjustable concurrency), bulk-duplicate workers, full Advisor-driven team-building, and cost/runtime guard rails.

**Architecture:** The run loop already delegates over the free-form edge tree kind-agnostically, so a `director` slots in as an intermediate router with almost no engine change; the real work is (a) a well-bounded set of enumerated kind-lists/records, (b) generalizing two `kind === 'manager'` review booleans to "manager **or** director", (c) gated prompt variants + settings, (d) additive UI. Everything is byte-for-byte when `largeTeamMode` is off **and** no director node exists.

**Tech Stack:** Electron (main/preload/renderer, CJS main), React 19 + TypeScript, zustand, @xyflow/react, lucide-react, Vitest. Spec: `docs/superpowers/specs/2026-07-02-large-team-director-design.md`.

## Global Constraints

- **Byte-for-byte invariant:** `largeTeamMode` off + no director node ⇒ identical engine behavior, prompt strings, parallelism, spawn/draft output, and rendering. Every new setting/param defaults to its inert value; every gated prompt branch is empty-string when off.
- **On-brand UI only** (per `DESIGN.md` + `tokens.css`): consume CSS custom-property tokens, never hardcode hex except the two documented xterm/React-Flow mirrors. Role colors must be a distinct triad-plus-one, all ≥7:1 on `--surface-2`, and ≠ emerald-signal. Reuse `Switch`/`SettingSection`/`SettingRow`/`Modal`/`gated-control`; add no new CSS beyond the director role rules.
- **Model ids:** Opus 4.8 = `claude-opus-4-8`, Sonnet 4.6 = `claude-sonnet-4-6`, Haiku 4.5 = `claude-haiku-4-5`.
- **Kind order everywhere:** `orchestrator → director → manager → worker`.
- **Integration gates (run before each commit that touches the area):** `npm run typecheck`, `npm run test`. Renderer-touching tasks additionally run `npm run lint`. The controller runs `npm run build` at the end. Renderer visuals/interactions also require the user's on-device smoke (App.tsx is not rendered by tests) — flagged per task.
- **Commit** after each task's tests pass. `--no-ff` merge to main happens only after the whole-branch opus review is clean (handled outside this plan).

---

### Task 1: Director kind — types, constants, icon key, kind-lists

Adds the 4th `AgentKind` so the whole codebase compiles with a director. No director nodes exist yet in any project, so behavior is byte-for-byte. TypeScript's exhaustive `Record<AgentKind>` maps force every kind-sensitive site to be visited.

**Files:**
- Modify: `src/shared/types.ts` (`AgentKind` `:7`, `AGENT_KINDS` `:563`, `DEFAULT_MODEL_BY_KIND` `:565`)
- Modify: `src/shared/team-bundle.ts` (duplicate `AGENT_KINDS` `:15`; `MAX_MEMBERS` `:11`)
- Modify: `src/shared/context-files.ts` (`KIND_PLURAL` `:41`, inline list in `scopeLabel` `:51`)
- Modify: `src/shared/octopus-layout.ts` (`LayoutNode.kind` union `:3`)
- Modify: `src/shared/icons.ts` (`IconKey` union `:5`, `KIND_FALLBACK` `:41`)
- Modify: `src/renderer/canvas/iconComponents.tsx` (`ICONS` map `:23`)
- Modify: `src/renderer/ContextModal.tsx` (`KINDS` array `:35`)
- Test: `src/shared/types.test.ts` (create); `src/shared/context-files.test.ts` runs unchanged as a regression (its `KIND_PLURAL`/`scopeLabel` coverage is TS-enforced by the exhaustive record)

**Interfaces:**
- Produces: `AgentKind = 'orchestrator' | 'director' | 'manager' | 'worker'`; `AGENT_KINDS` includes `'director'` in order; `DEFAULT_MODEL_BY_KIND.director === 'claude-opus-4-8'`; `iconForName(name, 'director') === 'compass'`; new `IconKey` member `'compass'`.

- [ ] **Step 1: Write the failing test** — create `src/shared/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AGENT_KINDS, DEFAULT_MODEL_BY_KIND } from './types'
import { iconForName } from './icons'

describe('director AgentKind', () => {
  it('is in AGENT_KINDS in chain order', () => {
    expect(AGENT_KINDS).toEqual(['orchestrator', 'director', 'manager', 'worker'])
  })
  it('defaults a director to Opus', () => {
    expect(DEFAULT_MODEL_BY_KIND.director).toBe('claude-opus-4-8')
  })
  it('falls back a director icon to compass', () => {
    expect(iconForName('Program Lead', 'director')).toBe('compass')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/types.test.ts`
Expected: FAIL — `AGENT_KINDS` lacks `'director'`; `DEFAULT_MODEL_BY_KIND.director` is undefined; icon fallback returns `'bot'`.

- [ ] **Step 3: Implement**

In `src/shared/types.ts`:
```ts
export type AgentKind = 'orchestrator' | 'director' | 'manager' | 'worker'
```
```ts
export const AGENT_KINDS: AgentKind[] = ['orchestrator', 'director', 'manager', 'worker']

export const DEFAULT_MODEL_BY_KIND: Record<AgentKind, string> = {
  orchestrator: 'claude-opus-4-8',
  director: 'claude-opus-4-8',
  manager: 'claude-opus-4-8',
  worker: 'claude-sonnet-4-6'
}
```

In `src/shared/team-bundle.ts`: update the local list at `:15` to `const AGENT_KINDS: AgentKind[] = ['orchestrator', 'director', 'manager', 'worker']` and bump the import cap `:11` from `export const MAX_MEMBERS = 200` to `export const MAX_MEMBERS = 1000`.

In `src/shared/context-files.ts`:
```ts
const KIND_PLURAL: Record<AgentKind, string> = {
  orchestrator: 'Orchestrator',
  director: 'Directors',
  manager: 'Managers',
  worker: 'Workers'
}
```
and the inline list at `:51`:
```ts
  const kindLabels = (['orchestrator', 'director', 'manager', 'worker'] as AgentKind[])
```

In `src/shared/octopus-layout.ts` `:3`:
```ts
  kind: 'orchestrator' | 'director' | 'manager' | 'worker'
```

In `src/shared/icons.ts`: add `| 'compass'` to the `IconKey` union, and add to `KIND_FALLBACK`:
```ts
const KIND_FALLBACK: Record<string, IconKey> = {
  orchestrator: 'crown',
  director: 'compass',
  manager: 'clipboard',
  worker: 'bot'
}
```

In `src/renderer/canvas/iconComponents.tsx`: import `Compass` from `lucide-react` and add `compass: Compass` to the `ICONS` record:
```ts
import { Database, Palette, Cpu, Code, Server, FlaskConical, ClipboardList, Crown, Compass, Shield, Pencil, Search, Bot, BarChart3, Globe, Wrench, Bug, BookOpen, type LucideIcon } from 'lucide-react'
```
```ts
  crown: Crown,
  compass: Compass,
  shield: Shield,
```

In `src/renderer/ContextModal.tsx` `:35`:
```ts
const KINDS: { k: AgentKind; label: string }[] = [
  { k: 'orchestrator', label: 'Orchestrator' },
  { k: 'director', label: 'Directors' },
  { k: 'manager', label: 'Managers' },
  { k: 'worker', label: 'Workers' }
]
```

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `npx vitest run src/shared/types.test.ts src/shared/context-files.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (all exhaustive `Record<AgentKind>` sites now satisfied).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/types.test.ts src/shared/team-bundle.ts src/shared/context-files.ts src/shared/octopus-layout.ts src/shared/icons.ts src/renderer/canvas/iconComponents.tsx src/renderer/ContextModal.tsx
git commit -m "feat(large-team): add director AgentKind — types, constants, icon key, kind-lists"
```

---

### Task 2: Director visuals + role template

Gives a director node its on-brand color/icon-chip/label and a proper role.md template. Purely additive: no director node exists in current projects.

**Files:**
- Modify: `src/renderer/tokens.css` (role-color block `:36-41`)
- Modify: `src/renderer/styles.css` (`.kind-*` rule sets at `:369-377`, `:396-398`, `:412-414`, `:1627-1632`)
- Modify: `src/main/engine/project-store.ts` (`roleTemplate` `:74`)
- Test: `src/main/engine/project-store.test.ts` (extend)

**Interfaces:**
- Produces: `roleTemplate(name, 'director')` returns markdown containing `(Director)` and program-lead language.

- [ ] **Step 1: Write the failing test** — add to `src/main/engine/project-store.test.ts` (import `roleTemplate` if not already; it is module-internal — export it for the test, see Step 3):

```ts
import { roleTemplate } from './project-store'

describe('roleTemplate', () => {
  it('gives a director a program-lead role', () => {
    const r = roleTemplate('Platform Lead', 'director')
    expect(r).toContain('# Role: Platform Lead (Director)')
    expect(r.toLowerCase()).toContain('program')
    expect(r.toLowerCase()).toContain('managers')
  })
  it('is unchanged for a worker (no director leakage)', () => {
    expect(roleTemplate('X', 'worker')).toContain('(Worker)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/engine/project-store.test.ts -t roleTemplate`
Expected: FAIL — `roleTemplate` is not exported (import error) and/or a director falls through to the Worker template.

- [ ] **Step 3: Implement**

In `src/main/engine/project-store.ts`, change `function roleTemplate` to `export function roleTemplate` and add a director branch **before** the worker fall-through (after the `manager` block, before `return \`# Role: ${name} (Worker)…\``):

```ts
  if (kind === 'director') {
    return `# Role: ${name} (Director)

You are a **director** — a program lead between the orchestrator and the managers.

## Responsibilities
- Own a broad **program area** the orchestrator hands you.
- Decompose that area across the managers and workers who report to you, and route each piece to the right one.
- **Review and integrate** what your team hands up — check it against the program area and the overall goal, decide pass/fail, and give specific feedback.
- Aggregate your area's result and report it up to the orchestrator.
- After a run, reflect on what your review and coordination caught so future programs go smoother.

## How you work
- Think in workstreams: split your area into coherent chunks a manager or worker can own end-to-end.
- Keep the orchestrator informed about what each part is doing and what is blocked.
- Prefer the simplest structure that covers your area — don't add managers a small area doesn't need.

## Constraints
- You operate inside this one project folder.
- You direct, review, and integrate — you do NOT implement. Don't edit workers' files; review and give feedback instead.
`
  }
```

In `src/renderer/tokens.css`, add to the role-color block (after `--worker-tint` at `:41`):
```css
  --director: #CB98DB;       /* orchid — program-lead tier, ≥7:1 on --surface-2, ≠ emerald */
  --director-tint: rgba(203, 152, 219, 0.14);
```

In `src/renderer/styles.css`, add a `.kind-director` rule to each of the four existing groups:
```css
.agent-node.kind-director {
  background-image: var(--gloss), radial-gradient(140% 90% at 0% 0%, var(--director-tint), transparent 62%);
}
```
```css
.kind-director .agent-icon { color: var(--director); background: var(--director-tint); }
```
```css
.kind-director .agent-kind { color: var(--director); }
```
```css
.run-row-name.kind-director,
.activity-agent.kind-director { color: var(--director); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/engine/project-store.test.ts -t roleTemplate && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts src/renderer/tokens.css src/renderer/styles.css
git commit -m "feat(large-team): director role.md template + on-brand node color/icon/label"
```

> **On-device smoke (defer to end-of-branch):** add a director node → renders orchid icon chip + label, gloss corner wash; run view/narration shows the director name in orchid. Verify `--director` ≥3:1 AA-large / ~7:1 on `--surface-2` (matches the triad).

---

### Task 3: N-tier review generalization (engine)

Generalizes the two `kind === 'manager'` booleans to "manager **or** director" so a director tier triggers integration review and QA-reflection. Byte-for-byte for any team without a director (existing fixtures stay green). The function name `hasManagers` is kept (minimal blast radius); only the predicate and doc comment change.

**Files:**
- Modify: `src/main/engine/nodes.ts` (`hasManagers` `:1196`, `reviewerIdsOf` `:1205`)
- Test: `src/main/engine/nodes.test.ts` (fixture `agents` map + `hasManagers / reviewerIdsOf` describe `:604`)

**Interfaces:**
- Consumes: `parentOf(id)` (faked in nodes.test.ts from `h.children`).
- Produces: `hasManagers(state)` true when any owned task's parent kind ∈ {manager, director}; `reviewerIdsOf(state)` includes director parents.

- [ ] **Step 1: Write the failing test** — in `src/main/engine/nodes.test.ts`: (a) add a director agent to the hoisted fixture `agents` map (`:42`):

```ts
      o: mk('o', 'orchestrator'),
      d: mk('d', 'director'),
      m: mk('m', 'manager'),
```

(b) add cases inside the existing `describe('hasManagers / reviewerIdsOf', …)` block (after the two-tier test at `:629`):

```ts
  it('director tier: a worker under a director → director + orchestrator review', () => {
    h.children = { o: ['d'], d: ['w1', 'w2'], w1: [], w2: [] }
    const s = stateWith({ t1: { ownerId: 'w1' }, t2: { ownerId: 'w2' } })
    expect(hasManagers(s)).toBe(true)
    expect(reviewerIdsOf(s).sort()).toEqual(['d', 'o'])
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
  })

  it('three tiers: workers under a manager under a director → manager + orchestrator', () => {
    h.children = { o: ['d'], d: ['m'], m: ['w1', 'w2'], w1: [], w2: [] }
    const s = stateWith({ t1: { ownerId: 'w1' }, t2: { ownerId: 'w2' } })
    expect(hasManagers(s)).toBe(true)
    expect(reviewerIdsOf(s).sort()).toEqual(['m', 'o'])
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "hasManagers"`
Expected: FAIL on the director-tier case — `hasManagers` returns false and `reviewerIdsOf` omits `'d'` because the predicate only matches `'manager'`.

- [ ] **Step 3: Implement** — in `src/main/engine/nodes.ts`:

```ts
/** True when at least one owned task's immediate parent is a manager or director (an intermediate review tier exists). */
export function hasManagers(state: RunState): boolean {
  return ownedTasks(state).some((t) => {
    const k = parentOf(t.ownerId!)?.kind
    return k === 'manager' || k === 'director'
  })
}
```
```ts
export function reviewerIdsOf(state: RunState): string[] {
  const ids = new Set<string>()
  for (const t of ownedTasks(state)) {
    const p = parentOf(t.ownerId!)
    if (p && (p.kind === 'manager' || p.kind === 'director')) ids.add(p.id)
  }
  if (hasManagers(state)) ids.add(state.orchestratorId)
  return [...ids]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/engine/nodes.test.ts && npm run typecheck`
Expected: PASS — new director cases green, existing flat/two-tier cases unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(large-team): generalize review booleans to director tier (byte-for-byte w/o director)"
```

---

### Task 4: `team-scale.ts` pure helpers + largeTeam settings

Introduces the settings and the pure concurrency/clamp helpers, plus the Settings UI section. `largeTeamMode` off keeps `parallelCap` at 3.

**Files:**
- Create: `src/shared/team-scale.ts`
- Create: `src/shared/team-scale.test.ts`
- Modify: `src/shared/types.ts` (`ProjectSettings` `:138`, `DEFAULT_SETTINGS` `:165`)
- Modify: `src/renderer/SettingsModal.tsx` (add a "Large Team" `SettingSection`)

**Interfaces:**
- Produces: `DEFAULT_PARALLEL = 3`; `clampParallel(n): number` (1–24); `clampBulk(n): number` (1–100); `parallelCap(settings): number`. New settings `largeTeamMode: boolean`, `largeTeamParallel: number`, `bulkCreateMax: number`.

- [ ] **Step 1: Write the failing test** — create `src/shared/team-scale.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_PARALLEL, clampParallel, clampBulk, parallelCap } from './team-scale'

describe('team-scale concurrency', () => {
  it('parallelCap is the default when largeTeamMode is off', () => {
    expect(parallelCap({ largeTeamMode: false, largeTeamParallel: 12 })).toBe(DEFAULT_PARALLEL)
    expect(DEFAULT_PARALLEL).toBe(3)
  })
  it('parallelCap uses the (clamped) largeTeamParallel when on', () => {
    expect(parallelCap({ largeTeamMode: true, largeTeamParallel: 6 })).toBe(6)
    expect(parallelCap({ largeTeamMode: true, largeTeamParallel: 999 })).toBe(24)
    expect(parallelCap({ largeTeamMode: true, largeTeamParallel: 0 })).toBe(1)
  })
  it('clampers bound their ranges', () => {
    expect(clampParallel(30)).toBe(24)
    expect(clampParallel(0)).toBe(1)
    expect(clampBulk(500)).toBe(100)
    expect(clampBulk(-1)).toBe(1)
    expect(clampBulk(Number.NaN)).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/team-scale.test.ts`
Expected: FAIL — module `./team-scale` does not exist.

- [ ] **Step 3: Implement** — create `src/shared/team-scale.ts`:

```ts
// Pure helpers for large-team scaling. No node/DOM imports.

export const DEFAULT_PARALLEL = 3

export function clampParallel(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PARALLEL
  return Math.max(1, Math.min(24, Math.floor(n)))
}

export function clampBulk(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(100, Math.floor(n)))
}

/** The concurrency cap for a run: raised (adjustable) only in large-team mode. */
export function parallelCap(settings: { largeTeamMode?: boolean; largeTeamParallel?: number }): number {
  return settings.largeTeamMode ? clampParallel(settings.largeTeamParallel ?? DEFAULT_PARALLEL) : DEFAULT_PARALLEL
}
```

In `src/shared/types.ts`, add to the `ProjectSettings` interface (after `maxFollowThrough` `:137`):
```ts
  /** master toggle for large-team behaviors: broad planning + director spawn/draft + raised concurrency (off = byte-for-byte) */
  largeTeamMode: boolean
  /** concurrency cap used only when largeTeamMode is on (clamped 1–24) */
  largeTeamParallel: number
  /** per-action ceiling for bulk create/duplicate (clamped 1–100) */
  bulkCreateMax: number
```
and to `DEFAULT_SETTINGS` (after `maxFollowThrough: 0` `:164`):
```ts
  largeTeamMode: false,
  largeTeamParallel: 6,
  bulkCreateMax: 25
```

In `src/renderer/SettingsModal.tsx`, import the clampers at the top:
```ts
import { clampParallel, clampBulk } from '../shared/team-scale'
```
and add a new `SettingSection` (place it after the token-efficiency `SettingSection` that ends near `:323`; mirror the existing `SettingRow`/`Switch`/`gated-control` pattern):
```tsx
              <SettingSection title="Large Team">
                <SettingRow
                  label="Large team mode"
                  desc="For big goals: the orchestrator plans at a broad program level, Build-team and Draft-roles may propose a director tier, and runs use a higher concurrency cap. Off = unchanged."
                  control={
                    <div className="gated-control">
                      {s.largeTeamMode && (
                        <input
                          type="number"
                          min={1}
                          max={24}
                          value={s.largeTeamParallel}
                          title="Concurrency cap (agents running at once)"
                          onChange={(e) => void update({ largeTeamParallel: clampParallel(Number(e.target.value)) })}
                        />
                      )}
                      <Switch
                        checked={s.largeTeamMode}
                        label="Large team mode"
                        onChange={(v) => void update({ largeTeamMode: v })}
                      />
                    </div>
                  }
                />
                <SettingRow
                  label="Bulk create limit"
                  desc="The most agents a single Add or Duplicate action may create at once."
                  control={
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={s.bulkCreateMax}
                      onChange={(e) => void update({ bulkCreateMax: clampBulk(Number(e.target.value)) })}
                    />
                  }
                />
              </SettingSection>
```

- [ ] **Step 4: Run tests + typecheck + lint to verify green**

Run: `npx vitest run src/shared/team-scale.test.ts && npm run typecheck && npm run lint`
Expected: PASS; typecheck clean (both `ProjectSettings` and `DEFAULT_SETTINGS` extended).

- [ ] **Step 5: Commit**

```bash
git add src/shared/team-scale.ts src/shared/team-scale.test.ts src/shared/types.ts src/renderer/SettingsModal.tsx
git commit -m "feat(large-team): largeTeamMode/largeTeamParallel/bulkCreateMax settings + team-scale helpers"
```

> **On-device smoke (defer):** Settings → Large Team → toggle reveals the concurrency number; both numbers persist and clamp.

---

### Task 5: Wire `parallelCap` into the engine

Raises concurrency when `largeTeamMode` is on. This is a **behavior-preserving refactor** (no natural red state): `parallelCap` is already unit-tested in Task 4; here the gate is that every existing wave/review/repair/reflect test stays green (the fixture's `largeTeamMode: false` ⇒ cap resolves to 3, identical to `MAX_PARALLEL`) and the four call sites now read the cap from settings.

**Files:**
- Modify: `src/main/engine/nodes.ts` (`MAX_PARALLEL` `:47`; four `mapCapped` call sites `:469`, `:544`, `:645`, `:761`, `:781`)
- Test: `src/main/engine/nodes.test.ts` (add the new settings fields to the `h.settings` fixture so `getSettings()` is complete)

**Interfaces:**
- Consumes: `parallelCap(settings)` from `src/shared/team-scale`; `getSettings()` (faked in nodes.test.ts as `h.settings`).

- [ ] **Step 1: Extend the settings fixture** — in `src/main/engine/nodes.test.ts`, add to the `h.settings` object (`:50`) so `getSettings()` returns the new fields and `parallelCap` resolves to 3:

```ts
      followThrough: 'off',
      largeTeamMode: false,
      largeTeamParallel: 6,
      bulkCreateMax: 25
```

- [ ] **Step 2: Run the existing suite as the baseline (green before the refactor)**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS (baseline; the substitution in Step 3 must keep it green).

- [ ] **Step 3: Implement** — in `src/main/engine/nodes.ts`:

Add the import near the other shared imports:
```ts
import { parallelCap } from '../../shared/team-scale'
```
Keep `MAX_PARALLEL` as the default for any remaining references but redefine it via the helper's default (optional; leaving `export const MAX_PARALLEL = 3` is fine). Replace the cap argument at each of the four `mapCapped` sites:

`:469`
```ts
    await mapCapped([...byOwner.entries()], parallelCap(getSettings()), ([ownerId, group]) => runGroup(ownerId, group))
```
`:544`
```ts
  await mapCapped([...groups.entries()], parallelCap(getSettings()), async ([reviewerId, group]) => {
```
`:645`
```ts
  await mapCapped(failed, parallelCap(getSettings()), async (t) => {
```
`:761`
```ts
  await mapCapped(workerIdsOf(state.tasks), parallelCap(getSettings()), async (wid) => {
```
`:781`
```ts
  await mapCapped(reviewerIdsOf(state), parallelCap(getSettings()), async (rid) => {
```

- [ ] **Step 4: Run tests to verify they stay green**

Run: `npx vitest run src/main/engine/nodes.test.ts && npm run typecheck`
Expected: PASS — all existing wave/review/repair/reflect tests unchanged (cap resolves to 3 with the fixture's `largeTeamMode: false`).

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(large-team): use adjustable parallelCap for concurrency (3 when off)"
```

---

### Task 6: Director-aware spawn + draft prompts/parsers

Teaches Build-team and Draft-roles about the director tier, gated to large-team mode. Off = prompt strings byte-for-byte; the parser accepts `director` unconditionally (harmless, since the prompt only proposes it when on).

**Files:**
- Modify: `src/shared/types.ts` (`SpawnedMember.kind` `:16`)
- Modify: `src/shared/team-spawn.ts` (`spawnTeamPrompt` `:6`, `parseSpawnedTeam` gate `:58`)
- Modify: `src/main/engine/team-spawner.ts` (pass the flag `:31`)
- Modify: `src/shared/role-draft.ts` (`draftRolesPrompt` `:12`, `:45`)
- Modify: `src/main/engine/role-drafter.ts` (pass the flag `:33`)
- Test: `src/shared/team-spawn.test.ts`, `src/shared/role-draft.test.ts` (create/extend)

**Interfaces:**
- Produces: `spawnTeamPrompt(goal, name, existing, offered?, assignModels?, largeTeam?)`; `draftRolesPrompt(goal, roster, edges, offered?, largeTeam?)`; `parseSpawnedTeam` accepts `kind: 'director'`; `SpawnedMember.kind = 'director' | 'manager' | 'worker'`.

- [ ] **Step 1: Write the failing test** — create/extend `src/shared/team-spawn.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { spawnTeamPrompt, parseSpawnedTeam } from './team-spawn'

describe('director-aware spawn', () => {
  it('is byte-for-byte when largeTeam is off', () => {
    expect(spawnTeamPrompt('g', 'Orky', [])).toBe(spawnTeamPrompt('g', 'Orky', [], [], false, false))
    expect(spawnTeamPrompt('g', 'Orky', [])).not.toContain('director')
  })
  it('mentions directors when largeTeam is on', () => {
    const p = spawnTeamPrompt('g', 'Orky', [], [], false, true)
    expect(p).toContain('director')
    expect(p).toContain('director|manager|worker')
  })
  it('parses a director member', () => {
    const text = '```json\n{ "members": [ { "id": "d1", "name": "Lead", "kind": "director", "role": "r", "reportsTo": "orchestrator" } ] }\n```'
    const members = parseSpawnedTeam(text)
    expect(members?.[0].kind).toBe('director')
  })
})
```
and extend `src/shared/role-draft.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { draftRolesPrompt } from './role-draft'

describe('director-aware draft', () => {
  it('is byte-for-byte when largeTeam is off', () => {
    const roster = [{ id: 'a', name: 'A', kind: 'worker' as const, role: 'r' }]
    expect(draftRolesPrompt('g', roster, [])).toBe(draftRolesPrompt('g', roster, [], [], false))
    expect(draftRolesPrompt('g', roster, [])).toContain('(<Worker|Manager>)')
  })
  it('offers Director when largeTeam is on', () => {
    const roster = [{ id: 'a', name: 'A', kind: 'worker' as const, role: 'r' }]
    expect(draftRolesPrompt('g', roster, [], [], true)).toContain('(<Worker|Manager|Director>)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/team-spawn.test.ts src/shared/role-draft.test.ts`
Expected: FAIL — `spawnTeamPrompt`/`draftRolesPrompt` don't accept a `largeTeam` arg and never mention director; `parseSpawnedTeam` drops the director member (returns null).

- [ ] **Step 3: Implement**

In `src/shared/types.ts` `:16`:
```ts
  kind: 'director' | 'manager' | 'worker'
```

In `src/shared/team-spawn.ts`, change the signature and gated strings:
```ts
export function spawnTeamPrompt(
  goal: string,
  orchestratorName: string,
  existing: { name: string; kind: AgentKind; role: string }[],
  offered: { id: string; description: string }[] = [],
  assignModels = false,
  largeTeam = false
): string {
```
```ts
  const kindHint = largeTeam ? 'director|manager|worker' : 'manager|worker'
  const memberShape = assignModels
    ? `{ "id": "m1", "name": "short name", "kind": "${kindHint}", "role": "<full role.md>", "reportsTo": "orchestrator", "model": "claude-sonnet-4-6", "skills": [] }`
    : `{ "id": "m1", "name": "short name", "kind": "${kindHint}", "role": "<full role.md>", "reportsTo": "orchestrator", "skills": [] }`
  const directorRule = largeTeam
    ? `\n- For a broad goal spanning several distinct PROGRAM AREAS, add a "director" between yourself and the managers: a director owns one broad area, routes to its managers/workers, and reviews/aggregates their results up to you. Use directors ONLY when the scope is genuinely large — otherwise keep the team flat or two-tier.`
    : ''
```
and append `${directorRule}` to the end of the existing "Create a domain manager…" rule line (immediately after `keep that flat (the worker reports directly to you).`):
```ts
- Create a domain manager when a distinct area of work (a cluster of several related roles or subsystems) would benefit from dedicated review, testing, and accumulated QA expertise — not only when there are many workers. A manager owns reviewing and testing its area, so group several related roles under one QA-capable manager. A manager with a single worker is pure overhead — keep that flat (the worker reports directly to you).${directorRule}
```
Update the `parseSpawnedTeam` kind gate `:58`:
```ts
    const kind = o.kind === 'director' ? 'director' : o.kind === 'manager' ? 'manager' : o.kind === 'worker' ? 'worker' : null
```

In `src/main/engine/team-spawner.ts` `:31`:
```ts
  const base = spawnTeamPrompt(opts.goal, getAgent(opts.orchestratorId).name, agents, offered, s.autoAssignModels, s.largeTeamMode)
```
(`s` is the `getSettings()` already bound at `:24`.)

In `src/shared/role-draft.ts`:
```ts
export function draftRolesPrompt(
  goal: string,
  roster: DraftRosterAgent[],
  edges: { source: string; target: string }[],
  offered: { id: string; description: string }[] = [],
  largeTeam = false
): string {
```
and change the shape line `:45`:
```ts
  const roleKinds = largeTeam ? 'Worker|Manager|Director' : 'Worker|Manager'
```
```ts
# Role: <name> (<${roleKinds}>)
```

In `src/main/engine/role-drafter.ts` `:33`:
```ts
  const base = draftRolesPrompt(opts.goal, agents, edges, offered, s.largeTeamMode)
```
(`s` is `getSettings()` bound at `:26`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/team-spawn.test.ts src/shared/role-draft.test.ts src/main/engine/team-spawner.test.ts src/main/engine/role-drafter.test.ts && npm run typecheck`
Expected: PASS. If `team-spawner.test.ts`/`role-drafter.test.ts` fixtures lack the new settings fields, add `largeTeamMode: false` to their settings fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/team-spawn.ts src/shared/team-spawn.test.ts src/main/engine/team-spawner.ts src/shared/role-draft.ts src/shared/role-draft.test.ts src/main/engine/role-drafter.ts
git commit -m "feat(large-team): director-aware Build-team + Draft-roles (gated; off = byte-for-byte)"
```

---

### Task 7: Broad planning prompt

When `largeTeamMode` is on, the orchestrator plans at a program level. Off = the current `planPrompt` string exactly.

**Files:**
- Modify: `src/main/engine/nodes.ts` (`planPrompt` `:1468`, `planStep` `:845-856`)
- Test: `src/main/engine/nodes.test.ts` (planPrompt unit check — export `planPrompt` for the test)

**Interfaces:**
- Produces: `planPrompt(goal, largeTeam?)` — `planPrompt(g)` byte-for-byte with today; `planPrompt(g, true)` adds a program-altitude instruction.

- [ ] **Step 1: Write the failing test** — add to `src/main/engine/nodes.test.ts`:

```ts
import { planPrompt } from './nodes'

describe('planPrompt broad planning', () => {
  it('is byte-for-byte when largeTeam is off', () => {
    expect(planPrompt('build X')).toBe(planPrompt('build X', false))
    expect(planPrompt('build X')).not.toMatch(/program/i)
  })
  it('asks for a broad program-level plan when on', () => {
    expect(planPrompt('build X', true)).toMatch(/program/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "planPrompt"`
Expected: FAIL — `planPrompt` is not exported and takes no `largeTeam` arg.

- [ ] **Step 3: Implement** — in `src/main/engine/nodes.ts`, change `function planPrompt` to `export function planPrompt` and add the gated clause (inserted so the off-string is unchanged):

```ts
export function planPrompt(goal: string, largeTeam = false): string {
  const scale = largeTeam
    ? `\n\nThis is a LARGE team. Plan at a BROAD, PROGRAM level: produce a small number (~3–8) of high-level workstreams, each of which a director or manager can own and break down further with their own team. Prefer few broad tasks over many fine-grained ones.`
    : ''
  return `You are planning work to achieve the user's goal for this project. You may READ files to inform the plan, but do NOT make any changes.

GOAL:
${goal}${scale}

Produce a concise, ordered list of concrete tasks that together fully achieve the goal. Each task should be self-contained and suitable to hand to a single specialist. Prefer the smallest set of tasks that covers the goal.

A task may optionally declare "dependsOn": an array of the ids of tasks that MUST be finished before it can start (e.g. a frontend task that needs the backend API to exist first). Add a dependency ONLY when a task genuinely cannot begin until another is done — most tasks have none, so use [] or omit it. Never create a cycle.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "tasks": [ { "id": "t1", "title": "short title", "description": "what to do, in enough detail for a specialist", "dependsOn": [] } ] }
\`\`\``
}
```
and in `planStep` `:853` pass the flag:
```ts
    planPrompt(goal, getSettings().largeTeamMode),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "planPrompt" && npm run typecheck`
Expected: PASS. (The `planPrompt('build X')` byte-for-byte assertion guards the off-path.)

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(large-team): broad program-level planning prompt when largeTeamMode is on"
```

---

### Task 8: Advisor brief — director + reportsTo + `briefTeamToSpawnedMembers`

Widens the Advisor's team-member shape and adds the pure mapper that turns a brief team into `SpawnedMember[]` for the existing apply-team path.

**Files:**
- Modify: `src/shared/advisor.ts` (`AdvisorBriefTeamMember` `:4`, `advisorSystemPrompt` brief-field line `:58`, new `briefTeamToSpawnedMembers`)
- Test: `src/shared/advisor.test.ts` (extend)

**Interfaces:**
- Produces: `AdvisorBriefTeamMember = { name: string; kind: 'director'|'manager'|'worker'; role: string; reportsTo?: string }`; `briefTeamToSpawnedMembers(team): SpawnedMember[]`.

- [ ] **Step 1: Write the failing test** — add to `src/shared/advisor.test.ts`:

```ts
import { briefTeamToSpawnedMembers } from './advisor'

describe('briefTeamToSpawnedMembers', () => {
  it('resolves reportsTo by member name and defaults to orchestrator', () => {
    const out = briefTeamToSpawnedMembers([
      { name: 'Platform Lead', kind: 'director', role: 'r' },
      { name: 'API Manager', kind: 'manager', role: 'r', reportsTo: 'Platform Lead' },
      { name: 'DB Worker', kind: 'worker', role: 'r', reportsTo: 'API Manager' }
    ])
    expect(out).toHaveLength(3)
    expect(out[0].reportsTo).toBe('orchestrator') // no reportsTo → orchestrator
    expect(out[1].reportsTo).toBe(out[0].id)      // by name
    expect(out[2].reportsTo).toBe(out[1].id)
    expect(out[0].kind).toBe('director')
  })
  it('sends an unknown or literal-orchestrator reportsTo to orchestrator', () => {
    const out = briefTeamToSpawnedMembers([
      { name: 'A', kind: 'worker', role: 'r', reportsTo: 'orchestrator' },
      { name: 'B', kind: 'worker', role: 'r', reportsTo: 'Nobody' }
    ])
    expect(out[0].reportsTo).toBe('orchestrator')
    expect(out[1].reportsTo).toBe('orchestrator')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/advisor.test.ts -t briefTeamToSpawnedMembers`
Expected: FAIL — `briefTeamToSpawnedMembers` does not exist.

- [ ] **Step 3: Implement** — in `src/shared/advisor.ts`:

Add the import of `SpawnedMember`:
```ts
import type { ProjectSettings, SpawnedMember } from './types'
```
Widen the member type:
```ts
export interface AdvisorBriefTeamMember {
  name: string
  kind: 'director' | 'manager' | 'worker'
  role: string
  reportsTo?: string
}
```
Update the brief-field description line in `advisorSystemPrompt` (`:58`) so the Advisor knows the shape (this changes the prompt string — update any exact-string assertion in `advisor.test.ts`):
```ts
    'Include ONE fenced code block labelled `brief` containing JSON with any of these optional fields: `goal` (string, a build goal), `summary` (string), `stack` (string[]), `settings` (object of cost/efficiency knobs only), `backendPresetId` (string), `team` ({name,kind,role,reportsTo?}[] — kind is director|manager|worker; reportsTo is another member\'s name or "orchestrator", so you can propose an orchestrator→director→manager→worker hierarchy for a large goal). Keep your normal prose OUTSIDE the block. The app renders the brief as buttons the user confirms — never assume it was applied. Never put secrets (API keys, tokens) anywhere.',
```
Add the mapper (pure) at the end of the file:
```ts
/** Map an Advisor brief team to SpawnedMember[] for applySpawnedTeam: temp ids, name→id reportsTo,
 *  anything unresolved (missing / literal "orchestrator" / unknown name) → "orchestrator". */
export function briefTeamToSpawnedMembers(team: AdvisorBriefTeamMember[]): SpawnedMember[] {
  const idByName = new Map<string, string>()
  const withIds = team.map((m, i) => {
    const id = `b${i + 1}`
    idByName.set(m.name.trim(), id)
    return { m, id }
  })
  return withIds.map(({ m, id }) => {
    const raw = (m.reportsTo ?? '').trim()
    const reportsTo =
      !raw || raw.toLowerCase() === 'orchestrator' ? 'orchestrator' : idByName.get(raw) ?? 'orchestrator'
    return { id, name: m.name.trim(), kind: m.kind, role: m.role, reportsTo }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/advisor.test.ts && npm run typecheck`
Expected: PASS (update the brief-field string assertion if the existing test checked it verbatim).

- [ ] **Step 5: Commit**

```bash
git add src/shared/advisor.ts src/shared/advisor.test.ts
git commit -m "feat(large-team): Advisor brief gains director + reportsTo + briefTeamToSpawnedMembers"
```

---

### Task 9: Advisor build-team wiring (renderer)

"Send to team builder" now builds the proposed team (confirm-gated via the existing `TeamSpawnModal`) when the brief carries a `team`, in addition to seeding the goal.

**Files:**
- Modify: `src/renderer/AdvisorModal.tsx` (`sendToBuilder` `:64`, the button condition `:107`, imports, a `TeamSpawnModal` render)

**Interfaces:**
- Consumes: `briefTeamToSpawnedMembers` (Task 8); `TeamSpawnModal` (`members`, `orchestratorId`, `onClose`); store `graph`, `notify`, `seedGoal`, `setOpen`.

- [ ] **Step 1: Write the change** (renderer — no unit test; gated by typecheck/lint/build + smoke). In `src/renderer/AdvisorModal.tsx`:

Add imports:
```ts
import TeamSpawnModal from './TeamSpawnModal'
import { parseBrief, applyableSettings, briefTeamToSpawnedMembers, type AdvisorBrief } from '../shared/advisor'
import type { SpawnedMember } from '../shared/types'
```
Add store + local state near the other hooks:
```ts
  const graph = useStore((s) => s.graph)
  const [spawn, setSpawn] = useState<{ members: SpawnedMember[]; orchestratorId: string } | null>(null)
```
Replace `sendToBuilder`:
```ts
  const sendToBuilder = (brief: AdvisorBrief): void => {
    if (brief.team && brief.team.length) {
      const orch = graph?.nodes.find((n) => n.kind === 'orchestrator')
      if (!orch) {
        notify({ kind: 'error', message: 'Add an Orchestrator first — then the Advisor can build a team.' })
        return
      }
      setSpawn({ members: briefTeamToSpawnedMembers(brief.team), orchestratorId: orch.id })
      if (brief.goal) seedGoal(brief.goal)
      return
    }
    if (!brief.goal) return
    seedGoal(brief.goal)
    setOpen(false)
  }
```
Widen the button condition `:107` so a team-only brief still shows it:
```tsx
                    {(m.brief.goal || (m.brief.team && m.brief.team.length > 0)) && <button className="btn primary" onClick={() => sendToBuilder(m.brief!)}>Send to team builder</button>}
```
Render the modal (just before the closing `</>` that wraps the outer fragment, alongside the `showBackends` render at `:140`):
```tsx
    {spawn && <TeamSpawnModal members={spawn.members} orchestratorId={spawn.orchestratorId} onClose={() => setSpawn(null)} />}
```

- [ ] **Step 2: Verify build gates**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/AdvisorModal.tsx
git commit -m "feat(large-team): Advisor Send-to-team-builder builds the proposed team (confirm-gated)"
```

> **On-device smoke (defer):** ask the Advisor for a large build; it returns a `brief` with a `team`; "Send to team builder" opens the TeamSpawn preview (director indented above managers), Apply creates the hierarchy, and the goal is seeded into the GoalBar.

---

### Task 10: `duplicateAgent` core (main + IPC + preload + RendererApi)

Adds atomic node duplication (copying role.md + config + parent edge) with a pure name-generation helper.

**Files:**
- Modify: `src/shared/team-scale.ts` (add `duplicateNames`)
- Modify: `src/shared/team-scale.test.ts` (add cases)
- Modify: `src/main/engine/project-store.ts` (new `duplicateAgent`)
- Modify: `src/shared/types.ts` (`IPC.duplicateAgent` `:576`ish; `RendererApi.duplicateAgent` `:654`ish)
- Modify: `src/main/ipc.ts` (handler `:58`ish)
- Modify: `src/preload/index.ts` (`:26`ish)

**Interfaces:**
- Produces: `duplicateNames(baseName, count, takenNames?): string[]`; `duplicateAgent(sourceId, count, opts?: { model?: string }): Promise<ProjectGraph>`; `RendererApi.duplicateAgent(input: { sourceId: string; count: number; model?: string }): Promise<ProjectGraph>`.

- [ ] **Step 1: Write the failing test** — add to `src/shared/team-scale.test.ts`:

```ts
import { duplicateNames } from './team-scale'

describe('duplicateNames', () => {
  it('numbers clones from 2, skipping taken names', () => {
    expect(duplicateNames('Frontend Worker', 3, ['Frontend Worker'])).toEqual([
      'Frontend Worker 2', 'Frontend Worker 3', 'Frontend Worker 4'
    ])
  })
  it('strips an existing trailing number so a clone of "Worker 2" is not "Worker 2 2"', () => {
    expect(duplicateNames('Worker 2', 2, ['Worker', 'Worker 2'])).toEqual(['Worker 3', 'Worker 4'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/team-scale.test.ts -t duplicateNames`
Expected: FAIL — `duplicateNames` does not exist.

- [ ] **Step 3: Implement**

In `src/shared/team-scale.ts`:
```ts
/** Unique display names for N clones of a base name: "<base> 2", "<base> 3", … skipping taken names.
 *  A trailing " <number>" on the base is stripped first so cloning "Worker 2" yields "Worker 3", not "Worker 2 2". */
export function duplicateNames(baseName: string, count: number, takenNames: string[] = []): string[] {
  const taken = new Set(takenNames)
  const base = baseName.replace(/\s+\d+$/, '').trim() || baseName
  const out: string[] = []
  let n = 2
  while (out.length < count) {
    const name = `${base} ${n}`
    if (!taken.has(name)) {
      out.push(name)
      taken.add(name)
    }
    n++
  }
  return out
}
```

In `src/main/engine/project-store.ts`, add after `createAgent` (import `duplicateNames` from `../../shared/team-scale`; `commitTeamAdditions`, `parentOf`, `readRole`, `memoryTemplate`, `iconForName`, `uniqueSlug`, `slugify`, `randomUUID`, `aimPath`, `AGENTS_DIR` are all already in-module):
```ts
export async function duplicateAgent(
  sourceId: string,
  count: number,
  opts?: { model?: string }
): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const src = graph.nodes.find((n) => n.id === sourceId)
  if (!src) throw new Error(`Unknown agent: ${sourceId}`)
  const n = Math.max(1, Math.min(count, 100))
  const srcRole = await readRole(sourceId)
  const parent = parentOf(sourceId)
  const takenSlugs = new Set(graph.nodes.map((x) => x.slug))
  const names = duplicateNames(src.name, n, graph.nodes.map((x) => x.name))
  const writes: { dir: string; role: string; memory: string }[] = []
  const newNodes: AgentNodeData[] = []
  const newEdges: GraphEdge[] = []
  names.forEach((name, i) => {
    const id = randomUUID()
    const slug = uniqueSlug(slugify(name), takenSlugs)
    takenSlugs.add(slug)
    writes.push({ dir: aimPath(path, AGENTS_DIR, slug), role: srcRole, memory: memoryTemplate(name) })
    const node: AgentNodeData = {
      id,
      name,
      slug,
      kind: src.kind,
      icon: iconForName(name, src.kind),
      model: opts?.model ?? src.model,
      permissionMode: src.permissionMode,
      position: { x: src.position.x + (i + 1) * 40, y: src.position.y + (i + 1) * 40 }
    }
    if (src.skills && src.skills.length) node.skills = [...src.skills]
    if (src.backendId) node.backendId = src.backendId
    newNodes.push(node)
    if (parent) newEdges.push({ id: `${parent.id}->${id}`, source: parent.id, target: id })
  })
  return commitTeamAdditions(graph, writes, newNodes, newEdges)
}
```

In `src/shared/types.ts`: add to the `IPC` const (near `createAgent: 'agent:create'` `:576`):
```ts
  duplicateAgent: 'agent:duplicate',
```
and to the `RendererApi` interface (near `createAgent` `:654`):
```ts
  duplicateAgent: (input: { sourceId: string; count: number; model?: string }) => Promise<ProjectGraph>
```

In `src/main/ipc.ts` (after the `createAgent` handler `:58`):
```ts
  ipcMain.handle(IPC.duplicateAgent, (_e, input: { sourceId: string; count: number; model?: string }) =>
    store.duplicateAgent(input.sourceId, input.count, { model: input.model })
  )
```

In `src/preload/index.ts` (after `createAgent` `:26`):
```ts
  duplicateAgent: (input) => ipcRenderer.invoke(IPC.duplicateAgent, input),
```

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `npx vitest run src/shared/team-scale.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/team-scale.ts src/shared/team-scale.test.ts src/main/engine/project-store.ts src/shared/types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat(large-team): duplicateAgent core + IPC/preload/RendererApi + duplicateNames"
```

---

### Task 11: Add-count + Duplicate ×N UI (renderer)

Wires both bulk-create entry points. Renderer-only — gated by typecheck/lint/build + smoke.

**Files:**
- Modify: `src/renderer/App.tsx` (`AddAgentModal` `:503`)
- Modify: `src/renderer/panels/AgentConfigPanel.tsx` (add a Duplicate control near the Delete button `:127`)

**Interfaces:**
- Consumes: `window.api.createAgent`, `window.api.duplicateAgent`, `clampBulk`, store `graph.settings`.

- [ ] **Step 1: Implement AddAgentModal count** — in `src/renderer/App.tsx`, inside `AddAgentModal`:

Add near the existing state and import `clampBulk` + `useStore`:
```ts
  const settings = useStore((s) => s.graph?.settings)
  const [count, setCount] = useState(1)
```
Replace `create`:
```ts
  const create = async (): Promise<void> => {
    if (!name.trim()) return
    const n = clampBulk(count)
    const model = settings?.largeTeamMode ? settings.cheapModelTier : undefined
    let g: ProjectGraph | null = null
    for (let i = 0; i < n; i++) {
      const nm = i === 0 ? name.trim() : `${name.trim()} ${i + 1}`
      g = await window.api.createAgent({ name: nm, kind, model })
    }
    if (g) onCreated(g)
    onClose()
  }
```
Add a count field after the "Role in the chain" field (before `</div>` of `.modal-body`):
```tsx
          <div className="field">
            <label>How many</label>
            <input
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(e) => setCount(clampBulk(Number(e.target.value)))}
            />
          </div>
```
(Ensure `clampBulk` is imported from `../shared/team-scale` and `useStore` from `./store` at the top of App.tsx — both likely already imported; add if missing.)

- [ ] **Step 2: Implement Duplicate ×N** — in `src/renderer/panels/AgentConfigPanel.tsx`:

Import `clampBulk` from `../../shared/team-scale` and `Copy` from `lucide-react`. Add state + handler after `remove`:
```ts
  const settings = graph?.settings
  const [dupCount, setDupCount] = useState(1)
  const [dupModel, setDupModel] = useState<string>('')
  const duplicate = async (): Promise<void> => {
    const model = settings?.largeTeamMode ? (dupModel || settings.cheapModelTier) : undefined
    setGraph(await window.api.duplicateAgent({ sourceId: agent.id, count: clampBulk(dupCount), model }))
  }
```
Add a Duplicate row just above the Delete button (`:127`):
```tsx
      <div className="field">
        <label>Duplicate</label>
        <div className="gated-control">
          <input
            type="number"
            min={1}
            max={100}
            value={dupCount}
            title="How many copies"
            onChange={(e) => setDupCount(clampBulk(Number(e.target.value)))}
          />
          {settings?.largeTeamMode && (
            <select value={dupModel} onChange={(e) => setDupModel(e.target.value)} title="Model for the copies">
              <option value="">Cheap tier ({settings.cheapModelTier})</option>
              {MODELS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
            </select>
          )}
          <button className="btn" onClick={() => void duplicate()}>
            <Copy size={13} /> Duplicate ×{clampBulk(dupCount)}
          </button>
        </div>
      </div>
```
(`MODELS` is already imported in this file.)

- [ ] **Step 3: Verify build gates**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx src/renderer/panels/AgentConfigPanel.tsx
git commit -m "feat(large-team): Add-agent count field + Duplicate ×N control"
```

> **On-device smoke (defer):** Add with count 3 → three distinctly-named agents; Duplicate a configured worker ×2 → clones copy role/model/skills/backend and share its parent edge; in largeTeamMode the model defaults to the cheap tier and is overridable.

---

### Task 12: Pre-run heads-up (GoalBar)

A display-only team-size + cost caption near the Run button, derived purely from the graph.

**Files:**
- Modify: `src/shared/team-scale.ts` (add `teamSizeCaption`)
- Modify: `src/shared/team-scale.test.ts` (add cases)
- Modify: `src/renderer/run/GoalBar.tsx` (render the caption)

**Interfaces:**
- Produces: `teamSizeCaption(nodes: { kind: string }[], cap: number): string`.

- [ ] **Step 1: Write the failing test** — add to `src/shared/team-scale.test.ts`:

```ts
import { teamSizeCaption } from './team-scale'

describe('teamSizeCaption', () => {
  it('summarizes counts and concurrency', () => {
    const cap = teamSizeCaption(
      [{ kind: 'orchestrator' }, { kind: 'director' }, { kind: 'manager' }, { kind: 'worker' }, { kind: 'worker' }],
      6
    )
    expect(cap).toContain('5 agents')
    expect(cap).toContain('1 director')
    expect(cap).toContain('2 workers')
    expect(cap).toContain('concurrency 6')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/team-scale.test.ts -t teamSizeCaption`
Expected: FAIL — `teamSizeCaption` does not exist.

- [ ] **Step 3: Implement**

In `src/shared/team-scale.ts`:
```ts
/** A plain-English team-size + concurrency caption for the pre-run heads-up. */
export function teamSizeCaption(nodes: { kind: string }[], cap: number): string {
  const c: Record<string, number> = { orchestrator: 0, director: 0, manager: 0, worker: 0 }
  for (const n of nodes) c[n.kind] = (c[n.kind] ?? 0) + 1
  const parts: string[] = []
  if (c.director) parts.push(`${c.director} director${c.director > 1 ? 's' : ''}`)
  if (c.manager) parts.push(`${c.manager} manager${c.manager > 1 ? 's' : ''}`)
  if (c.worker) parts.push(`${c.worker} worker${c.worker > 1 ? 's' : ''}`)
  const breakdown = parts.length ? ` (${parts.join(' · ')})` : ''
  return `${nodes.length} agents${breakdown} · concurrency ${cap} · large teams cost more and run longer — cheap-model workers recommended.`
}
```

In `src/renderer/run/GoalBar.tsx`: import the helpers and render the caption when large or in large-team mode. Add imports:
```ts
import { parallelCap, teamSizeCaption } from '../../shared/team-scale'
```
Compute near the other derived values (after `hasSpecialists` `:55`):
```ts
  const nodes = graph?.nodes ?? []
  const showHeadsUp = !!graph && (graph.settings.largeTeamMode || nodes.length >= 8)
```
Render a line just below the `.goal-tools` span (before the Run/Stop buttons block `:177`):
```tsx
      {showHeadsUp && (
        <span className="goal-target" title="Team size and concurrency for this run">
          {teamSizeCaption(nodes, parallelCap(graph!.settings))}
        </span>
      )}
```
(Reuses the existing `.goal-target` muted style — no new CSS.)

- [ ] **Step 4: Run tests + gates to verify green**

Run: `npx vitest run src/shared/team-scale.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/team-scale.ts src/shared/team-scale.test.ts src/renderer/run/GoalBar.tsx
git commit -m "feat(large-team): pre-run team-size + cost heads-up in the GoalBar"
```

> **On-device smoke (defer):** with largeTeamMode on (or ≥8 agents), the GoalBar shows "N agents (…) · concurrency N · …"; hidden for a small team with the mode off.

---

## Final verification (controller, after all tasks)

- [ ] `npm run typecheck` — clean
- [ ] `npm run test` — all green (expect ~+ new tests across types/context-files/team-scale/team-spawn/role-draft/advisor/nodes/project-store)
- [ ] `npm run lint` — 0 errors
- [ ] `npm run build` — succeeds
- [ ] **Byte-for-byte checklist** (spec §13): with `largeTeamMode` off + no director node — `spawnTeamPrompt`/`draftRolesPrompt`/`planPrompt` string-equality tests green; `parallelCap` returns 3; `hasManagers`/`reviewerIdsOf`/routing identical (flat + two-tier fixtures green); Advisor with no `brief.team` seeds-goal-only; no token/baseUrl leak added.
- [ ] **On-device smoke** (required for renderer): director node visuals (Task 2); Large Team settings + numbers (Task 4); Advisor build-team (Task 9); Add-count + Duplicate ×N (Task 11); pre-run heads-up (Task 12).

## Notes on decomposition / DRY / YAGNI

- All pure helpers live in `src/shared/team-scale.ts` (concurrency, clamps, duplicate names, size caption) — one focused module, unit-tested without fs/DOM.
- The director tier rides the existing kind-agnostic routing; the only engine logic change is the two review predicates (Task 3). No new graph node, no recursive planning (deferred per spec §12).
- The C→D build path reuses `TeamSpawnModal` + `applySpawnedTeam` rather than a new commit path.
- Deferred (spec §12): recursive/hierarchical planning; canvas auto-layout width cap for very wide worker rows.
