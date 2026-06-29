# HITL resume→synthesis + Handoff persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Make the orchestrator's final report acknowledge an answered HITL question (instead of falsely
reporting it unanswered / mislabeling the answer as a placeholder), and persist peer handoffs into the durable
run record + show the consulted peer as working.

**Architecture:** Two engine-only fixes batched into one cycle (both live in the serial `nodes.ts` run loop).
(1) **HITL:** synthesis is currently blind to `state.userRequests`; add a pure `formatUserRequests` section to
the synthesis input + a one-sentence prompt nudge, built only from the already-persisted *questions* (S5-safe,
no raw answer). (2) **R2 handoff persistence:** handoffs are emitted as events but never written to state; add
a cumulative `eng.handoffs` collector pushed at the single emit site, merged into run state via one generic
`NodeIO.collectExtras` seam in the graph runtime (foolproof + checkpoint-safe), so `toRunRecord` + the existing
HistoryView light up; plus a live `status` emit so the consulted peer's pill stops showing idle.

**Tech Stack:** TypeScript, Electron (main-process engine), Vitest. Pure logic in `src/shared`, engine in
`src/main/engine`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-29-hitl-synthesis-handoff-persistence-design.md`
**Repros:** `docs/audits/2026-06-28-live-verification-findings.md` (Test 1 = HITL; Test 2 att.2 = handoff).

> **Mechanism note (refinement of spec §2c):** the spec proposed threading `handoffs` through each
> handoff-capable node's return patch. During planning we found `runGraph` already `store.put`s after **every**
> node (`graph.ts:93`) and that the handoff-capable nodes have ~13 returns (incl. partial-patch early returns
> on the flat-team path) — threading risks silently missing one. We instead use a **cumulative `eng.handoffs`
> collector merged once via a generic `NodeIO.collectExtras` seam**. Same outcome (handoffs in every
> checkpoint + the final record), strictly more robust, off-path byte-for-byte. No user-facing behavior change.

## Global Constraints

- **Off-path byte-for-byte:** with `maxUserRequests = 0` and `maxHandoffs = 0`, runs must be unchanged
  (no new state fields populated, no new prompt text, no new events). Prove with existing snapshot/flat-team
  tests staying green.
- **No raw HITL answer in synthesis or any persisted record** — the S5 invariant
  (`JSON.stringify(state)` never contains the user's answer) must continue to hold. Build the synthesis
  consultation section from `state.userRequests` (questions only) — never read `resumeInput`/the answer.
- **Verification gates (run after each task):** `npm test` (currently 340 green), `npm run typecheck`
  (or the repo's `tsc` for node+web), `npm run build`. All must pass.
- **Serial file:** this is the first of the `nodes.ts` run-loop cluster — do **not** branch R1/R3 in parallel.
- Handoff record shape is the existing inline type used across `shared/types.ts`:
  `{ askerId: string; peerId: string; ask: string }`.

---

## File Structure

- `src/main/engine/nodes.ts` — `Eng.handoffs` field; new exported pure `formatUserRequests`; `synthNode`
  results wiring; one `synthPrompt` sentence; `runWithHandoffs` push + peer status emit.
- `src/main/engine/graph.ts` — `NodeIO.collectExtras?` field + a one-block merge in `runGraph`.
- `src/main/engine/orchestrator.ts` — init `eng.handoffs: []`, wire `io.collectExtras`, seed `eng.handoffs`
  from the checkpoint on resume.
- `src/main/engine/nodes.test.ts` — new/extended tests (per task).
- `src/main/engine/graph.test.ts` — `collectExtras` merge unit test.
- **No renderer changes** — `HistoryView.tsx:169` already renders `record.handoffs`; `store.ts` already maps
  `status` events to pills and `handoff` events to the live list.
- **No `shared/types.ts` changes** — `RunState.handoffs?`, `RunRecord.handoffs?`, the `status`/`handoff`
  events, and `toRunRecord`'s `handoffs` spread already exist.

---

## Task 1: HITL synthesis awareness — `formatUserRequests`

**Files:**
- Modify: `src/main/engine/nodes.ts` (add `formatUserRequests` near `formatResults` ~line 1202; wire into
  `synthNode` ~line 676)
- Test: `src/main/engine/nodes.test.ts`

**Interfaces:**
- Produces: `export function formatUserRequests(state: RunState): string` — returns `''` when
  `state.userRequests` is empty/absent; otherwise a `\n\n## User consultations during this run\n…` section,
  one bullet per request, built only from `askerId`/`question`, with a trailing directive line telling the
  synthesizer to treat them as resolved. **No `synthPrompt` change** — the directive travels inside the
  section, so when there are no consultations the synthesis prompt is byte-for-byte unchanged
  (off-path guarantee).

- [ ] **Step 1: Write the failing unit tests**

Add to `src/main/engine/nodes.test.ts` (import `formatUserRequests` from `./nodes` in the existing import
block alongside `hasManagers`, etc.):

```ts
describe('formatUserRequests', () => {
  it('returns empty string when there are no user requests', () => {
    expect(formatUserRequests({ userRequests: [] } as unknown as RunState)).toBe('')
    expect(formatUserRequests({} as unknown as RunState)).toBe('')
  })

  it('summarizes each consultation by asker name + question, marking it resolved', () => {
    const out = formatUserRequests({
      userRequests: [{ askerId: 'w1', question: 'Which package manager?' }]
    } as unknown as RunState)
    expect(out).toContain('## User consultations during this run')
    expect(out).toContain('W1') // getAgent('w1').name from the hoisted fake
    expect(out).toContain('Which package manager?')
    expect(out).toContain('provided an answer')
    expect(out).toContain('redacted from this record')
    expect(out).toContain('resolved') // the directive travels inside the section
  })

  it('never contains an answer — only the question is an input', () => {
    const out = formatUserRequests({
      userRequests: [{ askerId: 'w1', question: 'pick a color' }]
    } as unknown as RunState)
    expect(out).not.toContain('teal') // no answer field exists to leak
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/engine/nodes.test.ts -t formatUserRequests`
Expected: FAIL — `formatUserRequests is not a function` / not exported.

- [ ] **Step 3: Implement `formatUserRequests`**

Add in `src/main/engine/nodes.ts` directly after `formatVerdicts` (after ~line 1222):

```ts
/** Synthesis-visible summary of HITL consultations — questions only (S5-safe; never the answer). */
export function formatUserRequests(state: RunState): string {
  const reqs = state.userRequests ?? []
  if (reqs.length === 0) return ''
  const lines = reqs.map((r) => {
    const name = getAgent(r.askerId).name
    return `- ${name} paused to ask the user: "${r.question}". The user provided an answer, which ${name} incorporated into its work. (The answer itself is redacted from this record.)`
  })
  return `\n\n## User consultations during this run\n${lines.join('\n')}\nThese questions were answered by the user during the run and the answers were incorporated — report them as resolved, not as open questions or placeholder assumptions.`
}
```

> Note: the "treat as resolved" directive lives inside this section (not in `synthPrompt`), so when there are
> no consultations the synthesis prompt is byte-for-byte unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/engine/nodes.test.ts -t formatUserRequests`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire it into `synthNode`**

In `synthNode` (~line 676), change the `results` line to append the consultation section. **No `synthPrompt`
change** — the directive is inside the section:

```ts
  const results =
    (owned.length > 0 ? formatResults(state) + formatVerdicts(state) : '(no work was assigned)') +
    formatUserRequests(state)
```

- [ ] **Step 6: Run the full engine suite to confirm no regressions**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS (all existing + the 3 new). Off-path runs (no `userRequests`) are byte-for-byte unaffected:
`formatUserRequests` returns `''`, so `results` and the synth prompt are unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "fix(hitl): make synthesis aware of resolved user consultations

formatUserRequests() appends an S5-safe 'User consultations' section
(questions only) to the synthesis input + a synthPrompt nudge, so the
orchestrator no longer reports an answered HITL question as unanswered.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: HITL faithful end-to-end repro (capture + synthesis acknowledgment)

> **Investigative task (approved scope: "repro-and-fix-if-real").** Use **superpowers:systematic-debugging**.
> Goal: a faithful, live-shaped test (full graph → ask → pause → resume → synthesis) that proves the resumed
> worker's output reaches `final.tasks[].output` AND that the synth prompt carries the consultation section.
> The existing engine evidence (Task 1 + the existing resume/redact tests) says capture works; if this test
> reproduces a real capture gap instead, fix it at the resume block (`nodes.ts:238–275`) and document the
> cause in this plan + the live-verification findings doc.

**Files:**
- Test: `src/main/engine/nodes.test.ts`
- (Conditional) Modify: `src/main/engine/nodes.ts` only if a real capture gap reproduces.

**Interfaces:**
- Consumes: `formatUserRequests` wiring from Task 1; `buildOrchestratorGraph`, `seedRunState`, `runGraph`,
  `resumeGraph`, the hoisted `h.settings`, `eng`, `fakeStore`, `makeIO` test helpers.

- [ ] **Step 1: Write the failing end-to-end test**

Add to `src/main/engine/nodes.test.ts`, inside the existing HITL `describe` block (so `h.settings` is reset
by its `beforeEach`). It uses a self-contained canned agent that records the synth prompt:

```ts
it('after resume, synthesis sees the captured reply and acknowledges the answer (no leak)', async () => {
  h.settings.maxUserRequests = 2
  let synthPromptSeen = ''
  let w1Asked = false
  const runAgent: AgentRunner = async (o) => {
    const p = o.prompt
    if (p.includes('Produce a concise, ordered list'))
      return { text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"do t1"}]}\n```', sessionId: 's-' + o.agentId }
    if (p.includes('You route planned tasks'))
      return { text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","reason":"r"}]}\n```' }
    if (p.includes('You have been assigned')) {
      if (o.agentId === 'w1' && !w1Asked) {
        w1Asked = true
        return { text: '```ask\n{"question":"Which package manager?"}\n```', sessionId: 'sess-w1' }
      }
      return { text: `worked ${o.agentId}`, sessionId: 's-' + o.agentId }
    }
    if (p.includes('The user answered') || p.includes('did not provide an answer'))
      return { text: 'Installed deps and wrote the CLI per the manager you chose.', sessionId: 's2-w1' }
    if (p.includes('Judge each task'))
      return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
    if (p.includes('final INTEGRATION review'))
      return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
    if (p.includes('Reflect on')) return { text: '```json\n{"win":"w","loss":"","lessons":[]}\n```' }
    if (p.includes('Write a clear final report')) { synthPromptSeen = p; return { text: 'FINAL' } }
    return { text: 'unknown' }
  }
  const e = eng(runAgent)
  const store = fakeStore()
  const io = makeIO(e.abort.signal, store)
  await runGraph(buildOrchestratorGraph(e), seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }), store, io)
  const secret = 'pnpm v9 exactly'
  const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, secret)

  expect(final.status).toBe('completed')
  // (a) the resumed reply is captured into the durable task output — NOT the pre-resume ask
  expect(final.tasks['t1'].output).toContain('Installed deps and wrote the CLI')
  expect(final.tasks['t1'].output).not.toContain('Which package manager?')
  // (b) synthesis was handed the consultation section (so it can report it resolved)
  expect(synthPromptSeen).toContain('## User consultations during this run')
  expect(synthPromptSeen).toContain('Which package manager?')
  // (c) the raw answer never reaches synthesis or any persisted state (S5)
  expect(synthPromptSeen).not.toContain(secret)
  expect(JSON.stringify(final)).not.toContain(secret)
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "acknowledges the answer"`
Expected (hypothesis): PASS — capture already works in-engine; this confirms the live symptom was
synthesis-blindness (fixed by Task 1), not a capture gap. **If it FAILS on assertion (a)** (the resumed reply
is missing / the ask text persists), a real capture gap reproduced: STOP and go to Step 3.

- [ ] **Step 3: (Only if Step 2 failed) Debug + fix the capture gap**

Use **superpowers:systematic-debugging**: instrument the resume block (`nodes.ts:238–275`) and the wave loop to
find where the resumed `tasks[ask.ownerId].output` is dropped/overwritten before synthesis (candidate causes:
a later wave re-running the owner group and overwriting output; the owner's tasks not all in `ask.taskIds`;
the resumed `r.text` empty). Apply the minimal fix so assertion (a) passes, keeping the S5 redaction at the
single capture point intact. Re-run Step 2 until green.

- [ ] **Step 4: Record the outcome**

Append a short note to `docs/audits/2026-06-28-live-verification-findings.md` under Test 1 stating the
result: either "capture works in-engine; the live symptom was synthesis-blindness (fixed via
`formatUserRequests`); this test is the regression guard" OR "reproduced a real capture gap at `<site>`,
fixed by `<change>`."

- [ ] **Step 5: Run the full engine suite**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts docs/audits/2026-06-28-live-verification-findings.md
git commit -m "test(hitl): faithful resume→synthesis repro guards captured reply + acknowledgment

Full graph -> ask -> pause -> resume -> synth: asserts the resumed reply
lands in tasks[].output, synthesis receives the consultation section, and
the raw answer leaks nowhere. Documents the capture-vs-synthesis-blindness
outcome in the live-verification findings.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Handoff persistence (cumulative collector + generic checkpoint seam)

**Files:**
- Modify: `src/main/engine/nodes.ts` (`Eng` interface ~line 54; push in `runWithHandoffs` after the emit
  ~line 985)
- Modify: `src/main/engine/graph.ts` (`NodeIO.collectExtras?` ~line 10; merge in `runGraph` after ~line 76)
- Modify: `src/main/engine/orchestrator.ts` (`eng` init ~line 80; `io.collectExtras` ~line 81; resume seed
  ~line 109)
- Modify: `src/main/engine/nodes.test.ts` (`eng()` helper gets `handoffs: []`; handoff `run()` helper wires
  `collectExtras`)
- Test: `src/main/engine/graph.test.ts`, `src/main/engine/nodes.test.ts`

**Interfaces:**
- Produces: `Eng.handoffs: { askerId: string; peerId: string; ask: string }[]` (a per-run cumulative
  collector); `NodeIO.collectExtras?: () => Partial<RunState>` (engine-collected fields merged into state on
  every checkpoint). Consumed by `runGraph` and the orchestrator's `io`.

- [ ] **Step 1: Write the failing `graph.ts` `collectExtras` unit test**

Add to `src/main/engine/graph.test.ts` (reuse this file's existing helpers: `fakeStore()`, `mkState(...)`,
the `io(signal, store)` helper, the `live` never-aborted signal, and the imported `END`):

```ts
it('merges io.collectExtras() into state on every checkpoint', async () => {
  const store = fakeStore()
  const graph: CompiledGraph = {
    entry: 'a',
    nodes: {
      a: async () => ({ goto: 'b', patch: { phase: 'executing' } }),
      b: async () => ({ goto: END, patch: { phase: 'done' } })
    },
    edges: {}
  }
  const extrasIO: NodeIO = {
    ...io(live, store),
    collectExtras: () => ({ handoffs: [{ askerId: 'w1', peerId: 'w2', ask: 'q' }] })
  }
  const final = await runGraph(graph, mkState({ runId: 'r', cursor: 'a' }), store, extrasIO)
  expect(final.handoffs).toEqual([{ askerId: 'w1', peerId: 'w2', ask: 'q' }])
  // the last persisted checkpoint also carries it
  expect((await store.get('r'))!.handoffs).toEqual([{ askerId: 'w1', peerId: 'w2', ask: 'q' }])
})

it('does not touch state when collectExtras is absent (off-path)', async () => {
  const store = fakeStore()
  const graph: CompiledGraph = { entry: 'a', nodes: { a: async () => ({ goto: END }) }, edges: {} }
  const final = await runGraph(graph, mkState({ runId: 'r', cursor: 'a' }), store, io(live, store))
  expect('handoffs' in final).toBe(false)
})
```

> Confirm `mkState` accepts `{ runId, cursor }` overrides (it spreads `...over` over a default `RunState`);
> if its signature differs, pass the minimal overrides it supports. Keep the assertions identical.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/engine/graph.test.ts -t collectExtras`
Expected: FAIL — `collectExtras` is not part of `NodeIO`; `final.handoffs` undefined.

- [ ] **Step 3: Add the `collectExtras` seam to `graph.ts`**

In `src/main/engine/graph.ts`, extend `NodeIO` (after the `checkpoint` field, ~line 14):

```ts
  /** mid-node durability (e.g. after each task in a parallel batch) */
  checkpoint: (state: RunState) => Promise<void>
  /** engine-collected fields merged into state on every checkpoint (e.g. cumulative handoffs) */
  collectExtras?: () => Partial<RunState>
```

In `runGraph`, immediately after the patch merge (the `if (res.patch) state = { ...state, ...res.patch }`
line, ~line 76), add:

```ts
    if (res.patch) state = { ...state, ...res.patch }
    if (io.collectExtras) state = { ...state, ...io.collectExtras() }
```

- [ ] **Step 4: Run to verify the graph tests pass**

Run: `npx vitest run src/main/engine/graph.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Write the failing handoff-persistence test**

In `src/main/engine/nodes.test.ts`, update the **worker-site handoff** `describe`'s `run()` helper to wire
`collectExtras` (so persistence works as in production), then add a persistence test. Replace the existing
`run()` in that describe block with:

```ts
  function run(runAgent: AgentRunner, events: unknown[]) {
    const e = eng(runAgent)
    ;(e as { emit: (ev: unknown) => void }).emit = (ev) => events.push(ev)
    const store = fakeStore()
    const io: NodeIO = {
      signal: e.abort.signal,
      emit: (ev) => events.push(ev),
      checkpoint: (s) => store.put(s),
      collectExtras: () => (e.handoffs.length ? { handoffs: [...e.handoffs] } : {})
    }
    return runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      io
    )
  }
```

Then add (same describe block) a persistence assertion + a `toRunRecord` shape check (add
`import { toRunRecord } from '../../shared/run-state'` at the top of the test file if not present):

```ts
  it('persists the handoff into run state + the run record', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const events: unknown[] = []
      const out = await run(fake([], {}, 'Use a teal/amber palette'), events)
      expect(out.handoffs).toEqual([{ askerId: 'w1', peerId: 'w2', ask: 'expressive colorful UI ideas' }])
      expect(toRunRecord(out).handoffs).toEqual([{ askerId: 'w1', peerId: 'w2', ask: 'expressive colorful UI ideas' }])
    } finally {
      h.edges = []
    }
  })

  it('off (maxHandoffs=0): no handoffs key on the record', async () => {
    h.settings.maxHandoffs = 0
    const events: unknown[] = []
    const out = await run(fake([], {}, 'x'), events)
    expect(out.handoffs ?? []).toEqual([])
    expect('handoffs' in toRunRecord(out)).toBe(false)
  })
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "persists the handoff"`
Expected: FAIL — `Eng` has no `handoffs`; `out.handoffs` undefined. (TypeScript will also error that `eng()`
doesn't satisfy `Eng` once the field is added in Step 7 — fix the helper in the same step.)

- [ ] **Step 7: Add the `Eng.handoffs` collector + push at the emit site + fix the `eng()` test helper**

In `src/main/engine/nodes.ts`, extend the `Eng` interface (after `emit`, ~line 59):

```ts
export interface Eng {
  wc: WebContents
  abort: AbortController
  runId: string
  runAgent: AgentRunner
  emit: (e: OrchestrationEvent) => void
  /** per-run cumulative record of peer handoffs (persisted via NodeIO.collectExtras) */
  handoffs: { askerId: string; peerId: string; ask: string }[]
}
```

In `runWithHandoffs`, right after the existing `eng.emit({ ... type: 'handoff' ... })` (~line 985), push:

```ts
    eng.emit({ runId: eng.runId, type: 'handoff', askerId: consult.asker, peerId: peer.id, ask: req.ask })
    eng.handoffs.push({ askerId: consult.asker, peerId: peer.id, ask: req.ask })
```

In `src/main/engine/nodes.test.ts`, add `handoffs: []` to the `eng()` helper (~line 160):

```ts
function eng(runAgent: AgentRunner): Eng {
  return {
    wc: {} as Eng['wc'],
    abort: new AbortController(),
    runId: 'run1',
    runAgent,
    emit: () => {},
    handoffs: []
  }
}
```

- [ ] **Step 8: Wire the orchestrator (production) — init, collectExtras, resume seed**

In `src/main/engine/orchestrator.ts`, `makeDeps` (~line 80–81):

```ts
  const eng: Eng = { wc, abort, runId, runAgent: streamAgent, emit: emitFn, handoffs: [] }
  const io: NodeIO = {
    signal: abort.signal,
    emit: emitFn,
    checkpoint: (s) => store.put(s),
    collectExtras: () => (eng.handoffs.length ? { handoffs: [...eng.handoffs] } : {})
  }
```

In `resumeDrive` (~line 108–113), seed the collector from the checkpoint so a resumed run preserves handoffs
that fired before the pause/crash (the checkpoint carries them via `collectExtras`):

```ts
  const { eng, io, store } = makeDeps(wc, runId, abort)
  const saved = await store.get(runId)
  if (!saved) {
    emit(wc, { runId, type: 'run-finished', status: 'error', error: 'no checkpoint to resume' })
    return
  }
  eng.handoffs.push(...(saved.handoffs ?? []))
```

- [ ] **Step 9: Run the targeted + full engine suite**

Run: `npx vitest run src/main/engine/nodes.test.ts src/main/engine/graph.test.ts`
Expected: PASS — the persistence tests, the existing event-based handoff test (unchanged assertions), and all
off-path tests stay green.

- [ ] **Step 10: Add a review-site persistence test (a reviewer consults a peer)**

The review path reaches `runWithHandoffs` via `runStructured` (`nodes.ts:1031`). Add to the existing
**review-site handoff** `describe` (around `nodes.test.ts:932`) a persistence assertion mirroring Step 5's,
reusing that block's existing fake + run helper (wire its `run()`/io with `collectExtras` the same way if it
has its own helper). Assert `out.handoffs` contains the reviewer→peer entry and `toRunRecord(out).handoffs`
matches. (If that describe shares the top-level `makeIO`, give it a local `collectExtras` io like Step 5.)

```ts
  it('persists a review-site handoff into the record', async () => {
    // reuse this describe's edge/settings setup that triggers the manager->peer consult
    const out = /* run the review-site fake through runGraph with a collectExtras io */ null as unknown as RunState
    expect(out.handoffs?.length).toBeGreaterThan(0)
    expect(toRunRecord(out).handoffs).toEqual(out.handoffs)
  })
```

> Implementer: flesh this out against the actual review-site fixture in that describe block (it already drives
> a manager→worker handoff edge). The assertion is the point: review-site handoffs persist too.

- [ ] **Step 11: Run full suite + typecheck + build**

Run: `npx vitest run && npm run typecheck && npm run build`
(Use the repo's actual scripts — check `package.json`; node+web tsc projects must both pass.)
Expected: all green; renderer build clean.

- [ ] **Step 12: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/graph.ts src/main/engine/orchestrator.ts src/main/engine/nodes.test.ts src/main/engine/graph.test.ts
git commit -m "fix(handoff): persist peer handoffs into the run record (R2)

Add a cumulative eng.handoffs collector pushed at the single handoff emit
site, merged into run state via a generic NodeIO.collectExtras seam in the
graph runtime (foolproof + checkpoint-safe). toRunRecord + HistoryView
already surface it. Off-path (maxHandoffs=0) byte-for-byte. Resolves the
'handoffs leave no durable trace' bug (#23/#27/#25).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Consulted peer shows as working (status pill)

**Files:**
- Modify: `src/main/engine/nodes.ts` (`runWithHandoffs`, around the peer run ~lines 988–997)
- Test: `src/main/engine/nodes.test.ts`

**Interfaces:**
- Consumes: `Eng.emit`, the existing `status` event shape
  `{ runId; type: 'status'; nodeId; status; taskTitles? }` and `StepStatus` values (`'working'`, `'done'`,
  `'error'`).

- [ ] **Step 1: Write the failing test**

Add to the worker-site handoff `describe` in `src/main/engine/nodes.test.ts`:

```ts
  it('emits working + done status for the consulted peer', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const events: { type: string; nodeId?: string; status?: string }[] = []
      await run(fake([], {}, 'Use a teal/amber palette'), events as unknown[])
      const peerStatuses = events.filter((e) => e.type === 'status' && e.nodeId === 'w2').map((e) => e.status)
      expect(peerStatuses).toContain('working')
      expect(peerStatuses).toContain('done')
    } finally {
      h.edges = []
    }
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "status for the consulted peer"`
Expected: FAIL — no `status` events with `nodeId === 'w2'` (the peer never reports working).

- [ ] **Step 3: Emit peer status around the consult**

In `runWithHandoffs` (`nodes.ts`), wrap the peer run. The current block is:

```ts
    eng.emit({ runId: eng.runId, type: 'handoff', askerId: consult.asker, peerId: peer.id, ask: req.ask })
    eng.handoffs.push({ askerId: consult.asker, peerId: peer.id, ask: req.ask })
    let answer: string
    try {
      const r = await eng.runAgent({
        wc: eng.wc,
        agentId: peer.id,
        prompt: peerConsultPrompt(getAgent(consult.asker).name, consult.goal, req.ask),
        runId: eng.runId,
        stepId: peer.id,
        permissionMode: consult.actingMode,
        resume: false,
        abort: eng.abort
      })
      answer = r.text || '(no answer)'
    } catch (err) {
      answer = `ERROR: ${err instanceof Error ? err.message : String(err)}`
    }
```

Change to emit `working` before and a terminal status after (do not mutate the reporting `steps` record — a
live status emit is sufficient for the pill, and the peer is not an owned task step here):

```ts
    eng.emit({ runId: eng.runId, type: 'handoff', askerId: consult.asker, peerId: peer.id, ask: req.ask })
    eng.handoffs.push({ askerId: consult.asker, peerId: peer.id, ask: req.ask })
    eng.emit({ runId: eng.runId, type: 'status', nodeId: peer.id, status: 'working', taskTitles: [req.ask] })
    let answer: string
    try {
      const r = await eng.runAgent({
        wc: eng.wc,
        agentId: peer.id,
        prompt: peerConsultPrompt(getAgent(consult.asker).name, consult.goal, req.ask),
        runId: eng.runId,
        stepId: peer.id,
        permissionMode: consult.actingMode,
        resume: false,
        abort: eng.abort
      })
      answer = r.text || '(no answer)'
      eng.emit({ runId: eng.runId, type: 'status', nodeId: peer.id, status: 'done' })
    } catch (err) {
      answer = `ERROR: ${err instanceof Error ? err.message : String(err)}`
      eng.emit({ runId: eng.runId, type: 'status', nodeId: peer.id, status: 'error' })
    }
```

- [ ] **Step 4: Run to verify the test passes**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "status for the consulted peer"`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck + build**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "fix(handoff): show the consulted peer as working during a consult

Emit working/done(/error) status events for the peer in runWithHandoffs so
its run-tree pill reflects activity instead of staying idle (R2 observability).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (before the opus whole-branch review)

- [ ] `npx vitest run` — full suite green (340 + new tests).
- [ ] `npm run typecheck` (node + web tsc projects) — clean.
- [ ] `npm run build` — renderer bundle builds clean.
- [ ] Re-read the diff for the Global Constraints: off-path byte-for-byte (no populated `handoffs`/no
      consultation section when both settings are 0); no raw answer anywhere in persisted state.

---

## Self-Review (against the spec)

**Spec coverage:**
- §Part 1 (HITL synthesis awareness: `formatUserRequests` + synthNode wiring + synthPrompt) → Task 1. ✓
- §Part 1d (faithful repro / fix-if-real) → Task 2. ✓
- §Part 2 persistence (R2) → Task 3 (collector + generic `collectExtras` seam; mechanism refinement of §2c,
  documented). ✓
- §Part 2 peer status pill → Task 4. ✓
- §Non-goals (planner↔handoff redundancy, handoffs-into-synthesis, S5/transcript changes) → not touched. ✓
- §Testing list → Tasks 1–4 cover `formatUserRequests` unit, synthesis-awareness e2e, faithful HITL repro,
  handoff persistence (worker + review site + off-path), peer status, graph seam. ✓

**Placeholder scan:** Task 10 (review-site test) intentionally leaves the fixture wiring to the implementer
because it must bind to the existing review-site fake in that describe block — the assertion (handoffs persist
at the review site) is concrete; flagged inline, not a silent TODO.

**Type consistency:** `Eng.handoffs` and `NodeIO.collectExtras` signatures are used identically in Tasks 3 and
4 and in the orchestrator wiring; handoff record shape `{ askerId; peerId; ask }` matches `shared/types.ts`
and `toRunRecord`. ✓
