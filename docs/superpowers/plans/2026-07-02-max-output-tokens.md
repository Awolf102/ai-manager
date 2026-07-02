# Max-output-tokens Settings knob — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-project "Max output tokens" setting that injects `CLAUDE_CODE_MAX_OUTPUT_TOKENS` into the env of the `claude` subprocess for both headless runs and the interactive terminal, so agents can exceed the default 32,000 output-token cap.

**Architecture:** One new pure `shared/` module holds the clamp + env-overlay logic (fully unit-tested, matching how `team-scale.ts` / `applyBackendToRun` / `mergeBackendEnv` are tested). Two engine seams (`agent-runner.streamAgent` headless, `pty-manager.spawnPty` interactive) call the pure helpers as thin glue. A bare number input in the Settings **Cost** section drives the value through the existing `updateSettings` path. Default `0` = off = byte-for-byte no change.

**Tech Stack:** TypeScript, Electron (main + renderer), React 19, Vitest, `@anthropic-ai/claude-agent-sdk`, `node-pty`.

## Global Constraints

- **Byte-for-byte when off:** `maxOutputTokens === 0` (the default) MUST leave both execution paths exactly as they are today. This is the load-bearing invariant.
- **No new CSS/tokens/IPC/preload/RendererApi.** UI reuses `SettingRow`/`SettingSection` and the existing `update()` → `window.api.updateSettings` path. Engine reads the value live via `getSettings()` (no snapshot).
- **Field convention:** `ProjectSettings` has no optional numeric fields — add `maxOutputTokens` as a required `number` defaulting to `0` (like `maxReplans`/`maxHandoffs`/`maxFollowThrough`).
- **Clamp range:** `0`–`128000` (128000 = current top-tier model output ceiling; the model's own cap bounds the effective value regardless).
- **Import paths:** from `src/main/engine/*` use `../../shared/max-output-tokens`; from `src/renderer/*` use `../shared/max-output-tokens`.
- **Env var name (exact):** `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
- **Integration gates:** `npm run typecheck`, `npm run test`, and (because the renderer is touched in Task 5) `npm run lint`; controller runs `npm run build` at the integration gate.

---

### Task 1: Pure `max-output-tokens` module + tests

**Files:**
- Create: `src/shared/max-output-tokens.ts`
- Test: `src/shared/max-output-tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `clampMaxOutputTokens(n: number): number` — UI clamp; non-finite → 0, floors, bounds `0..128000`.
  - `maxOutputTokensEnv(n: number): Record<string, string>` — `{ CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(n) }` when `n > 0`, else `{}`.
  - `withMaxOutputTokensEnv(base: Record<string, string | undefined> | undefined, processEnv: Record<string, string | undefined>, n: number): Record<string, string | undefined> | undefined` — composes a headless run's env: off → returns `base` unchanged (so `undefined` stays `undefined` and the subprocess inherits `process.env`); on → overlays the var onto `base ?? processEnv`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/max-output-tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { clampMaxOutputTokens, maxOutputTokensEnv, withMaxOutputTokensEnv } from './max-output-tokens'

describe('clampMaxOutputTokens', () => {
  it('keeps 0 (off) and in-range values', () => {
    expect(clampMaxOutputTokens(0)).toBe(0)
    expect(clampMaxOutputTokens(64000)).toBe(64000)
  })
  it('bounds, floors, and rejects non-finite', () => {
    expect(clampMaxOutputTokens(200000)).toBe(128000)
    expect(clampMaxOutputTokens(-5)).toBe(0)
    expect(clampMaxOutputTokens(1000.9)).toBe(1000)
    expect(clampMaxOutputTokens(Number.NaN)).toBe(0)
    expect(clampMaxOutputTokens(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('maxOutputTokensEnv', () => {
  it('is empty when off (n <= 0)', () => {
    expect(maxOutputTokensEnv(0)).toEqual({})
    expect(maxOutputTokensEnv(-1)).toEqual({})
  })
  it('sets the stringified var when on', () => {
    expect(maxOutputTokensEnv(64000)).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' })
  })
})

describe('withMaxOutputTokensEnv', () => {
  const proc = { PATH: '/bin' }
  it('off + no base ⇒ undefined (subprocess inherits process.env, byte-for-byte)', () => {
    expect(withMaxOutputTokensEnv(undefined, proc, 0)).toBeUndefined()
  })
  it('off + base ⇒ the same base object, unchanged', () => {
    const base = { ANTHROPIC_BASE_URL: 'https://z' }
    expect(withMaxOutputTokensEnv(base, proc, 0)).toBe(base)
  })
  it('on + no base ⇒ overlays onto processEnv', () => {
    expect(withMaxOutputTokensEnv(undefined, proc, 64000)).toEqual({
      PATH: '/bin',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000'
    })
  })
  it('on + base ⇒ overlays onto base (not processEnv)', () => {
    expect(withMaxOutputTokensEnv({ ANTHROPIC_BASE_URL: 'https://z' }, proc, 64000)).toEqual({
      ANTHROPIC_BASE_URL: 'https://z',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000'
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/shared/max-output-tokens.test.ts`
Expected: FAIL — cannot resolve `./max-output-tokens` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/max-output-tokens.ts`:

```ts
/** Clamp a user-entered max-output-tokens value to a sane range. 0 = off (Claude Code's default,
 *  32000). 128000 is the current top-tier model output ceiling (Opus 4.8 / Sonnet 5); the model's
 *  own cap bounds the effective value regardless, so this is only a UI sanity guard. */
export function clampMaxOutputTokens(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(128000, Math.floor(n)))
}

/** The env overlay for CLAUDE_CODE_MAX_OUTPUT_TOKENS. Empty when off (n <= 0), so applying it is
 *  additively byte-for-byte. */
export function maxOutputTokensEnv(n: number): Record<string, string> {
  return n > 0 ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(n) } : {}
}

/** Compose the final env for a headless run. `base` is the resolved backend env (run.env) or
 *  undefined. Off (n <= 0): return `base` unchanged — undefined stays undefined so the subprocess
 *  inherits process.env byte-for-byte. On: overlay the var onto `base ?? processEnv`. */
export function withMaxOutputTokensEnv(
  base: Record<string, string | undefined> | undefined,
  processEnv: Record<string, string | undefined>,
  n: number
): Record<string, string | undefined> | undefined {
  const overlay = maxOutputTokensEnv(n)
  return Object.keys(overlay).length > 0 ? { ...(base ?? processEnv), ...overlay } : base
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/shared/max-output-tokens.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/shared/max-output-tokens.ts src/shared/max-output-tokens.test.ts
git commit -m "feat(settings): pure max-output-tokens clamp + env-overlay helpers"
```

---

### Task 2: `maxOutputTokens` setting field + default

**Files:**
- Modify: `src/shared/types.ts` (the `ProjectSettings` interface + `DEFAULT_SETTINGS` object)
- Test: `src/shared/settings-defaults.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent).
- Produces: `ProjectSettings.maxOutputTokens: number` (default `0`), read by Tasks 3, 4, 5.

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the `describe('DEFAULT_SETTINGS', ...)` in `src/shared/settings-defaults.test.ts`:

```ts
  it('defaults maxOutputTokens to 0 (off — Claude Code default 32000, byte-for-byte)', () => {
    expect(DEFAULT_SETTINGS.maxOutputTokens).toBe(0)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/shared/settings-defaults.test.ts`
Expected: FAIL — `DEFAULT_SETTINGS.maxOutputTokens` is `undefined`, so `.toBe(0)` fails.

- [ ] **Step 3: Add the field + default**

In `src/shared/types.ts`, add to the `ProjectSettings` interface (place it next to the other cost/numeric knobs, e.g. right after `bulkCreateMax: number`):

```ts
  maxOutputTokens: number
```

And add to `DEFAULT_SETTINGS` (matching position, e.g. after `bulkCreateMax: 25,`):

```ts
  maxOutputTokens: 0,
```

- [ ] **Step 4: Run test + typecheck to verify green**

Run: `npm run test -- src/shared/settings-defaults.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS (no code reads `maxOutputTokens` yet; the field just exists).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/settings-defaults.test.ts
git commit -m "feat(settings): add maxOutputTokens to ProjectSettings (default 0 = off)"
```

---

### Task 3: Headless seam (`agent-runner.streamAgent`)

**Files:**
- Modify: `src/main/engine/agent-runner.ts` (add import; replace the `if (run.env) options.env = run.env` line inside `streamAgent`, currently at line 161)

**Interfaces:**
- Consumes: `withMaxOutputTokensEnv` (Task 1); `getSettings().maxOutputTokens` (Task 2); the existing local `run` (from `applyBackendToRun`, whose `.env` is the backend env or `undefined`).
- Produces: nothing new for later tasks.

**Verification note:** This is thin glue over the Task-1 helper, which is exhaustively unit-tested (including the off→`undefined`/off→same-base byte-for-byte cases). Matching the codebase convention (backends were tested via `applyBackendToRun`, not by mocking `streamAgent`), there is **no** new `streamAgent` integration test — verification is: the existing `agent-runner.backends.test.ts` stays green (proves `applyBackendToRun` is untouched), plus typecheck + build. The byte-for-byte guarantee is provided structurally: when `maxOutputTokens === 0`, `withMaxOutputTokensEnv(run.env, process.env, 0)` returns `run.env` verbatim (or `undefined`), so `options.env` is assigned exactly as the old `if (run.env) options.env = run.env` did.

- [ ] **Step 1: Confirm the baseline test passes**

Run: `npm run test -- src/main/engine/agent-runner.backends.test.ts`
Expected: PASS (baseline before the edit).

- [ ] **Step 2: Add the import**

At the top of `src/main/engine/agent-runner.ts`, add (grouped with the other `../../shared/...` imports):

```ts
import { withMaxOutputTokensEnv } from '../../shared/max-output-tokens'
```

- [ ] **Step 3: Replace the env-assignment line**

In `streamAgent`, find (currently line 161):

```ts
    if (run.env) options.env = run.env
```

Replace it with:

```ts
    const composedEnv = withMaxOutputTokensEnv(run.env, process.env, getSettings().maxOutputTokens)
    if (composedEnv) options.env = composedEnv
```

- [ ] **Step 4: Verify typecheck + tests + build**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run test -- src/main/engine/agent-runner.backends.test.ts`
Expected: PASS (unchanged — `applyBackendToRun` behavior is not touched).
Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/agent-runner.ts
git commit -m "feat(settings): apply maxOutputTokens to headless agent runs"
```

---

### Task 4: Interactive seam (`pty-manager.spawnPty`)

**Files:**
- Modify: `src/main/engine/pty-manager.ts` (add import; add one line to `spawnPty` where the PTY env is built, currently line 69)

**Interfaces:**
- Consumes: `maxOutputTokensEnv` (Task 1); `settings.maxOutputTokens` (Task 2; `settings` is already `getSettings()` at line 54).
- Produces: nothing new.

**Verification note:** Same convention as Task 3 — the composition (`maxOutputTokensEnv`) is unit-tested in Task 1; the existing `pty-manager.test.ts` (which tests `mergeBackendEnv`/`buildClaudeArgs`) stays green; plus typecheck + build. Off is byte-for-byte because `Object.assign(env, {})` returns `env` unmutated. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is orthogonal to the backend keys (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`), so there is no collision.

- [ ] **Step 1: Confirm the baseline test passes**

Run: `npm run test -- src/main/engine/pty-manager.test.ts`
Expected: PASS (baseline).

- [ ] **Step 2: Add the import**

At the top of `src/main/engine/pty-manager.ts`, add:

```ts
import { maxOutputTokensEnv } from '../../shared/max-output-tokens'
```

- [ ] **Step 3: Add the overlay in `spawnPty`**

In `spawnPty`, the `pty.spawn(...)` call currently builds env inline (line 69):

```ts
  const proc = pty.spawn(resolveClaudeBin(), args, {
    name: 'xterm-256color',
    cols: Math.max(2, input.cols || 80),
    rows: Math.max(2, input.rows || 24),
    cwd: projectPath,
    env: mergeBackendEnv(cleanEnv(), await resolveBackendEnv(agent))
  })
```

Refactor to compute the env first, apply the overlay, then spawn:

```ts
  const env = mergeBackendEnv(cleanEnv(), await resolveBackendEnv(agent))
  Object.assign(env, maxOutputTokensEnv(settings.maxOutputTokens))

  const proc = pty.spawn(resolveClaudeBin(), args, {
    name: 'xterm-256color',
    cols: Math.max(2, input.cols || 80),
    rows: Math.max(2, input.rows || 24),
    cwd: projectPath,
    env
  })
```

- [ ] **Step 4: Verify typecheck + tests + build**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run test -- src/main/engine/pty-manager.test.ts`
Expected: PASS (unchanged).
Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/pty-manager.ts
git commit -m "feat(settings): apply maxOutputTokens to the interactive claude terminal"
```

---

### Task 5: Settings UI (Cost section number input)

**Files:**
- Modify: `src/renderer/SettingsModal.tsx` (add import; add one `SettingRow` in the `active === 'cost'` `SettingSection`)

**Interfaces:**
- Consumes: `clampMaxOutputTokens` (Task 1); `s.maxOutputTokens` (Task 2); the existing `update()` helper and `SettingRow` component.
- Produces: nothing.

**Verification note:** The renderer has no unit-test harness (App.tsx is not rendered in tests); verification is typecheck + lint + build, plus the user's on-device smoke. Follows the exact `bulkCreateMax` number-input pattern.

- [ ] **Step 1: Add the import**

In `src/renderer/SettingsModal.tsx`, update the `team-scale` import line (line 7) region by adding an import for the clamp:

```ts
import { clampMaxOutputTokens } from '../shared/max-output-tokens'
```

- [ ] **Step 2: Add the `SettingRow` in the Cost section**

In the `{active === 'cost' && (` block, inside `<SettingSection>`, add a third row after the "Adaptive effort" `SettingRow` (i.e. immediately before the closing `</SettingSection>`):

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

- [ ] **Step 3: Verify typecheck + lint + build**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run lint`
Expected: PASS (0 errors).
Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Full test suite (regression)**

Run: `npm run test`
Expected: PASS (all suites, including the two new specs).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/SettingsModal.tsx
git commit -m "feat(settings): Max output tokens number input in the Cost section"
```

---

## Post-implementation

- **Whole-branch review:** opus review per the standing cycle workflow; apply any worthwhile Minor before merge.
- **Merge:** on a clean review (no Critical/Important), `--no-ff` merge to `main` locally, re-verify tests on the merged result, delete the branch.
- **On-device smoke (user):** Settings → Cost → set Max output tokens (e.g. 64000) → persists across reopen; a large-output worker (or the resumed rust-training-tool run) completes instead of erroring at 32k; the interactive `claude` terminal honors it too; setting back to 0 restores the 32k default.
- **Memory:** update `ai-manager-phase3-plan.md` (mark #16 shipped) + `MEMORY.md`.

## Self-review notes

- **Spec coverage:** type+default (Task 2) ✓; pure helper module (Task 1) ✓; headless seam (Task 3) ✓; interactive seam (Task 4) ✓; Cost-section UI (Task 5) ✓; byte-for-byte invariant (Task 1 tests + Tasks 3/4 structural) ✓; clamp 0–128000 (Task 1) ✓.
- **Placeholder scan:** none — every code and test block is complete.
- **Type consistency:** `clampMaxOutputTokens` / `maxOutputTokensEnv` / `withMaxOutputTokensEnv` names and signatures are identical across Task 1 (definition) and Tasks 3/4/5 (consumers); `CLAUDE_CODE_MAX_OUTPUT_TOKENS` spelled identically throughout.
