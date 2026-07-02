# Max-output-tokens Settings knob (Phase-3 #16)

**Date:** 2026-07-02
**Status:** Approved design → spec
**Feature:** #16 from the Phase-3 backlog — a real in-app Settings control for the per-agent output-token ceiling.

## Problem / origin

Agents run through Claude Code / the Agent SDK, which imposes a **default 32,000 output-token cap** per response. During a live creative-vision (#9) run, a UX/Product Designer worker tried to emit one large "comprehensive wireframes document" and the run **failed**:

> `API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`

The app currently sets **no** max-output value and exposes **no** setting for it — `CLAUDE_CODE_MAX_OUTPUT_TOKENS` / `maxOutputTokens` / `maxTokens` appear nowhere in `src/` (verified). The cap only takes effect today if the whole Electron app is *launched* with the env var (agents inherit the process environment). The user wants this as a real, per-project in-app Settings knob.

**Not to be confused with the #6 token-efficiency levers** (`outputMode`, `effortThrift`, cheap-model workers, light prompts) — those change output *mode / effort / model*, i.e. how much the model *chooses* to emit. This feature raises the hard *ceiling* on how much it *may* emit before the SDK truncates the response.

## Goals

- A per-project **Max output tokens** setting that, when set, injects `CLAUDE_CODE_MAX_OUTPUT_TOKENS=<n>` into the environment of the `claude` subprocess for **both** execution paths: headless orchestration runs *and* the interactive `claude` terminal.
- `0` (the default) means "don't set the env var" — i.e. fall back to Claude Code's own default (32,000). This path must be **byte-for-byte** identical to today on both execution paths.
- On-brand, minimal UI in the existing Settings modal (Obsidian & Emerald), reusing existing components — no new CSS/tokens/IPC.

## Non-goals (YAGNI)

- No automatic "raise Max output tokens" hint/nudge surfaced when a run fails with the 32k error. (Possible future follow-up; not in scope.)
- No coupling to the #6 token-efficiency levers.
- No per-agent override — this is a single project-level setting (matches every other numeric knob in `ProjectSettings`).

## Design decisions (locked)

1. **Scope = both paths** — headless runs (`agent-runner.streamAgent`) AND the interactive `claude` PTY (`pty-manager.spawnPty`). Mirrors how #3's model backends inject env into both paths (`applyBackendToRun` + `mergeBackendEnv`); a user can hit the 32k cap in either.
2. **Placement = Cost section** in `SettingsModal` — "where the team may spend more for better results." Raising the ceiling permits larger, costlier responses, so it sits with the other spend knobs.
3. **Required `number` field defaulting to `0`** (not optional `?: number`). `ProjectSettings` has **no optional numeric fields**; every "off = 0" knob (`maxReplans`, `maxHandoffs`, `maxUserRequests`, `maxFollowThrough`) is a required `number` defaulting to `0`. Matching that keeps `DEFAULT_SETTINGS` and the `settings-defaults.test.ts` shape assertion uniform. Runtime behavior is identical to the optional form (falsy `0` ⇒ off).
4. **UI = bare number input** (the `bulkCreateMax` pattern), **not** a `GatedRow`. `GatedRow`'s toggle flips the value 0↔1, which is nonsensical for a token count; a labeled number input with `0 = default` reads clearly and matches `bulkCreateMax`.

## Implementation

### 1. Type + default — `src/shared/types.ts`

Add to `ProjectSettings` (alongside the other `cost`-ish numeric knobs):

```ts
maxOutputTokens: number   // 0 = off (Claude Code default, 32000). Otherwise sets CLAUDE_CODE_MAX_OUTPUT_TOKENS.
```

Add to `DEFAULT_SETTINGS`:

```ts
maxOutputTokens: 0,
```

`src/shared/settings-defaults.test.ts` asserts the `DEFAULT_SETTINGS` shape / key set and must be updated to include the new `maxOutputTokens` key.

### 2. New pure module — `src/shared/max-output-tokens.ts`

Small, leaf module (imports nothing from the project), shared by both engine seams and unit-tested independently:

```ts
/** Clamp a user-entered max-output-tokens value to a sane range. 0 = off (SDK default, 32000).
 *  128000 is the current top-tier model output ceiling (Opus 4.8 / Sonnet 5); the model's own
 *  cap bounds the effective value regardless, so this is just a UI sanity guard. */
export function clampMaxOutputTokens(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(128000, Math.floor(n)))
}

/** The env overlay for CLAUDE_CODE_MAX_OUTPUT_TOKENS. Empty object when off (n <= 0), so spreading
 *  it is additively byte-for-byte. */
export function maxOutputTokensEnv(n: number): Record<string, string> {
  return n > 0 ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(n) } : {}
}
```

### 3. Headless seam — `src/main/engine/agent-runner.ts`

Today, `options.env` is attached conditionally right after `additionalDirectories`:

```ts
if (run.env) options.env = run.env
```

where `run` is the return of `applyBackendToRun(...)`: `run.env` is `{ ...process.env, ...backendEnv }` for an `env` backend, and `undefined` for `none`. Replace that single line with:

```ts
const outputOverlay = maxOutputTokensEnv(getSettings().maxOutputTokens)
if (Object.keys(outputOverlay).length > 0) {
  options.env = { ...(run.env ?? process.env), ...outputOverlay }
} else if (run.env) {
  options.env = run.env
}
```

Behavior matrix:

| backend | maxOutputTokens | `options.env` |
|---|---|---|
| none (`run.env` undefined) | `0` | **unset** — subprocess inherits `process.env` (byte-for-byte with today) |
| none | `> 0` | `{ ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "<n>" }` (spreads `process.env` itself, matching how `applyBackendToRun` builds the backend env) |
| env (`run.env` set) | `0` | `run.env` (same object, byte-for-byte with today) |
| env | `> 0` | `{ ...run.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "<n>" }` |

`getSettings()` is already called inline several times in this function, so the value is read live at run time (no snapshot). `options.env`'s type already accepts `Record<string, string | undefined>` (the `applyBackendToRun` return type), so spreading `process.env` is type-safe.

Import `maxOutputTokensEnv` from `../../shared/max-output-tokens`.

### 4. Interactive seam — `src/main/engine/pty-manager.ts`

`spawnPty` reads `const settings = getSettings()` (already present) and builds the PTY env inline at the `pty.spawn` call:

```ts
env: mergeBackendEnv(cleanEnv(), await resolveBackendEnv(agent))
```

Refactor to compute the env first, then additively apply the overlay so the off-path is byte-for-byte:

```ts
const env = mergeBackendEnv(cleanEnv(), await resolveBackendEnv(agent))
const outputOverlay = maxOutputTokensEnv(settings.maxOutputTokens)
if (outputOverlay.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = outputOverlay.CLAUDE_CODE_MAX_OUTPUT_TOKENS
}

const proc = pty.spawn(resolveClaudeBin(), args, {
  name: 'xterm-256color',
  cols: Math.max(2, input.cols || 80),
  rows: Math.max(2, input.rows || 24),
  cwd: projectPath,
  env
})
```

When `maxOutputTokens === 0`, `env` is untouched → byte-for-byte with today. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is orthogonal to the backend keys (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`), so there is no collision.

`spawnShellPty` (the plain shell terminal, #11) is **not** touched — it's agent-less and unrelated.

Import `maxOutputTokensEnv` from `../../shared/max-output-tokens`.

### 5. UI — `src/renderer/SettingsModal.tsx`

In the **Cost** category `SettingSection`, add a bare-number `SettingRow` following the `bulkCreateMax` pattern:

```tsx
<SettingRow
  label="Max output tokens"
  desc="The most tokens an agent may emit in a single response. 0 = Claude Code's default (32,000). Raise this if agents fail with “exceeded the 32000 output token maximum.” The model's own ceiling still caps it (top models 128,000; Haiku 64,000)."
  control={
    <input
      type="number"
      min={0}
      max={128000}
      value={s.maxOutputTokens}
      onChange={(e) => void update({ maxOutputTokens: clampMaxOutputTokens(Number(e.target.value)) })}
    />
  }
/>
```

Import `clampMaxOutputTokens` from `'../shared/max-output-tokens'`. Reuses the existing `update()` helper (`window.api.updateSettings` → `store.updateSettings` → `graph.json`), the existing `SettingRow`/`SettingSection` components, and the existing number-input styling. No new CSS, tokens, IPC channels, preload, or RendererApi.

## Testing

**Pure unit tests** — `src/shared/max-output-tokens.test.ts`:
- `clampMaxOutputTokens`: `0 → 0`; a mid value (e.g. `64000 → 64000`); over-max (`200000 → 128000`); negative (`-5 → 0`); non-integer (`1000.9 → 1000`); non-finite (`NaN`/`Infinity → 0`).
- `maxOutputTokensEnv`: `0 → {}`; `> 0 → { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "<n>" }` with the value stringified.

**Engine seam tests** (extend the existing agent-runner / pty-manager test suites, or add focused ones):
- Headless, no backend + `maxOutputTokens=0`: `options.env` is **undefined** (byte-for-byte). *(Assert via whatever the existing agent-runner tests use to observe the options passed to `query`, or by asserting the composed env is not set.)*
- Headless, no backend + `maxOutputTokens>0`: `options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS === "<n>"` and `process.env` keys are present.
- Headless, env backend + `maxOutputTokens=0`: `options.env` deep-equals the backend env (byte-for-byte).
- Headless, env backend + `maxOutputTokens>0`: backend keys **and** `CLAUDE_CODE_MAX_OUTPUT_TOKENS` both present.
- Interactive PTY, `maxOutputTokens=0`: composed env deep-equals `mergeBackendEnv(cleanEnv(), ...)` with **no** `CLAUDE_CODE_MAX_OUTPUT_TOKENS` key.
- Interactive PTY, `maxOutputTokens>0`: composed env has `CLAUDE_CODE_MAX_OUTPUT_TOKENS === "<n>"`.

If the PTY env is not currently observable in a test (it's assembled inline in `spawnPty`), prefer testing the composition through the pure helper plus a thin assertion, rather than over-refactoring `spawnPty`. Keep changes minimal.

**Integration gates:** `npm run typecheck`, `npm run test`, `npm run lint` (renderer touched), `npm run build`.

## Invariant

`maxOutputTokens === 0` (the default) ⇒ **byte-for-byte no behavior change** on both the headless and interactive paths. This is the load-bearing guarantee; the seam tests assert it directly.

## On-device smoke (post-merge, user)

1. Open Settings → Cost → set **Max output tokens** to e.g. `64000`; confirm it persists (reopen Settings).
2. Run a goal whose worker emits a large response (or resume the stuck rust-training-tool creative run) → the previously-failing worker completes instead of erroring at 32k.
3. Open the interactive `claude` terminal for an agent → the higher cap applies there too.
4. Set it back to `0` → behavior returns to the 32k default (byte-for-byte).
