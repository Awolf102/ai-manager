# Follow-through (Headless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a worker hits an under-specified feature it infers + builds the real thing (not a placeholder) and records the assumption, which is surfaced in the Run view + History and fed into the orchestrator's final report.

**Architecture:** Opt-in `followThrough: 'off' | 'headless'` setting. In `'headless'`, a system-prompt section tells workers to build-and-record; the engine parses `followup` blocks from worker output, records each as `{workerId, summary, decision}` (mirroring the `handoffs` collector + `follow-up` event + `collectExtras` persistence + `toRunRecord` projection), feeds them into synthesis, and the renderer shows them live + in History. Off = byte-for-byte; the HITL ask/pause runtime is untouched.

**Tech Stack:** TypeScript, Electron (electron-vite), React 19, Vitest.

## Global Constraints

- **Off = byte-for-byte.** With `followThrough: 'off'` (the default), the worker prompt, synthesis input, run record, and run/History views are identical to today, and the HITL ask/pause/resume path is unmodified.
- **Workers during build only.** Follow-through fires only from the worker execute path in `executeNode`'s `runGroup`. Do not touch planning/routing/review/repair prompts or the HITL `ask` path.
- **Cycle 1 of 2.** This is the Headless half. The interactive "Ask me" path (pause + option-button modal + generalized pause runtime) is Cycle 2 — do NOT build it here. The `followThrough` union is `'off' | 'headless'` for now (Cycle 2 widens it to add `'ask'`).
- **Data shapes (exact):** setting `followThrough: 'off' | 'headless'`; record item `{ workerId: string; summary: string; decision: string }`; block `followup` with JSON `{ summary, decision }`; event `{ runId; type: 'follow-up'; workerId; summary; decision }`.
- **Mirror, don't invent:** follow `handoffs`/`userRequests` patterns exactly (collector on `Eng`, `follow-up` event like `handoff`, `collectExtras`, `toRunRecord` spread, RunView map, HistoryView section).
- **Gates:** implementers run `npm run typecheck` + `npm run test`; controller runs `npm run build` + `npm run lint` (renderer touched) at integration; user runs the on-device smoke.
- **Commit trailer:** end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch: `feat/follow-through-headless`.

---

### Task 1: Data types + run-record projection

**Files:**
- Modify: `src/shared/types.ts` (`ProjectSettings` + `DEFAULT_SETTINGS`; `RunState.followUps?`; `RunRecord.followUps?`; `OrchestrationEvent` union)
- Modify: `src/shared/run-state.ts` (`toRunRecord`)
- Test: `src/shared/types.test.ts`, `src/shared/run-state.test.ts` (append)

**Interfaces:**
- Produces: `ProjectSettings.followThrough: 'off' | 'headless'` (default `'off'`); `RunState.followUps?: { workerId: string; summary: string; decision: string }[]`; `RunRecord.followUps?` (same shape); `OrchestrationEvent` variant `{ runId: string; type: 'follow-up'; workerId: string; summary: string; decision: string }`; `toRunRecord` conditionally spreads `followUps`.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/types.test.ts`:

```ts
import { DEFAULT_SETTINGS } from './types'
// (add to existing imports if the file already imports from './types')

describe('follow-through setting', () => {
  it('defaults followThrough to off', () => {
    expect(DEFAULT_SETTINGS.followThrough).toBe('off')
  })
})
```

Append to `src/shared/run-state.test.ts`:

```ts
import type { RunState } from './types'

describe('toRunRecord followUps', () => {
  const base = {
    runId: 'r', goal: 'g', orchestratorId: 'o', startedAt: 't', updatedAt: 't',
    status: 'completed', phase: 'done', cursor: 'done', actingMode: 'auto',
    plan: [], tasks: {}, steps: {}, reviews: [], reflections: [],
    repairAttempts: 0, replanAttempts: 0, replanStageCursor: 0, userRequestCount: 0, final: ''
  } as unknown as RunState

  it('omits followUps when absent', () => {
    expect('followUps' in toRunRecord(base)).toBe(false)
  })
  it('includes followUps when present', () => {
    const fu = [{ workerId: 'w1', summary: 's', decision: 'd' }]
    expect(toRunRecord({ ...base, followUps: fu }).followUps).toEqual(fu)
  })
})
```

(If `run-state.test.ts` already imports `toRunRecord`/`describe`, don't duplicate the imports.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/types.test.ts src/shared/run-state.test.ts`
Expected: FAIL (`followThrough` undefined; `followUps` not on record).

- [ ] **Step 3: Add the ProjectSettings field + default**

In `src/shared/types.ts`, in `interface ProjectSettings`, after `lightPrompts: boolean` (the last token-efficiency field), add:

```ts
  /** how workers handle an under-specified feature: 'off' = no change, 'headless' = infer + build + record */
  followThrough: 'off' | 'headless'
```

In `DEFAULT_SETTINGS`, after `lightPrompts: false`, add (ensure the previous line ends with a comma):

```ts
  followThrough: 'off'
```

- [ ] **Step 4: Add the run-state fields + event variant**

In `src/shared/types.ts`, in `interface RunState`, right after the `handoffs?` field, add:

```ts
  /** headless follow-through: features workers inferred + built for under-specified parts */
  followUps?: { workerId: string; summary: string; decision: string }[]
```

In `interface RunRecord`, right after its `handoffs?` field, add:

```ts
  followUps?: { workerId: string; summary: string; decision: string }[]
```

In the `OrchestrationEvent` union, after the `handoff` variant line, add:

```ts
  | { runId: string; type: 'follow-up'; workerId: string; summary: string; decision: string }
```

- [ ] **Step 5: Spread followUps in `toRunRecord`**

In `src/shared/run-state.ts`, in `toRunRecord`, after the `handoffs` spread line, add:

```ts
    ...(s.followUps !== undefined ? { followUps: s.followUps } : {}),
```

(Place it alongside the other conditional spreads; keep trailing commas valid.)

- [ ] **Step 6: Run tests + typecheck to verify pass**

Run: `npx vitest run src/shared/types.test.ts src/shared/run-state.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/shared/run-state.ts src/shared/types.test.ts src/shared/run-state.test.ts
git commit -m "feat(follow-through): data types + run-record projection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Parser `shared/follow-through.ts`

**Files:**
- Create: `src/shared/follow-through.ts`
- Test: `src/shared/follow-through.test.ts` (create)

**Interfaces:**
- Produces: `interface FollowUp { summary: string; decision: string }`; `parseFollowUps(text: string): FollowUp[]` — every own-line ```followup``` block with non-empty `summary` AND `decision`, in document order.

- [ ] **Step 1: Write the failing test**

Create `src/shared/follow-through.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseFollowUps } from './follow-through'

const block = (s: string, d: string) =>
  '```followup\n{ "summary": ' + JSON.stringify(s) + ', "decision": ' + JSON.stringify(d) + ' }\n```'

describe('parseFollowUps', () => {
  it('returns [] when no followup block', () => {
    expect(parseFollowUps('just some worker output')).toEqual([])
  })
  it('parses a single block', () => {
    expect(parseFollowUps('did work\n' + block('chat icon unspecified', 'built a chat panel'))).toEqual([
      { summary: 'chat icon unspecified', decision: 'built a chat panel' }
    ])
  })
  it('parses multiple blocks in order', () => {
    const text = block('a', 'A') + '\nprose\n' + block('b', 'B')
    expect(parseFollowUps(text)).toEqual([
      { summary: 'a', decision: 'A' },
      { summary: 'b', decision: 'B' }
    ])
  })
  it('drops blocks missing summary or decision, or empty', () => {
    const bad = '```followup\n{ "summary": "x" }\n```'
    const empty = '```followup\n{ "summary": "", "decision": "y" }\n```'
    expect(parseFollowUps(bad + '\n' + empty + '\n' + block('ok', 'done'))).toEqual([
      { summary: 'ok', decision: 'done' }
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/follow-through.test.ts`
Expected: FAIL ("Cannot find module './follow-through'").

- [ ] **Step 3: Write the module**

Create `src/shared/follow-through.ts`:

```ts
// Pure parsing for headless follow-through (Phase-3 #12, cycle 1). No node/DOM
// imports — unit-tested in plain Node. Mirrors shared/ask-user.ts: extracts every
// ```followup fenced JSON object carrying a {summary, decision}. Workers-only;
// gated by followThrough === 'headless' in the engine. (Cycle 2 adds question/options.)

export interface FollowUp {
  summary: string
  decision: string
}

/** Parse every own-line ```followup fenced JSON object with non-empty summary AND
 *  decision, in document order. The closing fence must be on its own line so a ```
 *  inside a JSON value does not end the block early. */
export function parseFollowUps(text: string): FollowUp[] {
  const blocks = [...text.matchAll(/```followup[^\n]*\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1])
  const out: FollowUp[] = []
  for (const b of blocks) {
    const o = tryParseObject(b)
    if (!o) continue
    const summary = String(o.summary ?? '').trim()
    const decision = String(o.decision ?? '').trim()
    if (summary && decision) out.push({ summary, decision })
  }
  return out
}

function tryParseObject(s: string): { summary?: unknown; decision?: unknown } | null {
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const o = JSON.parse(s.slice(start, end + 1))
    return o && typeof o === 'object' ? (o as { summary?: unknown; decision?: unknown }) : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/follow-through.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/follow-through.ts src/shared/follow-through.test.ts
git commit -m "feat(follow-through): parseFollowUps pure parser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pure engine helpers `followThroughSection` + `formatFollowUps`

**Files:**
- Modify: `src/main/engine/nodes.ts` (add two exported functions near `formatUserRequests`, ~line 1306)
- Test: `src/main/engine/nodes.test.ts` (append a describe block; add both names to the existing `./nodes` import)

**Interfaces:**
- Consumes: `RunState`, `getAgent` (already in nodes.ts).
- Produces: `followThroughSection(): string` (the headless worker instruction; contains the literal `followup`); `formatFollowUps(state: RunState): string` (`''` when no follow-ups, else a "Features clarified during the build" section that names each worker + summary → decision).

- [ ] **Step 1: Write the failing test**

Add `followThroughSection`, `formatFollowUps` to the existing `import { ... } from './nodes'` in `src/main/engine/nodes.test.ts`, then append:

```ts
describe('followThroughSection', () => {
  it('is a non-empty instruction that references the followup block', () => {
    const s = followThroughSection()
    expect(s.length).toBeGreaterThan(0)
    expect(s).toContain('followup')
  })
})

describe('formatFollowUps', () => {
  it('returns empty string when there are no follow-ups', () => {
    expect(formatFollowUps({ followUps: [] } as unknown as RunState)).toBe('')
    expect(formatFollowUps({} as unknown as RunState)).toBe('')
  })
  it('renders a section naming the worker + summary and decision', () => {
    const out = formatFollowUps({
      followUps: [{ workerId: 'w1', summary: 'chat icon unspecified', decision: 'built a chat panel' }]
    } as unknown as RunState)
    expect(out).toContain('chat icon unspecified')
    expect(out).toContain('built a chat panel')
    expect(out).toContain('W1') // getAgent('w1').name is 'W1' in the test topology
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/engine/nodes.test.ts -t followThroughSection`
Expected: FAIL (not exported).

- [ ] **Step 3: Implement both functions**

In `src/main/engine/nodes.ts`, immediately after the `formatUserRequests` function (ends ~line 1319), add:

```ts
export function followThroughSection(): string {
  return `\n\nFOLLOW-THROUGH: If you encounter a feature whose intended behavior was not clearly specified (for example a button or control with no described action), do NOT leave a bare placeholder. Infer the most reasonable behavior from the overall goal and surrounding context, implement it fully, and keep working — do not stop or ask. Record each such decision by including a block of exactly this form (in addition to your normal report):
\`\`\`followup
{ "summary": "<what was under-specified>", "decision": "<what you built and why>" }
\`\`\`
You may include more than one followup block if you made several such decisions.`
}

/** Synthesis section listing headless follow-through decisions, so the final report
 *  treats inferred features as completed scope. '' when none (byte-for-byte off). */
export function formatFollowUps(state: RunState): string {
  const fus = state.followUps ?? []
  if (fus.length === 0) return ''
  const lines = fus.map((f) => {
    let name: string
    try {
      name = getAgent(f.workerId).name
    } catch {
      name = f.workerId
    }
    return `- ${name} built the following for an under-specified part: "${f.summary}" → "${f.decision}".`
  })
  return `\n\n## Features clarified during the build\n${lines.join('\n')}\nThese were reasonable assumptions made and implemented during the run. Report them as completed, intended scope — not as open questions or gaps.`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/engine/nodes.test.ts -t followThroughSection && npx vitest run src/main/engine/nodes.test.ts -t formatFollowUps`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(follow-through): followThroughSection + formatFollowUps helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Engine wiring — record, emit, synth, plumbing

**Files:**
- Modify: `src/main/engine/nodes.ts` (`Eng.followUps` field; inject `followThroughSection` at the worker-prompt site ~line 324; record + emit after the worker call ~line 337; synth append at ~line 727)
- Modify: `src/main/engine/orchestrator.ts` (`eng.followUps: []` init; `collectExtras` includes `followUps`; `resumeDrive` seeds `eng.followUps`)
- Test: `src/main/engine/nodes.test.ts` (add `followThrough: 'off'` to the `h.settings` fake; add `followUps: []` to the local `eng()` helper; add an integration test)

**Interfaces:**
- Consumes: `parseFollowUps` (Task 2), `followThroughSection`/`formatFollowUps` (Task 3), `Eng` (this file), the `follow-up` `OrchestrationEvent` (Task 1).
- Produces: `Eng.followUps: { workerId: string; summary: string; decision: string }[]` (required, like `Eng.handoffs`).

- [ ] **Step 1: Add the imports + `Eng.followUps` field**

In `src/main/engine/nodes.ts`, add to the existing `../../shared/ask-user` import area a new import:

```ts
import { parseFollowUps } from '../../shared/follow-through'
```

In the `Eng` interface, right after the `handoffs` field, add:

```ts
  /** per-run cumulative record of headless follow-through decisions (persisted via NodeIO.collectExtras) */
  followUps: { workerId: string; summary: string; decision: string }[]
```

- [ ] **Step 2: Update the test harness for the new required field (RED via typecheck)**

In `src/main/engine/nodes.test.ts`:
- In the hoisted `h.settings` object, add `followThrough: 'off'` (so all existing tests default to off).
- In the local `eng(runAgent)` helper (the one returning `{ wc, abort, runId, runAgent, emit, handoffs: [] }`), add `followUps: []` after `handoffs: []`.

Run: `npm run typecheck`
Expected: PASS after these edits (the new required `Eng.followUps` is satisfied). If you skip them, typecheck FAILS — that's the RED signal.

- [ ] **Step 3: Inject the headless instruction into the worker prompt**

In `executeNode`'s `runGroup`, change the `prompt:` line (currently):

```ts
        prompt: workerPrompt(state.goal, group.map((t) => t.task), es.lightPrompts) + (asksAvailable() ? askUserSection() : ''),
```

to append the follow-through section when headless (reuse the existing `es` const):

```ts
        prompt: workerPrompt(state.goal, group.map((t) => t.task), es.lightPrompts) + (asksAvailable() ? askUserSection() : '') + (es.followThrough === 'headless' ? followThroughSection() : ''),
```

- [ ] **Step 4: Record + emit follow-ups after the worker call**

In the same `runGroup`, immediately after:

```ts
      const { text, sessionId } = await runWithHandoffs(
        eng,
        base,
        consultFor(ownerId, state.goal, state.actingMode)
      )
```

and BEFORE the `// ── ASK DETECTION` block, insert:

```ts
      // ── HEADLESS FOLLOW-THROUGH: record inferred features (no pause). ──
      if (es.followThrough === 'headless') {
        for (const fu of parseFollowUps(text)) {
          eng.followUps.push({ workerId: ownerId, summary: fu.summary, decision: fu.decision })
          eng.emit({ runId: eng.runId, type: 'follow-up', workerId: ownerId, summary: fu.summary, decision: fu.decision })
        }
      }
```

- [ ] **Step 5: Feed follow-ups into synthesis**

In `synthNode`, change (line ~725–727):

```ts
  const results =
    (owned.length > 0 ? formatResults(state) + formatVerdicts(state) : '(no work was assigned)') +
    formatUserRequests(state)
```

to also append follow-ups:

```ts
  const results =
    (owned.length > 0 ? formatResults(state) + formatVerdicts(state) : '(no work was assigned)') +
    formatUserRequests(state) +
    formatFollowUps(state)
```

- [ ] **Step 6: Plumb the collector through the orchestrator**

In `src/main/engine/orchestrator.ts`, in `makeDeps`:
- In the `const eng: Eng = { ... }` literal, add `followUps: []` (next to `handoffs: []`).
- In the `io: NodeIO` literal, change `collectExtras` from:
  ```ts
    collectExtras: () => (eng.handoffs.length ? { handoffs: [...eng.handoffs] } : {})
  ```
  to include follow-ups:
  ```ts
    collectExtras: () => ({
      ...(eng.handoffs.length ? { handoffs: [...eng.handoffs] } : {}),
      ...(eng.followUps.length ? { followUps: [...eng.followUps] } : {})
    })
  ```

In `resumeDrive`, right after `eng.handoffs.push(...(saved.handoffs ?? []))`, add:

```ts
  eng.followUps.push(...(saved.followUps ?? []))
```

- [ ] **Step 7: Write the integration test**

Append to `src/main/engine/nodes.test.ts`. This wraps `cannedAgent` so worker outputs carry a `followup` block, runs the full graph, and asserts recording + gating + emission:

```ts
describe('headless follow-through (engine)', () => {
  afterEach(() => { h.settings.followThrough = 'off' })

  const fuBlock = '\n```followup\n{ "summary": "chat icon unspecified", "decision": "built a chat panel" }\n```'
  function agentWithFollowUp(): AgentRunner {
    const base = cannedAgent()
    return async (opts) => {
      const r = await base.runAgent(opts)
      return opts.prompt.includes('You have been assigned') ? { ...r, text: r.text + fuBlock } : r
    }
  }
  async function runOnce(): Promise<{ e: Eng; emitted: unknown[] }> {
    const emitted: unknown[] = []
    const e = eng(agentWithFollowUp())
    e.emit = (ev) => { emitted.push(ev) }
    const store = fakeStore()
    await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 't' }),
      store,
      makeIO(e.abort.signal, store)
    )
    return { e, emitted }
  }

  it('records + emits follow-ups when headless', async () => {
    h.settings.followThrough = 'headless'
    const { e, emitted } = await runOnce()
    expect(e.followUps.length).toBeGreaterThan(0)
    expect(e.followUps[0]).toMatchObject({ summary: 'chat icon unspecified', decision: 'built a chat panel' })
    expect(emitted.some((ev) => (ev as { type?: string }).type === 'follow-up')).toBe(true)
  })

  it('off: records nothing even when a worker emits a followup block', async () => {
    h.settings.followThrough = 'off'
    const { e, emitted } = await runOnce()
    expect(e.followUps).toEqual([])
    expect(emitted.some((ev) => (ev as { type?: string }).type === 'follow-up')).toBe(false)
  })
})
```

(If `seedRunState`/`fakeStore`/`makeIO`/`buildOrchestratorGraph`/`runGraph` signatures differ from an existing full-graph test in this file, copy that test's exact call shape — they're all already used above in the file.)

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run src/main/engine/nodes.test.ts && npm run typecheck`
Expected: PASS (new tests green, no regressions).

- [ ] **Step 9: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/orchestrator.ts src/main/engine/nodes.test.ts
git commit -m "feat(follow-through): record + emit + synthesize headless follow-throughs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Renderer — store + Run view + History

**Files:**
- Modify: `src/renderer/store.ts` (`RunState.followUps` field ~line 43; `emptyRun` ~line 65; `applyOrchestration` switch ~line 280)
- Modify: `src/renderer/run/RunView.tsx` (~line 174, after the `userRequests` map)
- Modify: `src/renderer/run/HistoryView.tsx` (~line 193, after the `userRequests` section)

**Interfaces:**
- Consumes: the `follow-up` `OrchestrationEvent` (Task 1); `RunRecord.followUps` (Task 1).

> Renderer JSX + store reducer — verified by `npm run typecheck` + `npm run lint` + `npm run build` and the on-device smoke (no unit test for JSX, consistent with the codebase).

- [ ] **Step 1: Add the store field + init**

In `src/renderer/store.ts`, in the `RunState` interface, right after the `handoffs: {...}[]` line, add:

```ts
  followUps: { workerId: string; summary: string; decision: string }[]
```

In `emptyRun`, right after `handoffs: [],`, add:

```ts
  followUps: [],
```

- [ ] **Step 2: Handle the `follow-up` event**

In `applyOrchestration`'s `switch (e.type)`, right after the `case 'handoff': ... return { run }` block, add:

```ts
        case 'follow-up':
          run.followUps = [...run.followUps, { workerId: e.workerId, summary: e.summary, decision: e.decision }]
          return { run }
```

- [ ] **Step 3: Surface in the Run view**

In `src/renderer/run/RunView.tsx`, right after the `run.userRequests.map(...)` block (ends ~line 174), add:

```tsx
          {run.followUps.map((fu, i) => (
            <div key={`fu-${i}`} className="run-userrequest" title={fu.decision}>
              ✎ Assumed · {nameOf(fu.workerId)}: {fu.summary} → {fu.decision}
            </div>
          ))}
```

- [ ] **Step 4: Surface in History**

In `src/renderer/run/HistoryView.tsx`, right after the `userRequests` section block (ends ~line 193), add:

```tsx
      {(record.followUps ?? []).length > 0 && (
        <div className="hist-section">
          <h4>Follow-through ({record.followUps!.length})</h4>
          <ul>
            {record.followUps!.map((fu, i) => (
              <li key={i}>
                <b>{nameOf(fu.workerId)}</b>: {fu.summary} → {fu.decision}
              </li>
            ))}
          </ul>
        </div>
      )}
```

- [ ] **Step 5: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store.ts src/renderer/run/RunView.tsx src/renderer/run/HistoryView.tsx
git commit -m "feat(follow-through): live + History surfacing of follow-throughs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Settings UI — Off / Headless select

**Files:**
- Modify: `src/renderer/SettingsModal.tsx` (the `active === 'run'` "Run behavior" section)

**Interfaces:**
- Consumes: `ProjectSettings.followThrough` (Task 1); existing `update`, `SettingRow`, `SettingSection`.

> Renderer JSX — verified by typecheck + lint + build + on-device smoke.

- [ ] **Step 1: Add the Follow-through row**

In `src/renderer/SettingsModal.tsx`, inside the `{active === 'run' && ( <SettingSection> ... </SettingSection> )}` block, after the last `GatedRow` (the "User questions per run" row), add a `SettingRow` with a select:

```tsx
              <SettingRow
                label="Follow-through"
                desc={
                  s.followThrough === 'headless'
                    ? 'When a worker hits a feature whose behavior wasn’t specified, it builds a reasonable version instead of a placeholder and records what it assumed (shown in the run + History).'
                    : 'Off — workers may leave placeholders for under-specified features.'
                }
                control={
                  <select
                    value={s.followThrough}
                    onChange={(e) => void update({ followThrough: e.target.value as ProjectSettings['followThrough'] })}
                  >
                    <option value="off">Off</option>
                    <option value="headless">Headless (auto-assume)</option>
                  </select>
                }
              />
```

(`ProjectSettings` is already imported in this file. Do not add an "Ask me" option — that is Cycle 2.)

- [ ] **Step 2: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/SettingsModal.tsx
git commit -m "feat(follow-through): Off/Headless setting in Run behavior

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Integration gate (controller, after all tasks)

- [ ] `npm run typecheck` — PASS
- [ ] `npm run test` — PASS (note the known `run-store.test.ts` full-suite flake; re-run in isolation if it trips)
- [ ] `npm run lint` — PASS (renderer touched)
- [ ] `npm run build` — PASS
- [ ] Opus whole-branch review — no Critical/Important
- [ ] User on-device smoke: Settings → Run behavior → set Follow-through = Headless; run a goal with an under-specified UI feature; confirm the worker builds a real behavior, an "✎ Assumed" line appears in the Run view, and a "Follow-through" section appears in History; set it back to Off and confirm no change.

## Self-review notes (spec coverage)

- Setting off/headless → Task 1 (field) + Task 6 (UI).
- Grammar + parser → Task 2.
- Worker instruction → Task 3 (`followThroughSection`) + Task 4 (injection).
- Record as run data (mirror handoffs) → Task 1 (types) + Task 4 (`Eng.followUps`, record, `collectExtras`, resume-seed) + Task 5 (store).
- Live `follow-up` event → Task 1 (event) + Task 4 (emit) + Task 5 (store case).
- Awareness / synthesis feed → Task 3 (`formatFollowUps`) + Task 4 (synth append).
- Run view + History → Task 5.
- Off = byte-for-byte → per-task guards (`followThrough !== 'headless'`, conditional spreads, `formatFollowUps` empty → `''`); Task 4 integration test asserts the off path records nothing; HITL ask path untouched (not referenced by any change).
