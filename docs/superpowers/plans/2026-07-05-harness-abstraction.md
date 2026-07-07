# Harness Abstraction (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a harness-abstraction seam the orchestrator targets, and move the existing Claude-SDK path behind it as the first (and only) implementation — with a byte-for-byte guarantee that a single-harness app is unchanged.

**Architecture:** The engine already funnels every orchestrated LLM call through one function-typed field, `Eng.runAgent: (opts: StreamAgentOptions) => Promise<{ text; sessionId? }>`, bound to `streamAgent` in `orchestrator.ts`. SP1 names that shape as a `Harness` interface, adds a registry keyed by `AgentNodeData.harness` (default `'claude-sdk'`), registers `streamAgent` as the `'claude-sdk'` harness, and rewires the one binding to a `dispatchAgent` that reads the agent's harness and routes. No `nodes.ts` change; no UI; no PTY/backend change.

**Tech Stack:** TypeScript, Electron (main process), Vitest (node environment). The Claude Agent SDK is dynamically imported inside `streamAgent` — untouched here.

## Global Constraints

- **Byte-for-byte invariant (load-bearing):** for an agent whose `harness` is absent or `'claude-sdk'`, the emitted `AgentStreamEvent`s, the `query` `Options`, the composed prompt, and the `{ text; sessionId? }` return must be identical to calling `streamAgent` directly, and `graph.json` on disk must be unchanged (no field written for existing agents). Same discipline as the #16/#9 off-path invariants.
- **Keep `StreamAgentOptions` verbatim.** Do NOT neutralize or add fields to it. The `Harness` interface uses today's shapes exactly.
- **No UI, no PTY change, no `resolveBackendEnv`/`backendId` gating, no `runHeadless` rerouting, no Advisor change** — all deferred to SP2. This plan touches only: `src/shared/types.ts`, `src/main/engine/harness/*` (new), and `src/main/engine/orchestrator.ts`.
- **Single-member union:** `HarnessId = 'claude-sdk'` (declare only what ships). Tests use a cast for a not-yet-real id.
- **Integration gates:** implementers run `npm run typecheck` + `npm run test`; the controller runs `npm run build`. `npm run lint` is not required (no renderer changes).
- **Spec:** `docs/superpowers/specs/2026-07-05-harness-abstraction-design.md`.

---

### Task 1: The harness module — `HarnessId` type, `Harness` interface, registry + dispatcher

**Files:**
- Modify: `src/shared/types.ts` (add `HarnessId` after `AgentKind` ~line 9; add `harness?` field to `AgentNodeData` after `backendId` ~line 57)
- Create: `src/main/engine/harness/types.ts`
- Create: `src/main/engine/harness/registry.ts`
- Test: `src/main/engine/harness/registry.test.ts`

**Interfaces:**
- Consumes: `StreamAgentOptions` (from `../agent-runner`); `streamAgent(opts: StreamAgentOptions): Promise<{ text: string; sessionId?: string }>` (from `../agent-runner`); `getAgent(agentId: string): AgentNodeData` (from `../project-store`, throws `Error('Unknown agent: …')` on miss).
- Produces:
  - `type HarnessId = 'claude-sdk'` and `AgentNodeData.harness?: HarnessId` (in `src/shared/types.ts`).
  - `interface Harness { run(opts: StreamAgentOptions): Promise<{ text: string; sessionId?: string }> }` (in `harness/types.ts`).
  - `harnessRegistry: Record<HarnessId, Harness>`, `harnessFor(id: HarnessId | undefined): Harness`, `dispatchAgent(opts: StreamAgentOptions): Promise<{ text: string; sessionId?: string }>` (in `harness/registry.ts`). `dispatchAgent` is signature-compatible with `Eng['runAgent']`.

- [ ] **Step 1: Add the `HarnessId` type and the `AgentNodeData.harness` field**

In `src/shared/types.ts`, immediately after the `AgentKind` line (`export type AgentKind = 'orchestrator' | 'director' | 'manager' | 'worker'`), add:

```ts
/** The runtime an agent executes on. Absent ⇒ 'claude-sdk' (the default). SP2 widens this union. */
export type HarnessId = 'claude-sdk'
```

In the `AgentNodeData` interface, immediately after the `backendId?: string` line (and its doc comment), add:

```ts
  /** the runtime this agent executes on; absent = 'claude-sdk' (the default, byte-for-byte) */
  harness?: HarnessId
```

- [ ] **Step 2: Write the failing test**

Create `src/main/engine/harness/registry.test.ts` with exactly this content:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { StreamAgentOptions } from '../agent-runner'
import type { HarnessId } from '../../../shared/types'
import type { Harness } from './types'

const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))
// Mock the Claude-SDK harness so no test path touches the real SDK; the mock IS the registered
// 'claude-sdk' harness's run (registry.ts imports { streamAgent } from '../agent-runner').
vi.mock('../agent-runner', () => ({
  streamAgent: vi.fn(async () => ({ text: 'claude-ran', sessionId: 'sid-claude' }))
}))

import { openProject, createAgent, updateAgent, getGraph } from '../project-store'
import { streamAgent } from '../agent-runner'
import { harnessFor, dispatchAgent, harnessRegistry } from './registry'

let proj: string
beforeEach(async () => {
  vi.clearAllMocks() // clears call history; keeps the streamAgent mock implementation
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-harness-'))
  await openProject(proj)
  await createAgent({ name: 'W', kind: 'worker' })
})
afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

const worker = () => getGraph().nodes.find((n) => n.name === 'W')!
const opts = (agentId: string): StreamAgentOptions => ({
  wc: {} as unknown as WebContents,
  agentId,
  prompt: 'hi',
  runId: 'r1'
})

describe('harnessFor', () => {
  it('resolves claude-sdk, undefined, and unknown ids all to the claude-sdk harness', () => {
    expect(harnessFor('claude-sdk').run).toBe(streamAgent)
    expect(harnessFor(undefined).run).toBe(streamAgent)
    expect(harnessFor('nope' as HarnessId).run).toBe(streamAgent)
  })
})

describe('dispatchAgent', () => {
  it('routes an agent with no harness to the claude-sdk harness, passing opts through and returning its result', async () => {
    const o = opts(worker().id)
    const res = await dispatchAgent(o)
    expect(streamAgent).toHaveBeenCalledTimes(1)
    expect(streamAgent).toHaveBeenCalledWith(o) // same opts object — byte-for-byte passthrough
    expect(res).toEqual({ text: 'claude-ran', sessionId: 'sid-claude' })
  })

  it('routes on the harness field to a registered alternate harness', async () => {
    const fakeRun = vi.fn(async () => ({ text: 'fake-ran' }))
    const fake: Harness = { run: fakeRun }
    harnessRegistry['openai' as HarnessId] = fake
    try {
      await updateAgent({ id: worker().id, harness: 'openai' as HarnessId })
      const res = await dispatchAgent(opts(worker().id))
      expect(fakeRun).toHaveBeenCalledTimes(1)
      expect(streamAgent).not.toHaveBeenCalled()
      expect(res).toEqual({ text: 'fake-ran' })
    } finally {
      delete harnessRegistry['openai' as HarnessId]
    }
  })

  it('falls back to the claude-sdk harness (never throws) when the agent id does not resolve', async () => {
    const res = await dispatchAgent(opts('ghost-id'))
    expect(streamAgent).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ text: 'claude-ran', sessionId: 'sid-claude' })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -- registry.test.ts`
Expected: FAIL — `Cannot find module './registry'` (and `./types`).

- [ ] **Step 4: Create the `Harness` interface**

Create `src/main/engine/harness/types.ts`:

```ts
import type { StreamAgentOptions } from '../agent-runner'

/**
 * A pluggable agent runtime. The engine's Eng.runAgent seam targets this shape.
 * Every harness is an in-process object; whether run() internally uses the Claude
 * SDK, an in-process JS SDK, or manages a subprocess is hidden behind this signature.
 */
export interface Harness {
  run(opts: StreamAgentOptions): Promise<{ text: string; sessionId?: string }>
}
```

- [ ] **Step 5: Create the registry + dispatcher**

Create `src/main/engine/harness/registry.ts`:

```ts
import { streamAgent } from '../agent-runner'
import { getAgent } from '../project-store'
import type { StreamAgentOptions } from '../agent-runner'
import type { HarnessId } from '../../../shared/types'
import type { Harness } from './types'

/** The Claude Agent SDK harness — the current (and, in SP1, only) runtime. */
const claudeSdkHarness: Harness = { run: streamAgent }

/**
 * Runtimes keyed by HarnessId. SP2 registers additional harnesses here, e.g.
 *   harnessRegistry['openai-agents'] = new OpenAiAgentsHarness()
 * Widening HarnessId forces a matching entry (Record<HarnessId, Harness>).
 */
export const harnessRegistry: Record<HarnessId, Harness> = {
  'claude-sdk': claudeSdkHarness
}

/** Resolve a harness, defaulting absent/unknown ids to claude-sdk (defensive). */
export function harnessFor(id: HarnessId | undefined): Harness {
  return (id && harnessRegistry[id]) || claudeSdkHarness
}

/** Read an agent's harness id without ever throwing (a bad/missing id must not break a run). */
function harnessIdFor(agentId: string): HarnessId | undefined {
  try {
    return getAgent(agentId).harness
  } catch {
    return undefined // unknown/absent agent ⇒ default harness
  }
}

/** The orchestrator's single dispatch entry point: read the agent's harness and route. */
export function dispatchAgent(
  opts: StreamAgentOptions
): Promise<{ text: string; sessionId?: string }> {
  return harnessFor(harnessIdFor(opts.agentId)).run(opts)
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -- registry.test.ts`
Expected: PASS (4 tests: 1 `harnessFor` + 3 `dispatchAgent`).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Confirms `HarnessId`/`harness` resolve, `dispatchAgent` is well-typed, and `Record<HarnessId, Harness>` is satisfied by the single `'claude-sdk'` entry.)

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/main/engine/harness/
git commit -m "feat(harness): Harness interface + registry/dispatcher (#15 SP1)"
```

---

### Task 2: Rewire the orchestrator to dispatch through the harness seam

**Files:**
- Modify: `src/main/engine/orchestrator.ts` (imports + the `runAgent` binding at ~lines 10, 89–90)

**Interfaces:**
- Consumes: `dispatchAgent` (from `./harness/registry`, produced by Task 1). Its signature is identical to `streamAgent`'s, so it is a drop-in for the existing binding.
- Produces: nothing new — production LLM dispatch now flows through `dispatchAgent` (which routes to `streamAgent` for every claude-sdk/absent agent, i.e. all of them in SP1).

- [ ] **Step 1: Verify `streamAgent` is used nowhere else in the file**

Run: `grep -n "streamAgent" src/main/engine/orchestrator.ts`
Expected: exactly two lines — the import (line 10) and the `runAgent` binding (line 90). If any other usage appears, keep the `streamAgent` import; otherwise remove it in Step 2.

- [ ] **Step 2: Swap the import and the binding**

In `src/main/engine/orchestrator.ts`, remove the `streamAgent` import line:

```ts
import { streamAgent } from './agent-runner'
```

and add (next to the other engine-module imports, e.g. after the `./graph` import):

```ts
import { dispatchAgent } from './harness/registry'
```

Then change the `runAgent` binding (currently ~lines 89–90):

```ts
  const runAgent: Eng['runAgent'] = (opts) =>
    streamAgent({ ...opts, header: headerGate(headersPrinted, opts.agentId, opts.header) })
```

to:

```ts
  const runAgent: Eng['runAgent'] = (opts) =>
    dispatchAgent({ ...opts, header: headerGate(headersPrinted, opts.agentId, opts.header) })
```

The `header` gate stays wrapped outside dispatch, so the claude-sdk harness receives identical `opts`.

- [ ] **Step 3: Run the full test suite to prove no regression (byte-for-byte)**

Run: `npm run test`
Expected: PASS — the entire pre-existing suite (incl. `nodes.test.ts`, `orchestrator.header.test.ts`, and every SDK/backend/paired-dir path) is unchanged and green, plus Task 1's `registry.test.ts`. This is the byte-for-byte regression gate: production now routes through `dispatchAgent`, and every agent still resolves to `streamAgent`, so behavior is identical.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/orchestrator.ts
git commit -m "feat(harness): route orchestrator LLM dispatch through the harness seam (#15 SP1)"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- Data model (`HarnessId` + `AgentNodeData.harness?`) → Task 1 Step 1. ✓
- `Harness` interface (main-only, verbatim shapes) → Task 1 Step 4. ✓
- Registry + dispatcher (`harnessFor`, defensive `harnessIdFor`, `dispatchAgent`) → Task 1 Step 5. ✓
- Single wiring change (`orchestrator.ts` binding) → Task 2 Step 2. ✓
- Byte-for-byte invariant → Task 1's passthrough/identity test + Task 2's full-suite regression gate. ✓
- Testing strategy (dispatch identity, routing-on-field, defensive fallback, full pipeline unchanged) → Task 1 Steps 2/6 + Task 2 Step 3. ✓
- Deliberately-not-touched (PTY, backend gate, `runHeadless`, Advisor, UI) → excluded by Global Constraints; no task touches them. ✓
- Accessor caveat (`getAgent` may throw) → handled by `harnessIdFor`'s `try/catch` + tested by the "ghost-id" fallback test. ✓

**2. Placeholder scan** — no TBD/TODO; every code step shows complete, runnable content; the test file is given in full. ✓

**3. Type consistency** — `HarnessId`, `Harness`, `harnessRegistry`, `harnessFor`, `harnessIdFor`, `dispatchAgent`, and the `{ text: string; sessionId?: string }` return are named identically across the interface block, Task 1's code, and Task 2's consumption. `dispatchAgent`'s signature matches `streamAgent`'s exactly (drop-in for the `Eng['runAgent']` binding). `getAgent` returns non-null `AgentNodeData` (throws on miss), so `getAgent(agentId).harness` needs no optional chaining. ✓
