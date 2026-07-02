# The Advisor — Design

**Phase-3 Wave C.** Date: 2026-07-02. Status: approved, pre-implementation. Unifies features #1 (folder-select prompt engineering), #2 (suggest best AI service), #5 (tech-stack by budget/scale), #7 (command-center chatbot) into ONE Advisor assistant.

## Goal

A project-grounded, multi-turn **chat assistant** that helps (especially non-technical) users plan what to build, pick AI services/models, choose a tech stack by budget/scale, and engineer prompts — optionally grounded in a selected folder. It **advises**, and can **hand off** a structured brief to the existing team-build flow (never auto-executes). It is **additive**: it does not touch the run engine, orchestrator, or existing agent runs; if never opened it has zero effect.

## Reach (the Wave C ↔ Wave D seam)

**Advise + safe hand-off.** The Advisor produces recommendations and, when ready, a structured **brief** (goal + optional recommended stack/settings/backend/team). Hand-off and state changes are **confirm-then-apply**, never automatic:
- "Send to team builder" seeds the goal into the existing GoalBar; the user then triggers the shipped `spawnTeam`/`startRun`.
- "Apply settings" changes only whitelisted safe knobs via `updateSettings`, after a confirm.
- Security-sensitive settings (autonomy/permissions) are **advisory text only — never applyable**.

The brief shape is the contract **Wave D's Director will later consume directly**; MVP hand-off is via `goal → spawnTeam`.

## Architecture

### 1. Standalone model call (main) — `src/main/engine/advisor.ts`

`streamAdvisor(wc, input): { turnId }` where `input = { message: string; sessionId?: string; focusPath?: string; model?: string }`. The main process **generates the `turnId`** (`randomUUID`) and returns it synchronously (mirrors `runHeadless` returning a `runId`); the async turn then streams events tagged with that `turnId`.

- Calls the SDK `query()` **directly** (net-new; the only other `query()` is inside `streamAgent`) on the **user's existing Claude login** — no agent node, no backend, no token. Dynamic `import('@anthropic-ai/claude-agent-sdk')` like `agent-runner.ts`.
- **Multi-turn:** resume via `options.resume = sessionId` when provided; capture the new `session_id` from the stream and emit it on the `done` event so the renderer round-trips it on the next turn (same mechanism agents use).
- **Options:**
  - `cwd: focusPath ?? projectPath`
  - `model: input.model ?? 'claude-sonnet-4-6'`
  - `systemPrompt: { type: 'preset', preset: 'claude_code', append: advisorSystemPrompt(ctx) }`
  - `disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']` — **read-only** (Read/Glob/Grep remain so it can inspect code for grounded prompt help; it can never modify or execute).
  - `permissionMode: 'default'` — write/exec tools are already disallowed, so nothing can modify or run regardless of autonomy.
  - `abortController` — one per turn, tracked in a `Map<turnId, AbortController>` (mirrors `runHeadless`); removed on completion.
- **Streaming:** emit **plain-text deltas** (assistant text blocks) to a new IPC event `advisor:stream` as `{ turnId, kind: 'delta' | 'done' | 'error', text, sessionId? }`. This is chat-shaped — NOT the ANSI-formatted `agentStream`. Tool-use blocks are **not** streamed as chat text in v1 (a subtle "reading files…" indicator is deferred).
- On completion: emit `{ kind: 'done', sessionId }`. On abort: `{ kind: 'done' }` with partial text already streamed. On error: `{ kind: 'error', text: message }`.
- `cancelAdvisor(turnId)` aborts the tracked controller.

### 2. System-prompt composer (pure) — in `src/shared/advisor.ts`

`advisorSystemPrompt(ctx: AdvisorContext): string` where `AdvisorContext = { projectName: string; settings: ProjectSettings; backends: { label: string; models: string[] }[]; digest?: string }`.

- Emits the Advisor role: concise, practical; helps plan/pick services+models/stack + prompt engineering; explains trade-offs; **when it has a concrete recommendation to hand off, emits a single fenced ` ```brief ` JSON block** (schema below) in addition to its prose.
- Injects grounding: project name; the current token-efficiency knob VALUES (`outputMode`, `effortThrift`/`effortThriftCeiling`, `cheapModelWorkers`/`cheapModelTier`, `lightPrompts`, `adaptiveEffort`, `autoAssignModels`); the configured backends as **labels + model ids only** (NEVER tokens or base URLs); and the optional folder `digest`.
- Pure (no node/DOM); the main process assembles `ctx` from `getSettings()` + `getBackends()` (mapping to labels+models) + an optional digest.

### 3. Folder digest (main) — `src/main/engine/advisor.ts`

`folderDigest(absPath): Promise<string>` — a shallow, bounded listing (top-level entries, capped ~60; read `package.json` scripts if present), reusing the `projectDigest` approach already in `manifest-detector.ts`. Only computed when a `focusPath` is set. Keeps the grounding cheap; deeper inspection is the read-only tools' job during the turn.

### 4. Brief parse + settings whitelist (pure) — `src/shared/advisor.ts`

```ts
interface AdvisorBriefTeamMember { name: string; kind: 'manager' | 'worker'; role: string }
interface AdvisorBrief {
  goal?: string
  summary?: string
  stack?: string[]
  settings?: Partial<Pick<ProjectSettings,
    'outputMode' | 'effortThrift' | 'effortThriftCeiling' |
    'cheapModelWorkers' | 'cheapModelTier' | 'lightPrompts' |
    'adaptiveEffort' | 'autoAssignModels'>>
  backendPresetId?: string
  team?: AdvisorBriefTeamMember[]
}
```

- `parseBrief(text): AdvisorBrief | null` — extract the fenced ` ```brief ` block (tolerant, mirrors `parseManifest` in `run-manifest.ts`); `JSON.parse`; return `null` when absent or unparseable.
- `applyableSettings(brief): Partial<ProjectSettings>` — filters `brief.settings` to the WHITELIST above (drops any other key, esp. `autonomy`/`lockBypassPermissions`/`blockPluginHooks`/permission-related), so a hallucinated or malicious brief can never change security posture. The renderer only ever offers this filtered subset.

### 5. UI (renderer) — `src/renderer/AdvisorModal.tsx`

- Opened by a top-bar **✦ Advisor** button. Reuses the `Modal` component (named export + `modal-header`/`modal-title`/`modal-body`, per the codebase convention).
- **Message list:** user + assistant bubbles; assistant text streams in via the `advisor:stream` subscription (append deltas to the in-flight assistant message keyed by `turnId`).
- **Input:** a textarea (Enter = send, Shift+Enter = newline) + Send; a **Stop** button while a turn is streaming (calls `cancelAdvisor`).
- **Model dropdown:** per-conversation, defaults sonnet, reuses `MODELS` (haiku for cheap/fast). Transient — not persisted.
- **Focus folder chip:** a small control to pick a folder via a new `advisor:pickFolder` IPC (opens the native directory dialog and returns the chosen absolute path or `null` — **no side effect**, unlike `addContextFolder` which records a context folder), setting `focusPath`; clearable; shown as a chip. Grounds #1.
- **Recommendation card:** when an assistant message's text yields a `parseBrief` result, render a card beneath it with the confirm-gated actions (§ Apply actions).
- **New chat:** clears messages + sessionId + focusPath.
- Conversation state (messages, sessionId, focusPath, streaming turnId) lives in a Zustand store slice — **in-memory, not persisted across app restarts (v1)**.
- Styling: reuse `Modal` + minimal new chat-bubble CSS (`.advisor-*`), on-brand (Obsidian & Emerald), no new design language.

### 6. Apply actions (renderer, all confirm-then-apply)

From a message's parsed brief:
- **Send to team builder** (if `goal`): a new store action `seedGoal(text)` sets the GoalBar's goal (GoalBar reads it), then closes/blurs the Advisor and focuses the GoalBar. The user reviews and triggers the shipped `spawnTeam`/`startRun`. No auto-execute.
- **Apply settings** (if `applyableSettings(brief)` non-empty): a `requestConfirm` dialog lists the exact changes → `window.api.updateSettings(applyableSettings(brief))` → `setGraph`.
- **Set up backend** (if `backendPresetId`): opens the existing `BackendsModal`.
- `stack`/`summary`/`team` render as read-only text/suggestions.

### 7. IPC / preload / RendererApi

- `advisor:send` (invoke, `{ message, sessionId?, focusPath?, model? }` → `{ turnId }` — main generates the turnId), `advisor:cancel` (send, `turnId`), `advisor:stream` (main→renderer event), `advisor:pickFolder` (invoke → `string | null`).
- `RendererApi`: `sendAdvisor(input) => Promise<{ turnId }>`, `onAdvisorStream(cb) => () => void` (mirrors `onAgentStream`), `cancelAdvisor(turnId) => void`, `pickAdvisorFolder() => Promise<string | null>`.
- **Stream/turnId race:** the renderer subscribes to `advisor:stream` once (global) and matches events by `turnId`; the in-flight assistant message is created lazily on the first `delta` for a `turnId` (or when `sendAdvisor` resolves), so a delta arriving before the invoke resolves is not lost.
- A `seedGoal` is renderer-only store state (no IPC).

## Security / safety

- **Read-only:** write/exec tools disallowed — the Advisor cannot modify files or run commands.
- **Project settings trust boundary:** like the main run engine (`agent-runner.ts` also uses `settingSources: ['project']`), the Advisor loads the project's `.claude/settings.json`, which can register hooks that run on tool use. This is an **inherited, not newly-introduced** risk — it rides on the same "you opened and trust this project" assumption as every agent run; the Advisor does not widen it.
- **No token leakage:** the system prompt injects backend **labels + model ids only**; tokens/base URLs are never included. The Advisor never reads the encrypted secret store.
- **Confirm-then-apply:** every state change (settings, team hand-off, backend setup) requires an explicit user confirm.
- **Settings whitelist:** only cost/efficiency knobs are applyable; autonomy/permission settings can be discussed but never applied by the Advisor.
- Runs on the user's Claude login; no new credential surface.

## Testing

- **Pure/unit** (`src/shared/advisor.test.ts`): `parseBrief` (valid brief / absent / malformed → null); `applyableSettings` (whitelists cost knobs, DROPS `autonomy`/`lockBypassPermissions`/any non-whitelisted key); `advisorSystemPrompt` (includes project name + settings values + backend labels; **asserts no token/baseUrl string is present** even when backends are passed).
- **Main** (`advisor.test.ts` where feasible): `folderDigest` bounded output on a temp dir; the abort-map bookkeeping. `streamAdvisor`'s `query()` loop is reviewed, not unit-tested (dynamic SDK import, like `streamAgent`).
- **UI:** verified via `npm run typecheck && npm run lint && npm run build` + manual smoke (no renderer component-test harness, consistent with the codebase).

## Additive-safety guarantee

The Advisor is a separate modal + a separate `query()` path. It does not import into or modify `orchestrator.ts`/`nodes.ts`/`agent-runner.ts`'s run behavior. Existing runs, byte-for-byte, are unaffected. The only cross-feature touch is the additive `seedGoal` store action the GoalBar reads (a no-op until the Advisor uses it) and opening the existing `BackendsModal`.

## Out of scope (v1)

- Persisting Advisor conversations across app restarts.
- The Advisor running on a non-Claude backend (it uses the Claude login).
- Auto-executing team builds or runs (hand-off is confirm-gated).
- A deep recursive folder summarizer (shallow `folderDigest` only; deeper reads are the read-only tools' job per turn).
- Wave D's Director consuming the full `team` brief (Wave D concern; MVP hand-off is `goal → spawnTeam`).
- Multiple concurrent Advisor threads; voice.
