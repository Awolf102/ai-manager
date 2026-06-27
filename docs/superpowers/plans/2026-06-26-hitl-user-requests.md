# HITL User Requests (Stage 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a worker pause an orchestration run to ask the user a question (minimizable modal), then resume that worker's own session with the user's answer — off by default, byte-for-byte identical when off.

**Architecture:** Reuse the already-built interrupt/resume runtime (`NodeResult.interrupt`, `graph.ts` driver keeps the cursor, `resumeGraph` injects `resumeInput`, Phase-3 `resumeSessionId`). A pure `parseAskUser` detects a ` ```ask ` block in worker output; `executeNode` reverts that worker's group to `pending`, records a `pendingAsk` (with the worker's session id), and returns `{ interrupt }`. `finishRun` emits an `interrupt` event; a new `resumeRun(runId, answer)` IPC threads the answer back through `resumeGraph`; `executeNode` re-entry resumes the asker's session with the answer. A minimizable React modal collects the answer.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), React, Zustand, Vitest. Local state-graph engine (no LangGraph).

## Global Constraints

- **Off by default:** `maxUserRequests` default `0`. When `0`: no ask section injected, stray ` ```ask ` blocks ignored, no `pendingAsk`/`userRequests`/interrupt → **byte-for-byte** behavior and identical `RunRecord`.
- **Workers only:** only `executeNode`/`runGroup` may ask. Never reviewers, managers, orchestrator, or the handoff peer path.
- **Answer is sensitive:** the raw answer lives only in transient `RunState.resumeInput` and the resumed agent call. It is **never** written to `pendingAsk`, `userRequests`, `steps`, `reviews`, `RunRecord`, or the durable checkpoint. **Every** `executeNode` return patch clears `resumeInput`/`pendingAsk`. (Caveat: the agent's *output* may echo it — that is accepted and surfaced in the UI copy.)
- **Bounded:** each consumed ask increments `RunState.userRequestCount`; asks stop once it reaches `maxUserRequests`.
- **Mirror existing patterns:** `parseAskUser` mirrors `shared/handoff.ts`; `askUserSection` mirrors `handoffSection`; settings field mirrors `maxHandoffs`; store/RunView/History mirror the `handoffs` plumbing.
- Run all tests with `npx vitest run`. Typecheck with `npm run build` is NOT required between tasks; use `npx tsc -p tsconfig.web.json --noEmit` / `tsconfig.node.json` only where a task says so.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/ask-user.ts` (new) | Pure `parseAskUser(text)` → `{ question } | null` |
| `src/shared/ask-user.test.ts` (new) | Unit tests for `parseAskUser` |
| `src/shared/types.ts` | `maxUserRequests` setting; `RunState.userRequestCount`/`pendingAsk`/`userRequests`; `OrchestrationEvent` `interrupt`; `RunRecord.userRequests`; `IPC.resumeRun`; `RendererApi.resumeRun` |
| `src/shared/run-state.ts` | map `userRequests` in `toRunRecord` |
| `src/shared/run-state.test.ts` | cover the mapping |
| `src/main/engine/nodes.ts` | `seedRunState` seed; `askUserSection`; `answerResumePrompt`; `executeNode` re-entry + `runGroup` ask detection + post-wave interrupt |
| `src/main/engine/nodes.test.ts` | interrupt / resume / skip / off tests |
| `src/main/engine/orchestrator.ts` | `finishRun` emits `interrupt`; `resumeRun(wc,runId,resumeInput)`; `resumeDrive` threads + skips `run-started` on HITL resume |
| `src/main/ipc.ts` | `resumeRun` handler |
| `src/preload/index.ts` | `resumeRun` bridge |
| `src/renderer/store.ts` | `pendingInterrupt`/`interruptMinimized`/`userRequests`; `interrupt` case; `answerInterrupt`/`minimizeInterrupt` |
| `src/renderer/HitlModal.tsx` (new) | Modal + minimized badge |
| `src/renderer/App.tsx` | mount `HitlModal` |
| `src/renderer/run/RunView.tsx` | render `userRequests` info lines |
| `src/renderer/run/HistoryView.tsx` | render `record.userRequests` section |
| `src/renderer/SettingsModal.tsx` | `maxUserRequests` field |
| `src/renderer/styles.css` | modal + badge + `run-userrequest` styles |

---

### Task 1: Pure `parseAskUser`

**Files:**
- Create: `src/shared/ask-user.ts`
- Test: `src/shared/ask-user.test.ts`

**Interfaces:**
- Produces: `parseAskUser(text: string): AskUserRequest | null` where `AskUserRequest = { question: string }`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/ask-user.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseAskUser } from './ask-user'

describe('parseAskUser', () => {
  it('parses an ```ask block', () => {
    const text = 'Working...\n```ask\n{ "question": "Which brand color?" }\n```'
    expect(parseAskUser(text)).toEqual({ question: 'Which brand color?' })
  })

  it('returns null when there is no ask block', () => {
    expect(parseAskUser('Just my normal answer, no question.')).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseAskUser('```ask\n{ question: nope }\n```')).toBeNull()
  })

  it('returns null when question is empty', () => {
    expect(parseAskUser('```ask\n{"question":""}\n```')).toBeNull()
  })

  it('returns null when question is only whitespace', () => {
    expect(parseAskUser('```ask\n{"question":"   "}\n```')).toBeNull()
  })

  it('does not treat a verdict JSON block as an ask', () => {
    const verdict = '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```'
    expect(parseAskUser(verdict)).toBeNull()
  })

  it('takes the last ask block when several are present', () => {
    const text = '```ask\n{"question":"first"}\n```\nthen\n```ask\n{"question":"second"}\n```'
    expect(parseAskUser(text)).toEqual({ question: 'second' })
  })

  it('does not end the block early on a ``` inside the JSON value', () => {
    const text = '```ask\n{ "question": "use ``` fences?" }\n```'
    expect(parseAskUser(text)).toEqual({ question: 'use ``` fences?' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/ask-user.test.ts`
Expected: FAIL — cannot resolve `./ask-user`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/ask-user.ts`:

```ts
// Pure parsing for human-in-the-loop user requests (Stage 3). No node/DOM imports —
// unit-tested in plain Node. Mirrors shared/handoff.ts: extracts a {question} ask
// from a worker's output. Workers-only; gated by maxUserRequests in the engine.

export interface AskUserRequest {
  question: string
}

/**
 * Parse an ask-user request from worker output, or null. Prefers the LAST own-line
 * ```ask fenced JSON object with a `question` field. Returns null when absent,
 * malformed, or `question` is empty/whitespace. The closing fence must be on its own
 * line so a ``` inside the JSON value does not end the block early.
 */
export function parseAskUser(text: string): AskUserRequest | null {
  const obj = extractAskObject(text)
  if (!obj) return null
  const question = String(obj.question ?? '').trim()
  if (!question) return null
  return { question }
}

function extractAskObject(text: string): { question?: unknown } | null {
  const blocks = [...text.matchAll(/```ask[^\n]*\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    const parsed = tryParseObject(blocks[i])
    if (parsed && 'question' in parsed) return parsed
  }
  return null
}

function tryParseObject(s: string): { question?: unknown } | null {
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const o = JSON.parse(s.slice(start, end + 1))
    return o && typeof o === 'object' ? (o as { question?: unknown }) : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/ask-user.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/ask-user.ts src/shared/ask-user.test.ts
git commit -m "feat(hitl): pure parseAskUser for ```ask blocks"
```

---

### Task 2: Types, settings, seed, and `toRunRecord` mapping

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/run-state.ts`
- Modify: `src/shared/run-state.test.ts`
- Modify: `src/main/engine/nodes.ts` (`seedRunState` only)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ProjectSettings.maxUserRequests: number`; `DEFAULT_SETTINGS.maxUserRequests = 0`.
  - `RunState.userRequestCount: number`; `RunState.pendingAsk?: { ownerId: string; taskIds: string[]; sessionId?: string; question: string }`; `RunState.userRequests?: { askerId: string; question: string }[]`.
  - `OrchestrationEvent` variant `{ runId: string; type: 'interrupt'; interrupt: Interrupt }`.
  - `RunRecord.userRequests?: { askerId: string; question: string }[]`.
  - `IPC.resumeRun = 'run:resume'`; `RendererApi.resumeRun: (runId: string, answer: string) => Promise<void>`.
  - `seedRunState(...)` returns state with `userRequestCount: 0`.

- [ ] **Step 1: Write the failing test (run-state mapping)**

In `src/shared/run-state.test.ts`, add inside the existing `describe` (or create the file's describe if testing `toRunRecord`). First inspect the file; it tests `toRunRecord`/`toRunStatus`. Add:

```ts
it('maps userRequests when present and omits when absent', () => {
  const base = {
    runId: 'r', goal: 'g', orchestratorId: 'o', startedAt: 'S', updatedAt: 'U',
    status: 'completed' as const, phase: 'done' as const, cursor: '__end__',
    actingMode: 'auto' as const, plan: [], tasks: {}, steps: {}, reviews: [],
    reflections: [], repairAttempts: 0, replanAttempts: 0, replanStageCursor: 0,
    userRequestCount: 1, final: ''
  }
  expect(toRunRecord(base).userRequests).toBeUndefined()
  const withReqs = { ...base, userRequests: [{ askerId: 'w1', question: 'Q?' }] }
  expect(toRunRecord(withReqs).userRequests).toEqual([{ askerId: 'w1', question: 'Q?' }])
})
```

(If `toRunRecord` is not yet imported in the test, add it to the existing import from `./run-state`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/run-state.test.ts`
Expected: FAIL — `withReqs` is not assignable / `userRequests` missing on `RunRecord`, or the mapping returns `undefined`.

- [ ] **Step 3: Edit `src/shared/types.ts`**

In `ProjectSettings` (after `maxHandoffs`):

```ts
  /** max times a worker may pause the run to ask the user a question (0 = off) */
  maxUserRequests: number
```

In `DEFAULT_SETTINGS` (after `maxHandoffs: 0`):

```ts
  maxHandoffs: 0,
  maxUserRequests: 0
```

In the `OrchestrationEvent` union, add a variant (e.g. after the `handoff` line):

```ts
  | { runId: string; type: 'interrupt'; interrupt: Interrupt }
```

In `RunRecord` (after `handoffs?`):

```ts
  userRequests?: { askerId: string; question: string }[]
```

In `RunState` (after the existing `handoffs?` field, keeping `pendingInterrupt`/`resumeInput` where they are):

```ts
  /** asks the user made this run, recorded for the run view + History (questions only — never answers) */
  userRequests?: { askerId: string; question: string }[]
  /** bounds worker→user questions this run (mirrors replanAttempts) */
  userRequestCount: number
  /** the worker waiting on a user answer; carries its session id across resume (never the answer) */
  pendingAsk?: { ownerId: string; taskIds: string[]; sessionId?: string; question: string }
```

In `IPC` (after `stopRun: 'run:stop',`):

```ts
  resumeRun: 'run:resume',
```

In `RendererApi` (after `stopRun`):

```ts
  resumeRun: (runId: string, answer: string) => Promise<void>
```

- [ ] **Step 4: Edit `src/shared/run-state.ts`**

In `toRunRecord`'s returned object, after the `handoffs` spread line:

```ts
    ...(s.handoffs !== undefined ? { handoffs: s.handoffs } : {}),
    ...(s.userRequests !== undefined ? { userRequests: s.userRequests } : {})
```

- [ ] **Step 5: Edit `seedRunState` in `src/main/engine/nodes.ts`**

In the object returned by `seedRunState`, after `replanStageCursor: 0,`:

```ts
    replanStageCursor: 0,
    userRequestCount: 0,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/shared/run-state.test.ts`
Expected: PASS.

Then verify the existing `seedRunState` test still passes (it asserts specific seed fields):

Run: `npx vitest run src/main/engine/nodes.test.ts -t seedRunState`
Expected: PASS (add `userRequestCount` to that test's expectation only if it does an exact-shape match; if it checks individual fields, no change needed — inspect first).

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/shared/run-state.ts src/shared/run-state.test.ts src/main/engine/nodes.ts
git commit -m "feat(hitl): state + settings + RunRecord mapping for user requests"
```

---

### Task 3: Worker prompt helpers (`askUserSection`, `answerResumePrompt`)

**Files:**
- Modify: `src/main/engine/nodes.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (module-local functions used by Task 4):
  - `askUserSection(): string` — instruction block appended to a worker prompt when asks are available.
  - `answerResumePrompt(answer: string): string` — prompt that resumes the asker; `''` ⇒ skip wording.

These are pure string helpers, exercised end-to-end in Task 4 (no standalone test needed — they have no branching beyond the empty-string check, which Task 4's skip test covers).

- [ ] **Step 1: Add the helpers near `handoffSection` / `resumePrompt` in `src/main/engine/nodes.ts`**

```ts
function askUserSection(): string {
  return `\n\nYou may ASK THE USER one question if you are blocked on information only they can provide (a decision, a missing detail, a preference). To ask, reply with ONLY this block and nothing else:
\`\`\`ask
{ "question": "<exactly what you need from the user>" }
\`\`\`
Do NOT ask for secrets (API keys, passwords) — those belong in environment files. Ask only when genuinely blocked; otherwise just finish normally.`
}

function answerResumePrompt(answer: string): string {
  if (answer.trim() === '') {
    return `The user did not provide an answer. Make a reasonable assumption and proceed best-effort. When finished, briefly report what you did and note the assumption you made.`
  }
  return `The user answered your question:

${answer}

Continue your task using this. When finished, briefly report what you changed.`
}
```

- [ ] **Step 2: Verify it compiles (no test yet)**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS (unchanged behavior; the new functions are unused so far — TypeScript "declared but never read" does not fail vitest, but to avoid an unused-var lint failure in the eventual build, Task 4 wires them in the same branch. If your editor flags unused, proceed — Task 4 consumes them.)

- [ ] **Step 3: Commit**

```bash
git add src/main/engine/nodes.ts
git commit -m "feat(hitl): askUserSection + answerResumePrompt helpers"
```

---

### Task 4: `executeNode` pause + re-entry (the core) — sonnet impl, OPUS review

**Files:**
- Modify: `src/main/engine/nodes.ts` (`executeNode`, `runGroup`)
- Modify: `src/main/engine/nodes.test.ts`

**Interfaces:**
- Consumes: `parseAskUser` (Task 1), `askUserSection`/`answerResumePrompt` (Task 3), `RunState.pendingAsk`/`userRequestCount`/`userRequests` + `OrchestrationEvent` `interrupt` (Task 2), and the existing `getSettings`, `updateAgent`, `getAgent`, `setStatus`, `stepBase`, `runWithHandoffs`, `consultFor`, `mapCapped`, `MAX_PARALLEL`.
- Produces: `executeNode` that pauses on a worker ask and resumes the asker on re-entry. No new exported symbols.

> **Reviewer focus (OPUS):** the re-entrant pause — finished workers checkpointed, asker left `pending` with its session captured, resume re-runs ONLY the asker, the answer never lands in any persisted field, and `maxUserRequests = 0` is byte-for-byte. Verify the scrub invariant holds on all three return paths.

- [ ] **Step 1: Add the failing tests to `src/main/engine/nodes.test.ts`**

First, add `maxUserRequests: 0` to the hoisted `h.settings` object (so the off-path tests run with today's behavior):

```ts
    settings: {
      reviewMode: 'once',
      maxRepairAttempts: 1,
      reflection: true,
      autonomy: 'auto',
      adaptiveEffort: true,
      maxReplans: 0,
      maxHandoffs: 0,
      maxUserRequests: 0
    },
```

Add an import for `resumeGraph` if not already present (it is, at line 2) and a new describe block at the end of the file. This test uses a bespoke `runAgent` (not `cannedAgent`) so it can control the ask:

```ts
describe('HITL user requests (Stage 3)', () => {
  // A worker (w1) asks once on its first work call, then completes on resume.
  // Plan→route reuse the canned shapes; only the work/resume calls are bespoke.
  function askingAgent() {
    const calls: { agentId: string; kind: string; prompt: string }[] = []
    let w1Asked = false
    const runAgent: AgentRunner = async (opts) => {
      const p = opts.prompt
      const id = opts.agentId
      if (p.includes('Produce a concise, ordered list')) {
        return {
          text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"do t1"},{"id":"t2","title":"T2","description":"do t2"}]}\n```',
          sessionId: 's-' + id
        }
      }
      if (p.includes('You route planned tasks')) {
        const childIds = [...p.matchAll(/- id: (\S+)\n\s+name:/g)].map((m) => m[1])
        const taskIds = [...p.matchAll(/- id: (t\d+) —/g)].map((m) => m[1])
        const assignments = taskIds.map((tid, i) => ({
          taskId: tid, childId: childIds[i % childIds.length] ?? null, reason: 'r'
        }))
        return { text: '```json\n' + JSON.stringify({ assignments }) + '\n```' }
      }
      if (p.includes('The user answered') || p.includes('did not provide an answer')) {
        calls.push({ agentId: id, kind: 'resume', prompt: p })
        return { text: `resumed ${id}`, sessionId: 's2-' + id }
      }
      if (p.includes('You have been assigned the following task')) {
        if (id === 'w1' && !w1Asked) {
          w1Asked = true
          calls.push({ agentId: id, kind: 'ask', prompt: p })
          return { text: '```ask\n{"question":"Which color?"}\n```', sessionId: 'sess-w1' }
        }
        calls.push({ agentId: id, kind: 'work', prompt: p })
        return { text: `worked ${id}`, sessionId: 's-' + id }
      }
      // reviews / reflect / synth → pass-through so the run can finish
      if (p.includes('Judge each task')) return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('final INTEGRATION review')) return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('Reflect on')) return { text: '```json\n{"win":"w","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'FINAL' }
      return { text: 'unknown' }
    }
    return { runAgent, calls }
  }

  it('off (maxUserRequests=0): an ask block is treated as ordinary output', async () => {
    h.settings.maxUserRequests = 0
    const { runAgent } = askingAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const final = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(final.status).toBe('completed')
    expect(final.pendingInterrupt).toBeUndefined()
    expect(final.pendingAsk).toBeUndefined()
    // the ask text became the worker's output (not a pause)
    expect(final.tasks['t1'].output).toContain('ask')
  })

  it('on: a worker ask pauses the run with an interrupt + pendingAsk', async () => {
    h.settings.maxUserRequests = 2
    const events: { type: string }[] = []
    const { runAgent } = askingAgent()
    const e: Eng = { ...eng(runAgent), emit: (ev) => events.push(ev) }
    const store = fakeStore()
    const io: NodeIO = { signal: e.abort.signal, emit: (ev) => events.push(ev), checkpoint: (s) => store.put(s) }
    const final = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      io
    )
    expect(final.status).toBe('interrupted')
    expect(final.pendingInterrupt?.kind).toBe('ask-user')
    expect(final.pendingInterrupt?.prompt).toBe('Which color?')
    expect(final.pendingAsk?.ownerId).toBe('w1')
    expect(final.pendingAsk?.sessionId).toBe('sess-w1')
    expect(final.pendingAsk?.taskIds).toContain('t1')
    expect(final.userRequests).toEqual([{ askerId: 'w1', question: 'Which color?' }])
    // the asking task is left pending; the answer is nowhere in state
    expect(final.tasks['t1'].status).toBe('pending')
    expect(JSON.stringify(final)).not.toContain('Which color')  // wait: question IS recorded; see note
  })

  it('resume with an answer continues the asking worker and finishes; no answer persisted', async () => {
    h.settings.maxUserRequests = 2
    const { runAgent, calls } = askingAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const io = makeIO(e.abort.signal, store)
    await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      io
    )
    const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, 'Use teal')
    expect(final.status).toBe('completed')
    expect(final.userRequestCount).toBe(1)
    expect(final.pendingAsk).toBeUndefined()
    expect(final.resumeInput).toBeUndefined()
    // the asker was resumed via its captured session with the answer
    const resume = calls.find((c) => c.kind === 'resume' && c.agentId === 'w1')
    expect(resume).toBeTruthy()
    expect(resume!.prompt).toContain('Use teal')
    // the raw answer never lands in persisted run state (questions are fine; answers are not)
    const persisted = JSON.stringify({ ...final, steps: undefined })  // steps.output may echo; exclude
    expect(persisted).not.toContain('Use teal')
  })

  it('skip (empty answer) resumes best-effort and finishes', async () => {
    h.settings.maxUserRequests = 2
    const { runAgent, calls } = askingAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const io = makeIO(e.abort.signal, store)
    await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      io
    )
    const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, '')
    expect(final.status).toBe('completed')
    const resume = calls.find((c) => c.kind === 'resume' && c.agentId === 'w1')
    expect(resume!.prompt).toContain('did not provide an answer')
  })
})
```

> **Note on the `not.toContain('Which color')` assertion above:** the *question* IS recorded in `userRequests`, so that assertion is WRONG as written — delete that single line. It is left here only to flag the distinction: questions are persisted, answers are not. The answer-scrub assertion lives in the "resume" test (`not.toContain('Use teal')`).

Delete the flagged `expect(JSON.stringify(final)).not.toContain('Which color')` line before running.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "HITL"`
Expected: the "off" test may PASS already (no ask handling yet → ask becomes output ✓); the "on"/"resume"/"skip" tests FAIL (no pause happens — run completes instead of interrupting).

- [ ] **Step 3: Implement the re-entry block + ask detection in `executeNode`**

Replace the body of `executeNode` (currently `src/main/engine/nodes.ts` ~L222–304). Keep the existing structure; add the marked NEW sections. Full replacement:

```ts
async function executeNode(state: RunState, io: NodeIO, eng: Eng): Promise<NodeResult> {
  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }
  const maxUserRequests = getSettings().maxUserRequests ?? 0
  let userRequestCount = state.userRequestCount ?? 0
  const userRequests = [...(state.userRequests ?? [])]
  // collected when a worker asks during a wave (one is chosen to pause on)
  const asks: { ownerId: string; taskIds: string[]; sessionId?: string; question: string }[] = []
  const asksAvailable = (): boolean => maxUserRequests > 0 && userRequestCount < maxUserRequests
  // cleared on EVERY return so a consumed answer never persists (sensitive)
  const scrub = { resumeInput: undefined, pendingAsk: undefined } as Partial<RunState>

  // ── RE-ENTRY: a human answered (or skipped). Resume the asking worker's session. ──
  if (state.resumeInput !== undefined && state.pendingAsk) {
    const ask = state.pendingAsk
    const answer = String(state.resumeInput ?? '')
    const owned = ask.taskIds.map((id) => tasks[id]).filter(Boolean)
    const titles = owned.map((t) => t.task.title)
    setStatus(eng, steps, ask.ownerId, 'working', titles)
    try {
      const r = await eng.runAgent({
        wc: eng.wc,
        agentId: ask.ownerId,
        prompt: answerResumePrompt(answer),
        runId: eng.runId,
        stepId: ask.ownerId,
        permissionMode: state.actingMode,
        resume: true,
        resumeSessionId: ask.sessionId,
        abort: eng.abort
      })
      if (r.sessionId) await updateAgent({ id: ask.ownerId, sessionId: r.sessionId })
      const out = r.text || '(no output)'
      for (const t of owned) {
        t.status = 'done'
        t.output = out
      }
      steps[ask.ownerId] = { ...stepBase(ask.ownerId, steps), output: out }
      setStatus(eng, steps, ask.ownerId, eng.abort.signal.aborted ? 'skipped' : 'done', titles)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      for (const t of owned) {
        t.status = 'done'
        t.output = `ERROR: ${msg}`
      }
      steps[ask.ownerId] = { ...stepBase(ask.ownerId, steps), output: `ERROR: ${msg}` }
      setStatus(eng, steps, ask.ownerId, 'error', titles)
    }
    userRequestCount += 1
    await io.checkpoint({ ...state, ...scrub, tasks: structuredClone(tasks), steps: { ...steps }, userRequestCount, phase: 'executing' })
  }

  // Execute one worker's batch of ready tasks in a single agent call.
  const runGroup = async (ownerId: string, group: TaskState[]): Promise<void> => {
    if (eng.abort.signal.aborted) return
    const titles = group.map((t) => t.task.title)
    for (const t of group) {
      tasks[t.task.id].status = 'running'
      tasks[t.task.id].attempts += 1
    }
    setStatus(eng, steps, ownerId, 'working', titles)
    const effort = getSettings().adaptiveEffort ? maxEffort(group.map((t) => t.effort)) : undefined
    try {
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
      const { text, sessionId } = await runWithHandoffs(
        eng,
        base,
        consultFor(ownerId, state.goal, state.actingMode)
      )
      // ── ASK DETECTION: a worker asked → leave its group pending, record the ask. ──
      if (asksAvailable()) {
        const req = parseAskUser(text)
        if (req) {
          for (const t of group) tasks[t.task.id].status = 'pending'
          asks.push({ ownerId, taskIds: group.map((t) => t.task.id), sessionId, question: req.question })
          return
        }
      }
      if (sessionId) await updateAgent({ id: ownerId, sessionId })
      const out = text || '(no output)'
      for (const t of group) {
        tasks[t.task.id].status = 'done'
        tasks[t.task.id].output = out
      }
      steps[ownerId] = { ...stepBase(ownerId, steps), output: out }
      setStatus(eng, steps, ownerId, eng.abort.signal.aborted ? 'skipped' : 'done', titles)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      for (const t of group) {
        tasks[t.task.id].status = 'done'
        tasks[t.task.id].output = `ERROR: ${msg}`
      }
      steps[ownerId] = { ...stepBase(ownerId, steps), output: `ERROR: ${msg}` }
      setStatus(eng, steps, ownerId, 'error', titles)
    }
    await io.checkpoint({ ...state, ...scrub, tasks: structuredClone(tasks), steps: { ...steps }, userRequestCount, phase: 'executing' })
  }

  while (!eng.abort.signal.aborted) {
    const pending = Object.values(tasks).filter((t) => t.status === 'pending' && t.ownerId)
    if (pending.length === 0) break
    const maxReplans = getSettings().maxReplans ?? 0
    if (maxReplans > 0 && state.replanAttempts < maxReplans) {
      const boundary = pendingStageBoundary(tasks, state.replanStageCursor)
      if (boundary != null) {
        return { patch: { ...scrub, tasks, steps, userRequestCount, userRequests, replanStageCursor: boundary, phase: 'replanning' }, goto: 'replan' }
      }
    }
    let ready = pending.filter((t) => depsSatisfied(t, tasks))
    if (ready.length === 0) ready = pending
    const byOwner = new Map<string, TaskState[]>()
    for (const t of ready) {
      const list = byOwner.get(t.ownerId!) ?? []
      list.push(t)
      byOwner.set(t.ownerId!, list)
    }
    await mapCapped([...byOwner.entries()], MAX_PARALLEL, ([ownerId, group]) => runGroup(ownerId, group))

    // ── A worker asked during this wave → pause on the first (by plan order). ──
    if (asks.length > 0 && !eng.abort.signal.aborted) {
      asks.sort((a, b) => state.plan.findIndex((p) => p.id === a.taskIds[0]) - state.plan.findIndex((p) => p.id === b.taskIds[0]))
      const chosen = asks[0]
      userRequests.push({ askerId: chosen.ownerId, question: chosen.question })
      const interrupt = {
        kind: 'ask-user',
        prompt: chosen.question,
        payload: { askerId: chosen.ownerId, askerName: getAgent(chosen.ownerId).name, question: chosen.question }
      }
      return {
        patch: { resumeInput: undefined, tasks, steps, userRequestCount, userRequests, pendingAsk: chosen, phase: 'executing' },
        interrupt
      }
    }
  }

  return { patch: { ...scrub, tasks, steps, userRequestCount, userRequests, phase: 'reviewing' } }
}
```

> Notes for the implementer:
> - `scrub` is `{ resumeInput: undefined, pendingAsk: undefined }`. The interrupt return deliberately sets `pendingAsk: chosen` (NOT scrubbed) but still clears `resumeInput`.
> - `userRequests` is included in the terminal + replan + interrupt patches so the recorded questions survive; it is **never** the answer.
> - The off path: `asksAvailable()` is always false → no `askUserSection`, `asks` stays empty, `pendingAsk` stays cleared, `userRequests` stays `[]` (and `toRunRecord` omits it when the array is empty? — it is `[]` not `undefined`, so it WOULD serialize as `[]`. To keep the off path's `RunRecord` byte-for-byte, change the terminal patch to set `userRequests` only when non-empty: `...(userRequests.length ? { userRequests } : { userRequests: undefined })`). Apply this conditional in ALL three return patches.

Apply that conditional: replace each `userRequests` patch entry with a spread `...(userRequests.length ? { userRequests } : {})` so an empty list never reaches `RunState.userRequests` (keeps off-path `toRunRecord` identical — `userRequests` stays `undefined`).

- [ ] **Step 4: Run the HITL tests**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "HITL"`
Expected: PASS (4 tests). Fix the `not.toContain('Which color')` line per the Step 1 note if you forgot to delete it.

- [ ] **Step 5: Run the full engine suite for regressions**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS — all existing tests unaffected (off path is byte-for-byte). If the existing end-to-end test now serializes `userRequests`, it should not, given the non-empty conditional.

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(hitl): executeNode pauses on a worker ask and resumes its session"
```

---

### Task 5: Orchestrator emit + `resumeRun(answer)` + IPC + preload

**Files:**
- Modify: `src/main/engine/orchestrator.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `OrchestrationEvent` `interrupt` (Task 2), `RunState.pendingInterrupt`, `resumeGraph(..., resumeInput)` (existing), `IPC.resumeRun`/`RendererApi.resumeRun` (Task 2).
- Produces: `orchestrator.resumeRun(wc, runId, resumeInput?)`; the `interrupt` event reaches the renderer.

- [ ] **Step 1: Edit `finishRun` in `src/main/engine/orchestrator.ts`**

Replace the interrupted early-return:

```ts
  if (final.status === 'interrupted') {
    // Paused for human input (Stage 3): keep the checkpoint for resume, don't finalize.
    if (final.pendingInterrupt) {
      emit(wc, { runId: final.runId, type: 'interrupt', interrupt: final.pendingInterrupt })
    }
    return
  }
```

- [ ] **Step 2: Thread `resumeInput` through `resumeRun` → `resumeDrive`**

Replace `resumeRun` and `resumeDrive`:

```ts
/** Resume a crashed run, or (Stage 3) resume an interrupted run with a user's answer. */
export function resumeRun(wc: WebContents, runId: string, resumeInput?: unknown): { runId: string } {
  const abort = new AbortController()
  active.set(runId, abort)
  void resumeDrive(wc, runId, abort, resumeInput).finally(() => active.delete(runId))
  return { runId }
}
```

```ts
async function resumeDrive(
  wc: WebContents,
  runId: string,
  abort: AbortController,
  resumeInput?: unknown
): Promise<void> {
  const { eng, io, store } = makeDeps(wc, runId, abort)
  const saved = await store.get(runId)
  if (!saved) {
    emit(wc, { runId, type: 'run-finished', status: 'error', error: 'no checkpoint to resume' })
    return
  }
  // HITL continuation (an answer was supplied) keeps the live run view — don't reset it
  // with a fresh run-started. Crash-recovery (no answer) rebuilds the view from scratch.
  if (resumeInput === undefined) {
    emit(wc, { runId, type: 'run-started', orchestratorId: saved.orchestratorId, goal: saved.goal })
  }
  const final = await resumeGraph(buildOrchestratorGraph(eng), runId, store, io, resumeInput)
  await finishRun(wc, final, store)
}
```

- [ ] **Step 3: Add the IPC handler in `src/main/ipc.ts`**

After the `stopRun` handler (~L89):

```ts
  ipcMain.handle(IPC.resumeRun, (e: IpcMainInvokeEvent, runId: string, answer: string) =>
    orchestrator.resumeRun(e.sender, runId, answer)
  )
```

- [ ] **Step 4: Add the preload bridge in `src/preload/index.ts`**

After the `stopRun` line:

```ts
  resumeRun: (runId, answer) => ipcRenderer.invoke(IPC.resumeRun, runId, answer),
```

- [ ] **Step 5: Typecheck main + preload**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the engine suite (no behavior change expected)**

Run: `npx vitest run src/main/engine`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/engine/orchestrator.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat(hitl): emit interrupt event + resumeRun(answer) IPC"
```

---

### Task 6: Renderer — store, modal, badge, settings, run/history surfaces

**Files:**
- Modify: `src/renderer/store.ts`
- Create: `src/renderer/HitlModal.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/run/RunView.tsx`
- Modify: `src/renderer/run/HistoryView.tsx`
- Modify: `src/renderer/SettingsModal.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `OrchestrationEvent` `interrupt`, `RunRecord.userRequests`, `RendererApi.resumeRun`, `ProjectSettings.maxUserRequests`.
- Produces: store fields `run.pendingInterrupt`/`run.interruptMinimized`/`run.userRequests`; actions `answerInterrupt(answer)`/`minimizeInterrupt(v)`.

- [ ] **Step 1: Extend the renderer store (`src/renderer/store.ts`)**

In the `RunState` interface (renderer), add:

```ts
  userRequests: { askerId: string; question: string }[]
  pendingInterrupt: { question: string; askerName: string; askerId: string } | null
  interruptMinimized: boolean
```

In `emptyRun`, add:

```ts
  userRequests: [],
  pendingInterrupt: null,
  interruptMinimized: false,
```

In the `AppState` interface, add the actions:

```ts
  answerInterrupt: (answer: string) => void
  minimizeInterrupt: (v: boolean) => void
```

In `applyOrchestration`'s switch, add a case (after `handoff`):

```ts
        case 'interrupt': {
          const pl = e.interrupt.payload as { askerId: string; askerName: string; question: string } | undefined
          run.pendingInterrupt = pl
            ? { question: pl.question, askerName: pl.askerName, askerId: pl.askerId }
            : { question: e.interrupt.prompt, askerName: 'Agent', askerId: '' }
          run.interruptMinimized = false
          run.userRequests = [...run.userRequests, { askerId: run.pendingInterrupt.askerId, question: run.pendingInterrupt.question }]
          return { run }
        }
```

After the `selectStep` action definition, add:

```ts
  answerInterrupt: (answer) =>
    set((s) => {
      const runId = s.run.runId
      if (runId) void window.api.resumeRun(runId, answer)
      return { run: { ...s.run, pendingInterrupt: null, interruptMinimized: false } }
    }),
  minimizeInterrupt: (v) => set((s) => ({ run: { ...s.run, interruptMinimized: v } })),
```

- [ ] **Step 2: Create `src/renderer/HitlModal.tsx`**

```tsx
import { useState } from 'react'
import { useStore } from './store'

export default function HitlModal() {
  const run = useStore((s) => s.run)
  const answerInterrupt = useStore((s) => s.answerInterrupt)
  const minimizeInterrupt = useStore((s) => s.minimizeInterrupt)
  const [text, setText] = useState('')

  const pending = run.pendingInterrupt
  if (!pending) return null

  if (run.interruptMinimized) {
    return (
      <button className="hitl-badge" onClick={() => minimizeInterrupt(false)}>
        ❓ {pending.askerName} needs you
      </button>
    )
  }

  const submit = (answer: string): void => {
    answerInterrupt(answer)
    setText('')
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{pending.askerName} has a question</h2>
        <div className="hitl-question">{pending.question}</div>
        <div className="field">
          <textarea
            autoFocus
            rows={4}
            value={text}
            placeholder="Your answer…"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Your answer is sent to the agent and may appear in its output — don’t paste secrets.
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => minimizeInterrupt(true)}>
            Minimize
          </button>
          <button className="btn" onClick={() => submit('')}>
            Skip
          </button>
          <button className="btn primary" disabled={!text.trim()} onClick={() => submit(text.trim())}>
            Submit
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Mount it in `src/renderer/App.tsx`**

Add the import near the other modal imports:

```tsx
import HitlModal from './HitlModal'
```

Mount it next to the other modals (after `{showContext && ...}`):

```tsx
      <HitlModal />
```

- [ ] **Step 4: Render `userRequests` lines in `src/renderer/run/RunView.tsx`**

After the `run.handoffs.map(...)` block (before the `chain.map`):

```tsx
        {run.userRequests.map((ur, i) => (
          <div key={`ur-${i}`} className="run-userrequest" title={ur.question}>
            ❓ Asked you · {nameOf(ur.askerId)}: {ur.question}
          </div>
        ))}
```

- [ ] **Step 5: Render the History section in `src/renderer/run/HistoryView.tsx`**

After the Handoffs section block:

```tsx
      {(record.userRequests ?? []).length > 0 && (
        <div className="hist-section">
          <h4>User requests ({record.userRequests!.length})</h4>
          <ul>
            {record.userRequests!.map((ur, i) => (
              <li key={i}>
                <b>{nameOf(ur.askerId)}</b>: {ur.question}
              </li>
            ))}
          </ul>
        </div>
      )}
```

- [ ] **Step 6: Add the Settings field in `src/renderer/SettingsModal.tsx`**

After the `maxHandoffs` field block:

```tsx
        <div className="field">
          <label>Max user questions per run (0 = off)</label>
          <input
            type="number"
            min={0}
            max={5}
            value={s.maxUserRequests}
            onChange={(e) =>
              void update({ maxUserRequests: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })
            }
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            When on, a worker that is blocked may pause the run to ask you one question. Your answer
            resumes that worker. Workers only — it’s sent to the agent, so don’t share secrets.
          </div>
        </div>
```

- [ ] **Step 7: Add styles in `src/renderer/styles.css`**

Append:

```css
.hitl-question {
  background: #11131a;
  border: 1px solid #2a2d3a;
  border-radius: 6px;
  padding: 10px 12px;
  margin: 8px 0;
  white-space: pre-wrap;
}
.hitl-badge {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 50;
  background: #2b2150;
  color: #e6e8ee;
  border: 1px solid #4b3f86;
  border-radius: 999px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
}
.hitl-badge:hover {
  background: #392b6b;
}
.run-userrequest {
  color: #c8b6ff;
  font-size: 12px;
  padding: 2px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 8: Typecheck the renderer**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/renderer
git commit -m "feat(hitl): user-request modal, badge, settings, run/history surfaces"
```

---

### Task 7: Whole-branch verification + off=byte-for-byte regression — OPUS review

**Files:**
- Modify: `src/main/engine/nodes.test.ts` (one explicit off-path regression test if not already covered)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add/confirm an explicit off-path regression test**

In `src/main/engine/nodes.test.ts`, confirm the existing end-to-end test (`orchestrator node graph — end to end`) still produces an identical `RunRecord` shape (no `userRequests` / `pendingAsk` keys) with `maxUserRequests` defaulting to `0`. If `h.settings.maxUserRequests` may be left mutated by the HITL describe block, add a `beforeEach(() => { h.settings.maxUserRequests = 0 })` guard (and reset `maxReplans`/`maxHandoffs` the same way if not already) so the HITL tests don't leak settings into other suites.

```ts
beforeEach(() => {
  h.settings.maxUserRequests = 0
})
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all suites green (was 233 before this feature; expect ~245+ with the new ask-user + HITL tests).

- [ ] **Step 3: Full typecheck (both projects)**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Production build smoke**

Run: `npm run build`
Expected: builds clean (electron-vite main + preload + renderer).

- [ ] **Step 5: OPUS whole-branch review**

Dispatch an OPUS code review of the full `feat/hitl-user-requests` diff against `main`. Review focus:
- The scrub invariant: grep the diff for every `executeNode` return; confirm each clears `resumeInput` and that the raw answer never reaches `pendingAsk`/`userRequests`/`steps`-as-question/`RunRecord`.
- `maxUserRequests = 0` is byte-for-byte (no ask section, no interrupt, `RunRecord` unchanged).
- Re-entry resumes ONLY the asker (no double-run of finished workers), via `resumeSessionId`.
- Multiple-asks-in-a-wave: one chosen deterministically, others re-ask later — no lost/duplicated tasks, no hang.
- `resumeDrive` skips `run-started` only on a HITL resume; crash path unaffected.

Address findings via `superpowers:receiving-code-review` (verify before agreeing), then re-run Step 2.

- [ ] **Step 6: Final commit (if review produced fixes)**

```bash
git add -A
git commit -m "fix(hitl): address whole-branch review"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** trigger (Task 1+3), state/settings/event/record (Task 2), engine pause+resume (Task 4), orchestrator emit + resumeRun + IPC + preload (Task 5), modal/badge/settings/run/history (Task 6), off=byte-for-byte + whole-branch (Task 7). All locked decisions (workers-only, sensitive answer, skip best-effort, off-by-default, resumeSessionId) map to Task 4/5/6 + the Global Constraints. ✓

**Type consistency:** `pendingAsk { ownerId; taskIds; sessionId?; question }`, `userRequests { askerId; question }`, interrupt `payload { askerId; askerName; question }`, `resumeRun(runId, answer)` — used identically in Tasks 2/4/5/6. ✓

**Sensitive scrub:** enforced as a Global Constraint and a per-return `scrub` object in Task 4; asserted in Task 4 Step 1 (`not.toContain('Use teal')`) and reviewed in Task 7. ✓

**Off path:** `userRequests` emitted only when non-empty (Task 4 Step 3 conditional), `maxUserRequests=0` ⇒ no ask section / no interrupt; regression in Task 7. ✓
