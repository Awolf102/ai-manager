# Pluggable Agent Harnesses — The Harness Seam — Design

**Phase-3 mini-phase #15, sub-project 1 of 2** (the harness-abstraction interface + Claude-SDK refactor). Date: 2026-07-05. Status: approved, pre-implementation.

## Framing: this is a mini-phase, decomposed

Feature #15 makes each agent's **runtime ("harness") pluggable**: today every agent runs on one runtime — the Claude Agent SDK, driven through `query({ options })`. #15 keeps the Claude SDK as one implementation behind a new harness-abstraction interface the orchestrator targets, and adds others. The first alternate harness chosen is a **native OpenAI-Agents SDK harness** (the native ChatGPT path — no Anthropic gateway); LangGraph is a later candidate.

This is **orthogonal to #3 (model backends)**: #3 is the model-*backend* axis *within* the Claude-SDK harness (Anthropic-API-compatible endpoints via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`); #15 is the *runtime* axis. #3's spec (`2026-07-02-model-backends-design.md` §"Relationship to pluggable harnesses") explicitly reserved `AgentNodeData.harness` (default `'claude-sdk'`) with `backendId` applying when `harness === 'claude-sdk'` — so the backend work needs no rework.

The mini-phase decomposes into two sub-projects, each its own brainstorm → spec → plan → SDD → review → merge cycle:

- **SP1 — The Harness Seam (THIS spec):** the harness-abstraction interface + refactor the existing Claude-SDK path behind it. A dormant `harness` field, a real dispatcher, **byte-for-byte proof that a single-harness app is unchanged**. No user-facing behavior change.
- **SP2 — First alternate harness (future spec):** a native `OpenAiAgentsHarness` behind the interface, the harness-selector UI, and the `claude-sdk`-only gates (backend/PTY). This is where the Claude-shaped option fields reveal what needs neutralizing, and where the in-process-vs-subprocess implementation question is actually built.

## Goal (SP1)

Introduce a harness-abstraction seam the orchestrator targets, and move the existing Claude-SDK path behind it as the first (and, in SP1, only) implementation. When every agent uses the default harness (`'claude-sdk'`, the absent-field default), behavior is **byte-for-byte** identical to today: the emitted `AgentStreamEvent`s, the `query` `Options`, the composed prompt, and the `{ text; sessionId? }` return are unchanged, and `graph.json` on disk is unchanged.

## Why this works (feasibility — grounded in the current code)

The abstraction seam **already exists**. Every orchestrated LLM call funnels through one function-typed field on the engine's dependency object:

```ts
// src/main/engine/nodes.ts
export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>
export interface Eng { /* … */ runAgent: AgentRunner /* … */ }
```

Production wiring binds it to `streamAgent` in `orchestrator.ts` (the `makeDeps`/deps construction, ~line 89):
```ts
runAgent: (opts) => streamAgent({ ...opts, header: headerGate(...) }),
```

All engine dispatch flows through this one field — the 8 `eng.runAgent` call sites (worker execute, repair, synthesize, HITL-resume, follow-through-ask-resume, and the consult/handoff turns) plus the 5 structured-JSON calls (`planStep`, `assignStep`, `reviewStep`, `integrationReviewStep`, `reflectStep`, via `runStructured` → `runWithHandoffs`). **`nodes.ts` never imports the SDK.** The SDK is imported in exactly two files: `agent-runner.ts` (`streamAgent`) and `advisor.ts` (`streamAdvisor`).

Therefore the harness interface is *already extracted and battle-tested*: `StreamAgentOptions` is the input; `AgentStreamEvent` (streamed over IPC) + `{ text; sessionId? }` (returned) is the output. SP1 only needs to (a) name that shape as an interface, (b) route through a registry keyed by `agent.harness`, and (c) register the current `streamAgent` as the `'claude-sdk'` implementation. Because the dispatcher only *adds* a lookup-and-route above the existing seam, and only `'claude-sdk'` is registered, every call resolves to today's `streamAgent` — the pass-through **is** the byte-for-byte guarantee.

**Verified against current code (2026-07-05):** `grep -rn "harness" src/` returns zero hits — the `harness` field does **not** exist yet; it is only reserved in the #3 spec. SP1 adds it.

## Data model

```ts
// src/shared/types.ts
export type HarnessId = 'claude-sdk'   // SP2 widens: | 'openai-agents'

export interface AgentNodeData {
  // …existing fields (id, name, slug, kind, icon, model, permissionMode,
  //   skills?, backendId?, sessionId?, memberId?, position)…
  harness?: HarnessId   // absent ⇒ 'claude-sdk' (the default). No UI sets it in SP1.
}
```

- **Optional field, resolved as `harness ?? 'claude-sdk'` at read time** ⇒ **no `graph.json` migration**; existing projects are byte-identical on disk, and `openProject`'s DEFAULT-merge needs no change (absent is the semantic default, not a value to backfill).
- The single-member union `HarnessId = 'claude-sdk'` is intentional: declare only what ships. SP2 widens the union and registers the new implementation. Tests exercise the *dispatch mechanism* for a second harness via a cast (see Testing), without shipping a real second `HarnessId` value.
- `HarnessId` (a pure string union) lives in `src/shared/types.ts` so the future selector UI and `AgentNodeData` can import it. The runtime `Harness` interface (below) lives in main, because it references `StreamAgentOptions`, which references Electron's `WebContents`.

## The `Harness` interface (main-process only)

```ts
// src/main/engine/harness/types.ts
import type { StreamAgentOptions } from '../agent-runner'

export interface Harness {
  run(opts: StreamAgentOptions): Promise<{ text: string; sessionId?: string }>
}
```

Verbatim the existing seam (the approved "keep current shapes" decision). `StreamAgentOptions` is **not** moved or neutralized in SP1 — it stays Claude-shaped (Claude tool names in `disallowedTools`, Claude's `permissionMode` enum, `effort`, a live `WebContents`, `modelOverride`, `resumeSessionId`, `header`). SP2's real second harness reveals which of those fields actually need harness-neutral mapping; guessing that abstraction now would be premature.

## Registry + dispatcher

```ts
// src/main/engine/harness/registry.ts
import type { StreamAgentOptions } from '../agent-runner'
import { streamAgent } from '../agent-runner'
import { getAgent } from '../project-store'
import type { HarnessId } from '../../../shared/types'
import type { Harness } from './types'

const claudeSdkHarness: Harness = { run: streamAgent }   // wrap in place — zero code movement

const registry: Record<HarnessId, Harness> = {
  'claude-sdk': claudeSdkHarness,
}

/** Resolve a harness, defaulting absent/unknown ids to claude-sdk (defensive). */
export function harnessFor(id: HarnessId | undefined): Harness {
  return (id && registry[id]) || claudeSdkHarness
}

/** Read an agent's harness id without ever throwing (a bad/missing id must not break a run). */
function harnessIdFor(agentId: string): HarnessId | undefined {
  try {
    return getAgent(agentId)?.harness
  } catch {
    return undefined   // unknown/absent agent ⇒ default harness
  }
}

/** The orchestrator's single dispatch entry point. Reads the agent's harness and routes. */
export function dispatchAgent(
  opts: StreamAgentOptions,
): Promise<{ text: string; sessionId?: string }> {
  return harnessFor(harnessIdFor(opts.agentId)).run(opts)
}
```

- The dispatcher reads the harness id from the project store **per call** (an in-memory read — no I/O, no behavioral effect on the stream), then routes. This keeps `StreamAgentOptions` unmodified (no `harness` field threaded through it) — honoring "keep verbatim." The lookup is wrapped so it can **never** throw into a run (matching the codebase's "a helper error must not break a run" posture); in production the agent id always resolves, so the wrap is defense-in-depth.
- **Accessor caveat (verify at implementation time):** use the existing synchronous single-agent accessor in `project-store.ts` — confirm its exact name (`getAgent`) and its unknown-id behavior. Per project memory, `getAgent` has thrown on an unresolved id before; `harnessIdFor`'s `try/catch` tolerates either a throw or an `undefined` return, so the dispatcher is correct regardless of which contract holds.
- `harnessFor(undefined)` and `harnessFor('claude-sdk')` both return the claude harness; an unregistered id (only reachable via a test cast in SP1) also falls back to claude. In SP1, with only `'claude-sdk'` registered and no UI to set the field, `dispatchAgent` **always** resolves to `streamAgent`.
- **Import direction:** `orchestrator → harness/registry → { agent-runner, project-store }`. `agent-runner` does **not** import `harness` (avoids a cycle). Verified: `streamAgent`/`agent-runner` have no dependency on the new module.

## The single wiring change

```ts
// src/main/engine/orchestrator.ts  (the runAgent binding, ~line 89)
- runAgent: (opts) => streamAgent({ ...opts, header: headerGate(...) }),
+ runAgent: (opts) => dispatchAgent({ ...opts, header: headerGate(...) }),
```

The `header` gate stays wrapped **outside** dispatch, so the claude harness receives identical `opts` (including `header`). `nodes.ts` and every one of its dispatch/structured call sites are **untouched** — they already target `Eng.runAgent`, which is exactly the property that makes this a one-line rewire.

## Deliberately NOT touched in SP1 (all → SP2)

Confirmed with the user during the design gate:

- **`resolveBackendEnv` / `backendId` gating and the interactive PTY** (`buildClaudeArgs`/`spawnPty`, `pty-manager.ts`). No non-claude agent can exist in SP1 (no UI sets `harness`), so a `harness === 'claude-sdk'` guard on these paths would be a dead branch. SP2 adds those guards when a non-claude agent first becomes possible — that is exactly when they are needed (an OpenAI agent must not receive `ANTHROPIC_*` env or a `claude` PTY).
- **`runHeadless`** (the manual "Run" button, in `agent-runner.ts`). It stays calling `streamAgent` directly. Routing it through `dispatchAgent` would create an `agent-runner ↔ harness` import cycle; SP2 restructures it (e.g. moving the manual-run entry above `agent-runner`, or having the harness module own it). Byte-for-byte in the meantime — the manual run is claude-only in practice.
- **The Advisor** (`streamAdvisor`, `advisor.ts`). It is a distinct, fixed product surface (a read-only chat assistant on the Claude login, emitting `AdvisorStreamEvent`, not a pluggable per-agent runtime). It stays Claude-only and outside the harness abstraction.
- **No UI.** With one harness there is nothing to select. The selector arrives in SP2 alongside the second harness.

## Execution-model stance (informs SP2, not SP1's interface)

Every `Harness` is an **in-process TS object** implementing `run()`. Whether a given harness's guts call the Claude SDK, an in-process JS SDK (OpenAI-Agents), or spawn and manage a subprocess (e.g. a Python LangGraph) is an **internal implementation detail hidden behind the same `run()` signature**: the in-process shim holds the `WebContents` and translates its runtime's output into `AgentStreamEvent`s. Consequently the in-process-vs-subprocess question does **not** fork the interface, and SP1's design does not depend on it. (Recorded here so SP2 inherits the decision.)

## Byte-for-byte invariant

The load-bearing invariant, held to the same discipline as #16/#9's off-path: **for an agent with `harness` absent or `'claude-sdk'`, the emitted `AgentStreamEvent`s, the `query` `Options`, the composed prompt, and the `{ text; sessionId? }` return are identical to calling `streamAgent` directly**, and `graph.json` is unchanged on disk (no new field is written for existing agents). The only added work on the hot path is one in-memory `getAgent` lookup in the dispatcher, which has no observable effect on the stream or return.

## Testing

Against the existing `nodes.test.ts` injected-runner seam plus a new `harness/registry.test.ts`:

1. **Dispatch identity (byte-for-byte).** `dispatchAgent`, for an agent whose `harness` is absent or `'claude-sdk'`, invokes the registered claude harness with the **exact same** `opts` object and returns its result verbatim (spy asserts argument-identity and return pass-through). This is the structural byte-for-byte proof at the seam.
2. **Routing.** Register a **fake** second harness under a cast `HarnessId`, set a test agent's `harness` to it (with `getAgent` mocked to return that agent), and assert `dispatchAgent` routes to the fake — proving the seam dispatches on the field **without** shipping a real second harness.
3. **Fallback (defensive).** `harnessFor(undefined)`, `harnessFor('claude-sdk')`, and `harnessFor(<unknown-cast-id>)` all return the claude harness; `dispatchAgent` for an agent id that `getAgent` doesn't resolve falls back to claude.
4. **Full pipeline unchanged.** The entire `nodes.test.ts` suite (plan → route → execute → review → repair → reflect → synthesize, incl. resume/effort/handoff/HITL paths) stays green unchanged — it injects a fake `runAgent`, so it already models the seam; SP1 must not perturb it.
5. **Type-level.** `Harness.run`'s signature is identical to `AgentRunner` (a compile-time check / assignment test), guaranteeing SP2 harnesses satisfy the engine seam.

UI: N/A (no UI in SP1). Integration gates: `npm run typecheck && npm run test` (implementers), `npm run build` (controller). `npm run lint` is not required (no renderer changes), but harmless to run.

## File-by-file

- `src/shared/types.ts` — add `HarnessId`; add `harness?: HarnessId` to `AgentNodeData`.
- `src/main/engine/harness/types.ts` — **new**; the `Harness` interface.
- `src/main/engine/harness/registry.ts` — **new**; `harnessFor` + `dispatchAgent` + the registry.
- `src/main/engine/harness/registry.test.ts` — **new**; the tests above.
- `src/main/engine/orchestrator.ts` — one-line `runAgent` binding change (`streamAgent` → `dispatchAgent`).

No changes to `nodes.ts`, `agent-runner.ts`, `pty-manager.ts`, `advisor.ts`, `backend-resolve.ts`, `project-store.ts` (beyond the type it already imports), the renderer, IPC, or preload.

## Why the interface pays off (SP2 preview)

SP2 becomes: write `class OpenAiAgentsHarness implements Harness` (builds its own agent context, calls the OpenAI-Agents SDK in-process, reuses the `safeStorage` credential store for `OPENAI_API_KEY`, translates its event stream → `AgentStreamEvent`, formats ANSI terminal text), then `registry['openai-agents'] = new OpenAiAgentsHarness()`, add the `harness === 'claude-sdk'` gates on backend/PTY, and add the selector UI. **Zero changes to `nodes.ts` or the dispatcher** — exactly the property this seam is designed to deliver.

## Out of scope (SP1)

- The native OpenAI-Agents harness itself (SP2).
- The harness-selector UI (SP2).
- `claude-sdk`-only gating of `resolveBackendEnv`/`backendId` and the interactive PTY (SP2).
- Routing `runHeadless` (manual Run) through the dispatcher (SP2).
- Neutralizing `StreamAgentOptions` into a harness-agnostic vocabulary (deferred until SP2's real second harness reveals the true seams).
- The Advisor (`streamAdvisor`) — stays Claude-only, outside the abstraction.
- LangGraph and any subprocess harness (later candidates; the execution-model stance already accommodates them without an interface change).
