# Human-in-the-Loop User Requests (Stage 3 HITL) — Design

**Status:** Approved (brainstorm 2026-06-26). Ready for implementation plan.

**Goal:** Let a **worker** pause an orchestration run mid-execution to **ask the user a question**, surface that question in a **minimizable modal**, and **resume the same worker's session** with the user's answer so it continues from exactly where it paused. Off by default; when off, runs are **byte-for-byte** identical to today.

This is feature **#5** of the 2026-06-26 seven-feature list (the parked "Stage 3 HITL"). It is the control-flow-heavy one: it wires the **already-built** interrupt/resume plumbing to a real trigger + UI.

---

## Context — current state (verified in code 2026-06-26)

The durable-orchestrator work (Stages 1–2) and Phase 3 (handoffs) already built **almost all** the runtime plumbing. Verified:

- **Types** (`src/shared/types.ts`):
  - `Interrupt { kind: string; prompt: string; payload?: unknown }` (L338).
  - `RunState.pendingInterrupt?: Interrupt` (L398) + `RunState.resumeInput?: unknown` (L400).
  - `LiveRunStatus` includes `'interrupted'` (L333).
  - `OrchestrationEvent` is a discriminated union (L241–258); `RunRecord` (L270) mirrors `handoffs` via `toRunRecord`.
- **Graph driver** (`src/main/engine/graph.ts`):
  - `NodeResult.interrupt?` (L23). A node returning `{ interrupt }` → driver sets `status: 'interrupted'`, `pendingInterrupt`, **keeps `cursor`** (so resume re-enters the same node), persists, returns (L78–89). `res.patch` is merged **before** the interrupt branch (L75).
  - `resumeGraph(graph, runId, store, io, resumeInput?)` (L106–123): when `resumeInput !== undefined` → `{ status:'running', pendingInterrupt: undefined, resumeInput }`, then `runGraph` from the saved cursor. **The paused node reads `state.resumeInput` on re-entry.** Note `pendingInterrupt` is **cleared** here.
- **Orchestrator** (`src/main/engine/orchestrator.ts`):
  - `startRun → drive → runGraph → finishRun`. `finishRun` **returns silently** when `final.status === 'interrupted'` (L98–101) — keeps the checkpoint, does not finalize, **emits nothing**.
  - `resumeRun(wc, runId) → resumeDrive → resumeGraph` already exists but takes **no** `resumeInput` and is **not wired to IPC** (only `startRun`/`stopRun` are, `ipc.ts` L86–89). `resumeDrive` re-emits `run-started`.
  - `active: Map<runId, AbortController>`; `drive().finally(() => active.delete(runId))` — so when a run pauses, `drive` returns and the runId is **removed** from `active`.
- **Execution** (`src/main/engine/nodes.ts`):
  - `executeNode` (L222) clones `tasks`/`steps`, defines `runGroup(ownerId, group)`, runs **waves** of ready tasks grouped by owner via `mapCapped([...byOwner], MAX_PARALLEL, …)` (L300), checkpointing after each group (L270). It is **already re-entrant** in spirit (the wave loop only runs `status === 'pending'` tasks).
  - `runGroup` runs a worker via `runWithHandoffs(eng, base, consultFor(ownerId, …))`, persists the worker's `sessionId` via `updateAgent({ id: ownerId, sessionId })` (L253), marks its group `done`, sets the step output.
  - **Phase 3 mechanism to mirror:** `handoffSection(peers)` (L841) appends an instruction block to the worker prompt; `parseHandoff` (in `src/shared/handoff.ts`) extracts a fenced ` ```handoff ` block (own-line close, last-wins); `runWithHandoffs` (L875) resumes the **asker's own session** via `eng.runAgent({ …, resume: true, resumeSessionId: result.sessionId })` (L904). `consultFor` (L833) returns `null` when `maxHandoffs <= 0` → byte-for-byte.
  - `StreamAgentOptions.resumeSessionId` exists (`agent-runner.ts` L72) and maps to the SDK `--resume` (L117).
  - `seedRunState` (L66) seeds `replanAttempts: 0` etc.; `workerPrompt` (L1168) is pure.
- **Settings** (`shared/types.ts` `ProjectSettings` + `DEFAULT_SETTINGS`): mirror `maxReplans`/`maxHandoffs` (both `0 = off`). `SettingsModal.tsx` already renders `0 = off` numeric fields for both.
- **Renderer:** `store.ts` `applyOrchestration` switches on `e.type`; `RunView.tsx` renders `run.replans`/`run.handoffs` info lines; `HistoryView.tsx` renders `record.handoffs`; `App.tsx` subscribes once via `window.api.onOrchestration` and mounts modals at the top level.

**Conclusion:** the 4 gaps the brainstorm identified are exactly: (1) no trigger, (2) `finishRun` swallows the pause, (3) `resumeRun` takes no answer + no IPC, (4) no modal. Everything else is reuse.

---

## Locked decisions (user, 2026-06-26)

1. **Scope = WORKERS ONLY.** Only the execute phase (`executeNode`/`runGroup`) can ask. Reviewers, managers, the orchestrator, and the handoff peer-consult path **cannot** ask. (Keeps the control flow to one node.)
2. **Answer = free-text, treated as SENSITIVE.** The raw answer is consumed on resume then **never persisted** to `RunState`, the checkpoint, `steps`, `reviews`, or `RunRecord`. The run view + History record **the question, not the answer**. **Honest caveat (documented in-product + here):** the answer necessarily reaches the asking agent's session and may appear in that agent's *output text* (which is stored). We cannot fully scrub it there → the modal steers users to ask for **non-secret** info; secrets belong in `.env`.
3. **Dismiss = SKIP → proceed best-effort.** A **Skip** button resumes the worker with "no answer was provided — make a reasonable assumption and proceed." The run is **never** stuck.
4. **Off by default.** New setting `maxUserRequests` (**default `0` = off**). When `0`, workers are **never told they can ask** (no ask section injected) and any stray ` ```ask ` block is ignored → **byte-for-byte** today. Bounded per run by a new `RunState.userRequestCount` (mirrors `replanAttempts`).
5. **Resume mechanics:** reuse `resumeSessionId` to resume the asking worker's **own** session with the answer (exactly like the handoff path).

---

## Architecture

### Trigger — pure `shared/ask-user.ts` (mirror of `shared/handoff.ts`)

```ts
export interface AskUserRequest { question: string }

/** Parse an ask-user request from worker output, or null. Prefers the LAST
 *  own-line ```ask fenced JSON block with a `question` field. Returns null when
 *  absent, malformed, or `question` is empty/whitespace. */
export function parseAskUser(text: string): AskUserRequest | null
```

- Same extraction shape as `extractHandoffObject`: `/```ask[^\n]*\r?\n([\s\S]*?)\r?\n```/g`, last-wins, own-line close fence, tolerant `{…}` slice + `JSON.parse`.
- Field is `question` (string, trimmed, non-empty). No target resolution (unlike handoff's `to`).
- Pure — no node/DOM imports — unit-tested in plain Node, mirroring `handoff.test.ts`.

### Worker prompt — `askUserSection()` (mirror of `handoffSection()`)

Injected into the worker prompt **only** when asks are available for this run (`maxUserRequests > 0 && userRequestCount < maxUserRequests`). Built in `runGroup` and appended to `base.prompt` **before** the `runWithHandoffs` call (so both sections can coexist when both features are on).

```
You may ASK THE USER one question if you are blocked on information only they can
provide (a decision, a missing detail, a preference). To ask, reply with ONLY this
block and nothing else:
```ask
{ "question": "<exactly what you need from the user>" }
```
Do NOT ask for secrets (API keys, passwords) — those belong in environment files.
Ask only when genuinely blocked; otherwise just finish normally.
```

### State additions (`shared/types.ts`)

- `ProjectSettings.maxUserRequests: number` + `DEFAULT_SETTINGS.maxUserRequests = 0`.
- `RunState.userRequestCount: number` — seeded `0` in `seedRunState`; read defensively as `?? 0`.
- `RunState.pendingAsk?: { ownerId: string; taskIds: string[]; sessionId?: string; question: string }` — **carries the asker across resume** (because `resumeGraph` clears `pendingInterrupt`, not the rest of the state). Holds the worker's in-run `sessionId` so re-entry resumes that exact session. **Never holds the answer.**
- `RunState.userRequests?: { askerId: string; question: string }[]` — recorded questions for the run view + History (mirror of `handoffs`). **Never holds answers.**
- `OrchestrationEvent` new variant: `{ runId: string; type: 'interrupt'; interrupt: Interrupt }`.
- `RunRecord.userRequests?: { askerId: string; question: string }[]`; `toRunRecord` maps it (mirror the `handoffs` spread in `run-state.ts`).
- IPC: `IPC.resumeRun = 'run:resume'`; `RendererApi.resumeRun: (runId: string, answer: string) => Promise<void>`.

The interrupt payload shape (what the modal needs):
```ts
interrupt = {
  kind: 'ask-user',
  prompt: question,                 // the question text
  payload: { askerId, askerName, question }
}
```

### Engine — `executeNode` pause + re-entry (the hard task)

`executeNode` gains two things: **re-entry handling** at the top, and **ask detection** in `runGroup`.

**Local accumulators** (per invocation):
```ts
let userRequestCount = state.userRequestCount ?? 0
const asksAvailable = () => maxUserRequests > 0 && userRequestCount < maxUserRequests
const asks: { ownerId: string; taskIds: string[]; sessionId?: string; question: string }[] = []
const userRequests = [...(state.userRequests ?? [])]
```

**(A) Re-entry after a human answered/skipped** — runs first, guarded by `state.resumeInput !== undefined && state.pendingAsk`:
1. `const answer = String(state.resumeInput ?? '')` — `''` ⇒ **skip**.
2. Resume the asker's session: `eng.runAgent({ agentId: ask.ownerId, prompt: answerResumePrompt(answer), resume: true, resumeSessionId: ask.sessionId, permissionMode: state.actingMode, … })`. `setStatus(working)` → on success persist `updateAgent({ id, sessionId })`, mark **all** `ask.taskIds` `done` with the output, set step output, `setStatus(done)`. On throw: mark group `done` with `ERROR: …`, `setStatus(error)` (same as the normal catch).
3. `userRequestCount += 1`. Checkpoint.
4. Fall through into the normal wave loop for the remaining `pending` tasks.

> **Scrub invariant (load-bearing for the sensitive decision):** **every** `executeNode` return patch — the normal completion (`→ reviewing`), the Phase-2 replan goto (`→ replan`), and the new ask interrupt — includes `resumeInput: undefined`, `pendingAsk: <chosen-or-undefined>`, and the live `userRequestCount`. Because the driver does `state = { ...state, ...patch }` then `store.put(state)`, omitting the clear on any path would persist the raw answer (`resumeInput`) into the checkpoint. Implement by building the cleared fields once and spreading them into all three return objects. (When off, these are all already `undefined`/`0` → no-op → byte-for-byte.)

`answerResumePrompt(answer)`:
- non-empty → `The user answered your question:\n\n${answer}\n\nContinue your task using this. When finished, briefly report what you changed.`
- empty (skip) → `The user did not provide an answer. Make a reasonable assumption and proceed best-effort. When finished, briefly report what you did and note the assumption you made.`

**(B) Ask detection in `runGroup`** — after `runWithHandoffs` returns `{ text, sessionId }`, **before** marking the group `done`:
```ts
if (asksAvailable()) {
  const req = parseAskUser(text)
  if (req) {
    for (const t of group) tasks[t.task.id].status = 'pending'   // revert from 'running'
    asks.push({ ownerId, taskIds: group.map(t => t.task.id), sessionId, question: req.question })
    return   // do NOT mark done; this group waits for the user
  }
}
// …unchanged: mark done, set output, checkpoint…
```

**(C) After each wave** (`mapCapped` resolved), if `asks.length > 0`:
1. Pick the **first** deterministically — sort by plan order (`state.plan.findIndex(p => p.id === a.taskIds[0])`), take `[0]`. (Concurrency makes push-order nondeterministic; sorting makes the choice stable.)
2. Record the question: `userRequests.push({ askerId: chosen.ownerId, question: chosen.question })`.
3. Build `interrupt` (above) with `askerName = getAgent(chosen.ownerId).name`.
4. **Return** `{ patch: { tasks, steps, phase: 'executing', pendingAsk: chosen, userRequests, userRequestCount, resumeInput: undefined }, interrupt }`.
   - The driver merges the patch (checkpointing finished workers + `pendingAsk`), then persists with `pendingInterrupt` + `status: 'interrupted'`.
   - Other askers in the same wave stay `pending`; the **next** wave (after this interrupt resolves) re-runs them → they re-ask → pause again. **One interrupt at a time** (documented). They lose their first-call session (re-run fresh) — acceptable, edge case.

**Off path:** `maxUserRequests === 0` ⇒ `asksAvailable()` is always false ⇒ no ask section injected, `asks` stays empty, no `pendingAsk`/`userRequests`, no interrupt. `executeNode` returns the **same** patch shape as today (the new fields are `undefined` and omitted from `toRunRecord`) → byte-for-byte.

> **Why a dedicated `pendingAsk` field (not the interrupt payload):** `resumeGraph` clears `pendingInterrupt` on resume but preserves the rest of `RunState`. The asker identity + `sessionId` must survive resume to drive the session-resume, so they live in `pendingAsk`, scrubbed when consumed.

### Orchestrator — emit the pause, accept the answer

- **`finishRun`** — when `final.status === 'interrupted'`, before the early return, emit `{ runId, type: 'interrupt', interrupt: final.pendingInterrupt }` (guard on presence). Still keep the checkpoint, still don't finalize.
- **`resumeRun(wc, runId, resumeInput?)`** — thread `resumeInput` → `resumeDrive(wc, runId, abort, resumeInput)` → `resumeGraph(graph, runId, store, io, resumeInput)`.
- **`resumeDrive`** — when `resumeInput !== undefined` (a HITL continuation), **skip** the `run-started` re-emit (the renderer still holds the run; re-emitting would reset the run view). Crash-recovery path (`resumeInput === undefined`) keeps emitting `run-started`.
- `resumeRun` re-registers an `AbortController` in `active` (the runId was removed when `drive` returned at the pause). `stopRun` continues to work during a pause.

### IPC + preload

- `ipc.ts`: `ipcMain.handle(IPC.resumeRun, (e, runId, answer) => orchestrator.resumeRun(e.sender, runId, answer))`.
- `preload/index.ts`: `resumeRun: (runId, answer) => ipcRenderer.invoke(IPC.resumeRun, runId, answer)`.
- `RendererApi.resumeRun` typed above.

### Renderer — store, modal, badge, settings

- **`store.ts`** `RunState` (renderer) gains:
  - `pendingInterrupt: { question: string; askerName: string; askerId: string } | null`
  - `interruptMinimized: boolean`
  - `userRequests: { askerId: string; question: string }[]`
  - `applyOrchestration` `case 'interrupt'`: set `run.pendingInterrupt` from `e.interrupt.payload`, `interruptMinimized = false`, and append `{ askerId, question }` to `run.userRequests`.
  - New actions: `answerInterrupt(answer: string)` → `void window.api.resumeRun(run.runId!, answer)` then clear `pendingInterrupt` (+ reset `interruptMinimized`); `minimizeInterrupt(v: boolean)`.
  - `run-started`/`beginRun` reset the three new fields (in `emptyRun`).
- **`HitlModal.tsx`** (new, mounted in `App.tsx` next to the other modals): visible when `run.pendingInterrupt && !interruptMinimized`. Shows asking agent name + question + a textarea + **Submit** (→ `answerInterrupt(text)`), **Skip** (→ `answerInterrupt('')`), **Minimize** (→ `minimizeInterrupt(true)`). One-line sensitive note: *"This goes to the agent and may appear in its output — don't paste secrets."* Not a hard-blocking backdrop click-to-dismiss (Minimize is the non-destructive exit).
- **Badge:** when `run.pendingInterrupt && interruptMinimized`, a small **non-abrasive** pill (e.g. `❓ <agent> needs you`) that on click calls `minimizeInterrupt(false)`. Placed unobtrusively (top-level, near the run dock). **Not** a blocking overlay.
- **`RunView.tsx`:** render `run.userRequests` as info lines (mirror the `run.handoffs` block): `❓ Asked: <askerName>: <question>`.
- **`HistoryView.tsx`:** render `record.userRequests` as a section (mirror Handoffs): `❓ User requests (n)` listing `<askerName>: <question>`.
- **`SettingsModal.tsx`:** numeric field `Max user questions per run (0 = off)`, `min 0 max 5`, with a one-line description that asks are **workers-only** and the answer reaches the agent (don't share secrets). Mirror the `maxHandoffs` field exactly.

---

## Edge cases & invariants

- **Bounded:** every consumed ask increments `userRequestCount`; once it reaches `maxUserRequests`, the ask section is no longer injected and stray blocks are ignored → no infinite ask loop.
- **One at a time:** the run is sequential; multiple asks in one wave are serialized (first chosen, rest re-ask later). Documented in code comments.
- **Skip never stalls:** empty answer resumes best-effort; the worker always completes.
- **Cancel during pause:** while paused, the run has already left the orchestrator's `active` map (its `drive` returned), so `stopRun(runId)` has no live `AbortController` to abort and is a no-op. The UI therefore **disables the Stop button while a question is outstanding** (`run.pendingInterrupt` set); the user resolves the pause with Submit or Skip, after which the run is back in `active` and Stop aborts the wave loop as usual. (Skip → best-effort is the intended "I don't want to answer" exit; truly abandoning a paused run mid-question is a possible follow-up.)
- **Sensitive scrub:** answer touches only `resumeInput` (transient) and the resumed agent call; it is never copied into `pendingAsk`, `userRequests`, `steps`, `reviews`, `RunRecord`, or the checkpoint's durable fields. (Caveat: agent *output* may echo it.)
- **Crash while interrupted:** there is no active crash-recovery IPC wiring today, so this is out of scope. Defensive note: if `executeNode` re-enters with `pendingAsk` set but `resumeInput === undefined`, it clears `pendingAsk` and the wave loop re-runs the still-`pending` group fresh.

---

## Testing

- **`shared/ask-user.test.ts`** (pure, mirror `handoff.test.ts`): parses a block; last-wins; null on absent/malformed/empty/whitespace; does not match a ` ```json ` verdict block.
- **`shared/run-state.test.ts`**: `toRunRecord` maps `userRequests` when present, omits when absent.
- **`nodes.test.ts`** (extend the existing harness — add `maxUserRequests` to `h.settings`, make `cannedAgent` emit a ` ```ask ` block on a worker's **first** call and real work when the prompt contains the answer-resume marker):
  - `maxUserRequests > 0` + a worker asks → `runGraph` returns `status: 'interrupted'`, `pendingInterrupt.kind === 'ask-user'`, `pendingAsk` set, the asking task still `pending`, finished siblings checkpointed.
  - `resumeGraph(graph, runId, store, io, 'the answer')` → run completes; the asker was resumed (assert a `runAgent` call with `resume: true` + the answer-resume prompt), `userRequestCount === 1`, task `done`, **no answer text in any persisted state field** (`pendingAsk`/`userRequests`/`resumeInput` cleared).
  - Skip: `resumeGraph(…, '')` → completes best-effort.
  - **Off (`maxUserRequests = 0`) regression:** a worker that emits an ` ```ask ` block is treated as ordinary output (task `done`, no interrupt) — proves the off path is byte-for-byte.
- **`orchestrator`-level** (light): `finishRun` emits an `interrupt` event when interrupted; `resumeRun` threads the answer to `resumeGraph` and skips the `run-started` re-emit.

---

## File map

| File | Change |
|---|---|
| `src/shared/ask-user.ts` | **new** — `parseAskUser` |
| `src/shared/ask-user.test.ts` | **new** — mirror `handoff.test.ts` |
| `src/shared/types.ts` | `maxUserRequests` (+default 0); `RunState.userRequestCount`/`pendingAsk`/`userRequests`; `OrchestrationEvent` `interrupt`; `RunRecord.userRequests`; `IPC.resumeRun`; `RendererApi.resumeRun` |
| `src/shared/run-state.ts` | map `userRequests` in `toRunRecord` |
| `src/shared/run-state.test.ts` | cover the mapping |
| `src/main/engine/nodes.ts` | `seedRunState` seeds `userRequestCount`; `askUserSection`; `executeNode` re-entry + `runGroup` ask detection + post-wave interrupt; `answerResumePrompt` |
| `src/main/engine/nodes.test.ts` | interrupt/resume/skip/off tests |
| `src/main/engine/graph.ts` | **no change** (infra exists) |
| `src/main/engine/orchestrator.ts` | `finishRun` emits `interrupt`; `resumeRun(wc,runId,resumeInput)`; `resumeDrive` threads + skips `run-started` on HITL resume |
| `src/main/ipc.ts` | `resumeRun` handler |
| `src/preload/index.ts` | `resumeRun` bridge |
| `src/renderer/store.ts` | `pendingInterrupt`/`interruptMinimized`/`userRequests`; `interrupt` case; `answerInterrupt`/`minimizeInterrupt` |
| `src/renderer/HitlModal.tsx` | **new** — modal + minimized badge |
| `src/renderer/App.tsx` | mount `HitlModal` |
| `src/renderer/run/RunView.tsx` | render `userRequests` lines |
| `src/renderer/run/HistoryView.tsx` | render `record.userRequests` section |
| `src/renderer/SettingsModal.tsx` | `maxUserRequests` field |
| `src/renderer/styles.css` | modal + badge + `run-userrequest` styles |

---

## Out of scope

- Asking by reviewers/managers/orchestrator or in the handoff peer path (workers-only is locked).
- Persisting or auditing answers (sensitive-by-design).
- Multiple simultaneous outstanding questions (serialized, one at a time).
- Active crash-recovery of an interrupted run (no IPC wiring exists today).
