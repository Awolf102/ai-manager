# Import & Enhance a Design System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone project-level "Design system" modal to import a self-contained HTML design system (→ the build follows it, skipping the generate-gate) and optionally have the creative team enhance it (before/after → adopt/discard).

**Architecture:** Import copies the uploaded `.html` to `<project>/design-preview.html` (the artifact the build already reads) + records a persistent `ProjectGraph.designSystem` marker. Enhance is a standalone acting agent-call (like `role-drafter`) force-equipped with the curated design skills, writing an enhanced candidate the user adopts. Reuses the design-preview.html build-reference, the skills-pack, and the Context-files upload pipeline.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), React, Vitest (node env).

## Global Constraints

- **Off-path byte-for-byte:** no `designSystem` marker + `autoApplyEnhancements` false (default) + no enhance call + no `extraSkillNames` ⇒ `buildOrchestratorGraph`, the worker prompt, `streamAgent`'s skill assembly, and every run are identical to today; `graph.json` gains no field.
- **Self-contained HTML** — the enhance prompt + FAQ prompt forbid external stylesheet/CDN/font URLs (the preview CSP blocks them).
- **Curated design skills** (verbatim): `emil-design-eng`, `ui-ux-pro-max`, `impeccable`, `design-taste-frontend`, `high-end-visual-design`, `redesign-existing-projects`, `review-animations`.
- **Files:** `<project>/design-preview.html` = live design; `<project>/.ai-manager/design-enhanced.html` = enhanced candidate.
- **Gates:** implementers `npm run typecheck` + `npm run test`; renderer tasks (8, 9) also `npm run lint`; controller `npm run build`.
- **Spec:** `docs/superpowers/specs/2026-07-08-design-system-import-design.md`.

---

### Task 1: Types, setting, IPC enum + RendererApi

**Files:**
- Modify: `src/shared/types.ts` (`ProjectGraph` ~253, `ProjectSettings`/`DEFAULT_SETTINGS`, `IPC` enum, `RendererApi`)
- Test: `src/shared/settings-defaults.test.ts`

**Interfaces:**
- Produces: `ProjectGraph.designSystem?: { fileName: string; addedAt: string; source: 'imported' | 'enhanced' }`; `ProjectSettings.autoApplyEnhancements: boolean`; IPC channels `design-system:import|remove|view|enhance|read-enhanced|adopt|discard`; `RendererApi` methods for each.

- [ ] **Step 1: Add the `ProjectGraph.designSystem` marker**

In `src/shared/types.ts`, in `ProjectGraph` (after `backends?: Backend[]`, the last field ~line 267):
```ts
  /** an imported/enhanced design system the build follows (lives at <project>/design-preview.html) */
  designSystem?: { fileName: string; addedAt: string; source: 'imported' | 'enhanced' }
```

- [ ] **Step 2: Add the `autoApplyEnhancements` setting + default**

In `ProjectSettings`, after `usePreMadeInspirationGuide: boolean`:
```ts
  /** adopt a design-system enhancement directly, skipping the before/after review */
  autoApplyEnhancements: boolean
```
In `DEFAULT_SETTINGS`, after `usePreMadeInspirationGuide: false` (add a trailing comma to it):
```ts
  usePreMadeInspirationGuide: false,
  autoApplyEnhancements: false
```

- [ ] **Step 3: Add IPC channels + RendererApi methods**

In the `IPC` enum, after the `readDesignPreview: 'design-preview:read'` entry:
```ts
  importDesignSystem: 'design-system:import',
  removeDesignSystem: 'design-system:remove',
  designSystemView: 'design-system:view',
  enhanceDesignSystem: 'design-system:enhance',
  readEnhancedDesign: 'design-system:read-enhanced',
  adoptEnhancement: 'design-system:adopt',
  discardEnhancement: 'design-system:discard',
```
In the `RendererApi` interface, after `readDesignPreview: () => Promise<string>`:
```ts
  importDesignSystem: (path?: string) => Promise<ProjectGraph>
  removeDesignSystem: () => Promise<ProjectGraph>
  designSystemView: () => Promise<{ designSystem?: ProjectGraph['designSystem']; hasFile: boolean }>
  enhanceDesignSystem: (directions: string[], note: string) => Promise<void>
  readEnhancedDesign: () => Promise<string>
  adoptEnhancement: () => Promise<ProjectGraph>
  discardEnhancement: () => Promise<void>
```

- [ ] **Step 4: Extend the defaults test**

In `src/shared/settings-defaults.test.ts`, in the DEFAULT_SETTINGS test:
```ts
expect(DEFAULT_SETTINGS.autoApplyEnhancements).toBe(false)
```

- [ ] **Step 5: Verify + commit**

Run: `npm run test -- settings-defaults` → PASS. `npm run typecheck` → clean.
```bash
git add src/shared/types.ts src/shared/settings-defaults.test.ts
git commit -m "feat(design-system): types + autoApplyEnhancements setting + IPC channels"
```

---

### Task 2: Pure `shared/design-enhance.ts`

**Files:**
- Create: `src/shared/design-enhance.ts`
- Test: `src/shared/design-enhance.test.ts`

**Interfaces:**
- Produces: `DESIGN_SKILLS: string[]`; `ENHANCE_PRESETS: { id: string; label: string }[]`; `DESIGN_SYSTEM_FAQ_PROMPT: string`; `enhanceDesignPrompt(currentHtml: string, directions: string[], note: string): string`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/design-enhance.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { DESIGN_SKILLS, ENHANCE_PRESETS, DESIGN_SYSTEM_FAQ_PROMPT, enhanceDesignPrompt } from './design-enhance'

describe('design-enhance constants', () => {
  it('curates the named design skills', () => {
    for (const s of ['emil-design-eng', 'ui-ux-pro-max', 'impeccable']) expect(DESIGN_SKILLS).toContain(s)
  })
  it('has preset directions and a self-contained FAQ prompt', () => {
    expect(ENHANCE_PRESETS.length).toBeGreaterThanOrEqual(4)
    expect(DESIGN_SYSTEM_FAQ_PROMPT).toMatch(/self-contained/i)
    expect(DESIGN_SYSTEM_FAQ_PROMPT).toMatch(/no external|do not reference/i)
  })
})

describe('enhanceDesignPrompt', () => {
  it('frames a creative team, targets the candidate file, forbids external assets, and embeds the current HTML', () => {
    const p = enhanceDesignPrompt('<html>CUR</html>', ['Modernize'], 'tighter spacing')
    expect(p).toMatch(/creative team/i)
    expect(p).toContain('.ai-manager/design-enhanced.html')
    expect(p).toMatch(/self-contained/i)
    expect(p).toContain('Modernize')
    expect(p).toContain('tighter spacing')
    expect(p).toContain('<html>CUR</html>')
  })
  it('is valid with empty directions and note', () => {
    const p = enhanceDesignPrompt('<x/>', [], '')
    expect(p).toContain('.ai-manager/design-enhanced.html')
    expect(p).toContain('<x/>')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- design-enhance` → FAIL (`Cannot find module './design-enhance'`).

- [ ] **Step 3: Create `src/shared/design-enhance.ts`**

```ts
// Pure prompt + constants for the design-system enhance pass. No node/DOM imports.

/** Curated design-craft skills forced onto the enhance pass (present in ~/.ai-manager/skills-pack/skills). */
export const DESIGN_SKILLS = [
  'emil-design-eng',
  'ui-ux-pro-max',
  'impeccable',
  'design-taste-frontend',
  'high-end-visual-design',
  'redesign-existing-projects',
  'review-animations'
]

/** One-click enhancement directions offered in the modal (plus a free-text box). */
export const ENHANCE_PRESETS: { id: string; label: string }[] = [
  { id: 'polish', label: 'Polish & refine' },
  { id: 'modernize', label: 'Modernize' },
  { id: 'motion', label: 'Add motion & micro-interactions' },
  { id: 'a11y', label: 'Improve accessibility & contrast' }
]

/** The copy-paste prompt shown in the modal's FAQ to export a faithful self-contained design system. */
export const DESIGN_SYSTEM_FAQ_PROMPT =
  'Produce ONE self-contained .html file of this design system: inline all CSS in a <style> tag, inline the icons as SVG and the fonts (or use a system-font stack), and include the color/type/spacing tokens, the component examples, the motion (CSS keyframes/transitions), and the written usage notes. Do NOT reference any external stylesheet, CDN, or font URL — everything must be inline so it renders and reads correctly offline.'

/** Prompt for the enhance pass. `directions` are preset labels; `note` is free text. */
export function enhanceDesignPrompt(currentHtml: string, directions: string[], note: string): string {
  const dirs = directions.length ? `\nRequested directions: ${directions.join(', ')}.` : ''
  const extra = note.trim() ? `\nAdditional instruction: ${note.trim()}` : ''
  return `You are enhancing an existing design system. Approach this as a creative team — Creative Director (overall direction), Art Director (visual hierarchy and composition), Visual Designer (execution and detail), and a motion designer (micro-interactions) — and apply your design-craft skills: typographic craft, spacing rhythm, color, elevation, and motion.${dirs}${extra}

Keep the design system's core identity (its palette, brand, and structure) — improve the CRAFT, do not replace it with something unrelated.

Write the enhanced result to the file ".ai-manager/design-enhanced.html" as ONE self-contained HTML page: inline all CSS, inline SVG icons and fonts (or a system-font stack), CSS-based motion — NO external stylesheet, CDN, or font URL. Produce ONLY that file.

Here is the current design system to enhance:

${currentHtml}

When done, reply with a one-line summary of what you improved.`
}
```

- [ ] **Step 4: Run + commit**

Run: `npm run test -- design-enhance` → PASS. `npm run typecheck` → clean.
```bash
git add src/shared/design-enhance.ts src/shared/design-enhance.test.ts
git commit -m "feat(design-system): pure enhance prompt + design-skill + FAQ constants"
```

---

### Task 3: Force extra skills onto a run (`withExtraSkills` + `StreamAgentOptions.extraSkillNames`)

**Files:**
- Modify: `src/shared/skills-pack.ts` (add `withExtraSkills`)
- Modify: `src/main/engine/agent-runner.ts` (`StreamAgentOptions` ~94-115; the skill-assembly ~170-179; imports ~9)
- Test: `src/shared/skills-pack.test.ts` (create if absent, else extend)

**Interfaces:**
- Consumes: `packSkillOptions`, `mergeSkillOptions`, `SkillSdkOptions` (from `shared/skills-pack`); `resolvePackPath` (from `main/engine/skills-pack`, already imported in agent-runner).
- Produces: `withExtraSkills(base: SkillSdkOptions | null, names: string[], packPath: string): SkillSdkOptions | null`; `StreamAgentOptions.extraSkillNames?: string[]`.

- [ ] **Step 1: Write the failing test**

Create/extend `src/shared/skills-pack.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { withExtraSkills } from './skills-pack'

describe('withExtraSkills', () => {
  it('returns the base unchanged when no extra names', () => {
    const base = { plugins: [{ type: 'local' as const, path: '/p' }], skills: ['a'] }
    expect(withExtraSkills(base, [], '/pack')).toBe(base)
    expect(withExtraSkills(null, [], '/pack')).toBe(null)
  })
  it('merges the pack-filtered extra skills into the base', () => {
    const out = withExtraSkills(null, ['emil-design-eng'], '/pack')
    expect(out).not.toBeNull()
    expect(out!.skills.some((s) => s.includes('emil-design-eng'))).toBe(true)
    expect(out!.plugins.some((p) => p.path === '/pack')).toBe(true)
  })
})
```
> If `SkillSdkOptions.plugins[]` shape differs, match the real type from `shared/skill-trust.ts` (read it first).

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- skills-pack` → FAIL (`withExtraSkills` not exported).

- [ ] **Step 3: Add `withExtraSkills` to `src/shared/skills-pack.ts`**

```ts
/** Merge a forced set of pack skills (by name) into `base`, regardless of the pack toggle.
 *  `names` empty ⇒ returns `base` unchanged (reference-identical). */
export function withExtraSkills(
  base: SkillSdkOptions | null,
  names: string[],
  packPath: string
): SkillSdkOptions | null {
  if (names.length === 0) return base
  return mergeSkillOptions(base, packSkillOptions(packPath, names))
}
```
(`packSkillOptions` and `mergeSkillOptions` are already in this file.)

- [ ] **Step 4: Add `extraSkillNames` to `StreamAgentOptions` and use it in `streamAgent`**

In `src/main/engine/agent-runner.ts`, add to `StreamAgentOptions` (after `header?: boolean`):
```ts
  /** force these pack skill names onto this run (e.g. design skills), even if the general pack is off */
  extraSkillNames?: string[]
```
Update the import at line ~9 to also bring `packSkillOptions`, `mergeSkillOptions`, `withExtraSkills`:
```ts
import { assembleAgentSkills, headlessNote, withExtraSkills } from '../../shared/skills-pack'
```
Replace the skill-assembly block (currently lines ~174-179):
```ts
    const perAgent = skillOptionsFor(agent.skills, await discoveredPlugins())
    let skillSdk = assembleAgentSkills(perAgent, pack.path, pack.names).options
    if (opts.extraSkillNames && opts.extraSkillNames.length > 0) {
      skillSdk = withExtraSkills(skillSdk, opts.extraSkillNames, resolvePackPath(getSettings().skillsPackPath ?? ''))
    }
    if (skillSdk) {
      options.plugins = skillSdk.plugins
      options.skills = skillSdk.skills
    }
```
(`resolvePackPath` is already imported at line ~12; `getSettings` is already imported.) When `extraSkillNames` is unset, `skillSdk` is exactly the prior value ⇒ byte-for-byte.

- [ ] **Step 5: Run + verify + commit**

Run: `npm run test -- skills-pack` → PASS. `npm run typecheck` → clean.
```bash
git add src/shared/skills-pack.ts src/shared/skills-pack.test.ts src/main/engine/agent-runner.ts
git commit -m "feat(design-system): withExtraSkills + StreamAgentOptions.extraSkillNames"
```

---

### Task 4: Import / remove / `hasDesignSystem` (project-store)

**Files:**
- Modify: `src/main/engine/project-store.ts`
- Test: `src/main/engine/project-store.test.ts`

**Interfaces:**
- Produces: `importDesignSystem(sourcePath: string): Promise<ProjectGraph>`; `removeDesignSystem(): Promise<ProjectGraph>`; `hasDesignSystem(): boolean`.

- [ ] **Step 1: Write the failing test**

Add to `src/main/engine/project-store.test.ts` (mirror the file's tmp-project + electron-mock setup; write a temp `.html` to import):
```ts
it('imports a design system, marks the graph, and removes it', async () => {
  const proj = await fs.mkdtemp(join(tmpdir(), 'aim-ds-'))
  await openProject(proj)
  const src = join(proj, 'src-design.html')
  await fs.writeFile(src, '<html>DS</html>', 'utf8')

  expect(hasDesignSystem()).toBe(false)
  const g = await importDesignSystem(src)
  expect(g.designSystem?.source).toBe('imported')
  expect(g.designSystem?.fileName).toBe('src-design.html')
  expect(await fs.readFile(join(proj, 'design-preview.html'), 'utf8')).toBe('<html>DS</html>')
  expect(hasDesignSystem()).toBe(true)

  await expect(importDesignSystem(join(proj, 'nope.txt'))).rejects.toThrow()

  await removeDesignSystem()
  expect(hasDesignSystem()).toBe(false)
  await expect(fs.access(join(proj, 'design-preview.html'))).rejects.toThrow()
  await fs.rm(proj, { recursive: true, force: true })
})
```
(Import `importDesignSystem, removeDesignSystem, hasDesignSystem` from `./project-store`; the `.txt` reject also covers "not html".)

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- project-store` → FAIL (not exported).

- [ ] **Step 3: Implement in `project-store.ts`**

Add near the other graph accessors (reuse the file's `fs`, `join`, `basename`, `requireCurrent`, `saveGraph`, `getGraph`):
```ts
const DESIGN_PREVIEW_FILE = 'design-preview.html'

/** True when the project has an imported/enhanced design system. */
export function hasDesignSystem(): boolean {
  return getGraph().designSystem != null
}

/** Import a self-contained HTML design system → becomes the project's design-preview.html. */
export async function importDesignSystem(sourcePath: string): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const stat = await fs.lstat(sourcePath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Design system must be a file')
  if (!/\.html?$/i.test(sourcePath)) throw new Error('Design system must be an .html file')
  if (stat.size > 25 * 1024 * 1024) throw new Error('Design system file is too large (max 25 MB)')
  await fs.copyFile(sourcePath, join(path, DESIGN_PREVIEW_FILE))
  graph.designSystem = { fileName: basename(sourcePath), addedAt: new Date().toISOString(), source: 'imported' }
  return saveGraph()
}

/** Clear the design system marker + delete design-preview.html (best-effort). */
export async function removeDesignSystem(): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  delete graph.designSystem
  try { await fs.rm(join(path, DESIGN_PREVIEW_FILE)) } catch { /* best-effort */ }
  return saveGraph()
}
```

- [ ] **Step 4: Run + commit**

Run: `npm run test -- project-store` → PASS. `npm run typecheck` → clean.
```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(design-system): importDesignSystem / removeDesignSystem / hasDesignSystem"
```

---

### Task 5: Enhance-candidate ops (project-store)

**Files:**
- Modify: `src/main/engine/project-store.ts`
- Test: `src/main/engine/project-store.test.ts`

**Interfaces:**
- Consumes: `DESIGN_PREVIEW_FILE`, `aimPath`, `requireCurrent`, `getCurrentProjectPath`, `saveGraph` (Task 4 / existing).
- Produces: `readEnhancedDesign(): Promise<string>`; `adoptEnhancement(): Promise<ProjectGraph>`; `discardEnhancement(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Add to `src/main/engine/project-store.test.ts`:
```ts
it('reads, adopts, and discards an enhancement candidate', async () => {
  const proj = await fs.mkdtemp(join(tmpdir(), 'aim-enh-'))
  await openProject(proj)
  await fs.writeFile(join(proj, 'design-preview.html'), '<html>BEFORE</html>', 'utf8')
  await fs.mkdir(join(proj, '.ai-manager'), { recursive: true })
  await fs.writeFile(join(proj, '.ai-manager', 'design-enhanced.html'), '<html>AFTER</html>', 'utf8')

  expect(await readEnhancedDesign()).toBe('<html>AFTER</html>')
  const g = await adoptEnhancement()
  expect(g.designSystem?.source).toBe('enhanced')
  expect(await fs.readFile(join(proj, 'design-preview.html'), 'utf8')).toBe('<html>AFTER</html>')
  expect(await readEnhancedDesign()).toBe('') // candidate consumed

  await fs.writeFile(join(proj, '.ai-manager', 'design-enhanced.html'), '<x/>', 'utf8')
  await discardEnhancement()
  expect(await readEnhancedDesign()).toBe('')
  await fs.rm(proj, { recursive: true, force: true })
})
```
(Import `readEnhancedDesign, adoptEnhancement, discardEnhancement` from `./project-store`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- project-store` → FAIL (not exported).

- [ ] **Step 3: Implement in `project-store.ts`**

```ts
const DESIGN_ENHANCED_FILE = 'design-enhanced.html' // under .ai-manager/

/** Read the enhancement candidate; '' if none. */
export async function readEnhancedDesign(): Promise<string> {
  try {
    return await fs.readFile(aimPath(getCurrentProjectPath(), DESIGN_ENHANCED_FILE), 'utf8')
  } catch {
    return ''
  }
}

/** Adopt the candidate as the live design; flip the marker to 'enhanced'; remove the candidate. */
export async function adoptEnhancement(): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const cand = aimPath(path, DESIGN_ENHANCED_FILE)
  await fs.copyFile(cand, join(path, DESIGN_PREVIEW_FILE))
  try { await fs.rm(cand) } catch { /* best-effort */ }
  graph.designSystem = {
    fileName: graph.designSystem?.fileName ?? 'enhanced',
    addedAt: new Date().toISOString(),
    source: 'enhanced'
  }
  return saveGraph()
}

/** Discard the candidate; keep the current design. */
export async function discardEnhancement(): Promise<void> {
  try { await fs.rm(aimPath(getCurrentProjectPath(), DESIGN_ENHANCED_FILE)) } catch { /* best-effort */ }
}
```
> `getCurrentProjectPath()` is already exported/used in this file (e.g. by `readDesignPreview`); confirm the name and reuse it.

- [ ] **Step 4: Run + commit**

Run: `npm run test -- project-store` → PASS. `npm run typecheck` → clean.
```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(design-system): enhancement-candidate read/adopt/discard"
```

---

### Task 6: The enhance pass (`design-enhancer.ts`)

**Files:**
- Create: `src/main/engine/design-enhancer.ts`
- Test: `src/main/engine/design-enhancer.test.ts`

**Interfaces:**
- Consumes: `readDesignPreview`, `getGraph`, `getSettings` (project-store); `actingModeFor` (`./acting-mode`); `enhanceDesignPrompt`, `DESIGN_SKILLS` (Task 2); `streamAgent`/`StreamAgentOptions` + `extraSkillNames` (Task 3).
- Produces: `enhanceDesignSystem(opts: { directions: string[]; note: string; wc: WebContents; abort: AbortController }, runAgent?: AgentRunner): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/main/engine/design-enhancer.test.ts` (mirror `role-drafter`/`manifest-detector` tests — inject a fake `runAgent`, mock `project-store`):
```ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('./project-store', () => ({
  readDesignPreview: vi.fn(async () => '<html>CUR</html>'),
  getGraph: () => ({ nodes: [{ id: 'orch1', kind: 'orchestrator' }] }),
  getSettings: () => ({ autonomy: 'auto' })
}))
import { enhanceDesignSystem } from './design-enhancer'
import { DESIGN_SKILLS } from '../../shared/design-enhance'

describe('enhanceDesignSystem', () => {
  it('runs the orchestrator with the enhance prompt, the design skills, and acting permission', async () => {
    let seen: any
    const runAgent = vi.fn(async (o: any) => { seen = o; return { text: 'done' } })
    await enhanceDesignSystem({ directions: ['Modernize'], note: 'x', wc: {} as any, abort: new AbortController() }, runAgent)
    expect(seen.agentId).toBe('orch1')
    expect(seen.prompt).toContain('<html>CUR</html>')
    expect(seen.prompt).toContain('Modernize')
    expect(seen.extraSkillNames).toEqual(DESIGN_SKILLS)
    expect(seen.permissionMode).toBeDefined() // acting mode, not 'default'
  })
})
```
> Adjust the `project-store` mock keys to the real exports the module imports. If `actingModeFor` needs mocking, add it; the assertion only checks `permissionMode` is set.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- design-enhancer` → FAIL (module missing).

- [ ] **Step 3: Create `src/main/engine/design-enhancer.ts`**

```ts
// Standalone (non-graph) acting call that enhances the project's design system, writing an
// enhanced candidate to .ai-manager/design-enhanced.html. Force-equipped with the design skills.
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { StreamAgentOptions } from './agent-runner'
import { streamAgent } from './agent-runner'
import { readDesignPreview, getGraph, getSettings } from './project-store'
import { actingModeFor } from './acting-mode'
import { enhanceDesignPrompt, DESIGN_SKILLS } from '../../shared/design-enhance'

export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

export async function enhanceDesignSystem(
  opts: { directions: string[]; note: string; wc: WebContents; abort: AbortController },
  runAgent: AgentRunner = streamAgent
): Promise<void> {
  const current = await readDesignPreview()
  if (!current) throw new Error('No design system to enhance — import one first.')
  const orch = getGraph().nodes.find((n) => n.kind === 'orchestrator')
  if (!orch) throw new Error('This project has no orchestrator agent.')
  await runAgent({
    wc: opts.wc,
    agentId: orch.id,
    prompt: enhanceDesignPrompt(current, opts.directions, opts.note),
    runId: randomUUID(),
    stepId: orch.id,
    permissionMode: actingModeFor(getSettings().autonomy),
    extraSkillNames: DESIGN_SKILLS,
    abort: opts.abort
  })
}
```

- [ ] **Step 4: Run + commit**

Run: `npm run test -- design-enhancer` → PASS. `npm run typecheck` → clean.
```bash
git add src/main/engine/design-enhancer.ts src/main/engine/design-enhancer.test.ts
git commit -m "feat(design-system): enhance pass (design-capable acting call)"
```

---

### Task 7: Gate-skip + run seeds the marker

**Files:**
- Modify: `src/main/engine/nodes.ts` (`buildOrchestratorGraph` ~106; project-store import ~30-40)
- Modify: `src/main/engine/orchestrator.ts` (after `seedRunState` ~line 37; imports ~14-21)
- Test: `src/main/engine/nodes.test.ts`

**Interfaces:**
- Consumes: `hasDesignSystem` (Task 4).
- Produces: `buildOrchestratorGraph`'s gate is `getSettings().designPreview && !hasDesignSystem()`; a run with a design-system marker seeds `designPreviewApproved = true`.

- [ ] **Step 1: Write the failing test**

Add to `src/main/engine/nodes.test.ts` (reuse the harness's settings + project-store mocks; ensure `hasDesignSystem` is mockable):
```ts
describe('design-system gate-skip', () => {
  it('skips the generate-gate when a design system is imported', () => {
    setSettings({ designPreview: true })
    setHasDesignSystem(true) // adapt: make hasDesignSystem() return true in the mock
    const g = buildOrchestratorGraph(fakeEng())
    expect(g.edges.route).toBe('execute')
    expect(g.nodes.designPreviewGate).toBeUndefined()
  })
  it('keeps the gate when designPreview on and no design system', () => {
    setSettings({ designPreview: true })
    setHasDesignSystem(false)
    const g = buildOrchestratorGraph(fakeEng())
    expect(g.edges.route).toBe('designPreviewGate')
  })
})
```
> Adapt `setSettings`/`fakeEng`/`setHasDesignSystem` to the real `nodes.test.ts` harness — add `hasDesignSystem` to its `project-store` mock (default `() => false`, so existing tests stay byte-for-byte).

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- nodes.test` → FAIL.

- [ ] **Step 3: Wire the gate + import**

In `src/main/engine/nodes.ts`, add `hasDesignSystem` to the `./project-store` import block (lines ~30-40). In `buildOrchestratorGraph`, change:
```ts
  const gate = getSettings().designPreview
```
to:
```ts
  const gate = getSettings().designPreview && !hasDesignSystem()
```

- [ ] **Step 4: Seed `designPreviewApproved` at run start**

In `src/main/engine/orchestrator.ts`, add `hasDesignSystem` to the `./project-store` import (the block ~lines 14-21). Immediately after `const state = seedRunState({ ... })` (~line 37):
```ts
  if (hasDesignSystem()) state.designPreviewApproved = true
```
This makes the existing approved-design worker-prompt line fire for imported/enhanced designs (the run's workers reference `design-preview.html`), without a gate pause.

- [ ] **Step 5: Run + verify no regression + commit**

Run: `npm run test -- nodes.test` → PASS. `npm run test` → full suite green. `npm run typecheck` → clean.
```bash
git add src/main/engine/nodes.ts src/main/engine/orchestrator.ts src/main/engine/nodes.test.ts
git commit -m "feat(design-system): skip generate-gate + seed approved-design when imported"
```

---

### Task 8: IPC handlers + preload bridges

**Files:**
- Modify: `src/main/ipc.ts` (near the `design-preview:read` / `context:*` handlers)
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: all Task 1 IPC channels; Task 4/5 store fns; Task 6 `enhanceDesignSystem`; `store.getGraph`.

- [ ] **Step 1: Add the main handlers**

In `src/main/ipc.ts`, after the `readDesignPreview` handler (and mirroring how `addContext` opens a dialog when no path is given), add:
```ts
  ipcMain.handle(IPC.importDesignSystem, async (_e, path?: string) => {
    let src = path
    if (!src) {
      const r = await dialog.showOpenDialog({ title: 'Import a design system (.html)', properties: ['openFile'], filters: [{ name: 'HTML', extensions: ['html', 'htm'] }] })
      if (r.canceled || r.filePaths.length === 0) return store.getGraph()
      src = r.filePaths[0]
    }
    return store.importDesignSystem(src)
  })
  ipcMain.handle(IPC.removeDesignSystem, () => store.removeDesignSystem())
  ipcMain.handle(IPC.designSystemView, () => ({ designSystem: store.getGraph().designSystem, hasFile: store.hasDesignSystem() }))
  ipcMain.handle(IPC.enhanceDesignSystem, (e: IpcMainInvokeEvent, directions: string[], note: string) =>
    enhanceDesignSystem({ directions, note, wc: e.sender, abort: new AbortController() })
  )
  ipcMain.handle(IPC.readEnhancedDesign, () => store.readEnhancedDesign())
  ipcMain.handle(IPC.adoptEnhancement, () => store.adoptEnhancement())
  ipcMain.handle(IPC.discardEnhancement, () => store.discardEnhancement())
```
Add the import near the other engine imports in `ipc.ts`:
```ts
import { enhanceDesignSystem } from './engine/design-enhancer'
```
(`dialog` and `IpcMainInvokeEvent` are already imported in `ipc.ts` — confirm and reuse.)

- [ ] **Step 2: Add the preload bridges**

In `src/preload/index.ts`, after `readDesignPreview`:
```ts
  importDesignSystem: (path) => ipcRenderer.invoke(IPC.importDesignSystem, path),
  removeDesignSystem: () => ipcRenderer.invoke(IPC.removeDesignSystem),
  designSystemView: () => ipcRenderer.invoke(IPC.designSystemView),
  enhanceDesignSystem: (directions, note) => ipcRenderer.invoke(IPC.enhanceDesignSystem, directions, note),
  readEnhancedDesign: () => ipcRenderer.invoke(IPC.readEnhancedDesign),
  adoptEnhancement: () => ipcRenderer.invoke(IPC.adoptEnhancement),
  discardEnhancement: () => ipcRenderer.invoke(IPC.discardEnhancement),
```

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck` → clean. `npm run build` → succeeds.
```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat(design-system): IPC handlers + preload bridges"
```

---

### Task 9: `DesignSystemModal` + top-bar button

**Files:**
- Create: `src/renderer/DesignSystemModal.tsx`
- Modify: `src/renderer/App.tsx` (top-bar button + mount + drag-drop optional)
- Modify: `src/renderer/store.ts` (a `showDesignSystem` flag + `setGraph` already exists)

**Interfaces:**
- Consumes: `window.api.{importDesignSystem, removeDesignSystem, designSystemView, enhanceDesignSystem, readEnhancedDesign, adoptEnhancement, discardEnhancement, readDesignPreview, getPathForFile}`; `ENHANCE_PRESETS`, `DESIGN_SYSTEM_FAQ_PROMPT` (Task 2); the `Modal` component.

- [ ] **Step 1: Add a `showDesignSystem` UI flag to the store**

In `src/renderer/store.ts`, mirror an existing modal flag (e.g. `showEnv`/`showContext`): add `showDesignSystem: boolean` to state (default `false`) + a setter `setShowDesignSystem: (v: boolean) => void` (mirror `setShowEnv`). If the store uses a generic pattern, follow it exactly.

- [ ] **Step 2: Create `src/renderer/DesignSystemModal.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { useStore } from './store'
import { Modal } from './Modal'
import { ENHANCE_PRESETS, DESIGN_SYSTEM_FAQ_PROMPT } from '../shared/design-enhance'

export default function DesignSystemModal() {
  const show = useStore((s) => s.showDesignSystem)
  const setShow = useStore((s) => s.setShowDesignSystem)
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)

  const [html, setHtml] = useState('')            // current design-preview.html
  const [faq, setFaq] = useState(false)
  const [directions, setDirections] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [before, setBefore] = useState<string | null>(null) // set when a candidate awaits review
  const [after, setAfter] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const ds = graph.designSystem

  useEffect(() => {
    if (!show) return
    void window.api.readDesignPreview().then(setHtml)
  }, [show, ds?.addedAt])

  if (!show) return null

  const doImport = async (path?: string): Promise<void> => {
    setErr('')
    try { setGraph(await window.api.importDesignSystem(path)) } catch (e) { setErr(String(e)) }
  }
  const doRemove = async (): Promise<void> => { setGraph(await window.api.removeDesignSystem()); setHtml('') }
  const toggleDir = (id: string): void =>
    setDirections((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]))

  const runEnhance = async (): Promise<void> => {
    setErr(''); setBusy(true)
    try {
      const labels = ENHANCE_PRESETS.filter((p) => directions.includes(p.id)).map((p) => p.label)
      await window.api.enhanceDesignSystem(labels, note)
      const [b, a] = await Promise.all([window.api.readDesignPreview(), window.api.readEnhancedDesign()])
      if (graph.settings.autoApplyEnhancements) {
        setGraph(await window.api.adoptEnhancement())
        setHtml(await window.api.readDesignPreview())
      } else {
        setBefore(b); setAfter(a)
      }
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  const adopt = async (): Promise<void> => {
    setGraph(await window.api.adoptEnhancement()); setBefore(null); setAfter(null)
    setHtml(await window.api.readDesignPreview())
  }
  const discard = async (): Promise<void> => { await window.api.discardEnhancement(); setBefore(null); setAfter(null) }

  const frame = (src: string) => (
    <iframe srcDoc={src} sandbox="allow-same-origin" title="design" style={{ width: '100%', height: '52vh', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
  )

  // Before/after review takes over the modal body when a candidate is pending.
  if (before !== null && after !== null) {
    return (
      <Modal dismissable={false} onClose={discard} labelledBy="ds-title">
        {(close) => (<>
          <div className="modal-header"><h2 id="ds-title" className="modal-title">Review enhancement</h2></div>
          <div className="modal-body">
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}><div className="radio-desc">Before</div>{frame(before)}</div>
              <div style={{ flex: 1, minWidth: 0 }}><div className="radio-desc">After</div>{frame(after)}</div>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => close(discard)}>Discard</button>
            <button className="btn primary" onClick={() => close(adopt)}>Adopt enhancement</button>
          </div>
        </>)}
      </Modal>
    )
  }

  return (
    <Modal onClose={() => setShow(false)} labelledBy="ds-title">
      {(close) => (<>
        <div className="modal-header"><h2 id="ds-title" className="modal-title">Design system</h2></div>
        <div className="modal-body">
          {err && <div className="chat-key-error">{err}</div>}
          <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 0 }}>
            <button className="btn" onClick={() => void doImport()}>Import .html…</button>
            <button className="btn" onClick={() => setFaq((v) => !v)}>FAQ</button>
            {ds && <button className="btn" onClick={() => void doRemove()}>Remove</button>}
          </div>
          {faq && (
            <div className="field" style={{ marginTop: 8 }}>
              <div className="radio-desc">Ask your design tool's chat to export a faithful, self-contained file with this prompt:</div>
              <textarea readOnly rows={5} value={DESIGN_SYSTEM_FAQ_PROMPT} />
              <button className="btn" onClick={() => void navigator.clipboard.writeText(DESIGN_SYSTEM_FAQ_PROMPT)}>Copy prompt</button>
            </div>
          )}
          {ds ? (
            <>
              <div className="radio-desc" style={{ marginTop: 8 }}>{ds.fileName} · {ds.source}</div>
              {html && frame(html)}
              <div className="field" style={{ marginTop: 12 }}>
                <div className="radio-desc">Enhance with the design team</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {ENHANCE_PRESETS.map((p) => (
                    <button key={p.id} className={`btn ${directions.includes(p.id) ? 'primary' : ''}`} onClick={() => toggleDir(p.id)}>{p.label}</button>
                  ))}
                </div>
                <textarea rows={2} value={note} placeholder="Optional: your own instruction…" onChange={(e) => setNote(e.target.value)} style={{ marginTop: 6 }} />
                <button className="btn primary" disabled={busy} onClick={() => void runEnhance()} style={{ marginTop: 6 }}>{busy ? 'Enhancing…' : 'Enhance'}</button>
              </div>
            </>
          ) : (
            <div className="radio-desc" style={{ marginTop: 8 }}>No design system yet — import a self-contained .html to have the build follow it (skips the generate step).</div>
          )}
        </div>
        <div className="modal-actions"><button className="btn" onClick={() => close(() => setShow(false))}>Close</button></div>
      </>)}
    </Modal>
  )
}
```
> Match the real `Modal` render-prop signature + class names against `DesignPreviewModal.tsx`/`ContextModal.tsx`. `setGraph` is the store's graph setter (confirm its name). No new CSS — reuse existing classes.

- [ ] **Step 3: Add the top-bar button + mount in `App.tsx`**

Add the import near the other modal imports:
```tsx
import DesignSystemModal from './DesignSystemModal'
```
Add a top-bar button next to the Context/Env buttons (mirror the Context button; `Palette` from lucide-react):
```tsx
<button className="btn" title="Design system — import or enhance the project's UI look" onClick={() => setShowDesignSystem(true)}>
  <Palette size={14} /> Design
</button>
```
(Get `setShowDesignSystem` from the store; add `Palette` to the lucide-react import.) Mount the modal alongside the others (near `<DesignPreviewModal />`):
```tsx
<DesignSystemModal />
```

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck && npm run lint` → clean (0 errors). `npm run test` → full suite green. `npm run build` → succeeds.
```bash
git add src/renderer/DesignSystemModal.tsx src/renderer/App.tsx src/renderer/store.ts
git commit -m "feat(design-system): Design system modal + top-bar button"
```

---

## Self-Review

**1. Spec coverage:** Import (button+modal+upload+persist) → T1/T4/T8/T9. Gate-skip + build-reference → T7. FAQ prompt → T2/T9. Enhance (direction picker + creative-team pass + forced design skills) → T2/T3/T6/T9. Before/after + adopt/discard → T5/T9. Headless auto-apply → T1 (setting) + T9 (flow). `readEnhancedDesign` → T5/T8. Off-path byte-for-byte → T3 (extraSkillNames unset), T7 (gate `&& !hasDesignSystem()`), T1 (defaults). ✓

**2. Placeholder scan:** No TBD/TODO; complete code for every new file + exact edits; test code given. Adaptation notes (test-harness helper names in T6/T7; `SkillSdkOptions` shape in T3; `getCurrentProjectPath`/`setGraph` names) are verify-instructions, not placeholders.

**3. Type consistency:** `designSystem { fileName, addedAt, source }`, `autoApplyEnhancements`, `hasDesignSystem()`, `importDesignSystem`/`removeDesignSystem`/`readEnhancedDesign`/`adoptEnhancement`/`discardEnhancement`, `withExtraSkills`, `StreamAgentOptions.extraSkillNames`, `DESIGN_SKILLS`, `enhanceDesignPrompt`, `enhanceDesignSystem`, `design-system:*` channels — named identically across defining and consuming tasks. The enhance pass sets `extraSkillNames: DESIGN_SKILLS` (T6) consumed by `streamAgent` (T3); the marker set by T4/T5 is read by T7's gate + seed.
