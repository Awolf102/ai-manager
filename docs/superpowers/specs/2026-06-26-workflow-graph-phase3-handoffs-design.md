# Workflow-Graph Canvas — Phase 3: Lateral Peer Handoffs (edge types + handoff runtime)

**Date:** 2026-06-26
**Status:** Approved design, ready for implementation planning
**Roadmap:** #1 (workflow-graph canvas) — **Phase 3 of 3**, scoped to pieces **(1) two edge types + (2) the handoff runtime**. The deferred **two-tier-review v2 escalation** (a manager kicking a mis-scoped task back to be re-planned) is a separate later cycle that reuses Phase 2's `replan` node. Background: memory `ai-manager-workflow-graph`, `ai-manager-architecture`, `ai-manager-two-tier-review`.

## Motivation

Phases 1 (clickable edge ordering) and 2 (goal-locked proactive re-planning) are shipped. The canvas now expresses *order* and the orchestrator can rewrite the plan between stages — but every edge still means only "source delegates to target," and the engine routes edges as a strict reporting **tree** (`childrenOf` recurses down; `parentOf` is the single edge targeting a node). Work only ever flows *down* the tree and bubbles *up*.

The user wants **lateral peer handoffs**: a non-orchestrator role, mid-work, reaches *sideways* to another connected team, which does a focused piece and hands the result back. The motivating examples: a **web developer**, mid-build, asks the **research team** for "expressive, colorful UI ideas" and uses them; a **marketing** reviewer asks **compliance** to check something. Crucially this is **direct, peer-to-peer** — "it does not HAVE to go through the orchestrator" — and applies to **any role, including managers**.

This is the routing-core re-architecture the arc deferred to last: a lateral, possibly-cyclic edge the current tree forbids (the dynamic-spawn cycle-break exists specifically to prevent it). It needs a second edge type layered alongside the reporting tree, plus a runtime for the consult itself, with hard loop bounds.

## Goals

- **Two edge types:** a `GraphEdge.kind` distinguishing the reporting tree (`'report'`, the default) from lateral `'handoff'` lines; authorable on the canvas; visually distinct.
- **The routing tree is unchanged** by handoff edges — `childrenOf`/`parentOf`/`deriveOrderDeps`/`deriveStages`/review all ignore `'handoff'` edges.
- **Handoff runtime:** when enabled, an agent mid-run may **consult a connected peer** — emit a request, the engine runs that peer with the ask, then **resumes the asker's session** with the answer so it continues with its context intact.
- **Both initiation sites:** the executing **worker** (during `executeNode`) and **reviewers** (manager `domainReview` + orchestrator `integrationReview`).
- **Hard-bounded & cycle-free:** a `maxHandoffs` cap per agent-run; the dispatched peer's answer is **terminal** (never re-parsed for handoffs) → no recursion, no A↔B ping-pong.
- **Orchestrator stays in the loop:** handoffs happen *inside* a task/review; the orchestrator still owns the plan + goal and runs the final integration review over the assembled whole. Handoffs are surfaced (not silent), but not per-handoff-approved.
- **Off by default → byte-for-byte today** (`maxHandoffs === 0`, or no handoff edges).

## Non-goals (out of scope, YAGNI)

- **Two-tier-review v2 escalation** (reactive manager kick-back → re-plan). Reuses Phase 2's `replan` node from the review exit — its own later cycle.
- **Orchestrating the peer's whole subtree** to fulfill an ask. A handoff dispatches the **target node as a single agent** answering from its own role + memory; it does NOT re-orchestrate the target's subtree (no recursion, no sub-run).
- **Mid-call custom tools / MCP.** The consult is engine-mediated (output→prompt + session-resume), matching the codebase's "agents never call each other directly" design — no SDK custom-tool/MCP plumbing.
- **Peer chaining.** A peer answering a consult cannot itself hand off (its output is terminal). A node may only initiate handoffs while running its *own* task/review.
- **Handoffs from `plan`/`assign`/`reflect`/`replan` steps.** Only the worker-execution and review sites get peers.

## Decisions locked in brainstorming

- **This cycle = pieces 1 + 2** (edge types + handoff runtime); v2 escalation deferred.
- **Mechanism = engine-mediated request/response** — a structured `handoff` block in the agent's output; the engine runs the peer and **resumes the asker's session** with the answer.
- **Initiation sites = workers (execute) + reviewers (domainReview + integrationReview).**
- **Target dispatch = run the target as ONE agent** answering the ask (run's acting mode so it can do real work); no subtree orchestration, no recursion.
- **Bound = `maxHandoffs` (default 0 = off); peer answer terminal** (structurally cycle-free).
- **Canvas = select an edge + a "Make handoff" / "Make reporting" convert button** (no new mode); reporting solid, handoff dashed + accent.
- **Surfacing = a `handoff` event → Run-view `↪ Handoff` line + History "Handoffs" section.**

## Architecture

### Data model — `src/shared/types.ts`

```ts
export interface GraphEdge {
  id: string
  source: string
  target: string
  order?: number                  // Phase 1 (reporting edges only)
  kind?: 'report' | 'handoff'     // absent/'report' = reporting tree; 'handoff' = lateral consult
}

// ProjectSettings
maxHandoffs: number               // default 0 = off; caps consults per agent-run

// OrchestrationEvent
| { runId: string; type: 'handoff'; askerId: string; peerId: string; ask: string }

// RunState  +  RunRecord (History projection)
handoffs?: { askerId: string; peerId: string; ask: string }[]
```

`DEFAULT_SETTINGS.maxHandoffs = 0` (old graphs read 0 via the load-path `{ ...DEFAULT_SETTINGS, ...graph.settings }` spread — no migration). Existing edges have no `kind` → treated as `'report'` everywhere.

### Routing stays a tree — the byte-for-byte foundation

Handoff edges must be invisible to every reporting-tree consumer:

- `src/main/engine/project-store.ts`:
  - `childrenOf(nodeId)` → only edges with `kind !== 'handoff'`.
  - `parentOf(nodeId)` → the first **reporting** edge targeting the node (`kind !== 'handoff'`).
  - NEW `handoffPeersOf(nodeId): AgentNodeData[]` → targets of this node's outgoing `kind === 'handoff'` edges.
  - `getEdges()` stays raw (returns all edges, incl. handoff).
- `src/shared/workflow-order.ts`: `deriveOrderDeps` and `deriveStages` filter out `kind === 'handoff'` edges before building the child map / teams (a handoff edge from the orchestrator must NOT become an "ordered team" or a stage).

With no handoff edges present, all of the above is identical to today.

### The handoff runtime — one reusable consult-loop

New pure helper `src/shared/handoff.ts`:

```ts
/** Extract a `{ to, ask }` request from a ```handoff fenced block (or bare JSON), or null.
 *  `to` is matched against the peer list by id first, then case-insensitive name. */
export function parseHandoff(
  text: string,
  peers: { id: string; name: string }[]
): { peerId: string; ask: string } | null
```

It scans for a ` ```handoff ... ``` ` fenced block (fallback: a JSON object with `to`+`ask`), parses `{to, ask}`, resolves `to` to a peer id (by id, then name), and returns null if absent, malformed, `ask` empty, or the target isn't a reachable peer.

Engine consult-loop in `src/main/engine/nodes.ts` — a helper that wraps an agent run:

```
runWithHandoffs(eng, baseOpts, peers, maxHandoffs, asker, onPeerName):
  if maxHandoffs <= 0 or peers.length === 0:
     return runAgent(baseOpts)                       // un-augmented, single call → byte-for-byte
  prompt = baseOpts.prompt + handoffSection(peers)   // list peers + how to request
  let { text, sessionId } = runAgent({ ...baseOpts, prompt })
  let count = 0
  while count < maxHandoffs and not aborted:
     req = parseHandoff(text, peers)
     if !req: break
     // dispatch the peer as ONE agent (terminal — its output is not re-parsed)
     setStatus(peer, 'working'); emit { type:'handoff', askerId: asker, peerId: req.peerId, ask: req.ask }
     const { text: answer } = runAgent({ agentId: req.peerId, prompt: peerConsultPrompt(askerName, goal, req.ask),
                                         stepId: req.peerId, permissionMode: actingMode, resume: false, abort })
     // (do NOT persist the peer's sessionId — a consult must not clobber the peer's own task session)
     count++
     ;({ text, sessionId } = runAgent({ ...baseOpts, prompt: resumePrompt(peerName, answer), resume: true }))
  return { text, sessionId }
```

- **Prompt augmentation** (`handoffSection`): *"You may consult these connected teammates for help: <name list>. To consult one, reply with ONLY a ` ```handoff {\"to\":\"<id or name>\",\"ask\":\"<what you need>\"} ``` ` block and stop — you'll receive their answer and can continue. Consult only when it genuinely helps; otherwise finish normally."*
- **Peer consult prompt:** *"Your teammate <asker> is working toward this goal: <goal>. They ask for your help: <ask>. Provide exactly what they need, concisely, using your expertise; you may read files / do focused work."* (run with the run's acting mode so the peer can actually produce the artifact). The peer's output is **terminal** — never parsed for handoffs.
- **Resume prompt:** *"Your teammate <peer> responded to your request:\n<answer>\nContinue your task with this. If you need another consult, emit another handoff block; otherwise finish and report."*
- The asker's session is resumed (`resume:true`) each round, so it keeps full context.

### Wiring the two sites

- **Execution (worker)** — `executeNode`'s `runGroup` replaces its single `runAgent` with `runWithHandoffs(..., peers = handoffPeersOf(ownerId), maxHandoffs)`. The worker's final (post-consult) text is the task output, exactly as before. Effort/acting-mode unchanged.
- **Review (manager + orchestrator)** — handoffs ride **inside `runStructured`** *only when the caller passes `peers`*. `runStructured` gains optional `{ peers, maxHandoffs, asker }`; in its loop it first checks `parseHandoff` on the agent's output — if a handoff block is present (and budget remains), it consults the peer + resumes the agent and continues the loop **without** consuming a JSON-parse retry; otherwise it parses the verdict JSON as today (retry-once-on-bad-JSON preserved). `domainReviewNode`/`integrationReviewNode` pass `peers = handoffPeersOf(reviewerId)`; `planStep`/`assignStep`/`reflectStep`/`replanStep` pass none → unaffected. The review prompt's augmentation explains "either consult a teammate (handoff block) OR give your verdict JSON."

DRY: `parseHandoff` (pure) is shared; the dispatch+resume step is one private `consultPeer` helper used by both `runWithHandoffs` (worker) and the `runStructured` loop (review).

### Orchestrator-in-the-loop

Handoffs are scoped inside a task/review run; they never bypass the plan or goal. The orchestrator still does the final `integrationReview` over the assembled whole vs plan+goal (a worker's handoff-informed output is reviewed like any other). Visibility — not approval — keeps the orchestrator/user "in the loop" (the rejected orchestrator-mediated model required per-handoff routing).

### Canvas authoring — `src/renderer/canvas/OrgChart.tsx`, `styles.css`

- `onConnect` is unchanged — a dragged connection creates a **reporting** edge.
- **Select + convert:** `onEdgeClick` (when *not* in Order mode) sets a `selectedEdgeId`; a `<Panel>` toolbar renders for the selected edge with **"Make handoff"** (or **"Make reporting"** when it's already a handoff) → flips `kind` via `setEdges`. `onPaneClick` clears the selection.
- `toEdges`: handoff edges render `className:'edge-handoff'`, `animated:false`, dashed + a distinct accent color (CSS `stroke-dasharray` + color); reporting edges render as today (ordered ones keep their number). `edgeSig` includes `kind` so a convert re-renders.
- Order mode untouched: it stamps order only on top-level **reporting** edges; a handoff edge clicked in Order mode is ignored.

### Surfacing — `store.ts`, `RunView.tsx`, `HistoryView.tsx`, `run-state.ts`

- `handoff` event → store appends `{ askerId, peerId, ask }` to `run.handoffs`.
- **RunView:** a `↪ Handoff: <asker> → <peer>: <ask>` line in the run-tree (styled like the Phase-2 `⚡ Re-planned` banner); names resolved from the graph; the peer's own agent output streams into its pane (it runs with `stepId = peerId`).
- **HistoryView:** a "Handoffs (n)" section in `RunDetail`; `toRunRecord` projects `handoffs`.

## Data flow

Canvas: draw a reporting edge → select it → **Make handoff** → `GraphEdge.kind='handoff'` → `graph.json`. At run time (when `maxHandoffs>0`): a worker in `executeNode` (or a reviewer in `domainReview`/`integrationReview`), augmented with its `handoffPeersOf(...)` list, may emit a `handoff` block → the engine runs the peer with the ask (`stepId=peerId`, emits the `handoff` event) → resumes the asker with the answer → repeats up to `maxHandoffs` → the asker's final output flows on exactly as before (review/repair/reflect/synthesize unchanged).

## Error handling / edge cases

- **`maxHandoffs === 0` or no handoff peers** → `runWithHandoffs`/`runStructured` run the agent once, un-augmented → **byte-for-byte today**.
- **Malformed / non-peer handoff block** → `parseHandoff` returns null → the agent's output is used as-is (worker output, or parsed as a verdict in review).
- **Cap reached** → further handoff blocks are not honored; the agent's latest output is taken. (Optionally the final resume prompt can note "no more consults available"; not required.)
- **Peer emits a handoff-looking block** → ignored (peer output is terminal) → no recursion / ping-pong.
- **Peer consult fails** (agent error) → the answer is the error text; the asker is resumed with it and continues (a consult failure never aborts the run), mirroring `runGroup`'s existing error handling.
- **Handoff to a peer whose own task hasn't run yet** → fine; the peer answers as an agent from its role/memory + current filesystem (it isn't required to have completed its task).
- **Handoff edges + Phase 1/2** → ignored by `deriveOrderDeps`/`deriveStages`/`childrenOf`, so ordering, stages, re-plan, and routing are unaffected.
- **A handoff edge that forms a cycle in the graph** → harmless: it's never traversed by routing (tree-only), and the runtime can't loop on it (peer terminal + cap).
- **Consult must not clobber the peer's task session** → the peer consult runs `resume:false` and its `sessionId` is NOT persisted via `updateAgent`.

## Testing

- **Pure unit — `src/shared/handoff.test.ts`**: `parseHandoff` extracts `{peerId, ask}` from a ` ```handoff ``` ` block; resolves `to` by id and by case-insensitive name; returns null when absent, malformed, `ask` empty, or `to` isn't a reachable peer; takes the last block if multiple.
- **Pure unit — `src/shared/workflow-order.test.ts`**: a `kind:'handoff'` edge from the orchestrator is ignored by `deriveOrderDeps` (no added deps) and `deriveStages` (no stage); reporting edges still work.
- **`src/main/engine/project-store.test.ts`**: `childrenOf`/`parentOf` exclude handoff edges; `handoffPeersOf` returns only handoff targets.
- **`src/shared/run-state.test.ts`**: `toRunRecord` projects `handoffs` when present, omits when absent.
- **`src/main/engine/nodes.test.ts`** (canned-agent seam):
  - **worker consult:** `maxHandoffs:1`, a handoff edge worker→peer; the worker's first output emits a handoff block, the peer runs with the ask, the worker is resumed with the answer and finishes → assert the peer ran with the `ask`, a `handoff` event fired, the asker's session was resumed, the final task output reflects the answer.
  - **reviewer consult:** a manager `domainReview` emits a handoff block then (after the consult) its verdict JSON → assert the consult happened and the verdict still parsed.
  - **cap:** the asker keeps emitting handoff blocks; only `maxHandoffs` consults occur, then the run finishes.
  - **peer-terminal:** a dispatched peer whose output contains a handoff-looking block is NOT re-dispatched.
  - **off control:** `maxHandoffs:0` with a handoff edge present → no peer dispatch, no event, byte-for-byte (existing assertions hold).
- **Renderer** (`OrgChart`/`RunView`/`HistoryView`/`SettingsModal`): typecheck + build (house precedent).

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/types.ts` | `GraphEdge.kind?`; `ProjectSettings.maxHandoffs` (+ `DEFAULT_SETTINGS=0`); `handoff` `OrchestrationEvent`; `RunState.handoffs?`; `RunRecord.handoffs?` |
| `src/shared/handoff.ts` (NEW) + `.test.ts` | pure `parseHandoff(text, peers)` |
| `src/shared/workflow-order.ts` + `.test.ts` | `deriveOrderDeps`/`deriveStages` ignore `kind:'handoff'` edges |
| `src/shared/run-state.ts` + `.test.ts` | `toRunRecord` projects `handoffs` |
| `src/main/engine/project-store.ts` | `childrenOf`/`parentOf` exclude handoff; NEW `handoffPeersOf` |
| `src/main/engine/nodes.ts` + `.test.ts` | `runWithHandoffs` + `consultPeer` + `handoffSection`/`peerConsultPrompt`/`resumePrompt`; `runGroup` wired; `runStructured` gains optional peers (review sites only); `handoff` event; settings gate |
| `src/renderer/store.ts` | `run.handoffs` + `handoff` reducer |
| `src/renderer/canvas/OrgChart.tsx` | edge-select + convert toolbar; `toEdges` renders handoff (dashed); `edgeSig` includes `kind` |
| `src/renderer/run/RunView.tsx` + `HistoryView.tsx` | handoff line + History section |
| `src/renderer/SettingsModal.tsx` | `maxHandoffs` field |
| `src/renderer/styles.css` | `.edge-handoff` + handoff-line styling |

**Untouched:** the wave loop / stage scheduling (handoffs are orthogonal), the `replan` node, `graph.ts`.

## Risks / edge cases

- **Byte-for-byte regression** — the load-bearing guarantee. Mitigation: `runWithHandoffs`/`runStructured` only augment + parse when `maxHandoffs > 0` AND peers exist; `childrenOf`/`parentOf`/`deriveOrderDeps`/`deriveStages` exclude handoff edges; `GraphEdge.kind` is additive. Pinned by the "off control" test.
- **Non-termination** — two backstops: the per-run `maxHandoffs` cap, and the **terminal peer** rule (peer output never re-parsed) → no chains, no A↔B ping-pong. Handoff cycles in the graph are never traversed (routing is tree-only).
- **Review-path complexity** — handoffs share the `runStructured` JSON-retry loop; the design checks `parseHandoff` *before* the JSON parse and does not consume a retry on a consult. Covered by the reviewer-consult test.
- **Session hygiene** — the peer consult is `resume:false` and does not persist the peer's `sessionId`, so a consult never corrupts the peer's own task session.
- **Selection UX** — converting requires selecting an edge; ensure `onEdgeClick` outside Order mode sets the selection and the toolbar reflects the current `kind` (Make handoff ↔ Make reporting).
