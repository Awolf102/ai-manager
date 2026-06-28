# HITL Secret-Handling Truth-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the app from durably storing a HITL user answer in its own records — redact echoed answers from persisted step output, scrub the abort-path checkpoint, and make the modal copy truthful about the SDK session transcript.

**Architecture:** A pure `redactUserAnswer` helper in `shared/ask-user.ts` is applied at the single point where the resumed worker's output is captured in `nodes.ts`; a one-line scrub on the `graph.ts` abort branch; a copy change in `HitlModal.tsx`. No new state, no engine-flow change.

**Tech Stack:** TypeScript, Electron, React renderer, Vitest, electron-vite.

## Global Constraints

- Test runner **Vitest**. Commands: `npm test` (= `vitest run`), `npm run typecheck` (node+web), `npm run build`.
- Pure modules in `src/shared/` have **no node/DOM imports**.
- `MIN_REDACT_LEN = 6`. Placeholder string: `[user answer redacted]`.
- `redactUserAnswer` gates on the **trimmed** answer length and redacts the **trimmed** answer with a literal `split/join` (no `RegExp`).
- Off-by-default unchanged: `maxUserRequests = 0` ⇒ the resume path never runs ⇒ byte-for-byte. `redactUserAnswer` runs only on the HITL resume path.
- Each task leaves `npm run typecheck` + `npm test` green before its commit.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/shared/ask-user.ts` | + pure `redactUserAnswer` + `MIN_REDACT_LEN` | 1 |
| `src/shared/ask-user.test.ts` | + `redactUserAnswer` unit tests | 1 |
| `src/main/engine/nodes.ts` | apply redaction at the resume capture point | 2 |
| `src/main/engine/nodes.test.ts` | + echoed-answer-redacted integration test | 2 |
| `src/main/engine/graph.ts` | scrub `resumeInput` on the abort branch | 3 |
| `src/main/engine/graph.test.ts` | + abort-after-resume scrubs `resumeInput` test | 3 |
| `src/renderer/HitlModal.tsx` | truthful answer-handling copy | 3 |

**Order:** 1 → 2 → 3 (Task 2 consumes Task 1; Task 3 is independent).

---

### Task 1: `redactUserAnswer` pure helper

**Files:**
- Modify: `src/shared/ask-user.ts`
- Test: `src/shared/ask-user.test.ts`

**Interfaces:**
- Produces: `redactUserAnswer(text: string, answer: string): string` and `const MIN_REDACT_LEN = 6`.

- [ ] **Step 1: Write the failing tests** — add to `src/shared/ask-user.test.ts` (it already imports from `./ask-user`; add `redactUserAnswer` to that import):

```typescript
describe('redactUserAnswer', () => {
  it('redacts every verbatim occurrence of a >=6-char answer', () => {
    expect(redactUserAnswer('I used TealSecret123 then TealSecret123 again', 'TealSecret123'))
      .toBe('I used [user answer redacted] then [user answer redacted] again')
  })
  it('trims the answer before matching and gating', () => {
    expect(redactUserAnswer('set to hunter2secret done', '  hunter2secret  '))
      .toBe('set to [user answer redacted] done')
  })
  it('leaves text unchanged when the trimmed answer is shorter than 6 chars', () => {
    // also proves no substring carnage: "no" must not blank out "node"
    expect(redactUserAnswer('the node said no', 'no')).toBe('the node said no')
  })
  it('leaves text unchanged for an empty/whitespace answer', () => {
    expect(redactUserAnswer('anything here', '')).toBe('anything here')
    expect(redactUserAnswer('anything here', '   ')).toBe('anything here')
  })
  it('leaves text unchanged when the answer does not appear', () => {
    expect(redactUserAnswer('no secret here', 'TealSecret123')).toBe('no secret here')
  })
})
```

- [ ] **Step 2: Run, verify fail** — `npm test -- ask-user` → FAIL (`redactUserAnswer is not a function`).

- [ ] **Step 3: Implement** — append to `src/shared/ask-user.ts`:

```typescript
/** Minimum trimmed-answer length to redact. Short answers (decisions like "yes",
 *  "no", "B") are not secrets and a literal replace of them would mangle normal
 *  prose (e.g. "no" inside "node"); secrets (keys, passwords, tokens, URLs) are long. */
export const MIN_REDACT_LEN = 6

/**
 * Redact a user's HITL answer from text the app will persist (e.g. an agent's echoed
 * output). Replaces every verbatim occurrence of the TRIMMED answer with a placeholder,
 * but only when the trimmed answer is at least MIN_REDACT_LEN chars. Verbatim only — a
 * paraphrase is not caught (documented limitation). Literal string replace, no RegExp.
 */
export function redactUserAnswer(text: string, answer: string): string {
  const a = answer.trim()
  if (a.length < MIN_REDACT_LEN) return text
  return text.split(a).join('[user answer redacted]')
}
```

- [ ] **Step 4: Run, verify pass** — `npm test -- ask-user` → PASS. `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(s5): redactUserAnswer pure helper for HITL answer redaction"`

---

### Task 2: Apply redaction at the resume capture point

**Files:**
- Modify: `src/main/engine/nodes.ts` (the HITL resume output capture, ~line 257)
- Test: `src/main/engine/nodes.test.ts` (the existing HITL `describe` block around lines 1300-1408)

**Interfaces:**
- Consumes: `redactUserAnswer` from `../../shared/ask-user` (Task 1).

- [ ] **Step 1: Write the failing integration test** — in `src/main/engine/nodes.test.ts`, first extend the existing `askingAgent()` helper so its resume branch can echo the answer. Find its resume branch (currently):

```typescript
      if (p.includes('The user answered') || p.includes('did not provide an answer')) {
        calls.push({ agentId: id, kind: 'resume', prompt: p })
        return { text: `resumed ${id}`, sessionId: 's2-' + id }
      }
```

Add an optional parameter to `askingAgent` and make the resume echo the prompt (which contains the answer) when set. Change the helper signature `function askingAgent() {` → `function askingAgent(opts?: { echoAnswerOnResume?: boolean }) {` and the resume branch to:

```typescript
      if (p.includes('The user answered') || p.includes('did not provide an answer')) {
        calls.push({ agentId: id, kind: 'resume', prompt: p })
        const text = opts?.echoAnswerOnResume ? `resumed ${id}: ${p}` : `resumed ${id}`
        return { text, sessionId: 's2-' + id }
      }
```

(Existing callers pass no args → `echoAnswerOnResume` is undefined → unchanged behavior.)

Then add the new test inside the same `describe` block (after the `resume with an answer …` test):

```typescript
  it('redacts an echoed answer from the asking worker’s persisted output', async () => {
    h.settings.maxUserRequests = 2
    const { runAgent } = askingAgent({ echoAnswerOnResume: true })
    const e = eng(runAgent)
    const store = fakeStore()
    const io = makeIO(e.abort.signal, store)
    await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      io
    )
    const secret = 'TealSecret123' // >= 6 chars, unique
    const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, secret)
    expect(final.status).toBe('completed')
    // the worker echoed the answer, but the persisted output is redacted
    expect(final.tasks['t1'].output).toContain('[user answer redacted]')
    expect(final.tasks['t1'].output).not.toContain(secret)
    // the raw answer appears NOWHERE in persisted state — INCLUDING steps[].output
    expect(JSON.stringify(final)).not.toContain(secret)
  })
```

- [ ] **Step 2: Run, verify fail** — `npm test -- nodes` → the new test FAILS (`final.tasks['t1'].output` still contains `TealSecret123`; `JSON.stringify(final)` contains it).

- [ ] **Step 3: Implement** — in `src/main/engine/nodes.ts`:
  1. Add `redactUserAnswer` to the ask-user import (currently `import { parseAskUser } from '../../shared/ask-user'`):

```typescript
import { parseAskUser, redactUserAnswer } from '../../shared/ask-user'
```

  2. At the resume capture point (currently `const out = r.text || '(no output)'`), redact using the in-scope `answer`:

```typescript
      const out = redactUserAnswer(r.text || '(no output)', answer)
```

- [ ] **Step 4: Run, verify pass** — `npm test -- nodes` → PASS (new test + all existing HITL tests green). `npm run typecheck` → PASS. Run the full suite once: `npm test` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(s5): redact echoed HITL answer from persisted worker output"`

---

### Task 3: Abort-path scrub + truthful modal copy

**Files:**
- Modify: `src/main/engine/graph.ts` (the abort branch, ~lines 54-56)
- Test: `src/main/engine/graph.test.ts` (mirror the existing error-scrub test at ~line 233)
- Modify: `src/renderer/HitlModal.tsx` (the answer warning copy, ~lines 39-41)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing graph test** — in `src/main/engine/graph.test.ts`, add inside `describe('runGraph', …)`, using the file's existing helpers (`mkState`, `fakeStore`, `io`, `CompiledGraph`, `END`) exactly as the sibling test `'stops with status cancelled when the signal is already aborted'` (~line 111) does. It seeds `resumeInput` in the initial state and aborts before the loop:

```typescript
  it('scrubs resumeInput from the cancelled checkpoint when aborted after consuming an answer', async () => {
    const store = fakeStore()
    const ac = new AbortController()
    ac.abort() // already aborted → driver hits the abort branch at the top of the loop
    const graph: CompiledGraph = {
      entry: 'a',
      edges: { a: END },
      nodes: { a: async () => ({}) }
    }
    const out = await runGraph(graph, mkState({ resumeInput: 'a-sensitive-answer' }), store, io(ac.signal, store))
    expect(out.status).toBe('cancelled')
    expect(out.resumeInput).toBeUndefined()
    // the persisted checkpoint is scrubbed too
    expect(store.puts.at(-1)?.resumeInput).toBeUndefined()
  })
```

- [ ] **Step 2: Run, verify fail** — `npm test -- graph` → the new test FAILS (`out.resumeInput` is still `'a-sensitive-answer'`).

- [ ] **Step 3: Implement the abort scrub** — in `src/main/engine/graph.ts`, the abort branch currently reads:

```typescript
    if (io.signal.aborted) {
      state = { ...state, status: 'cancelled', updatedAt: now() }
      break
    }
```

Change to (symmetric with the error branch's `resumeInput: undefined`):

```typescript
    if (io.signal.aborted) {
      state = { ...state, status: 'cancelled', resumeInput: undefined, updatedAt: now() }
      break
    }
```

- [ ] **Step 4: Run, verify pass** — `npm test -- graph` → PASS.

- [ ] **Step 5: Update the modal copy** — in `src/renderer/HitlModal.tsx`, the warning line currently reads:

```tsx
        Your answer is sent to the agent and may appear in its output — don't paste secrets.
```

Replace with the truthful version:

```tsx
        Your answer is sent to the agent and saved in its session transcript (like any prompt). We redact it
        from the run history — but don't paste true secrets (API keys, passwords).
```

- [ ] **Step 6: Verify everything** — `npm test` → PASS. `npm run typecheck` → PASS. `npm run build` → PASS (renderer changed).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "fix(s5): scrub resumeInput on abort path + truthful HITL answer copy"`

---

## Self-Review (completed by plan author)

- **Spec coverage:** §2 redaction → Tasks 1+2. §3 abort scrub → Task 3. §4 truthful copy → Task 3. §5 memory fix → post-merge (not a code task; the controller updates the `ai-manager-hitl-stage3` memory after merge). §6 tests → each task's test steps. §7 non-goals honored (no transcript deletion, no #30/#12 UX). All sections mapped.
- **Placeholder scan:** code shown for every code step; the one "placeholder names" note in Task 3 Step 1 explicitly instructs mirroring the sibling test's real helpers (the test harness in graph.test.ts must be matched, not guessed) — flagged, not a silent TBD.
- **Type consistency:** `redactUserAnswer(text, answer): string` + `MIN_REDACT_LEN` defined in Task 1, imported+applied identically in Task 2; `[user answer redacted]` placeholder consistent across Tasks 1/2 and the spec.
