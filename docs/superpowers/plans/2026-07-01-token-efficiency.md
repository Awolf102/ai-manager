# Token Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new opt-in "Token Efficiency" Settings section with four independent levers (concise output, effort thrift, cheap-model workers, lighter internal prompts) that reduce token spend during headless runs.

**Architecture:** Each lever is a `ProjectSettings` field defaulting off/neutral, guarded so all-off is byte-for-byte identical to today. Levers attach at existing seams: the system-prompt append in `agent-runner.ts`, the effort pipeline (`assignStep` + dispatch) and worker dispatch in `nodes.ts`, and the scaffolding-prompt builders in `nodes.ts`. All new logic lives in small pure functions (a new `shared/token-efficiency.ts` + exported helpers in `nodes.ts`) that are unit-tested directly; the wiring is verified by typecheck/build/lint and an on-device Settings smoke.

**Tech Stack:** TypeScript, Electron (electron-vite), React 19, `@anthropic-ai/claude-agent-sdk`, Vitest.

## Global Constraints

- **Off = byte-for-byte.** With all four levers off/neutral, `composeAppend`, the effort pipeline output, the dispatched worker model, and every scaffolding prompt string must be identical to today. Each lever guards on its own flag.
- **No `output_config` guarantee.** The engine drives the `claude` CLI; "code-only" is a soft system-prompt instruction, not schema-enforced.
- **Scope: headless runs only.** Interactive PTY sessions are untouched.
- **Design system:** the new Settings section consumes existing tokens + the `Switch` primitive + the two-pane Settings pattern; no new colors/materials/motion. Emerald stays a signal color (Switch "on").
- **Model IDs:** `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` (from `shared/types.ts` `MODELS`). Haiku has no effort parameter.
- **Gates:** implementers run `npm run typecheck` + `npm run test`; controller runs `npm run build` + `npm run lint` (renderer touched) at the integration gate; user runs the on-device Settings smoke.
- **Commit style:** end commit messages with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Work on branch `feat/token-efficiency`.

---

### Task 1: Settings schema — `ProjectSettings` fields + defaults

**Files:**
- Modify: `src/shared/types.ts` (add fields to `ProjectSettings` interface + `DEFAULT_SETTINGS`)
- Test: `src/shared/types.test.ts` (create)

**Interfaces:**
- Produces: six new `ProjectSettings` fields — `outputMode: 'normal' | 'terse' | 'code-only'`, `effortThrift: boolean`, `effortThriftCeiling: Effort`, `cheapModelWorkers: boolean`, `cheapModelTier: string`, `lightPrompts: boolean`. `DEFAULT_SETTINGS` sets them to `'normal'`, `false`, `'medium'`, `false`, `'claude-haiku-4-5'`, `false` respectively.

- [ ] **Step 1: Write the failing test**

Create `src/shared/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from './types'

describe('DEFAULT_SETTINGS token-efficiency fields', () => {
  it('defaults every token-efficiency lever to off/neutral', () => {
    expect(DEFAULT_SETTINGS.outputMode).toBe('normal')
    expect(DEFAULT_SETTINGS.effortThrift).toBe(false)
    expect(DEFAULT_SETTINGS.effortThriftCeiling).toBe('medium')
    expect(DEFAULT_SETTINGS.cheapModelWorkers).toBe(false)
    expect(DEFAULT_SETTINGS.cheapModelTier).toBe('claude-haiku-4-5')
    expect(DEFAULT_SETTINGS.lightPrompts).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/types.test.ts`
Expected: FAIL (properties undefined / not on `DEFAULT_SETTINGS`; likely also a TS error).

- [ ] **Step 3: Add the fields to the interface**

In `src/shared/types.ts`, inside `interface ProjectSettings` (after the existing `maxUserRequests` field, before the closing `}`), add:

```ts
  /** system-prompt output mode for every headless agent: 'normal' = no change */
  outputMode: 'normal' | 'terse' | 'code-only'
  /** cap every acting task's effort down to `effortThriftCeiling` (forces effort even when adaptiveEffort is off) */
  effortThrift: boolean
  /** the ceiling used when effortThrift is on */
  effortThriftCeiling: Effort
  /** run all WORKER dispatches on `cheapModelTier` (managers/orchestrator unaffected) */
  cheapModelWorkers: boolean
  /** the model workers run on when cheapModelWorkers is on */
  cheapModelTier: string
  /** use trimmed variants of the app's internal scaffolding prompts */
  lightPrompts: boolean
```

- [ ] **Step 4: Add the defaults**

In `src/shared/types.ts`, inside `DEFAULT_SETTINGS` (after `maxUserRequests: 0`), add:

```ts
  outputMode: 'normal',
  effortThrift: false,
  effortThriftCeiling: 'medium',
  cheapModelWorkers: false,
  cheapModelTier: 'claude-haiku-4-5',
  lightPrompts: false
```

(Ensure the preceding `maxUserRequests: 0` line ends with a comma.)

- [ ] **Step 5: Run test + typecheck to verify pass**

Run: `npx vitest run src/shared/types.test.ts && npm run typecheck`
Expected: test PASS, typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/types.test.ts
git commit -m "feat(token-efficiency): add ProjectSettings fields + defaults

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure module `shared/token-efficiency.ts`

**Files:**
- Create: `src/shared/token-efficiency.ts`
- Test: `src/shared/token-efficiency.test.ts` (create)

**Interfaces:**
- Consumes: `Effort`, `EFFORT_LEVELS` from `./types`.
- Produces:
  - `type OutputMode = 'normal' | 'terse' | 'code-only'`
  - `outputModeInstruction(mode: OutputMode): string` — `''` for `'normal'`; a non-empty append (leading `\n\n`) for the others that instructs minimal prose **but explicitly exempts required code/structured/JSON blocks**.
  - `capEffort(effort: Effort | undefined, ceiling: Effort): Effort | undefined` — pure min-by-level; `undefined` in → `undefined` out.

- [ ] **Step 1: Write the failing test**

Create `src/shared/token-efficiency.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { outputModeInstruction, capEffort } from './token-efficiency'

describe('outputModeInstruction', () => {
  it('returns empty string for normal (byte-for-byte when off)', () => {
    expect(outputModeInstruction('normal')).toBe('')
  })
  it('terse and code-only return non-empty instructions', () => {
    expect(outputModeInstruction('terse').length).toBeGreaterThan(0)
    expect(outputModeInstruction('code-only').length).toBeGreaterThan(0)
  })
  it('both non-normal modes exempt required structured/JSON output', () => {
    for (const m of ['terse', 'code-only'] as const) {
      expect(outputModeInstruction(m).toLowerCase()).toContain('json')
    }
  })
})

describe('capEffort', () => {
  it('caps a higher effort down to the ceiling', () => {
    expect(capEffort('max', 'medium')).toBe('medium')
    expect(capEffort('xhigh', 'high')).toBe('high')
  })
  it('leaves an effort at or below the ceiling unchanged', () => {
    expect(capEffort('low', 'medium')).toBe('low')
    expect(capEffort('medium', 'medium')).toBe('medium')
  })
  it('undefined in -> undefined out', () => {
    expect(capEffort(undefined, 'medium')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/token-efficiency.test.ts`
Expected: FAIL ("Cannot find module './token-efficiency'").

- [ ] **Step 3: Write the module**

Create `src/shared/token-efficiency.ts`:

```ts
// Pure token-efficiency helpers. No node/DOM/engine imports — unit-tested in
// plain Node like shared/model-caps.ts. Off/neutral inputs return no-op values
// so the whole feature is byte-for-byte identical when disabled.
import type { Effort } from './types'
import { EFFORT_LEVELS } from './types'

export type OutputMode = 'normal' | 'terse' | 'code-only'

/** A system-prompt append that biases the agent toward fewer output tokens.
 *  '' for 'normal' (byte-for-byte). Non-normal modes always exempt any code or
 *  required structured/JSON block so routing/review/plan steps still work. */
export function outputModeInstruction(mode: OutputMode): string {
  if (mode === 'terse') {
    return (
      '\n\n## Output mode: terse\n' +
      'Keep prose to a minimum. No preamble, no restating the task, no narration of ' +
      'what you are about to do, no closing summary beyond one line. Give only the ' +
      'essential result. This does NOT apply to code or to any structured/JSON block ' +
      'you were asked to produce — always output those in full.'
    )
  }
  if (mode === 'code-only') {
    return (
      '\n\n## Output mode: code only\n' +
      'Output only code and essential results — file edits, commands, and the minimal ' +
      'text needed to be understood. Omit explanations, narration, and summaries unless ' +
      'explicitly asked. Any code block or required structured/JSON reply must still be ' +
      'produced in full.'
    )
  }
  return ''
}

/** Cap an effort DOWN to `ceiling` (pure min by level). undefined in -> undefined out. */
export function capEffort(effort: Effort | undefined, ceiling: Effort): Effort | undefined {
  if (!effort) return undefined
  return EFFORT_LEVELS.indexOf(effort) <= EFFORT_LEVELS.indexOf(ceiling) ? effort : ceiling
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/token-efficiency.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/shared/token-efficiency.ts src/shared/token-efficiency.test.ts
git commit -m "feat(token-efficiency): pure outputModeInstruction + capEffort

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire concise output + `modelOverride` into `agent-runner.ts`

**Files:**
- Modify: `src/main/engine/agent-runner.ts` (`StreamAgentOptions` interface ~line 64; the `options.model` + `systemPrompt.append` assembly ~lines 108–117)

**Interfaces:**
- Consumes: `outputModeInstruction`, `OutputMode` from `../../shared/token-efficiency`; `getSettings()` (already imported); `agent.model`.
- Produces: `StreamAgentOptions.modelOverride?: string`. `streamAgent` uses `opts.modelOverride ?? agent.model` for the SDK `options.model` and the header line, and appends `outputModeInstruction(getSettings().outputMode)` to the system-prompt `append`. When `outputMode` is `'normal'` and `modelOverride` is undefined, the assembled options are identical to today.

> No unit test: `streamAgent` dynamically imports the SDK and is not unit-tested in this codebase (consistent with run-narration/skills-pack wiring). Correctness rests on Task 2's pure tests (`'normal' → ''`), typecheck, and the on-device smoke. Verify the diff by reading.

- [ ] **Step 1: Add the import**

At the top of `src/main/engine/agent-runner.ts`, near the other `../../shared/...` imports, add:

```ts
import { outputModeInstruction } from '../../shared/token-efficiency'
```

- [ ] **Step 2: Add `modelOverride` to `StreamAgentOptions`**

In the `StreamAgentOptions` interface, add (near the other optional fields, e.g. after `effort?: Effort`):

```ts
  /** run this call on a different model than the agent's configured one (e.g. cheap-model workers); transient, never persisted */
  modelOverride?: string
```

- [ ] **Step 3: Use `modelOverride` for the model + header**

In `streamAgent`, the header line currently reads:

```ts
    if (opts.header !== false) {
      send('system', `\x1b[2m▶ ${agent.name} · ${agent.model}\x1b[0m\r\n`)
    }
```

Change `${agent.model}` to `${opts.modelOverride ?? agent.model}`.

In the `const options: Options = { ... }` block, change:

```ts
      model: agent.model,
```

to:

```ts
      model: opts.modelOverride ?? agent.model,
```

- [ ] **Step 4: Append the output-mode instruction**

In the same `options` object, change the `systemPrompt` line:

```ts
      systemPrompt: { type: 'preset', preset: 'claude_code', append: composeAppend(role, memory, context, folders) + headlessNote(pack.names) },
```

to:

```ts
      systemPrompt: { type: 'preset', preset: 'claude_code', append: composeAppend(role, memory, context, folders) + headlessNote(pack.names) + outputModeInstruction(getSettings().outputMode) },
```

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS. (No test to run for this file.)

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/agent-runner.ts
git commit -m "feat(token-efficiency): append output-mode instruction + modelOverride at the SDK boundary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Effort thrift in `nodes.ts`

**Files:**
- Modify: `src/main/engine/nodes.ts` (add import + exported `assignEffort`; rewrite `assignStep` effort line ~789–790; dispatch gates at ~316 and ~561)
- Test: `src/main/engine/nodes.test.ts` (append an `assignEffort` describe block)

**Interfaces:**
- Consumes: `effortForModel` (already in this file), `clampEffort` (already imported from `./model-caps`), `capEffort` (from `../../shared/token-efficiency`).
- Produces: `export function assignEffort(args: { model: string | undefined; requested: Effort | undefined; adaptive: boolean; thrift: boolean; ceiling: Effort }): Effort | undefined`.

- [ ] **Step 1: Write the failing test**

Append to `src/main/engine/nodes.test.ts` (add `assignEffort` to the existing import from `./nodes` at the top of the file, then add this block at the end):

```ts
describe('assignEffort (thrift)', () => {
  it('off (thrift=false) matches effortForModel: adaptive on, model clamp only', () => {
    // Sonnet has no xhigh -> effortForModel rounds up to max
    expect(assignEffort({ model: 'claude-sonnet-4-6', requested: 'xhigh', adaptive: true, thrift: false, ceiling: 'medium' })).toBe('max')
  })
  it('off + adaptive off returns the request unchanged (as today)', () => {
    expect(assignEffort({ model: 'claude-opus-4-8', requested: 'max', adaptive: false, thrift: false, ceiling: 'medium' })).toBe('max')
  })
  it('thrift caps down to the ceiling (adaptive on)', () => {
    expect(assignEffort({ model: 'claude-opus-4-8', requested: 'max', adaptive: true, thrift: true, ceiling: 'medium' })).toBe('medium')
  })
  it('thrift forces the ceiling even when adaptive is off', () => {
    expect(assignEffort({ model: 'claude-opus-4-8', requested: undefined, adaptive: false, thrift: true, ceiling: 'low' })).toBe('low')
  })
  it('thrift result is clamped to the model (Haiku -> undefined)', () => {
    expect(assignEffort({ model: 'claude-haiku-4-5', requested: 'high', adaptive: true, thrift: true, ceiling: 'high' })).toBeUndefined()
  })
  it('no model (unassigned task): thrift is skipped, request passes through', () => {
    expect(assignEffort({ model: undefined, requested: 'high', adaptive: true, thrift: true, ceiling: 'low' })).toBe('high')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/engine/nodes.test.ts -t assignEffort`
Expected: FAIL ("assignEffort is not exported" / undefined).

- [ ] **Step 3: Add the import + the exported helper**

In `src/main/engine/nodes.ts`, change the model-caps import (line ~42) from:

```ts
import { clampEffort } from '../../shared/model-caps'
```

to:

```ts
import { clampEffort } from '../../shared/model-caps'
import { capEffort } from '../../shared/token-efficiency'
```

Add the exported helper next to `effortForModel` (after the `effortForModel` function, ~line 1185):

```ts
/** The final per-assignment effort: model-clamp the router's requested effort,
 *  then (when thrift is on and a worker/model is known) cap it DOWN to the
 *  ceiling — clamped back to what the model supports. Thrift forces an effort
 *  even when adaptive routing is off. thrift off => identical to effortForModel. */
export function assignEffort(args: {
  model: string | undefined
  requested: Effort | undefined
  adaptive: boolean
  thrift: boolean
  ceiling: Effort
}): Effort | undefined {
  let effort = effortForModel(args.model, args.requested, args.adaptive)
  if (args.thrift && args.model) {
    const base = effort ?? args.requested ?? args.ceiling
    effort = clampEffort(args.model, capEffort(base, args.ceiling))
  }
  return effort
}
```

- [ ] **Step 4: Wire `assignStep` to use it**

In `assignStep`, replace (lines ~789–790):

```ts
    const requested = parseEffort(a.effort)
    const effort = effortForModel(model, requested, getSettings().adaptiveEffort)
```

with:

```ts
    const requested = parseEffort(a.effort)
    const s = getSettings()
    const effort = assignEffort({ model, requested, adaptive: s.adaptiveEffort, thrift: s.effortThrift, ceiling: s.effortThriftCeiling })
```

(The following line `if (requested && effort && requested !== effort) out.assignedEffort = requested` is unchanged — it now correctly records the pre-thrift request as the "capped from" badge value.)

- [ ] **Step 5: Honor thrift at the two dispatch sites**

In `executeNode`'s `runGroup` (line ~316), replace:

```ts
    const effort = getSettings().adaptiveEffort ? maxEffort(group.map((t) => t.effort)) : undefined
```

with:

```ts
    const es = getSettings()
    const effort = es.adaptiveEffort || es.effortThrift ? maxEffort(group.map((t) => t.effort)) : undefined
```

In `repairNode` (line ~561), replace:

```ts
    const effort = getSettings().adaptiveEffort ? t.effort : undefined
```

with:

```ts
    const rs = getSettings()
    const effort = rs.adaptiveEffort || rs.effortThrift ? t.effort : undefined
```

- [ ] **Step 6: Run tests + typecheck to verify pass**

Run: `npx vitest run src/main/engine/nodes.test.ts -t assignEffort && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(token-efficiency): effort thrift (cap per-task effort to a ceiling)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Cheap-model workers in `nodes.ts`

**Files:**
- Modify: `src/main/engine/nodes.ts` (add exported `workerModelOverride`; wire into `executeNode` base ~line 318 and `repairNode` opts ~line 563)
- Test: `src/main/engine/nodes.test.ts` (append a `workerModelOverride` describe block)

**Interfaces:**
- Consumes: `ProjectSettings` fields `cheapModelWorkers`, `cheapModelTier`; `StreamAgentOptions.modelOverride` (from Task 3).
- Produces: `export function workerModelOverride(s: { cheapModelWorkers: boolean; cheapModelTier: string }): string | undefined` — the tier when on, else `undefined`.

- [ ] **Step 1: Write the failing test**

Append to `src/main/engine/nodes.test.ts` (add `workerModelOverride` to the `./nodes` import):

```ts
describe('workerModelOverride', () => {
  it('returns the cheap tier when cheapModelWorkers is on', () => {
    expect(workerModelOverride({ cheapModelWorkers: true, cheapModelTier: 'claude-haiku-4-5' })).toBe('claude-haiku-4-5')
  })
  it('returns undefined when off (byte-for-byte dispatch)', () => {
    expect(workerModelOverride({ cheapModelWorkers: false, cheapModelTier: 'claude-haiku-4-5' })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/engine/nodes.test.ts -t workerModelOverride`
Expected: FAIL ("workerModelOverride is not exported").

- [ ] **Step 3: Add the exported helper**

In `src/main/engine/nodes.ts`, next to `assignEffort` (from Task 4), add:

```ts
/** The model override to dispatch WORKER steps on when cheap-model-workers is on
 *  (managers/orchestrator never get an override). undefined => byte-for-byte. */
export function workerModelOverride(s: { cheapModelWorkers: boolean; cheapModelTier: string }): string | undefined {
  return s.cheapModelWorkers ? s.cheapModelTier : undefined
}
```

- [ ] **Step 4: Wire into `executeNode`**

In `executeNode`'s `runGroup`, the `base: StreamAgentOptions = { ... }` object (starts ~line 318) currently ends with `abort: eng.abort`. Add a `modelOverride` field. Change:

```ts
      const base: StreamAgentOptions = {
        wc: eng.wc,
        agentId: ownerId,
        prompt: workerPrompt(state.goal, group.map((t) => t.task)) + (asksAvailable() ? askUserSection() : ''),
        runId: eng.runId,
        stepId: ownerId,
        permissionMode: state.actingMode,
        effort,
        resume: false,
        abort: eng.abort
      }
```

to add the field (reuse the `es` settings object already read in Task 4's step 5, so no extra `getSettings()` call):

```ts
      const base: StreamAgentOptions = {
        wc: eng.wc,
        agentId: ownerId,
        prompt: workerPrompt(state.goal, group.map((t) => t.task)) + (asksAvailable() ? askUserSection() : ''),
        runId: eng.runId,
        stepId: ownerId,
        permissionMode: state.actingMode,
        effort,
        resume: false,
        abort: eng.abort,
        modelOverride: workerModelOverride(es)
      }
```

- [ ] **Step 5: Wire into `repairNode`**

In `repairNode`, the `eng.runAgent({ ... })` call (~line 563) currently ends with `abort: eng.abort`. Add `modelOverride: workerModelOverride(rs)` (reusing the `rs` settings object from Task 4's step 5):

```ts
      const { text, sessionId } = await eng.runAgent({
        wc: eng.wc,
        agentId: ownerId,
        prompt: repairPrompt(state.goal, t.task, t.verdict?.feedback ?? ''),
        runId: eng.runId,
        stepId: ownerId,
        permissionMode: state.actingMode,
        effort,
        resume: true,
        abort: eng.abort,
        modelOverride: workerModelOverride(rs)
      })
```

- [ ] **Step 6: Run tests + typecheck to verify pass**

Run: `npx vitest run src/main/engine/nodes.test.ts -t workerModelOverride && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(token-efficiency): cheap-model workers (override worker dispatch model)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Lighter internal prompts in `nodes.ts`

**Files:**
- Modify: `src/main/engine/nodes.ts` (export + add a `light` param to `assignPrompt` ~line 1310 and `workerPrompt` ~line 1343; pass `getSettings().lightPrompts` at the two call sites ~line 781 and ~line 321)
- Test: `src/main/engine/nodes.test.ts` (append a `lighter prompts` describe block)

**Interfaces:**
- Produces: `export function assignPrompt(tasks: RunTask[], childRoles: ChildBrief[], light?: boolean): string` and `export function workerPrompt(goal: string, tasks: RunTask[], light?: boolean): string`. Default `light = false` returns the exact current strings (byte-for-byte). `ChildBrief` is the existing local type used by `assignPrompt`.

- [ ] **Step 1: Write the failing test**

Append to `src/main/engine/nodes.test.ts` (add `assignPrompt`, `workerPrompt` to the `./nodes` import):

```ts
describe('lighter internal prompts', () => {
  const tasks = [{ id: 't1', title: 'Do a thing', description: 'details' }]
  const roles = [{ id: 'w1', name: 'Worker', kind: 'worker' as const, role: 'does things', lessons: [] as string[] }]

  it('assignPrompt: light=false is unchanged and both keep the JSON block marker', () => {
    const full = assignPrompt(tasks, roles)
    const light = assignPrompt(tasks, roles, true)
    expect(assignPrompt(tasks, roles, false)).toBe(full) // default === explicit false
    expect(full).toContain('```json')
    expect(light).toContain('```json')
    expect(light.length).toBeLessThan(full.length)
    expect(light).not.toBe(full)
  })

  it('workerPrompt: light=false is unchanged; light keeps the goal and is shorter', () => {
    const full = workerPrompt('build X', tasks)
    const light = workerPrompt('build X', tasks, true)
    expect(workerPrompt('build X', tasks, false)).toBe(full)
    expect(light).toContain('build X')
    expect(light.length).toBeLessThan(full.length)
    expect(light).not.toBe(full)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "lighter internal prompts"`
Expected: FAIL ("assignPrompt is not exported" / arity).

- [ ] **Step 3: Export + branch `assignPrompt`**

In `src/main/engine/nodes.ts`, change `function assignPrompt(tasks, childRoles)` (line ~1310) to `export function assignPrompt(tasks: RunTask[], childRoles: ChildBrief[], light = false): string`. Keep the existing `specialists`/`taskList` construction. Then branch the returned string:

```ts
  if (light) {
    return `Route each task to the ONE specialist whose role best fits (prefer relevant track record); childId null if none fit. Also assign an effort level (low|medium|high|xhigh|max) per task by difficulty — reserve xhigh/max for genuinely hard work. Do NOT edit files.

SPECIALISTS:
${specialists}

TASKS:
${taskList}

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "assignments": [ { "taskId": "t1", "childId": "<specialist id, or null>", "effort": "low|medium|high|xhigh|max", "reason": "why" } ] }
\`\`\``
  }
  return `You route planned tasks to the specialists who report to you. For each specialist you can see their role AND their track record (lessons they've recorded from past work). Assign every task to the ONE specialist whose role best matches it — and when more than one role fits, prefer the specialist whose track record shows the most relevant, reliable experience for that task. If no specialist fits a task, set childId to null. Do NOT make changes to files.

For EACH task, also assess its difficulty and assign a reasoning "effort" level for the specialist who will do it:
- low: trivial / boilerplate
- medium: simple, well-defined
- high: normal engineering work (default)
- xhigh: tricky, ambiguous, or wide-reaching
- max: hardest — deep reasoning, subtle correctness, or high stakes
Be economical — reserve xhigh/max for genuinely hard tasks (they cost more).

SPECIALISTS:
${specialists}

TASKS:
${taskList}

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "assignments": [ { "taskId": "t1", "childId": "<specialist id, or null>", "effort": "low|medium|high|xhigh|max", "reason": "why" } ] }
\`\`\``
```

(The non-light branch is the verbatim current string — copy it exactly from the existing function so `light=false` is byte-for-byte.)

- [ ] **Step 4: Export + branch `workerPrompt`**

Change `function workerPrompt(goal, tasks)` (line ~1343) to `export function workerPrompt(goal: string, tasks: RunTask[], light = false): string`. Keep the existing `list` construction. Branch:

```ts
  if (light) {
    return `Team goal: ${goal}

Complete the following task(s) in this project folder, making the necessary changes. Apply any relevant lessons from your memory.

${list}

If your work serves web pages, actually run it and confirm the entry page AND every asset it references return 200 before reporting success. When finished, briefly report what you changed and flag anything you could not complete.`
  }
  return `You are working as part of a team to achieve this overall goal:
${goal}

You have been assigned the following task(s). Complete them in this project folder, making the necessary changes. Apply any relevant lessons from your memory.

${list}

If your work is a web app or anything that serves pages, do not rely on unit tests or "the code looks right" — actually run it and load the entry page: confirm it returns 200 AND every asset it references (CSS, JS, images) also returns 200. A static-path or route mismatch that 404s assets makes the page render as unstyled, broken HTML even when your code is correct. Don't report success until the page renders fully.

When finished, briefly report what you changed and flag anything you could not complete.`
```

(Again, the non-light branch must be the verbatim current string.)

- [ ] **Step 5: Pass the flag at the call sites**

In `assignStep`, the `runStructured(..., assignPrompt(tasks, childRoles), ...)` call (~line 781): change `assignPrompt(tasks, childRoles)` to `assignPrompt(tasks, childRoles, getSettings().lightPrompts)`.

In `executeNode`'s `runGroup`, the `prompt: workerPrompt(state.goal, group.map((t) => t.task)) + ...` line (~line 321): change `workerPrompt(state.goal, group.map((t) => t.task))` to `workerPrompt(state.goal, group.map((t) => t.task), es.lightPrompts)` (reusing the `es` settings object from Task 4).

- [ ] **Step 6: Run tests + typecheck to verify pass**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "lighter internal prompts" && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(token-efficiency): lighter internal prompts (trim assign + worker prompts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: "Token Efficiency" Settings section

**Files:**
- Modify: `src/renderer/SettingsModal.tsx` (new category id, nav entry, and pane)

**Interfaces:**
- Consumes: `ProjectSettings` fields from Task 1; the existing `update(patch)`, `SettingSection`, `SettingRow`, `Switch`. No new IPC — `updateSettings` already accepts `Partial<ProjectSettings>`.

> No unit test (renderer JSX, consistent with the codebase). Verification: `npm run typecheck`, `npm run lint`, `npm run build`, and the user's on-device Settings smoke.

- [ ] **Step 1: Add the category id + nav entry**

In `src/renderer/SettingsModal.tsx`:
- Change `type CategoryId` to include `'efficiency'`:
  ```ts
  type CategoryId = 'safety' | 'cost' | 'efficiency' | 'review' | 'run' | 'team'
  ```
- Add an icon import: change the lucide import line to also import `Gauge`:
  ```ts
  import { AlertTriangle, ClipboardCheck, Coins, Gauge, Shield, Users, Workflow, X, type LucideIcon } from 'lucide-react'
  ```
- Add a `CATEGORIES` entry after the `cost` entry:
  ```ts
  { id: 'efficiency', label: 'Token Efficiency', icon: Gauge, subtitle: 'Opt-in ways to spend fewer tokens per run — all off by default' },
  ```

- [ ] **Step 2: Add the pane**

In the render body, after the `{active === 'cost' && ( ... )}` block and before `{active === 'review' && ...`, add:

```tsx
          {active === 'efficiency' && (
            <SettingSection>
              <SettingRow
                label="Concise output"
                desc={
                  s.outputMode === 'normal'
                    ? 'Agents write normally. Turn on to instruct every agent to minimize prose (required code/JSON is always kept in full).'
                    : s.outputMode === 'terse'
                      ? 'Agents minimize prose — no preamble or summaries, just the essential result.'
                      : 'Agents output only code and essential results, omitting explanations.'
                }
                control={
                  <div className="gated-control">
                    {s.outputMode !== 'normal' && (
                      <select
                        value={s.outputMode}
                        onChange={(e) => void update({ outputMode: e.target.value as ProjectSettings['outputMode'] })}
                      >
                        <option value="terse">Terse</option>
                        <option value="code-only">Code only</option>
                      </select>
                    )}
                    <Switch
                      checked={s.outputMode !== 'normal'}
                      label="Concise output"
                      onChange={(on) => void update({ outputMode: on ? 'terse' : 'normal' })}
                    />
                  </div>
                }
              />
              <SettingRow
                label="Effort thrift"
                desc="Cap every task's reasoning effort at a ceiling. Lower reasoning effort spends fewer thinking tokens — the biggest cost driver. Applies even when Adaptive effort is off."
                control={
                  <div className="gated-control">
                    {s.effortThrift && (
                      <select
                        value={s.effortThriftCeiling}
                        onChange={(e) => void update({ effortThriftCeiling: e.target.value as ProjectSettings['effortThriftCeiling'] })}
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    )}
                    <Switch
                      checked={s.effortThrift}
                      label="Effort thrift"
                      onChange={(v) => void update({ effortThrift: v })}
                    />
                  </div>
                }
              />
              <SettingRow
                label="Cheap-model workers"
                desc="Run all workers on a cheaper model. Managers and the orchestrator keep their own model, so planning, routing, and review quality are unaffected."
                control={
                  <div className="gated-control">
                    {s.cheapModelWorkers && (
                      <select
                        value={s.cheapModelTier}
                        onChange={(e) => void update({ cheapModelTier: e.target.value })}
                      >
                        <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                        <option value="claude-haiku-4-5">Haiku 4.5</option>
                      </select>
                    )}
                    <Switch
                      checked={s.cheapModelWorkers}
                      label="Cheap-model workers"
                      onChange={(v) => void update({ cheapModelWorkers: v })}
                    />
                  </div>
                }
              />
              <SettingRow
                label="Lighter internal prompts"
                desc="Send trimmed versions of the app's own routing and worker instructions — fewer input tokens per step. Slightly less guidance to the agents."
                control={
                  <Switch
                    checked={s.lightPrompts}
                    label="Lighter internal prompts"
                    onChange={(v) => void update({ lightPrompts: v })}
                  />
                }
              />
            </SettingSection>
          )}
```

- [ ] **Step 3: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/SettingsModal.tsx
git commit -m "feat(token-efficiency): Token Efficiency settings section

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Integration gate (controller, after all tasks)

- [ ] `npm run typecheck` — PASS
- [ ] `npm run test` — PASS (full suite; note the known `run-store.test.ts` full-suite isolation flake — re-run in isolation if it trips)
- [ ] `npm run lint` — PASS (renderer touched)
- [ ] `npm run build` — PASS
- [ ] Opus whole-branch review — no Critical/Important
- [ ] User on-device Settings smoke: open Settings → Token Efficiency; toggle each lever; confirm sub-selectors appear/persist; confirm a run with all off behaves as before.

## Self-review notes (spec coverage)

- Concise output → Task 2 (`outputModeInstruction`) + Task 3 (wiring) + Task 7 (UI).
- Effort thrift → Task 2 (`capEffort`) + Task 4 (`assignEffort` + dispatch gates) + Task 7 (UI).
- Cheap-model workers → Task 3 (`modelOverride` field/use) + Task 5 (`workerModelOverride` + dispatch) + Task 7 (UI).
- Lighter internal prompts → Task 6 (`assignPrompt`/`workerPrompt` light variants) + Task 7 (UI).
- Settings schema / off-by-default → Task 1 + per-lever `light=false`/`'normal'`/`false`/`undefined` byte-for-byte tests.
- Design-system fit → Task 7 reuses `Switch`/`SettingSection`/`SettingRow` + `gated-control`; no new tokens.
