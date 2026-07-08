# Design-Preview Approval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in gate that, before building, produces a self-contained design-system HTML preview, pauses the run to show it in an iframe, and proceeds to build on approve (or regenerates on request-changes).

**Architecture:** A new graph node `designPreviewGate` is conditionally wired `route → designPreviewGate → execute` when the `designPreview` setting is on. It runs one focused orchestrator acting-call to write `design-preview.html`, returns `{ interrupt }` to pause via the existing generic runtime, and on resume reads `resumeInput` to approve (→ `execute`) or regenerate. A renderer modal frames the file via `srcdoc`. Both new settings default off ⇒ byte-for-byte.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), React, Vitest (node env). Reuses the existing `graph.ts` interrupt/resume runtime, the `visionMode` prompt-threading pattern, and the `readRole`/`env:read` IPC pattern.

## Global Constraints

- **Byte-for-byte when off:** `designPreview === false` ⇒ `buildOrchestratorGraph` produces exactly today's node/edge map (`route → execute`), the gate node never runs, `workerPrompt` output is unchanged, both settings inert. Same discipline as #9/#16.
- **Both new settings default `false`.** `designPreview`, `usePreMadeInspirationGuide`.
- **Self-contained preview:** the generation prompt forbids external CSS/CDN/`@import`/remote fonts (the production CSP blocks them in the iframe).
- **Fail-open:** a generation error must never block the build — catch and proceed to `execute`.
- **Inspiration guide = FORMAT/structure only** — never carries specific colors/fonts; the generator picks a domain-appropriate visual direction.
- **Integration gates:** implementers run `npm run typecheck` + `npm run test`; controller runs `npm run build`. **`npm run lint` is required** (renderer changes in Tasks 6–7).
- **Spec:** `docs/superpowers/specs/2026-07-08-design-preview-gate-design.md`.

---

### Task 1: Settings, RunState fields, and `resumeRun` widening (types)

**Files:**
- Modify: `src/shared/types.ts` (`ProjectSettings` ~154, `DEFAULT_SETTINGS` ~186, `RunPhase` ~475, `RunState` ~566, `RendererApi.resumeRun` ~704)
- Modify: `src/main/ipc.ts:110` (widen `answer` param type)
- Test: `src/main/engine/settings-defaults.test.ts` (extend)

**Interfaces:**
- Produces: `ProjectSettings.designPreview: boolean`, `ProjectSettings.usePreMadeInspirationGuide: boolean`; `RunState.designPreviewApproved?: boolean`, `RunState.designPreviewIteration?: number`; `RunPhase` includes `'previewing'`; `RendererApi.resumeRun(runId: string, answer?: unknown)`.

- [ ] **Step 1: Add the two settings to `ProjectSettings`**

In `src/shared/types.ts`, immediately after the `visionMode: boolean` line (currently the last field of `ProjectSettings`, ~line 154), add:

```ts
  /** pause before building to show a design-system preview for approval (off = byte-for-byte) */
  designPreview: boolean
  /** inject the shipped de-branded structural guide into the design-preview generator (only meaningful when designPreview is on) */
  usePreMadeInspirationGuide: boolean
```

Ensure the preceding `visionMode: boolean` line now ends without being the last (no syntax issue — interface members don't need commas; they use newlines/semicolons per the file's existing style — match the surrounding style exactly).

- [ ] **Step 2: Add their defaults to `DEFAULT_SETTINGS`**

In `DEFAULT_SETTINGS` (~line 186), after `visionMode: false` add (mind the comma — `visionMode: false` must gain a trailing comma):

```ts
  visionMode: false,
  designPreview: false,
  usePreMadeInspirationGuide: false
```

- [ ] **Step 3: Add `'previewing'` to `RunPhase`**

In `RunPhase` (~line 475), add `| 'previewing'` after `| 'planning'`:

```ts
export type RunPhase =
  | 'planning'
  | 'previewing'
  | 'routing'
  | 'executing'
  | 'reviewing'
  | 'repairing'
  | 'replanning'
  | 'reflecting'
  | 'synthesizing'
  | 'done'
```

- [ ] **Step 4: Add the two `RunState` fields**

In `RunState` (~line 566), after `resumeInput?: unknown`, add:

```ts
  /** design-preview gate: set true once the user approved the preview (checkpoint-only; undefined on old runs) */
  designPreviewApproved?: boolean
  /** design-preview gate: how many previews have been generated this run (display only) */
  designPreviewIteration?: number
```

- [ ] **Step 5: Widen `resumeRun` to accept a non-string decision**

In `src/shared/types.ts` (~line 704) change:
```ts
  resumeRun: (runId: string, answer?: string) => Promise<void>
```
to:
```ts
  resumeRun: (runId: string, answer?: unknown) => Promise<void>
```
In `src/main/ipc.ts:110` change the handler param `answer?: string` to `answer?: unknown`:
```ts
  ipcMain.handle(IPC.resumeRun, (e: IpcMainInvokeEvent, runId: string, answer?: unknown) =>
    orchestrator.resumeRun(e.sender, runId, answer)
  )
```
(`orchestrator.resumeRun` already takes `resumeInput?: unknown`; existing string callers remain valid.)

- [ ] **Step 6: Extend the defaults test**

In `src/main/engine/settings-defaults.test.ts`, add assertions inside the existing DEFAULT_SETTINGS test (match the file's existing style):

```ts
expect(DEFAULT_SETTINGS.designPreview).toBe(false)
expect(DEFAULT_SETTINGS.usePreMadeInspirationGuide).toBe(false)
```

- [ ] **Step 7: Verify + commit**

Run: `npm run test -- settings-defaults` → PASS. Run: `npm run typecheck` → clean.
```bash
git add src/shared/types.ts src/main/ipc.ts src/main/engine/settings-defaults.test.ts
git commit -m "feat(design-preview): settings + RunState fields + resumeRun widening"
```

---

### Task 2: Pure prompt builder + inspiration guide (`shared/design-preview.ts`)

**Files:**
- Create: `src/shared/design-preview.ts`
- Test: `src/shared/design-preview.test.ts`

**Interfaces:**
- Produces: `designPreviewPrompt(goal: string, guide?: string): string`; `INSPIRATION_GUIDE: string`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/design-preview.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { designPreviewPrompt, INSPIRATION_GUIDE } from './design-preview'

describe('designPreviewPrompt', () => {
  it('with no guide produces a self-contained-HTML instruction and omits the exemplar block', () => {
    const p = designPreviewPrompt('Build an art shop')
    expect(p).toContain('design-preview.html')
    expect(p).toContain('SELF-CONTAINED')
    expect(p).toContain('Build an art shop')
    expect(p).not.toContain('structural exemplar')
  })

  it('with a guide injects it for FORMAT ONLY and forbids copying its styles', () => {
    const p = designPreviewPrompt('Build a B2B SaaS', INSPIRATION_GUIDE)
    expect(p).toContain('structural exemplar')
    expect(p).toContain('FORMAT ONLY')
    expect(p).toContain(INSPIRATION_GUIDE)
  })

  it('the no-guide branch is byte-identical to passing an empty guide', () => {
    expect(designPreviewPrompt('G')).toBe(designPreviewPrompt('G', ''))
  })
})

describe('INSPIRATION_GUIDE', () => {
  it('is non-empty and fully self-contained (no external resources)', () => {
    expect(INSPIRATION_GUIDE.length).toBeGreaterThan(200)
    expect(INSPIRATION_GUIDE).not.toMatch(/https?:\/\//)
    expect(INSPIRATION_GUIDE).not.toContain('@import')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- design-preview` → FAIL (`Cannot find module './design-preview'`).

- [ ] **Step 3: Create `src/shared/design-preview.ts`**

```ts
// Pure prompt + asset for the design-preview gate. No node/DOM imports.

/**
 * A curated, de-branded structural exemplar for the design-preview generator.
 * Teaches SECTION STRUCTURE + a token-driven, self-contained approach ONLY —
 * it deliberately uses neutral placeholder tokens, never a real palette/font,
 * so generated previews don't inherit one project's look.
 */
export const INSPIRATION_GUIDE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>Design System</title>
<style>
  /* Token-driven: define ALL colors/type as CSS variables chosen to fit the project's domain, then use them. */
  :root{
    --font-sans: system-ui, sans-serif;      /* choose a domain-appropriate stack */
    --font-mono: ui-monospace, monospace;
    --bg:#ffffff; --surface:#f5f5f5; --text:#111111; --muted:#666666; --accent:#333333; --border:#e5e5e5;
  }
  body{font-family:var(--font-sans);background:var(--bg);color:var(--text);margin:0;padding:32px;line-height:1.6}
  .section{margin-bottom:48px} .swatch{display:inline-block;width:64px;height:64px;border-radius:8px;margin-right:8px}
  .type-row{display:flex;gap:16px;align-items:baseline;margin-bottom:12px}
</style></head>
<body>
  <!-- 1. BRAND: product name + one-line positioning -->
  <section class="section"><h1>[Brand name]</h1><p>[One-line positioning]</p></section>
  <!-- 2. PALETTE: one swatch per token, each labelled with its hex + role -->
  <section class="section"><h2>Color</h2><span class="swatch" style="background:var(--accent)"></span></section>
  <!-- 3. TYPE SCALE: one row per role with px / weight / letter-spacing / line-height -->
  <section class="section"><h2>Type</h2>
    <div class="type-row"><span style="font-size:48px;font-weight:600">Display</span><code>48px / 600 / -0.03em / 1.1</code></div>
    <!-- also Heading 1, Heading 2, Heading 3, Body, Small, Label, Code -->
  </section>
  <!-- 4. COMPONENTS: primary + secondary button, input, card -->
  <section class="section"><h2>Components</h2></section>
  <!-- 5. APP-SHELL MOCK: topbar + sidebar + content region -->
  <section class="section"><h2>App shell</h2></section>
</body></html>`

/**
 * Prompt for the design-preview generation step. `guide` non-empty ⇒ injected
 * as a FORMAT-ONLY structural exemplar. `guide === ''` ⇒ byte-identical to the
 * no-guide branch (default param).
 */
export function designPreviewPrompt(goal: string, guide = ''): string {
  const guideBlock = guide
    ? `\n\nUse this structural exemplar for FORMAT ONLY — adopt its section structure and token-driven, self-contained approach, but choose colors, fonts, and mood that fit THIS project's domain (do NOT copy the exemplar's palette or fonts):\n\n${guide}`
    : ''
  return `You are producing a design-system PREVIEW for this goal:
${goal}

Write ONE self-contained HTML page to the file "design-preview.html" in the project root, showing, in order: (1) brand direction (name + one-line positioning), (2) the color palette as labelled swatches, (3) the type scale (each role with px / weight / letter-spacing / line-height), (4) key components (buttons, input, card), (5) a small app-shell mock.

Hard requirements:
- SELF-CONTAINED: inline all CSS in a <style> tag and use a system font stack (or an embedded @font-face). Do NOT reference any external stylesheet, CDN, or @import (e.g. Google Fonts) — they are blocked when the page is previewed and will silently fall back.
- Choose a visual direction that fits the project's domain and audience (e.g. an art shop reads expressive and artistic; a B2B SaaS reads minimal and professional).
- Produce ONLY this preview file — do not build the app, install anything, or edit other files.${guideBlock}

When done, reply with a one-line confirmation.`
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test -- design-preview` → PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` → clean.
```bash
git add src/shared/design-preview.ts src/shared/design-preview.test.ts
git commit -m "feat(design-preview): pure prompt builder + de-branded inspiration guide"
```

---

### Task 3: The gate node + conditional graph wiring (engine)

**Files:**
- Modify: `src/main/engine/nodes.ts` (`buildOrchestratorGraph` ~104; add `designPreviewGateNode` + `generateDesignPreview` in the nodes section; import from `shared/design-preview` + `getSettings`/`getCurrentProjectPath` already imported patterns)
- Test: `src/main/engine/nodes.test.ts` (add design-preview cases)

**Interfaces:**
- Consumes: `designPreviewPrompt`, `INSPIRATION_GUIDE` (Task 2); `RunState.designPreviewApproved`/`designPreviewIteration` (Task 1); `eng.runAgent(opts: StreamAgentOptions)`; `getSettings()`.
- Produces: graph node `'designPreviewGate'` wired `route → designPreviewGate → execute` when `getSettings().designPreview`; it returns `{ interrupt: { kind: 'design-preview', prompt, payload: { iteration } } }` on generate, `{ goto: 'execute' }` on approve/fail-open.

- [ ] **Step 1: Write the failing tests**

In `src/main/engine/nodes.test.ts`, add a describe block. Follow the file's existing harness (it injects a fake `runAgent` and mocks `project-store` + `getSettings`). Use the existing helpers for building a minimal `RunState`/`Eng`; the assertions:

```ts
describe('designPreviewGate', () => {
  it('buildOrchestratorGraph inserts the gate between route and execute only when designPreview is on', () => {
    setSettings({ designPreview: false })            // use the test's settings mock helper
    const off = buildOrchestratorGraph(fakeEng())
    expect(off.edges.route).toBe('execute')
    expect(off.nodes.designPreviewGate).toBeUndefined()

    setSettings({ designPreview: true })
    const on = buildOrchestratorGraph(fakeEng())
    expect(on.edges.route).toBe('designPreviewGate')
    expect(on.edges.designPreviewGate).toBe('execute')
    expect(typeof on.nodes.designPreviewGate).toBe('function')
  })

  it('fresh entry generates a preview and interrupts', async () => {
    const calls: string[] = []
    const eng = fakeEng({ runAgent: async (o) => { calls.push(o.prompt); return { text: 'ok' } } })
    const res = await runNode('designPreviewGate', baseState({ resumeInput: undefined }), eng)
    expect(calls[0]).toContain('design-preview.html')
    expect(res.interrupt?.kind).toBe('design-preview')
    expect(res.patch?.designPreviewIteration).toBe(1)
  })

  it('resume=approve proceeds to execute and records approval', async () => {
    const eng = fakeEng()
    const res = await runNode('designPreviewGate', baseState({ resumeInput: { decision: 'approve' } }), eng)
    expect(res.goto).toBe('execute')
    expect(res.patch?.designPreviewApproved).toBe(true)
  })

  it('resume=changes regenerates with the feedback and re-interrupts', async () => {
    const calls: string[] = []
    const eng = fakeEng({ runAgent: async (o) => { calls.push(o.prompt); return { text: 'ok' } } })
    const res = await runNode('designPreviewGate', baseState({ resumeInput: { decision: 'changes', feedback: 'darker' }, designPreviewIteration: 1 }), eng)
    expect(calls[0]).toContain('darker')
    expect(res.interrupt?.kind).toBe('design-preview')
    expect(res.patch?.designPreviewIteration).toBe(2)
  })

  it('fails open to execute when generation throws', async () => {
    const eng = fakeEng({ runAgent: async () => { throw new Error('boom') } })
    const res = await runNode('designPreviewGate', baseState({ resumeInput: undefined }), eng)
    expect(res.goto).toBe('execute')
    expect(res.interrupt).toBeUndefined()
  })
})
```

> Adapt `setSettings`/`fakeEng`/`runNode`/`baseState` to the actual helpers already in `nodes.test.ts` (the file already builds fake `Eng`s and drives nodes; reuse those). If a helper doesn't exist, add a minimal one consistent with the file. The gate calls `getSettings()` inside `generateDesignPreview`, so ensure the settings mock returns `usePreMadeInspirationGuide` too.

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -- nodes.test` → FAIL (`designPreviewGate` node undefined / helper references).

- [ ] **Step 3: Add the import**

At the top of `src/main/engine/nodes.ts`, add to the shared-imports:
```ts
import { designPreviewPrompt, INSPIRATION_GUIDE } from '../../shared/design-preview'
```

- [ ] **Step 4: Conditionally wire the gate in `buildOrchestratorGraph`**

Replace the body of `buildOrchestratorGraph` (lines ~104–132) with:

```ts
export function buildOrchestratorGraph(eng: Eng): CompiledGraph {
  const gate = getSettings().designPreview
  return {
    entry: 'plan',
    edges: {
      plan: 'route',
      route: gate ? 'designPreviewGate' : 'execute',
      ...(gate ? { designPreviewGate: 'execute' } : {}),
      execute: 'domainReview',
      replan: 'execute',
      escalate: 'reflect',
      domainReview: 'integrationReview',
      integrationReview: 'reflect',
      repair: 'domainReview',
      reflect: 'synthesize',
      synthesize: END
    },
    nodes: {
      plan: (s, io) => planNode(s, io, eng),
      route: (s, io) => routeNode(s, io, eng),
      ...(gate ? { designPreviewGate: (s, io) => designPreviewGateNode(s, io, eng) } : {}),
      execute: (s, io) => executeNode(s, io, eng),
      replan: (s, io) => replanNode(s, io, eng),
      escalate: (s, io) => escalateNode(s, io, eng),
      domainReview: (s, io) => domainReviewNode(s, io, eng),
      integrationReview: (s, io) => integrationReviewNode(s, io, eng),
      repair: (s, io) => repairNode(s, io, eng),
      reflect: (s, io) => reflectNode(s, io, eng),
      synthesize: (s, io) => synthNode(s, io, eng)
    }
  }
}
```

When `gate` is false the spreads are `{}`, so the edge/node maps are byte-identical to today (`route: 'execute'`, no `designPreviewGate`).

- [ ] **Step 5: Add the gate node + generator**

Add these to the nodes section of `nodes.ts` (e.g. after `routeNode`):

```ts
interface DesignDecision {
  decision: 'approve' | 'changes'
  feedback?: string
}

/** Run one focused orchestrator acting-call to (re)write design-preview.html. Throws on agent error. */
async function generateDesignPreview(eng: Eng, state: RunState, feedback?: string): Promise<void> {
  const s = getSettings()
  const guide = s.usePreMadeInspirationGuide ? INSPIRATION_GUIDE : ''
  const fb = feedback
    ? `\n\nThe user requested changes to the previous preview: ${feedback}\nProduce a revised design-preview.html that addresses this.`
    : ''
  await eng.runAgent({
    wc: eng.wc,
    agentId: state.orchestratorId,
    prompt: designPreviewPrompt(state.goal, guide) + fb,
    runId: eng.runId,
    stepId: state.orchestratorId,
    permissionMode: state.actingMode,
    abort: eng.abort
  })
}

/**
 * Design-preview approval gate. On fresh entry (or a 'changes' resume) it generates
 * a preview and pauses (interrupt). On an 'approve' resume it records approval and
 * proceeds to execute. Fails open (→ execute) if generation throws — never blocks a build.
 */
async function designPreviewGateNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const decision = state.resumeInput as DesignDecision | undefined
  if (decision?.decision === 'approve') {
    return { patch: { resumeInput: undefined, designPreviewApproved: true, phase: 'executing' }, goto: 'execute' }
  }
  const steps = { ...state.steps }
  setStatus(eng, steps, state.orchestratorId, 'working')
  const feedback = decision?.decision === 'changes' ? decision.feedback : undefined
  try {
    await generateDesignPreview(eng, state, feedback)
  } catch {
    // fail-open: a preview failure must never block the build
    return { patch: { resumeInput: undefined, steps, phase: 'executing' }, goto: 'execute' }
  }
  const iteration = (state.designPreviewIteration ?? 0) + 1
  return {
    patch: { resumeInput: undefined, steps, designPreviewIteration: iteration, phase: 'previewing' },
    interrupt: { kind: 'design-preview', prompt: 'Review the design preview', payload: { iteration } }
  }
}
```

> `setStatus(eng, steps, id, status)` is the existing helper used by `planNode` (mutates `steps`, emits a status event). Use a status string that already exists (`'working'`); confirm against `setStatus`'s usage and the `NodeStatus` type — if `'working'` isn't valid, use the same status `routeNode`/`executeNode` set for the acting phase.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- nodes.test` → PASS (existing suite + the 5 new cases).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck` → clean.
```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(design-preview): gate node + conditional route→gate→execute wiring"
```

---

### Task 4: Thread the approved-design reference into the worker prompt

**Files:**
- Modify: `src/main/engine/nodes.ts` (`workerPrompt` ~1541; its call site ~384)
- Test: `src/main/engine/nodes.test.ts` (add `workerPrompt` cases) — or the existing prompt-marker test file if one covers `workerPrompt`.

**Interfaces:**
- Consumes: `RunState.designPreviewApproved` (Task 1).
- Produces: `workerPrompt(goal, tasks, light?, vision?, designApproved?)` — appends a one-line `design-preview.html` reference when `designApproved` is true; byte-identical when false.

- [ ] **Step 1: Write the failing test**

Add to `nodes.test.ts`:

```ts
describe('workerPrompt design-preview reference', () => {
  const task = { id: 't1', title: 'T', description: 'D' } as RunTask
  it('appends the approved-design reference when designApproved is true', () => {
    expect(workerPrompt('g', [task], false, false, true)).toContain('design-preview.html')
    expect(workerPrompt('g', [task], true, false, true)).toContain('design-preview.html')
  })
  it('is byte-identical to today when designApproved is false/omitted', () => {
    expect(workerPrompt('g', [task], false, false, false)).toBe(workerPrompt('g', [task], false, false))
    expect(workerPrompt('g', [task], true, false, false)).toBe(workerPrompt('g', [task], true, false))
    expect(workerPrompt('g', [task], false, false, false)).not.toContain('design-preview.html')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- nodes.test` → FAIL (arity / missing text).

- [ ] **Step 3: Add the parameter and the gated line**

Change `workerPrompt`'s signature and both branches. New signature:
```ts
export function workerPrompt(goal: string, tasks: RunTask[], light = false, vision = false, designApproved = false): string {
```
Immediately after computing `list`, add:
```ts
  const designNote = designApproved
    ? ' An approved design-system preview is at design-preview.html — build the UI to match its palette, type, and components.'
    : ''
```
In the **light** branch, change the closing sentence from:
```ts
${qa} When finished, briefly report what you changed and flag anything you could not complete.`
```
to:
```ts
${qa}${designNote} When finished, briefly report what you changed and flag anything you could not complete.`
```
In the **non-light** branch, change:
```ts
${qa}

When finished, briefly report what you changed and flag anything you could not complete.`
```
to:
```ts
${qa}${designNote}

When finished, briefly report what you changed and flag anything you could not complete.`
```
When `designApproved` is false, `designNote === ''`, so both branches are byte-identical to today.

- [ ] **Step 4: Thread it at the call site**

At the `workerPrompt(...)` call in `executeNode` (~line 384), add the 5th argument:
```ts
workerPrompt(state.goal, group.map((t) => t.task), es.lightPrompts, es.visionMode, state.designPreviewApproved === true)
```
(`state` is in scope in `executeNode`; `es` is the existing effort/settings snapshot used for `lightPrompts`/`visionMode`.)

- [ ] **Step 5: Run tests + verify no regression**

Run: `npm run test -- nodes.test` → PASS (new cases + the existing `workerPrompt`/pipeline tests unchanged).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` → clean.
```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(design-preview): workers follow the approved design-preview.html"
```

---

### Task 5: `readDesignPreview` IPC (main → renderer)

**Files:**
- Modify: `src/main/engine/project-store.ts` (add `readDesignPreview`)
- Modify: `src/main/ipc.ts` (handler), `src/preload/index.ts` (bridge), `src/shared/types.ts` (`IPC` enum + `RendererApi`)
- Test: `src/main/engine/project-store.test.ts` (or a sibling) — read returns content / '' when missing.

**Interfaces:**
- Produces: `readDesignPreview(): Promise<string>` (main) returning `<currentProject>/design-preview.html` text or `''`; IPC `design-preview:read`; `RendererApi.readDesignPreview(): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Add to `src/main/engine/project-store.test.ts` (it mocks electron + uses a tmp project — mirror the existing setup):

```ts
it('readDesignPreview returns the file content, or empty string when absent', async () => {
  const proj = await fs.mkdtemp(join(tmpdir(), 'aim-dp-'))
  await openProject(proj)
  expect(await readDesignPreview()).toBe('')
  await fs.writeFile(join(proj, 'design-preview.html'), '<h1>hi</h1>', 'utf8')
  expect(await readDesignPreview()).toBe('<h1>hi</h1>')
  await fs.rm(proj, { recursive: true, force: true })
})
```
(Add `readDesignPreview` to the import from `./project-store` and ensure `fs`/`tmpdir`/`join` are imported as in the file's other tests.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- project-store` → FAIL (`readDesignPreview` not exported).

- [ ] **Step 3: Implement `readDesignPreview` in `project-store.ts`**

Add (near `getGraph`/`getAgent`, reusing the file's `fs`/`join`/`getCurrentProjectPath`):
```ts
/** Read the design-preview HTML from the project root; '' if it doesn't exist. */
export async function readDesignPreview(): Promise<string> {
  try {
    return await fs.readFile(join(getCurrentProjectPath(), 'design-preview.html'), 'utf8')
  } catch {
    return ''
  }
}
```
> Confirm `getCurrentProjectPath()` is defined/exported in this file (it is used by `backend-resolve`); if it's a different accessor name, use the file's canonical "current project path" getter.

- [ ] **Step 4: Wire IPC + preload + RendererApi**

In `src/shared/types.ts` `IPC` enum, after `readEnv: 'env:read'` add:
```ts
  readDesignPreview: 'design-preview:read',
```
In the `RendererApi` interface, after `readEnv` add:
```ts
  readDesignPreview: () => Promise<string>
```
In `src/main/ipc.ts`, after the `readEnv` handler:
```ts
  ipcMain.handle(IPC.readDesignPreview, () => store.readDesignPreview())
```
In `src/preload/index.ts`, after `readEnv`:
```ts
  readDesignPreview: () => ipcRenderer.invoke(IPC.readDesignPreview),
```

- [ ] **Step 5: Run test + typecheck + commit**

Run: `npm run test -- project-store` → PASS. Run: `npm run typecheck` → clean.
```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts src/main/ipc.ts src/preload/index.ts src/shared/types.ts
git commit -m "feat(design-preview): readDesignPreview IPC"
```

---

### Task 6: SettingsModal "Design preview" section

**Files:**
- Modify: `src/renderer/SettingsModal.tsx` (add a section near "Creative Vision" ~line 392)

**Interfaces:**
- Consumes: `ProjectSettings.designPreview`/`usePreMadeInspirationGuide` (Task 1); the existing `SettingSection`, `SettingRow`, `Switch`, and `update()` helpers.

- [ ] **Step 1: Add the section**

Immediately after the closing `</SettingSection>` of the "Creative Vision" section (~line 392), add:

```tsx
              <SettingSection title="Design preview">
                <SettingRow
                  label="Design preview"
                  desc="Before building, the run pauses to show a design-system preview (palette, type, components) that you approve or send back for changes. Off = unchanged."
                  control={
                    <Switch
                      checked={s.designPreview}
                      label="Design preview"
                      onChange={(v) => void update({ designPreview: v })}
                    />
                  }
                />
                {s.designPreview && (
                  <SettingRow
                    label="Use pre-made inspiration guide"
                    desc="Give the preview generator a curated structural guide — layout and token approach only; colors and fonts are still chosen to fit your project."
                    control={
                      <Switch
                        checked={s.usePreMadeInspirationGuide}
                        label="Use pre-made inspiration guide"
                        onChange={(v) => void update({ usePreMadeInspirationGuide: v })}
                      />
                    }
                  />
                )}
              </SettingSection>
```

- [ ] **Step 2: Verify + commit**

Run: `npm run typecheck && npm run lint` → clean (0 errors). Run: `npm run build` → succeeds.
```bash
git add src/renderer/SettingsModal.tsx
git commit -m "feat(design-preview): Settings section (gate + inspiration-guide toggles)"
```

---

### Task 7: Renderer pause UX — store handling + `DesignPreviewModal`

**Files:**
- Modify: `src/renderer/store.ts` (`pendingInterrupt` type; `'interrupt'` case ~306; add `resolveDesignPreview` action ~350)
- Create: `src/renderer/DesignPreviewModal.tsx`
- Modify: `src/renderer/App.tsx` (mount the modal ~398)

**Interfaces:**
- Consumes: `RendererApi.readDesignPreview` (Task 5); `resumeRun(runId, answer?: unknown)` (Task 1); the `'design-preview'` interrupt kind emitted by the gate node (Task 3).
- Produces: store action `resolveDesignPreview(decision: { decision: 'approve' } | { decision: 'changes'; feedback: string })`.

- [ ] **Step 1: Extend the `pendingInterrupt` renderer type**

Find the store's `pendingInterrupt` type (the shape assigned in the `'interrupt'` case: `{ kind, question, askerName, askerId, summary?, options? }`). Add `'design-preview'` to its `kind` union and add `iteration?: number`. For example, if the type is inline/aliased, change `kind: 'ask-user' | 'follow-through'` to `kind: 'ask-user' | 'follow-through' | 'design-preview'` and add `iteration?: number`.

- [ ] **Step 2: Handle the `'design-preview'` interrupt**

In `applyOrchestration`'s `case 'interrupt':` (store.ts ~306), before the existing `const kind = ...` line, add:

```ts
          if (e.interrupt.kind === 'design-preview') {
            const pl = e.interrupt.payload as { iteration?: number } | undefined
            run.pendingInterrupt = { kind: 'design-preview', iteration: pl?.iteration ?? 1, question: '', askerName: '', askerId: '' }
            run.interruptMinimized = false
            return { run }
          }
```
(The existing `ask-user`/`follow-through` logic below is unchanged.)

- [ ] **Step 3: Add the `resolveDesignPreview` action**

After the `answerInterrupt` action (store.ts ~350), add:
```ts
  resolveDesignPreview: (decision) =>
    set((s) => {
      const runId = s.run.runId
      if (runId) void window.api.resumeRun(runId, decision)
      return { run: { ...s.run, pendingInterrupt: null, interruptMinimized: false } }
    }),
```
Add its signature to the store's type/interface (mirror `answerInterrupt`):
```ts
  resolveDesignPreview: (decision: { decision: 'approve' } | { decision: 'changes'; feedback: string }) => void
```

- [ ] **Step 4: Create `DesignPreviewModal.tsx`**

Create `src/renderer/DesignPreviewModal.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { useStore } from './store'
import { Modal } from './Modal'

export default function DesignPreviewModal() {
  const run = useStore((s) => s.run)
  const resolveDesignPreview = useStore((s) => s.resolveDesignPreview)
  const minimizeInterrupt = useStore((s) => s.minimizeInterrupt)
  const [html, setHtml] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')

  const pending = run.pendingInterrupt
  const active = pending?.kind === 'design-preview'

  useEffect(() => {
    if (!active) return
    setHtml(null)
    void window.api.readDesignPreview().then(setHtml)
  }, [active, pending?.iteration])

  if (!active) return null

  if (run.interruptMinimized) {
    return (
      <button className="hitl-badge" onClick={() => minimizeInterrupt(false)}>
        ✎ Design preview ready for review
      </button>
    )
  }

  return (
    <Modal dismissable={false} onClose={() => minimizeInterrupt(true)} labelledBy="dp-title">
      {(close) => (<>
        <div className="modal-header">
          <h2 id="dp-title" className="modal-title">Review the design preview</h2>
        </div>
        <div className="modal-body">
          {html === null ? (
            <div className="radio-desc">Loading preview…</div>
          ) : html === '' ? (
            <div className="radio-desc">The preview could not be generated. You can request changes to try again, or proceed to build without one.</div>
          ) : (
            <iframe
              srcDoc={html}
              sandbox="allow-same-origin"
              title="Design preview"
              style={{ width: '100%', height: '60vh', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }}
            />
          )}
          <div className="field" style={{ marginTop: 12 }}>
            <textarea rows={2} value={feedback} placeholder="Optional: what to change if you request changes…" onChange={(e) => setFeedback(e.target.value)} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => close(() => minimizeInterrupt(true))}>Minimize</button>
          <button className="btn" disabled={!feedback.trim()} onClick={() => close(() => { resolveDesignPreview({ decision: 'changes', feedback: feedback.trim() }); setFeedback('') })}>Request changes</button>
          <button className="btn primary" onClick={() => close(() => resolveDesignPreview({ decision: 'approve' }))}>Approve &amp; build</button>
        </div>
      </>)}
    </Modal>
  )
}
```

- [ ] **Step 5: Mount the modal**

In `src/renderer/App.tsx`, add the import near the other modal imports (~line 19):
```tsx
import DesignPreviewModal from './DesignPreviewModal'
```
and mount it right after `<FollowThroughModal />` (~line 398):
```tsx
      <DesignPreviewModal />
```

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && npm run lint` → clean (0 errors). Run: `npm run test` → full suite green. Run: `npm run build` → succeeds.
```bash
git add src/renderer/store.ts src/renderer/DesignPreviewModal.tsx src/renderer/App.tsx
git commit -m "feat(design-preview): pause modal + approve/request-changes resume"
```

---

## Self-Review

**1. Spec coverage:**
- Two settings, default off → Task 1 (+ UI Task 6). ✓
- Conditional gate node `route → gate → execute` → Task 3. ✓
- Self-contained generation prompt + domain-fit + inspiration guide (format-only) → Task 2 (prompt/guide) + Task 3 (wiring, guide injection gated on `usePreMadeInspirationGuide`). ✓
- Pause → approve / request-changes→regenerate → Task 3 (node) + Task 7 (modal/resume). ✓
- Fail-open on generation failure → Task 3 (try/catch → goto execute). ✓
- Approved design reaches the build (worker-prompt line) → Task 4. ✓
- `srcdoc` iframe + `readDesignPreview` → Task 5 (IPC) + Task 7 (modal). ✓
- Byte-for-byte off → Task 3 (conditional spreads), Task 4 (default param), Task 1 (defaults). ✓
- Empty/failed preview handled gracefully in the modal → Task 7 (`html === ''` branch). ✓

**2. Placeholder scan:** No TBD/TODO; each code step shows complete content; new files given in full. Two explicit "confirm against the file" notes (the `nodes.test.ts` helper names in Task 3; `getCurrentProjectPath` name in Task 5; `setStatus` status value in Task 3) are verification instructions, not placeholders — the code to write is fully specified.

**3. Type consistency:** `designPreview`/`usePreMadeInspirationGuide` (settings), `designPreviewApproved`/`designPreviewIteration` (RunState), `'design-preview'` interrupt kind, `{ decision, feedback? }` resume object, `readDesignPreview(): Promise<string>`, `designPreviewPrompt(goal, guide?)`, `INSPIRATION_GUIDE`, `resolveDesignPreview` — all named identically across the tasks that define and consume them. `resumeRun`'s widened `answer?: unknown` (Task 1) is what lets Task 7 pass the decision object.
