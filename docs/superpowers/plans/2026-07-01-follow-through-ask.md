# Follow-through "Ask me" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive "Ask me" follow-through mode: a worker hitting an under-specified feature pauses with agent-proposed clickable options; the user's pick resumes the worker and is recorded via cycle 1's `followUps` surfacing.

**Architecture:** Extend the existing HITL pause/queue/resume runtime in `executeNode` additively (Approach A): each pause item carries a `source` ('ask-user' | 'follow-through'); follow-through pauses use kind `follow-through`, carry `summary`/`options`, record a `followUp` on resume (no secret-scrubbing), and are bounded by their own `maxFollowThrough` budget. Every follow-through branch is guarded so HITL is byte-for-byte when Ask-me is off. Cycle 1 (headless) already built the `followUps` data/event/store/views/synthesis — reuse it.

**Tech Stack:** TypeScript, Electron (electron-vite), React 19, Vitest.

## Global Constraints

- **Off = byte-for-byte.** With `followThrough !== 'ask'`: no ask-instruction, no `parseFollowUpAsk`, no follow-through pause items, no `follow-through` interrupt, `FollowThroughModal` renders nothing. The HITL ask path (`parseAskUser`, `resumeAsker` + `redactUserAnswer` scrubbing, `userRequestCount`, HitlModal) is unchanged. Cycle-1 headless behavior unchanged.
- **Workers during build only.** Changes live only in `executeNode`'s `runGroup`/wave-loop/re-entry. Do not touch planning/routing/review/repair.
- **Reuse cycle 1.** Record follow-through resolutions via the existing `eng.followUps` collector + `follow-up` event + `RunState.followUps` + store/RunView/HistoryView + `formatFollowUps` synthesis feed. Do NOT add new run-record/view plumbing.
- **`source` back-compat:** the `source` field on pause items is optional; `undefined` means `'ask-user'` (so pre-cycle-2 checkpoints resume as HITL).
- **Exact shapes:** setting `followThrough: 'off' | 'headless' | 'ask'`; `maxFollowThrough: number` (default 0); `RunState.followThroughCount: number`; pause item adds `source?: 'ask-user' | 'follow-through'`, `summary?: string`, `options?: string[]`; ask block `{ summary, question, options? }`; follow-through interrupt `{ kind: 'follow-through', prompt: question, payload: { askerId, askerName, summary, question, options } }`.
- **Gates:** implementers run `npm run typecheck` + `npm run test`; controller runs `npm run build` + `npm run lint` at integration; user runs the on-device smoke.
- **Commit trailer:** end commits with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch: `feat/follow-through-ask`.

---

### Task 1: Settings + data types

**Files:**
- Modify: `src/shared/types.ts` (`ProjectSettings.followThrough` union + `maxFollowThrough`; `DEFAULT_SETTINGS`; `RunState.followThroughCount` + `pendingAsk`/`askQueue` item shape)
- Test: `src/shared/types.test.ts` (append)

**Interfaces:**
- Produces: `followThrough: 'off' | 'headless' | 'ask'`; `maxFollowThrough: number` (default 0); `RunState.followThroughCount: number`; `pendingAsk`/`askQueue` items gain `source?: 'ask-user' | 'follow-through'`, `summary?: string`, `options?: string[]`.

- [ ] **Step 1: Write the failing test** — append to `src/shared/types.test.ts`:

```ts
describe('follow-through ask settings', () => {
  it('defaults maxFollowThrough to 0', () => {
    expect(DEFAULT_SETTINGS.maxFollowThrough).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/shared/types.test.ts` → FAIL.

- [ ] **Step 3: Widen the union + add the setting.** In `interface ProjectSettings`, change `followThrough: 'off' | 'headless'` to:
```ts
  followThrough: 'off' | 'headless' | 'ask'
  /** pause budget for followThrough === 'ask' (0 = no pauses) */
  maxFollowThrough: number
```
In `DEFAULT_SETTINGS`, after `followThrough: 'off'`, add `maxFollowThrough: 0` (fix the trailing comma on the `followThrough` line).

- [ ] **Step 4: Add RunState fields.** In `interface RunState`, after `userRequestCount: number` add:
```ts
  /** bounds follow-through 'ask' pauses this run (mirrors userRequestCount) */
  followThroughCount: number
```
Change the `pendingAsk?:` and `askQueue?:` item shapes (both currently `{ ownerId: string; taskIds: string[]; sessionId?: string; question: string }`) to add the tag fields:
```ts
  pendingAsk?: { ownerId: string; taskIds: string[]; sessionId?: string; question: string; source?: 'ask-user' | 'follow-through'; summary?: string; options?: string[] }
  askQueue?: { ownerId: string; taskIds: string[]; sessionId?: string; question: string; source?: 'ask-user' | 'follow-through'; summary?: string; options?: string[] }[]
```

- [ ] **Step 5: Seed `followThroughCount` in `seedRunState`.** In `src/main/engine/nodes.ts` `seedRunState`, the returned object has `userRequestCount: 0`; add `followThroughCount: 0` next to it (so new runs start at 0). (This file is `nodes.ts`; the field is required on `RunState`, so typecheck will force this.)

- [ ] **Step 6: Run test + typecheck** — `npx vitest run src/shared/types.test.ts && npm run typecheck` → PASS.

- [ ] **Step 7: Commit**
```bash
git add src/shared/types.ts src/shared/types.test.ts src/main/engine/nodes.ts
git commit -m "feat(follow-through-ask): settings + run-state data types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `parseFollowUpAsk`

**Files:**
- Modify: `src/shared/follow-through.ts` (add the ask parser)
- Test: `src/shared/follow-through.test.ts` (append)

**Interfaces:**
- Produces: `interface FollowUpAsk { summary: string; question: string; options: string[] }`; `parseFollowUpAsk(text: string): FollowUpAsk | null` — the LAST own-line ```followup``` block with non-empty `summary` + `question`; `options` optional (array of non-empty strings, capped to 4); null when absent/malformed.

- [ ] **Step 1: Write the failing test** — append to `src/shared/follow-through.test.ts`:

```ts
import { parseFollowUpAsk } from './follow-through'

const askBlock = (s: string, q: string, opts?: string[]) =>
  '```followup\n' + JSON.stringify(opts ? { summary: s, question: q, options: opts } : { summary: s, question: q }) + '\n```'

describe('parseFollowUpAsk', () => {
  it('returns null when no block', () => {
    expect(parseFollowUpAsk('nope')).toBeNull()
  })
  it('parses summary + question with options', () => {
    expect(parseFollowUpAsk('x\n' + askBlock('chat icon', 'what should it do?', ['a', 'b']))).toEqual({
      summary: 'chat icon', question: 'what should it do?', options: ['a', 'b']
    })
  })
  it('options default to [] and are capped to 4, empties dropped', () => {
    expect(parseFollowUpAsk(askBlock('s', 'q'))).toEqual({ summary: 's', question: 'q', options: [] })
    expect(parseFollowUpAsk(askBlock('s', 'q', ['a', '', 'b', 'c', 'd', 'e'])).options).toEqual(['a', 'b', 'c', 'd'])
  })
  it('returns null if summary or question is empty/missing', () => {
    expect(parseFollowUpAsk(askBlock('', 'q'))).toBeNull()
    expect(parseFollowUpAsk('```followup\n{ "summary": "s" }\n```')).toBeNull()
  })
  it('prefers the last block', () => {
    expect(parseFollowUpAsk(askBlock('s1', 'q1') + '\n' + askBlock('s2', 'q2'))?.question).toBe('q2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/shared/follow-through.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `src/shared/follow-through.ts`, add (reuse the existing block-matching regex approach from `parseFollowUps`; keep `parseFollowUps` unchanged):

```ts
export interface FollowUpAsk {
  summary: string
  question: string
  options: string[]
}

/** Parse the LAST own-line ```followup block carrying a non-empty summary + question.
 *  options optional → array of non-empty strings capped to 4. null when absent/malformed. */
export function parseFollowUpAsk(text: string): FollowUpAsk | null {
  const blocks = [...text.matchAll(/```followup[^\n]*\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    const o = tryParseObject(blocks[i]) as { summary?: unknown; question?: unknown; options?: unknown } | null
    if (!o) continue
    const summary = String(o.summary ?? '').trim()
    const question = String(o.question ?? '').trim()
    if (!summary || !question) continue
    const options = Array.isArray(o.options)
      ? o.options.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 4)
      : []
    return { summary, question, options }
  }
  return null
}
```

If `tryParseObject` is currently a local (non-exported) helper in this file, reuse it directly. If its typed signature is too narrow, widen the cast at the call site as shown (`as { ... } | null`).

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/shared/follow-through.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/shared/follow-through.ts src/shared/follow-through.test.ts
git commit -m "feat(follow-through-ask): parseFollowUpAsk parser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pure engine helpers — `followThroughAskSection` + `interruptFor`

**Files:**
- Modify: `src/main/engine/nodes.ts` (two exported functions near `followThroughSection`)
- Test: `src/main/engine/nodes.test.ts` (append; add both names to the `./nodes` import)

**Interfaces:**
- Produces:
  - `followThroughAskSection(): string` — the 'ask'-mode worker instruction (contains `followup`, `options`, `question`).
  - `interruptFor(item: { ownerId: string; question: string; source?: 'ask-user' | 'follow-through'; summary?: string; options?: string[] }): Interrupt` — builds the interrupt for a pause item by source. `Interrupt` is imported from `../../shared/types`.

- [ ] **Step 1: Write the failing test** — add `followThroughAskSection`, `interruptFor` to the `./nodes` import in `nodes.test.ts`, then append:

```ts
describe('followThroughAskSection', () => {
  it('references followup, options, and question', () => {
    const s = followThroughAskSection()
    expect(s).toContain('followup')
    expect(s).toContain('options')
    expect(s).toContain('question')
  })
})

describe('interruptFor', () => {
  it('builds an ask-user interrupt (default source)', () => {
    const iv = interruptFor({ ownerId: 'w1', question: 'Which color?' })
    expect(iv.kind).toBe('ask-user')
    expect(iv.payload).toMatchObject({ askerId: 'w1', askerName: 'W1', question: 'Which color?' })
  })
  it('builds a follow-through interrupt carrying summary + options', () => {
    const iv = interruptFor({ ownerId: 'w1', question: 'What should it do?', source: 'follow-through', summary: 'chat icon', options: ['a', 'b'] })
    expect(iv.kind).toBe('follow-through')
    expect(iv.payload).toMatchObject({ askerId: 'w1', askerName: 'W1', summary: 'chat icon', question: 'What should it do?', options: ['a', 'b'] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/main/engine/nodes.test.ts -t interruptFor` → FAIL.

- [ ] **Step 3: Implement.** In `nodes.ts`, ensure `Interrupt` is imported from `../../shared/types` (add to the existing type import if absent). Immediately after `followThroughSection`, add:

```ts
export function followThroughAskSection(): string {
  return `\n\nFOLLOW-THROUGH (ask): If you encounter a feature whose intended behavior was not clearly specified (for example a button or control with no described action), do NOT assume — pause and ask the user. Reply with ONLY this block and nothing else:
\`\`\`followup
{ "summary": "<what is under-specified>", "question": "<what you need decided>", "options": ["<option 1>", "<option 2>"] }
\`\`\`
Propose 2–4 concrete options you'd recommend. Ask only for genuinely under-specified features; otherwise finish normally.`
}

/** Build the pause interrupt for a collected ask item, by source. */
export function interruptFor(item: {
  ownerId: string
  question: string
  source?: 'ask-user' | 'follow-through'
  summary?: string
  options?: string[]
}): Interrupt {
  const askerName = getAgent(item.ownerId).name
  if (item.source === 'follow-through') {
    return {
      kind: 'follow-through',
      prompt: item.question,
      payload: { askerId: item.ownerId, askerName, summary: item.summary ?? '', question: item.question, options: item.options ?? [] }
    }
  }
  return {
    kind: 'ask-user',
    prompt: item.question,
    payload: { askerId: item.ownerId, askerName, question: item.question }
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/main/engine/nodes.test.ts -t interruptFor && npx vitest run src/main/engine/nodes.test.ts -t followThroughAskSection` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(follow-through-ask): followThroughAskSection + interruptFor helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Generalize the pause machinery to be source-aware (HITL byte-for-byte)

**Files:**
- Modify: `src/main/engine/nodes.ts` (`executeNode`: `asks` type, `followThroughCount`, re-entry, wave-end presentation; new `resumeFollowUpAsk`)
- Test: `src/main/engine/nodes.test.ts` (append a `resumeFollowUpAsk` unit test; existing HITL tests are the regression guard)

**Interfaces:**
- Consumes: `interruptFor` (Task 3), `parseFollowUps` (cycle 1, already imported).
- Produces: `resumeFollowUpAsk(eng, item, answer, actingMode, tasks, steps)` — resumes the worker with the decision, records a `followUp` on `eng.followUps` + emits the `follow-up` event, **no scrubbing**. `executeNode` now threads `followThroughCount` and per-source budgets.

This task ONLY generalizes the machinery — no follow-through *detection* yet (Task 5). All pause items are still `source: 'ask-user'` here, so behavior is unchanged and the existing HITL tests must stay green (the regression guard).

- [ ] **Step 1: Add `followThroughCount` + `maxFollowThrough` locals + source-typed `asks`.** In `executeNode`, near `let userRequestCount = ...`:
```ts
  const maxFollowThrough = getSettings().maxFollowThrough ?? 0
  let followThroughCount = state.followThroughCount ?? 0
```
Change the `asks` declaration (line ~278) to the tagged shape:
```ts
  const asks: { ownerId: string; taskIds: string[]; sessionId?: string; question: string; source: 'ask-user' | 'follow-through'; summary?: string; options?: string[] }[] = []
```
Add a follow-through availability helper next to `asksAvailable`:
```ts
  const followThroughAskAvailable = (): boolean => getSettings().followThrough === 'ask' && followThroughCount < maxFollowThrough
```

- [ ] **Step 2: Add `resumeFollowUpAsk`** (place right after `resumeAsker`):
```ts
/** Resume a follow-through asker with the user's decision (or Skip). Records the resolution
 *  as a followUp (cycle-1 surfacing) and does NOT scrub — a scope decision isn't a secret. */
async function resumeFollowUpAsk(
  eng: Eng,
  item: { ownerId: string; taskIds: string[]; sessionId?: string; summary?: string },
  answer: string,
  actingMode: PermissionMode,
  tasks: Record<string, TaskState>,
  steps: Record<string, RunStepRecord>
): Promise<void> {
  const owned = item.taskIds.map((id) => tasks[id]).filter(Boolean)
  const titles = owned.map((t) => t.task.title)
  const decision = answer.trim() || '(skipped — the worker proceeded with a reasonable assumption)'
  setStatus(eng, steps, item.ownerId, 'working', titles)
  try {
    const r = await eng.runAgent({
      wc: eng.wc,
      agentId: item.ownerId,
      prompt: answerResumePrompt(answer),
      runId: eng.runId,
      stepId: item.ownerId,
      permissionMode: actingMode,
      resume: true,
      resumeSessionId: item.sessionId,
      abort: eng.abort,
      modelOverride: workerModelOverride(getSettings())
    })
    if (r.sessionId) await updateAgent({ id: item.ownerId, sessionId: r.sessionId })
    const out = r.text || '(no output)'
    for (const t of owned) {
      t.status = 'done'
      t.output = out
    }
    steps[item.ownerId] = { ...stepBase(item.ownerId, steps), output: out }
    setStatus(eng, steps, item.ownerId, eng.abort.signal.aborted ? 'skipped' : 'done', titles)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    for (const t of owned) {
      t.status = 'done'
      t.output = `ERROR: ${msg}`
    }
    steps[item.ownerId] = { ...stepBase(item.ownerId, steps), output: `ERROR: ${msg}` }
    setStatus(eng, steps, item.ownerId, 'error', titles)
  }
  eng.followUps.push({ workerId: item.ownerId, summary: item.summary ?? '', decision })
  eng.emit({ runId: eng.runId, type: 'follow-up', workerId: item.ownerId, summary: item.summary ?? '', decision })
}
```

- [ ] **Step 3: Generalize the RE-ENTRY block** (currently lines ~284–316). Replace the body of `if (state.resumeInput !== undefined && state.pendingAsk) { ... }` so it dispatches by source, increments the right counter, and drains the queue via `interruptFor`:
```ts
  if (state.resumeInput !== undefined && state.pendingAsk) {
    const answer = String(state.resumeInput ?? '')
    if (state.pendingAsk.source === 'follow-through') {
      await resumeFollowUpAsk(eng, state.pendingAsk, answer, state.actingMode, tasks, steps)
      followThroughCount += 1
    } else {
      await resumeAsker(eng, state.pendingAsk, answer, state.actingMode, tasks, steps)
      userRequestCount += 1
    }
    await io.checkpoint({ ...state, ...scrub, tasks: structuredClone(tasks), steps: { ...steps }, userRequestCount, followThroughCount, phase: 'executing', ...(io.collectExtras?.() ?? {}) })
    const queue = state.askQueue ?? []
    if (queue.length > 0) {
      const [next, ...rest] = queue
      if (next.source !== 'follow-through') userRequests.push({ askerId: next.ownerId, question: next.question })
      return {
        patch: {
          resumeInput: undefined,
          tasks,
          steps,
          userRequestCount,
          followThroughCount,
          ...(userRequests.length ? { userRequests } : {}),
          pendingAsk: next,
          askQueue: rest.length ? rest : undefined,
          phase: 'executing'
        },
        interrupt: interruptFor(next)
      }
    }
  }
```
(Note: `followThroughCount` is now included in the checkpoint + patch; `userRequests` is only pushed for non-follow-through queue items, since a follow-through records via `resumeFollowUpAsk` on its own resume.)

- [ ] **Step 4: Include `followThroughCount` in the other `executeNode` return patches.** Every `return { patch: { ...scrub, tasks, steps, userRequestCount, ... } }` in `executeNode` (the replan-boundary return and the final `return { patch: { ... phase: 'reviewing' } }`) must also carry `followThroughCount` so it persists. Add `followThroughCount,` next to `userRequestCount,` in each such patch (search `userRequestCount,` in this function).

- [ ] **Step 5: Generalize the WAVE-END presentation** (the `if (asks.length > 0 && ...)` block). Replace the single-budget slot logic with per-source selection and `interruptFor`:
```ts
    if (asks.length > 0 && !eng.abort.signal.aborted) {
      asks.sort((a, b) => state.plan.findIndex((p) => p.id === a.taskIds[0]) - state.plan.findIndex((p) => p.id === b.taskIds[0]))
      const hitlRemaining = maxUserRequests - userRequestCount
      const ftRemaining = maxFollowThrough - followThroughCount
      const present: typeof asks = []
      const overflow: typeof asks = []
      let hitlTaken = 0
      let ftTaken = 0
      for (const a of asks) {
        if (a.source === 'follow-through') {
          if (ftTaken < ftRemaining) { present.push(a); ftTaken += 1 } else overflow.push(a)
        } else {
          if (hitlTaken < hitlRemaining) { present.push(a); hitlTaken += 1 } else overflow.push(a)
        }
      }
      // over-budget askers: resume best-effort with no answer — never re-run fresh, never lost
      for (const ask of overflow) {
        if (ask.source === 'follow-through') await resumeFollowUpAsk(eng, ask, '', state.actingMode, tasks, steps)
        else await resumeAsker(eng, ask, '', state.actingMode, tasks, steps)
      }
      const [head, ...rest] = present
      if (head.source !== 'follow-through') userRequests.push({ askerId: head.ownerId, question: head.question })
      return {
        patch: {
          resumeInput: undefined,
          tasks,
          steps,
          userRequestCount,
          followThroughCount,
          ...(userRequests.length ? { userRequests } : {}),
          pendingAsk: head,
          askQueue: rest.length ? rest : undefined,
          phase: 'executing'
        },
        interrupt: interruptFor(head)
      }
    }
```
(When Ask-me is off, no follow-through asks are ever pushed, so `ftRemaining` is unused, every `a.source === 'ask-user'`, and this reduces to the prior HITL behavior — `present` is the first `hitlRemaining` asks, exactly as `slots` did, and `interruptFor` yields the same `ask-user` interrupt. HITL tests must still pass.)

- [ ] **Step 6: Tag the existing HITL ask push with `source: 'ask-user'`.** In the HITL ASK DETECTION branch (`asks.push({ ownerId, taskIds: ..., sessionId, question: req.question })`), add `source: 'ask-user'` to the pushed object so it satisfies the new required `source` field.

- [ ] **Step 7: Add a `resumeFollowUpAsk` unit test** — append to `nodes.test.ts` (uses the existing `eng()`/`cannedAgent` harness):
```ts
describe('resumeFollowUpAsk', () => {
  it('records a followUp with the decision and does not scrub', async () => {
    const e = eng(cannedAgent().runAgent)
    const tasks: Record<string, TaskState> = {
      t1: { task: { id: 't1', title: 'T1', description: 'd' }, ownerId: 'w1', status: 'pending', attempts: 1, output: '' }
    }
    await resumeFollowUpAsk(e, { ownerId: 'w1', taskIds: ['t1'], summary: 'chat icon' }, 'Open a chat panel', 'auto', tasks, {})
    expect(e.followUps).toEqual([{ workerId: 'w1', summary: 'chat icon', decision: 'Open a chat panel' }])
    expect(tasks.t1.status).toBe('done')
  })
  it('Skip records the sentinel decision', async () => {
    const e = eng(cannedAgent().runAgent)
    const tasks: Record<string, TaskState> = {
      t1: { task: { id: 't1', title: 'T1', description: 'd' }, ownerId: 'w1', status: 'pending', attempts: 1, output: '' }
    }
    await resumeFollowUpAsk(e, { ownerId: 'w1', taskIds: ['t1'], summary: 's' }, '', 'auto', tasks, {})
    expect(e.followUps[0].decision).toContain('skipped')
  })
})
```
Export `resumeFollowUpAsk` from `nodes.ts` and add it to the test's `./nodes` import. (`cannedAgent().runAgent` returns `worked w1` for a resume prompt via its fallthrough; that's fine — we assert the recording, not the text.)

- [ ] **Step 8: Run tests + typecheck** — `npx vitest run src/main/engine/nodes.test.ts && npm run typecheck` → PASS (the NEW tests pass AND all pre-existing HITL tests pass unchanged — the regression guard).

- [ ] **Step 9: Commit**
```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(follow-through-ask): source-aware pause machinery + resumeFollowUpAsk

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire follow-through detection + instruction into the run

**Files:**
- Modify: `src/main/engine/nodes.ts` (`runGroup`: inject `followThroughAskSection`; detect `parseFollowUpAsk`)
- Test: `src/main/engine/nodes.test.ts` (append end-to-end ask-mode tests)

**Interfaces:**
- Consumes: `parseFollowUpAsk` (Task 2), `followThroughAskSection`/`interruptFor` (Task 3), the source-aware machinery (Task 4).

- [ ] **Step 1: Write the failing integration test** — append to `nodes.test.ts` (mirrors the cycle-1 headless engine test wrapper; sets `followThrough: 'ask'` + a budget, worker emits a followup-ask block, asserts the run pauses with a follow-through interrupt, then resumes and records a followUp):
```ts
describe('follow-through ask (engine)', () => {
  afterEach(() => { h.settings.followThrough = 'off'; h.settings.maxFollowThrough = 0 })

  const askBlk = '\n```followup\n{ "summary": "chat icon unspecified", "question": "what should it do?", "options": ["chat panel", "help page"] }\n```'
  function agentWithAsk(): AgentRunner {
    const base = cannedAgent()
    return async (opts) => {
      const r = await base.runAgent(opts)
      return opts.prompt.includes('You have been assigned') ? { ...r, text: r.text + askBlk } : r
    }
  }

  it('pauses with a follow-through interrupt carrying options', async () => {
    h.settings.followThrough = 'ask'; h.settings.maxFollowThrough = 2
    const e = eng(agentWithAsk())
    const store = fakeStore()
    const paused = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 't' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(paused.status).toBe('interrupted')
    expect(paused.pendingInterrupt?.kind).toBe('follow-through')
    expect(paused.pendingAsk?.source).toBe('follow-through')
    expect(paused.pendingInterrupt?.payload).toMatchObject({ summary: 'chat icon unspecified', options: ['chat panel', 'help page'] })
  })

  it('resuming with a choice records a followUp', async () => {
    h.settings.followThrough = 'ask'; h.settings.maxFollowThrough = 2
    const e = eng(agentWithAsk())
    const store = fakeStore()
    const graph = buildOrchestratorGraph(e)
    await runGraph(graph, seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 't' }), store, makeIO(e.abort.signal, store))
    // resume the paused run with a decision — resumeFollowUpAsk records onto e2.followUps
    const e2 = eng(cannedAgent().runAgent)
    await resumeGraph(buildOrchestratorGraph(e2), 'run1', store, makeIO(e2.abort.signal, store), 'chat panel')
    expect(e2.followUps.some((f) => f.decision === 'chat panel' && f.summary === 'chat icon unspecified')).toBe(true)
  })
})
```
(If `resumeGraph`'s signature in this file's existing tests differs, copy the exact call shape from the existing resume test — `resumeGraph` is already imported and used in `nodes.test.ts`. The key assertions are: paused with `kind: 'follow-through'`; resume records a `followUp`.)

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/main/engine/nodes.test.ts -t "follow-through ask"` → FAIL (no detection yet; run completes without pausing).

- [ ] **Step 3: Inject the ask instruction.** In `runGroup`, the worker `prompt:` line currently ends with `+ (es.followThrough === 'headless' ? followThroughSection() : '')`. Append the ask section:
```ts
        prompt: workerPrompt(state.goal, group.map((t) => t.task), es.lightPrompts) + (asksAvailable() ? askUserSection() : '') + (es.followThrough === 'headless' ? followThroughSection() : '') + (es.followThrough === 'ask' ? followThroughAskSection() : ''),
```

- [ ] **Step 4: Detect follow-through asks.** In `runGroup`, right after the cycle-1 headless-record block and BEFORE the `// ── ASK DETECTION` HITL block, add:
```ts
      // ── FOLLOW-THROUGH ASK: a worker wants the user to decide an under-specified feature → pause. ──
      if (followThroughAskAvailable()) {
        const fa = parseFollowUpAsk(text)
        if (fa) {
          for (const t of group) tasks[t.task.id].status = 'pending'
          asks.push({ ownerId, taskIds: group.map((t) => t.task.id), sessionId, question: fa.question, source: 'follow-through', summary: fa.summary, options: fa.options })
          return
        }
      }
```
(This runs before HITL ASK DETECTION so a followup-ask block is claimed as a follow-through, not misread. It leaves the group pending exactly like the HITL branch, and the Task-4 wave-end/re-entry handle it by source.)

- [ ] **Step 5: Run tests + typecheck** — `npx vitest run src/main/engine/nodes.test.ts && npm run typecheck` → PASS (new ask tests green; all prior tests, incl. headless + HITL, still pass).

- [ ] **Step 6: Commit**
```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(follow-through-ask): worker instruction + pause detection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Renderer — store + FollowThroughModal + mount

**Files:**
- Modify: `src/renderer/store.ts` (`pendingInterrupt` shape + `interrupt` case)
- Create: `src/renderer/FollowThroughModal.tsx`
- Modify: `src/renderer/HitlModal.tsx` (kind guard); `src/renderer/App.tsx` (mount)

**Interfaces:**
- Consumes: the `follow-through` interrupt (`payload: { askerId, askerName, summary, question, options }`); `answerInterrupt` (existing) → `resumeRun`.

> Renderer JSX + store reducer — verified by typecheck + lint + build + on-device smoke.

- [ ] **Step 1: Extend the store `pendingInterrupt` shape.** In `src/renderer/store.ts`, change the field (currently `pendingInterrupt: { question: string; askerName: string; askerId: string } | null`) to:
```ts
  pendingInterrupt: { kind: 'ask-user' | 'follow-through'; question: string; askerName: string; askerId: string; summary?: string; options?: string[] } | null
```

- [ ] **Step 2: Branch the `interrupt` case by kind.** In `applyOrchestration`, replace the `case 'interrupt':` block with:
```ts
        case 'interrupt': {
          const kind = e.interrupt.kind === 'follow-through' ? 'follow-through' : 'ask-user'
          const pl = e.interrupt.payload as { askerId?: string; askerName?: string; question?: string; summary?: string; options?: string[] } | undefined
          run.pendingInterrupt = {
            kind,
            question: pl?.question ?? e.interrupt.prompt,
            askerName: pl?.askerName ?? 'Agent',
            askerId: pl?.askerId ?? '',
            summary: pl?.summary,
            options: pl?.options
          }
          run.interruptMinimized = false
          if (kind === 'ask-user') {
            run.userRequests = [...run.userRequests, { askerId: run.pendingInterrupt.askerId, question: run.pendingInterrupt.question }]
          }
          return { run }
        }
```

- [ ] **Step 3: Guard HitlModal to ask-user only.** In `src/renderer/HitlModal.tsx`, after `const pending = run.pendingInterrupt; if (!pending) return null`, add:
```tsx
  if (pending.kind === 'follow-through') return null
```

- [ ] **Step 4: Create `FollowThroughModal.tsx`** (mirrors HitlModal, adds option buttons):
```tsx
import { useState } from 'react'
import { useStore } from './store'
import { Modal } from './Modal'

export default function FollowThroughModal() {
  const run = useStore((s) => s.run)
  const answerInterrupt = useStore((s) => s.answerInterrupt)
  const minimizeInterrupt = useStore((s) => s.minimizeInterrupt)
  const [text, setText] = useState('')

  const pending = run.pendingInterrupt
  if (!pending || pending.kind !== 'follow-through') return null

  if (run.interruptMinimized) {
    return (
      <button className="hitl-badge" onClick={() => minimizeInterrupt(false)}>
        ✎ {pending.askerName} needs a decision
      </button>
    )
  }

  const submit = (answer: string): void => {
    answerInterrupt(answer)
    setText('')
  }

  return (
    <Modal dismissable={false} onClose={() => minimizeInterrupt(true)} labelledBy="ft-title">
      {(close) => (<>
        <div className="modal-header">
          <h2 id="ft-title" className="modal-title">{pending.askerName} needs a decision</h2>
        </div>
        <div className="modal-body">
          {pending.summary && <div className="hitl-question">{pending.summary}</div>}
          <div className="radio-desc" style={{ marginTop: 4 }}>{pending.question}</div>
          {(pending.options ?? []).length > 0 && (
            <div className="field" style={{ marginTop: 8 }}>
              {pending.options!.map((opt, i) => (
                <button key={i} className="btn" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }} onClick={() => close(() => submit(opt))}>
                  {opt}
                </button>
              ))}
            </div>
          )}
          <div className="field">
            <textarea autoFocus rows={3} value={text} placeholder="Or type your own answer…" onChange={(e) => setText(e.target.value)} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => close(() => minimizeInterrupt(true))}>Minimize</button>
          <button className="btn" onClick={() => close(() => submit(''))}>Skip</button>
          <button className="btn primary" disabled={!text.trim()} onClick={() => close(() => submit(text.trim()))}>Submit</button>
        </div>
      </>)}
    </Modal>
  )
}
```

- [ ] **Step 5: Mount it.** In `src/renderer/App.tsx`, next to `<HitlModal />`, add `<FollowThroughModal />` and add the import `import FollowThroughModal from './FollowThroughModal'`.

- [ ] **Step 6: Typecheck + lint + build** — `npm run typecheck && npm run lint && npm run build` → PASS.

- [ ] **Step 7: Commit**
```bash
git add src/renderer/store.ts src/renderer/FollowThroughModal.tsx src/renderer/HitlModal.tsx src/renderer/App.tsx
git commit -m "feat(follow-through-ask): FollowThroughModal + kind-routed interrupts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Settings UI — "Ask me" option + budget

**Files:**
- Modify: `src/renderer/SettingsModal.tsx` (the Follow-through row in Run behavior)

**Interfaces:**
- Consumes: `followThrough` union (now incl. `'ask'`), `maxFollowThrough`.

- [ ] **Step 1: Add the "Ask me" option + budget stepper.** In `SettingsModal.tsx`, the Follow-through `SettingRow` (added in cycle 1) has a `<select>` with Off/Headless. Add an `ask` option and, when selected, a budget stepper. Replace the follow-through `control` and `desc` with:
```tsx
                desc={
                  s.followThrough === 'headless'
                    ? "When a worker hits a feature whose behavior wasn't specified, it builds a reasonable version instead of a placeholder and records what it assumed."
                    : s.followThrough === 'ask'
                      ? 'When a worker hits an under-specified feature, it pauses and asks you, with clickable options it proposes. Your pick is recorded.'
                      : 'Off — workers may leave placeholders for under-specified features.'
                }
                control={
                  <div className="gated-control">
                    {s.followThrough === 'ask' && (
                      <label className="gated-count">
                        up to{' '}
                        <input
                          type="number"
                          min={1}
                          max={5}
                          value={s.maxFollowThrough || 3}
                          onChange={(e) => void update({ maxFollowThrough: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })}
                        />
                      </label>
                    )}
                    <select
                      value={s.followThrough}
                      onChange={(e) => {
                        const v = e.target.value as ProjectSettings['followThrough']
                        void update(v === 'ask' ? { followThrough: v, maxFollowThrough: s.maxFollowThrough || 3 } : { followThrough: v })
                      }}
                    >
                      <option value="off">Off</option>
                      <option value="headless">Headless (auto-assume)</option>
                      <option value="ask">Ask me</option>
                    </select>
                  </div>
                }
```
(Selecting "Ask me" defaults the budget to 3 if it was 0. `gated-control`/`gated-count` classes already exist.)

- [ ] **Step 2: Typecheck + lint + build** — `npm run typecheck && npm run lint && npm run build` → PASS.

- [ ] **Step 3: Commit**
```bash
git add src/renderer/SettingsModal.tsx
git commit -m "feat(follow-through-ask): Ask-me option + budget in Settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Integration gate (controller, after all tasks)

- [ ] `npm run typecheck` — PASS
- [ ] `npm run test` — PASS (note the known `run-store.test.ts` full-suite flake; re-run in isolation if it trips)
- [ ] `npm run lint` — PASS
- [ ] `npm run build` — PASS
- [ ] Opus whole-branch review — no Critical/Important
- [ ] User on-device smoke: Settings → Run behavior → Follow-through = **Ask me** (budget ≥1); run a goal with an under-specified UI feature; confirm the run pauses with a modal showing the summary + question + clickable option buttons + free-text; pick an option → the worker continues and an "✎ Assumed"/follow-through entry appears in the Run view + History; try Skip (records the sentinel); set back to Off → HITL asks (if enabled) and normal runs behave exactly as before.

## Self-review notes (spec coverage)

- Setting off/headless/ask + budget → Task 1 + Task 7.
- Ask grammar → Task 2. Ask instruction → Task 3 + Task 5.
- Reuse HITL runtime (Approach A), per-source budget, byte-for-byte when off → Task 4 (machinery) + Task 5 (detection); the existing HITL tests are the regression guard.
- Record via cycle-1 followUps (no scrub), Skip sentinel → Task 4 (`resumeFollowUpAsk`).
- Interrupt routing + option-button modal → Task 3 (`interruptFor`) + Task 6.
- Off = byte-for-byte → guards in Tasks 4/5 (`followThroughAskAvailable`, `source`), Task 6 (kind guards); HITL path untouched.
