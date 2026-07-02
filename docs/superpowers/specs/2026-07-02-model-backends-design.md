# Model Backends Per Agent — Design

**Phase-3 feature #3** (the user's flagged "final feature"). Date: 2026-07-02. Status: approved, pre-implementation.

## Goal

Let each agent run on an **alternative Anthropic-API-compatible model backend** (e.g. GLM via z.ai, or ChatGPT via an Anthropic→OpenAI gateway) instead of the default Claude login. A backend is a `{ base URL, token, model ids }` triple; an agent optionally references one. When no agent references a backend, behavior is **byte-for-byte** identical to today (default Claude login, no env injection).

Per-agent **Claude-tier** selection already exists (`AgentConfigPanel` Model dropdown over `MODELS`, persisted via `updateAgent`). This feature adds the **alternative-backend** half only.

## Why this works (feasibility)

The Claude Agent SDK's `query({ options })` accepts a per-call `env` field (`sdk.d.ts:1364`): when set it **replaces** the subprocess environment (you spread `process.env` yourself); when omitted the subprocess inherits `process.env`. So we can route **one agent's run** to an Anthropic-compatible endpoint via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` without touching the app-wide `process.env`. Omitting `env` = today's behavior exactly.

**Constraint:** the mechanism only reaches **Anthropic-API-compatible** endpoints (the `claude` engine speaks the Anthropic wire format). GLM (z.ai) publishes such an endpoint natively. OpenAI/ChatGPT does **not** — it requires an Anthropic→OpenAI **gateway/proxy** in front of it (the user supplies that gateway's URL). Native OpenAI is a future concern of the pluggable-harness feature (#15), not this one.

## Relationship to pluggable harnesses (#15)

This feature is the **model-backend axis for the current (Claude-SDK) harness**. A future harness axis (#15) adds `AgentNodeData.harness` (default `'claude-sdk'`); this feature's `backendId` applies when `harness === 'claude-sdk'`. Nothing here needs rework when harnesses arrive. (LangGraph/OpenAI-Agents harnesses would be the clean native path to OpenAI; the ChatGPT-via-gateway preset here is an interim for the Claude-SDK harness.)

## Data model

**Storage decision:** project-level (backends on `ProjectGraph`, like `contextFolders`); tokens `safeStorage`-encrypted in `<project>/.ai-manager/`.

### Built-in presets (shipped code constant — `src/shared/model-backends.ts`)

```ts
interface BackendPreset {
  presetId: string          // 'zai-glm' | 'chatgpt-gateway' | 'custom'
  label: string
  baseUrl: string           // '' for gateway/custom (user fills)
  gateway?: boolean         // true ⇒ base URL is a user-supplied Anthropic→OpenAI proxy
  models: { id: string; label: string }[]  // default model ids (editable)
}
export const BACKEND_PRESETS: BackendPreset[]
```

Presets shipped in v1:
- **`zai-glm`** "z.ai (GLM)" — `baseUrl: 'https://api.z.ai/api/anthropic'` (prefilled), default models e.g. `glm-4.6`, `glm-4.5-air` (editable; exact ids are user-updatable strings, version-agnostic). BYOK token.
- **`chatgpt-gateway`** "ChatGPT (via gateway)" — `gateway: true`, `baseUrl: ''` (user fills their proxy), default models e.g. `gpt-5.5` (editable). BYOK token. UI shows an inline note that this requires an Anthropic-compatible gateway in front of OpenAI.
- **`custom`** "Custom" — no prefill; user enters label, base URL, models.

Presets are **templates only**; adding more later is a code edit. Author-managed/preset keys = future, out of scope, structure permits (see Out of scope).

### Configured backends (non-secret) — `ProjectGraph.backends?: Backend[]`

```ts
interface BackendModel { id: string; label: string }
interface Backend {
  id: string                 // randomUUID — React key + agent.backendId reference + token key
  label: string
  baseUrl: string            // absolute; the Anthropic-compatible endpoint
  models: BackendModel[]
  presetId?: string          // provenance ('zai-glm' | 'chatgpt-gateway' | 'custom')
  addedAt: string            // ISO timestamp
}
// on ProjectGraph:
backends?: Backend[]
```

Persisted in `graph.json`, default-filled `?? []` on open (absent = byte-for-byte). **No token field** — tokens live only in the encrypted secret store.

### Token storage (secret)

Encrypted file `<project>/.ai-manager/backend-secrets.json`: `{ [backendId]: string }` where the value is `base64(safeStorage.encryptString(token))`. Decrypted **only in the main process at run time**; never persisted in `graph.json`; never sent to the renderer. On first write, the secret store ensures a self-contained `<project>/.ai-manager/.gitignore` containing `backend-secrets.json` (scoped ignore inside the app's own dir — the project-root `.gitignore` is left untouched). Note: `safeStorage` encryption is OS-user-bound, so the ciphertext is useless on another machine even if committed; the ignore is defense-in-depth.

### Per-agent reference

`AgentNodeData.backendId?: string` — absent = default Claude login (byte-for-byte). When set, references a `Backend.id`; the agent's `model` string must be one of that backend's model ids (the UI keeps this consistent).

## Secure credential store (main) — `src/main/engine/backend-secrets.ts`

- `encryptionAvailable(): boolean` — wraps `safeStorage.isEncryptionAvailable()`.
- `setBackendToken(id, token): Promise<void>` — `safeStorage.encryptString` → base64 → atomic write into the secret file (merge with existing map). Throws/returns an error surfaced to the UI if encryption is unavailable.
- `getBackendToken(id): string | undefined` — read + base64-decode + `safeStorage.decryptString`; main-only.
- `hasBackendToken(id): boolean` — key present in the secret file.
- `deleteBackendToken(id): Promise<void>` — drop the key (called when a backend is removed).

If `encryptionAvailable()` is false, the Backends UI disables token entry with a clear message. An agent whose assigned backend can't resolve a token is a **misconfiguration**: the run surfaces an error (see Env injection tri-state + Error handling) rather than silently using the Claude login — which would send a non-Claude model id to the Claude endpoint.

## Backend store CRUD (main — `src/main/engine/project-store.ts`)

Mirror the `contextFolders`/`pairedDirs` seams:
- `getBackends(): Backend[]`
- `addBackend(input: { label; baseUrl; models; presetId? }): Promise<ProjectGraph>` — push with a new id + `addedAt`.
- `updateBackend(id, patch: Partial<{ label; baseUrl; models }>): Promise<ProjectGraph>`
- `removeBackend(id): Promise<ProjectGraph>` — also `deleteBackendToken(id)` and clear `backendId` on any agent referencing it.

Backend metadata returned to the renderer is augmented with `hasToken: boolean` (never the token itself).

## Env injection (the core) — `src/main/engine/agent-runner.ts`

- Pure helper (`src/shared/model-backends.ts`): `backendEnv(baseUrl: string, token: string): Record<string, string>` → `{ ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token }`.
- Main helper `resolveBackendEnv(agent)` returns a **tri-state** so the runner can tell "no backend" from "broken backend":
  - `{ kind: 'none' }` — `agent.backendId` absent ⇒ omit `options.env` (byte-for-byte, default Claude login).
  - `{ kind: 'env', env }` — `agent.backendId` set AND its `Backend` + decrypted token both resolve ⇒ `env = backendEnv(baseUrl, token)`.
  - `{ kind: 'error', message }` — `agent.backendId` set but the backend is missing from `graph.backends` or the token is absent/undecryptable ⇒ a misconfiguration.
- In `streamAgent`, after building `options`: switch on the result — `none` → leave `options` untouched; `env` → `options.env = { ...process.env, ...env }`; `error` → stream the message as a run error and throw **before** calling `query()` (never silently fall back to the Claude login, which would send a non-Claude model id to the Claude endpoint). Model sent = `agent.model` (a backend model id when `backendId` set).

## Interactions

- **cheap-model-workers:** the transient worker override (`workerModelOverride`, swaps workers to a Claude tier) is **skipped for agents with a `backendId`** — a Claude model id would mismatch a non-Claude endpoint. A small helper `effectiveWorkerOverride(agent, settings)` returns `undefined` when `agent.backendId` is set, else `workerModelOverride(settings)`; applied at the 4 dispatch sites in `nodes.ts`.
- **Effort caps:** unknown backend model ids already pass through `clampEffort` unchanged (no clamp) — safe, no change.
- **autoAssignModels:** only assigns Claude tiers at spawn; backends are assigned manually — no conflict.

## Interactive terminal — `src/main/engine/pty-manager.ts`

`spawnPty` already loads the agent via `buildAgentContext`. Merge `resolveBackendEnv(agent)` into the object returned by `cleanEnv()` for that spawn when present; else unchanged. `buildClaudeArgs` passes `--model agent.model` (the backend model id). The plain `$SHELL` `spawnShellPty` is untouched.

## UI

- **Per-agent selection** — `AgentConfigPanel` gains a **Backend** dropdown above Model: "Claude (default)" + configured backends (by label). Selecting a backend switches the Model dropdown's options to that backend's `models` (Claude `MODELS` when default) and resets `model` to a valid id for the selection. Persisted via `updateAgent({ backendId, model })`.
- **Backends manager** — a new `BackendsModal` (project-scoped) reached from a **"Manage backends…"** link in the config panel:
  - Add: pick a preset (`zai-glm` / `chatgpt-gateway` / `custom`) → prefills label, base URL, models. The gateway preset shows the "requires an Anthropic-compatible gateway" note.
  - Fields: label, base URL, model-ids (comma/newline text list → parsed to `{id,label}` with id==label unless `id|Label`), token (masked, **write-only**: shows "Token configured" once set, never displays it back; a "Replace token" affordance).
  - Edit / remove (remove warns it clears the token + unassigns agents).
  - If `encryptionAvailable()` is false, the token field is disabled with a message.
- **Display** — the run stream header (`agent-runner.ts:123`) shows the backend label when the agent has one: e.g. `▶ Builder · glm-4.6 (z.ai)`. (Reuses the existing header line; no new component.)

Styling stays on-brand (Obsidian & Emerald), reusing `Modal`, existing form/`field` and `.topmenu`/select patterns — no new visual language. (Backends manager kept off the top bar to avoid clutter; reachable from the agent config panel.)

## IPC / preload / RendererApi

Mirror the existing folders/paired-dir seams:
- `backend:add` / `backend:update` / `backend:remove` → store CRUD; return the graph (backends augmented with `hasToken`).
- `backend:list` → backends + `hasToken` for the manager.
- `backend:setToken` (id, token) → `setBackendToken` (write-only; returns `{ ok, error? }`; never echoes the token).
- `backend:encryptionAvailable` → boolean, for the UI gate.
Preload bridge + `RendererApi` method types for each. The token setter is the only channel carrying a secret and only flows renderer→main.

## Error handling

- **Encryption unavailable:** UI blocks token entry with a message; `setBackendToken` returns an error.
- **Backend assigned but backend/token missing or undecryptable at run time:** `resolveBackendEnv` returns `{ kind: 'error', message }`; `streamAgent` streams the message ("Agent <name> is set to backend <label> but its token is missing — set it in Manage backends") and throws before `query()`, rather than silently falling back to the Claude login (which would send a non-Claude model id to the Claude endpoint). The orchestrator treats this like any run error.
- **Model/backend mismatch:** the UI keeps `agent.model` valid for the selected backend; runtime trusts the stored `model`.

## Testing

- **Pure/unit** (`src/shared/model-backends.test.ts`): `backendEnv` shape; `BACKEND_PRESETS` well-formed (ids unique, gateway flag on chatgpt); the model-ids parse helper; `effectiveWorkerOverride` returns undefined when `backendId` set and the normal override otherwise.
- **Main** (`backend-secrets.test.ts`): encrypt→decrypt roundtrip and `hasBackendToken`, with `safeStorage` mocked; `setBackendToken` error when encryption unavailable. (`project-store.backends.test.ts`): store CRUD, default `[]` on open, `removeBackend` deletes token + unassigns agents. (`agent-runner.backends.test.ts`): `options.env` present (spreads `process.env` + backend vars) only when a backend resolves; **absent → options byte-for-byte** (exact-equality style); model unchanged.
- **UI:** verified via `npm run typecheck && npm run lint && npm run build` + manual smoke (no renderer component-test harness, consistent with the codebase).

## Byte-for-byte guarantee

No agent has a `backendId` ⇒ no `options.env`, no PTY env additions, model unchanged, zero secret reads; `contextFolders`/`pairedDirs`/HITL/shell-terminal paths untouched. `graph.backends` absent/empty ⇒ `graph.json` and every run identical to today.

## Out of scope (v1)

- **Author-provided / managed preset keys** (ship the app with keys so users don't BYOK) — future; the `Backend`/preset structure allows a later "token source = app-provided" without a data migration.
- **Native OpenAI without a gateway** — belongs to the pluggable-harness feature (#15).
- **App-level backend reuse across projects** — storage is project-level per the chosen decision.
- **Pluggable agent harnesses (#15)** — separate future feature; this spec only notes the layering.
- Per-agent scoping semantics beyond a single `backendId` reference.
