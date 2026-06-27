# Plain-English Run Narration — Design

**Status:** Approved (brainstorm 2026-06-27). Ready for implementation plan.

**Goal:** Give the Run view a whole-run **activity feed** that narrates, in plain English, what every agent is doing — derived deterministically from each agent's tool calls — shown alongside the existing raw terminal. **Live-only**, **zero token cost**, **no engine behavior change**.

This is feature **#4** of the 2026-06-26 seven-feature list.

---

## Context — current state (verified in code 2026-06-27)

- **The stream already carries structured tool calls.** `main/engine/agent-runner.ts` `streamAgent` iterates SDK messages; for an assistant `tool_use` block it has `block.name` (e.g. `Bash`, `Edit`, `Read`, `Grep`, …) and `block.input` (the structured args), and emits an `AgentStreamEvent` `{ kind: 'tool_use', text: '⚙ <name> <json>' }` (agent-runner.ts ~L142-144). Claude Code's `Bash` tool input includes a `description` field (the agent's own one-line summary of the command).
- **`AgentStreamEvent`** (`shared/types.ts` ~L169) = `{ agentId, runId, stepId?, kind, text, sessionId?, isFinal? }`. `kind` ∈ `system|assistant|tool_use|tool_result|result|error|stderr`. The renderer subscribes via `window.api.onAgentStream` (`preload` → `IPC.agentStream`).
- **Run view** (`src/renderer/run/RunView.tsx`) is a CSS grid `230px 1fr` (`.runview`): left `.run-tree` (agent rows + status pills + the replan/handoff/userRequest info lines), right `.run-output` — a single xterm host that buffers each agent's stream by `agentId` (a `useRef<Map>`) and live-writes the **selected** agent (`run.selectedStepId`). Buffers clear on `run.runId` change. `selectStep(id)` selects an agent.
- **Renderer store** (`src/renderer/store.ts`): `run` holds `runId`, `selectedStepId`, status maps, etc. `applyOrchestration` handles orchestration events; `onAgentStream` is consumed directly in RunView (not via the store).
- **History** (`HistoryView.tsx`) renders the saved `RunRecord` (per-agent final `output`, reviews, reflections). Tool-by-tool activity is **not** persisted today (only the final step output is).

**Conclusion:** the narration source already exists on the wire (structured tool calls). The feature is (1) a pure name→phrase mapper, (2) one extra field on the `tool_use` event, (3) a new read-only feed component. No `RunState`/`RunRecord`/engine-control changes.

---

## Locked decisions (brainstorm 2026-06-27)

1. **Source = derived from tool calls** (no summarizer model, agents do not self-narrate). A pure mapper turns each `tool_use` into a friendly phrase; `Bash` reuses the agent's `description`.
2. **Placement = whole-run activity feed.** The Run view's right pane splits vertically: the plain-English feed on top, the raw terminal below. The feed is chronological across **all** agents.
3. **Live-only.** Not saved to `RunRecord`/History; no `RunState` change. (History replay is a possible later add — out of scope.)
4. **Always on.** Pure presentation — no token cost, no engine effect, no agent-behavior risk — so no settings flag. The raw terminal is always still present, so nothing is hidden.

---

## Architecture

### 1. Pure mapper — `shared/narrate.ts` (new, unit-tested)

```ts
/** Turn one tool call into a short plain-English phrase for the activity feed.
 *  Pure — no node/DOM imports — unit-tested in plain Node (like shared/effort.ts). */
export function narrateTool(name: string, input: unknown): string
```

Mapping (`input` is read defensively — any field may be missing/non-string):

| Tool name | Phrase |
|---|---|
| `Bash` | `input.description` (trimmed) if a non-empty string; else `` Running `<command, ≤80 chars>` `` |
| `Read` | `Reading <basename(file_path)>` |
| `Edit`, `MultiEdit` | `Editing <basename(file_path)>` |
| `Write` | `Writing <basename(file_path)>` |
| `NotebookEdit` | `Editing <basename(notebook_path)>` |
| `Grep` | `Searching for "<pattern, ≤60 chars>"` |
| `Glob` | `Finding files: <pattern>` |
| `WebFetch` | `Fetching <host(url)>` (host only; falls back to the raw url) |
| `WebSearch` | `Searching the web: <query, ≤60 chars>` |
| `TodoWrite` | `Updating the task list` |
| `Task` | `Delegating to a subagent` (append `: <description>` when present) |
| name starting `mcp__` | `Using <tool> (<server>)` parsed from `mcp__<server>__<tool>` |
| anything else | `Using <name>` |

Helpers (module-local, pure): `basename(p)` (last `/`-or-`\`-segment, falls back to the whole string), `host(u)` (best-effort host via a regex — no `URL`/DOM dependency so it stays Node-pure), `clip(s, n)`.

### 2. Wire-up — one new optional field

- `shared/types.ts`: add `narration?: string` to `AgentStreamEvent`.
- `agent-runner.ts`: when emitting the `tool_use` event, also compute it:
  ```ts
  } else if (block.type === 'tool_use') {
    send('tool_use', `\x1b[36m⚙ ${block.name}\x1b[0m ${oneLine(JSON.stringify(block.input))}\r\n`,
      { narration: narrateTool(block.name, block.input) })
  }
  ```
  No other event kind carries `narration`. This is the only main-process change; existing terminal output is unchanged (byte-for-byte) — the new field rides alongside.

### 3. UI — `src/renderer/run/ActivityFeed.tsx` (new) + RunView split

**`ActivityFeed`** is a self-contained read-only component:
- Subscribes to `window.api.onAgentStream` in a `useEffect` (its own subscription, mirroring RunView's pattern). For each event with a truthy `narration`, it appends `{ id, agentId, text: narration, time }` to a capped list (keep the most recent **200**; drop older). `time` is stamped on receipt via `new Date()` (renderer — allowed).
- Resolves the agent name from the store graph (`useStore(s => s.graph)` → `nodes.find`), falling back to `agentId`.
- Clears its list when `run.runId` changes (a `useEffect` keyed on `runId`, like RunView's buffer-clear).
- Renders newest-at-bottom, auto-scrolled to the end on append (a bottom-anchored scroll container). Each row: `<time> · <agentName> · <narration>`, the agent name tinted. Clicking a row calls `selectStep(agentId)` so the raw terminal below jumps to that agent.
- Empty state: `No activity yet.`

**RunView layout change:** wrap the right grid cell so the feed sits above the terminal:
```tsx
<div className="runview">
  <div className="run-tree"> … </div>
  <div className="run-right">
    <ActivityFeed runId={run.runId} />
    <div className="run-output" ref={hostRef} />
  </div>
</div>
```
`.runview` stays `grid-template-columns: 230px 1fr`. `.run-right` is `display:flex; flex-direction:column; min-height:0; overflow:hidden`. The feed gets a bounded share (e.g. `flex: 0 0 38%` with its own `overflow-y:auto`); `.run-output` gets `flex:1; min-height:0`. RunView's existing `ResizeObserver`→`fit.fit()` keeps the xterm fitted in its smaller box (the observer already watches `hostRef`).

**State location:** the feed list lives in `ActivityFeed`'s local state (a `useRef` buffer + a `useState` tick to render), NOT the zustand store — it is ephemeral and live-only, matching how RunView keeps terminal buffers in a ref. This keeps the store lean and RunView focused.

---

## Edge cases & invariants

- **No narration on non-tool events.** Only `tool_use` carries `narration`; the feed ignores everything else. Assistant reasoning text stays in the raw terminal only (feed stays glanceable).
- **Bash without a description.** Falls back to `` Running `<command>` `` (clipped). Empty/whitespace description ⇒ treated as absent.
- **Malformed/missing input.** `narrateTool` never throws; a tool with no recognizable fields yields `Using <name>` (or the clipped command for Bash).
- **Cap.** The feed holds ≤200 rows; older rows drop (live view, not a log). Documented so it doesn't read as "complete history."
- **New run.** Switching/starting a run clears the feed (keyed on `runId`), exactly like the terminal buffers.
- **Off-impact.** The sole engine-side change is one computed string attached to an event already sent every tool call. No run behaves differently; nothing is persisted.

---

## Testing

- **`shared/narrate.test.ts`** (pure, mirrors `effort.test.ts`): one assertion per tool — Bash with `description`; Bash without `description` (falls back to clipped command); Edit/MultiEdit/Write/Read basename extraction (incl. nested + Windows-style paths); Grep pattern quoting + clip; Glob; WebFetch host extraction (and url fallback); WebSearch query clip; TodoWrite; Task with/without description; `mcp__github__create_issue` → `Using create_issue (github)`; an unknown tool → `Using <name>`; and malformed input (non-object / missing fields) returns a safe phrase without throwing.
- **No renderer unit test** is mandated (the renderer has only `goalbar-keys.test.ts`; `ActivityFeed` is presentational and event-driven). The component is covered by typecheck + the whole-branch review + live smoke. Do not fabricate an assertion-free test.

---

## File map

| File | Change |
|---|---|
| `src/shared/narrate.ts` | **new** — `narrateTool` + pure helpers |
| `src/shared/narrate.test.ts` | **new** — per-tool unit tests |
| `src/shared/types.ts` | add `narration?: string` to `AgentStreamEvent` |
| `src/main/engine/agent-runner.ts` | import `narrateTool`; attach `narration` to the `tool_use` emit |
| `src/renderer/run/ActivityFeed.tsx` | **new** — the whole-run feed component |
| `src/renderer/run/RunView.tsx` | wrap the right cell in `.run-right`; mount `<ActivityFeed>` |
| `src/renderer/styles.css` | `.run-right`, `.activity-feed`, `.activity-row` styles; keep `.run-output` working in a flex child |

---

## Out of scope

- Persisting narration to `RunRecord`/History replay (live-only is locked; a later add).
- A settings flag / on-off toggle (always on; the raw terminal is always present).
- Narrating assistant reasoning text, tool results, or summarizing with a model.
- Resizable/collapsible split (a fixed flex share is enough; resizing is a possible later polish).
